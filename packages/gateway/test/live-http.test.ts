import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { fail, type ToolResult } from "../src/protocol.ts";
import { UserStore } from "../src/user-store.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";

const temporary: string[] = [];
const password = "a-long-live-test-password";
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function login(users: UserStore, username: string): Promise<string> {
  const user = (await users.list()).find(
    (entry) => entry.username === username,
  )!;
  const session = await users.createSession(user);
  return "__Host-dev-mcp-session=" + session.token;
}

function success(data: unknown, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, data, truncated: false, ...extra };
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-live-http-"));
  temporary.push(dataDir);
  const users = new UserStore(dataDir);
  const admin = await adminAccount(users, dataDir);
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      userRunnerSocketDir: path.join(dataDir, "runners"),
      runnerStatusDir: path.join(dataDir, "status"),
      google: { clientId: "test-client", clientSecret: "test-secret" },
    },
    { users },
  );
  const process = {
    id: "process-a",
    projectId: "project-a",
    command: "echo <script>command</script>",
    status: "running",
    pid: 123,
    startedAt: "2026-10-01T10:00:00.000Z",
  };
  const state = {
    processes: success({ processes: [process] }),
    logs: success({ output: "first line\n", cursor: "cursor-first" }),
  };
  const ipc = vi
    .spyOn(IpcClient.prototype, "call")
    .mockImplementation(async (method) => {
      if (method === "process_list") {
        return state.processes;
      }
      if (method === "process_logs") {
        return state.logs;
      }
      if (method === "project_list") {
        return success({ projects: [] });
      }
      throw new Error("Unexpected runner method: " + method);
    });
  const cookie = await login(users, "admin");
  const get = (url: string, selectedCookie = cookie) =>
    inject(app, {
      method: "GET",
      url,
      headers: { cookie: selectedCookie },
    });
  const detailUrl = "/admin/processes/" + admin.id + "/" + process.id;
  return { app, users, admin, dataDir, process, state, ipc, get, detailUrl };
}

describe("automatic process and runner updates over HTTP", () => {
  it("shows command mode, exit status and redirected-file notices outside the log output", async () => {
    const { get, state, process, detailUrl } = await fixture();
    state.processes = success({
      processes: [
        {
          ...process,
          mode: "command",
          status: "exited",
          exitCode: 7,
          logPath: "build<file>.log",
        },
      ],
    });
    state.logs = success({
      output: "",
      cursor: "file-cursor",
      logSource: "file",
      logFile: "build<file>.log",
      logWarning: "The selected log file has not been created.",
    });
    const page = await get(detailUrl);
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain("완료까지 대기");
    expect(page.payload).toContain("data-process-exit>7</dd>");
    expect(page.payload).toContain("build&lt;file&gt;.log");
    expect(page.payload).toContain(
      "지정한 로그 파일이 아직 생성되지 않았습니다.",
    );
    expect(page.payload).toMatch(/data-live-log[^>]*><\/pre>/);
    state.logs = success({
      output: "",
      cursor: "file-cursor",
      logFile: "build<file>.log",
    });
    const live = await get(
      detailUrl + "/live?cursor=file-cursor&status=exited",
    );
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      process: { exitLabel: "7" },
      output: "",
      logNotice: expect.stringContaining("build<file>.log"),
    });
    expect(live.json()).not.toHaveProperty("logWarning");
  });

  it("shows terminal log availability once and leaves repeated live polls idle", async () => {
    const { get, state, process, detailUrl } = await fixture();
    state.logs = success({
      output: "",
      cursor: "terminal-cursor",
      captureAvailable: false,
      logSource: "terminal",
      nextOffset: 0,
    });
    const page = await get(detailUrl);
    expect(page.statusCode).toBe(200);
    expect(page.payload.match(/data-log-notice/g)).toHaveLength(1);
    expect(page.payload).toContain("출력은 시작한 터미널에서 확인하세요.");
    expect(page.payload).not.toContain("MCP process_start로 실행하면");
    expect(page.payload).toMatch(/data-live-log[^>]*><\/pre>/);
    for (let poll = 0; poll < 3; poll += 1) {
      const idle = await get(
        detailUrl + "/live?cursor=terminal-cursor&status=" + process.status,
      );
      expect(idle.statusCode).toBe(204);
      expect(idle.payload).toBe("");
    }
    process.status = "stopped";
    const stopped = await get(
      detailUrl + "/live?cursor=terminal-cursor&status=running",
    );
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      output: "",
      cursor: "terminal-cursor",
      more: false,
      process: { status: "stopped" },
    });
  });

  it("rejects unauthenticated and non-admin live requests before runner access", async () => {
    const { app, users, admin, dataDir, ipc, get, detailUrl } = await fixture();
    const anonymous = await get(detailUrl + "/live", "");
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers.location).toBeUndefined();
    expect(ipc).not.toHaveBeenCalled();

    const regular = await pendingAccount(users, dataDir, "regular");
    await users.update(admin.id, regular.id, {
      role: "user",
      status: "active",
    });
    const regularCookie = await login(users, regular.username);
    const denied = await get(detailUrl + "/live", regularCookie);
    expect(denied.statusCode).toBe(403);
    expect(ipc).not.toHaveBeenCalled();
  });

  it("reads only the requested owner's process and refuses missing owners or processes before logs", async () => {
    const { users, admin, dataDir, ipc, state, process, get } = await fixture();
    const owner = await pendingAccount(users, dataDir, "alice");
    const url = "/admin/processes/" + owner.id + "/" + process.id + "/live";
    const response = await get(url);
    expect(response.statusCode).toBe(200);
    expect(ipc.mock.calls.map(([method]) => method)).toEqual([
      "process_list",
      "process_logs",
    ]);
    for (const [index, call] of ipc.mock.calls.entries()) {
      expect(call[2]).toBe("admin:" + admin.id + ":owner:" + owner.id);
      expect(ipc.mock.contexts[index]).toEqual(
        expect.objectContaining({
          socketPath: path.join(dataDir, "runners", owner.id, "runner.sock"),
        }),
      );
    }

    ipc.mockClear();
    expect(
      (await get("/admin/processes/missing-owner/" + process.id + "/live"))
        .statusCode,
    ).toBe(404);
    expect(ipc).not.toHaveBeenCalled();

    state.processes = success({ processes: [] });
    expect((await get(url)).statusCode).toBe(404);
    expect(ipc.mock.calls.map(([method]) => method)).toEqual(["process_list"]);
  });

  it("forwards cursors and returns empty EOF polls and the final output after exit without caching", async () => {
    const { get, state, process, ipc, detailUrl } = await fixture();
    const pages = [
      {
        input: "start/&?=",
        cursor: "chunk-end",
        output: "first chunk\n",
        more: true,
        status: "running",
      },
      {
        input: "chunk-end",
        cursor: "chunk-end",
        output: "",
        more: false,
        status: "running",
      },
      {
        input: "chunk-end",
        cursor: "final-end",
        output: "last line\n",
        more: false,
        status: "exited",
      },
    ];
    for (const page of pages) {
      state.processes = success({
        processes: [{ ...process, status: page.status }],
      });
      state.logs = success(
        { output: page.output, cursor: page.cursor },
        { truncated: page.more },
      );
      const response = await get(
        detailUrl + "/live?cursor=" + encodeURIComponent(page.input),
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json()).toEqual({
        process: {
          status: page.status,
          statusLabel: page.status === "running" ? "실행 중" : "완료",
          exitLabel: page.status === "running" ? "실행 중" : "확인 불가",
        },
        logNotice:
          "표준 출력·표준 오류를 표시합니다. 파일로 보낸 출력은 실행할 때 로그 파일을 지정해야 표시됩니다.",
        output: page.output,
        cursor: page.cursor,
        more: page.more,
      });
      expect(ipc).toHaveBeenLastCalledWith(
        "process_logs",
        { process_id: process.id, cursor: page.input },
        expect.any(String),
        { timeoutMs: 5000 },
      );
    }
  });

  it("keeps older runners usable at EOF by building a v1 cursor from nextOffset", async () => {
    const { get, state, process, detailUrl } = await fixture();
    for (const nextOffset of [0, 37]) {
      state.logs = success({ output: "", nextOffset });
      const response = await get(detailUrl + "/live");
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        JSON.parse(Buffer.from(body.cursor, "base64url").toString()),
      ).toEqual({
        v: 1,
        kind: "process-log",
        id: process.id,
        offset: nextOffset,
      });
      expect(body.more).toBe(false);
      const initial = await get(detailUrl);
      expect(initial.payload).toContain('data-cursor="' + body.cursor + '"');
    }

    state.logs = success(
      { output: "old chunk", nextOffset: 37 },
      { truncated: true, continuation: "old-runner-continuation" },
    );
    expect((await get(detailUrl + "/live")).json()).toMatchObject({
      cursor: "old-runner-continuation",
      more: true,
    });
  });

  it("escapes initial command and log text and exposes the incremental cursor", async () => {
    const { get, state, detailUrl } = await fixture();
    state.logs = success(
      { output: '<script>log</script> & "quoted"', cursor: "cursor-next" },
      { truncated: true, continuation: "cursor-next" },
    );
    const response = await get(detailUrl);
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain(
      "echo &lt;script&gt;command&lt;/script&gt;",
    );
    expect(response.payload).toContain(
      "&lt;script&gt;log&lt;/script&gt; &amp;",
    );
    expect(response.payload).not.toContain("<script>log</script>");
    expect(response.payload).not.toContain("<script>command</script>");
    expect(response.payload).toContain(
      'data-live-log data-cursor="cursor-next"',
    );
    expect(response.payload).toContain(
      'data-live-process="' + detailUrl + '/live"',
    );
    expect(response.payload).toContain('data-live-running="true"');
    expect(response.payload).toContain('data-live-more="true"');
    expect(response.payload).toContain("data-process-status");
    expect(response.payload).toContain("data-process-stop");
    expect(response.payload).toContain("data-live-next");
  });

  it("keeps transient read failures out of log text and accepts a later successful read", async () => {
    const { get, state, detailUrl } = await fixture();
    state.logs = fail("RUNNER_TIMEOUT", "Temporary <runner> error");
    const initial = await get(detailUrl);
    expect(initial.statusCode).toBe(200);
    expect(initial.payload).toContain("Temporary &lt;runner&gt; error");
    expect(initial.payload).toContain("data-log-error");
    expect(initial.payload).toMatch(/<pre[^>]*data-live-log[^>]*><\/pre>/);
    expect(initial.payload).toContain('data-live-more="true"');

    const failed = await get(detailUrl + "/live?cursor=last-good");
    expect(failed.statusCode).toBe(503);
    expect(failed.headers["cache-control"]).toBe("private, no-store");

    state.logs = success({ output: "recovered\n", cursor: "after-recovery" });
    const recovered = await get(detailUrl + "/live?cursor=last-good");
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      output: "recovered\n",
      cursor: "after-recovery",
      more: false,
    });
  });

  it("rejects unavailable runners and malformed log pages without treating them as successful updates", async () => {
    const { get, state, ipc, detailUrl } = await fixture();
    state.processes = fail("RUNNER_UNAVAILABLE", "Unavailable");
    expect((await get(detailUrl + "/live")).statusCode).toBe(503);
    expect(ipc.mock.calls.map(([method]) => method)).toEqual(["process_list"]);

    state.processes = success({
      processes: [{ id: "process-a", status: "running" }],
    });
    for (const data of [{ output: "no cursor" }, { cursor: "no-output" }]) {
      state.logs = success(data);
      expect((await get(detailUrl + "/live")).statusCode).toBe(502);
    }
  });

  it("enables same-origin update hooks only on process and runner views and serves their script", async () => {
    const { get, admin, detailUrl } = await fixture();
    for (const [url, hook] of [
      ["/admin/processes", 'data-live-region="processes"'],
      ["/admin/runners", 'data-live-region="runners"'],
      ["/admin/runners/" + admin.id, 'data-live-region="runner-state"'],
      [detailUrl, "data-live-log"],
    ]) {
      const response = await get(url!);
      expect(response.statusCode).toBe(200);
      expect(response.payload).toContain('src="/assets/live-updates.js" defer');
      expect(response.payload).toContain("data-live-page");
      expect(response.payload).toContain(hook!);
      expect(response.headers["content-security-policy"]).toContain(
        "connect-src 'self'",
      );
      expect(response.payload).not.toContain("자동 갱신");
    }
    const dashboard = await get("/admin");
    expect(dashboard.payload).not.toContain("live-updates.js");
    expect(dashboard.payload).not.toContain("data-live-page");
    const asset = await get("/assets/live-updates.js", "");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");
  });
});
