import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { AuditLogger } from "../src/audit.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { fail, type ToolResult } from "../src/protocol.ts";
import { UserStore } from "../src/user-store.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";

const temporary: string[] = [];
const password = "a-long-audit-test-password";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function success(data: unknown, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, data, truncated: false, ...extra };
}

function logBlocks(html: string): string[] {
  return Array.from(
    html.matchAll(
      /<pre\b[^>]*class="[^"]*\blog-output\b[^"]*"[^>]*>([\s\S]*?)<\/pre>/g,
    ),
    (match) => match[1]!,
  );
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-audit-live-"));
  temporary.push(dataDir);
  const users = new UserStore(dataDir);
  const admin = await adminAccount(users, dataDir);
  const owner = await pendingAccount(users, dataDir, "audit-owner");
  await users.update(admin.id, owner.id, { status: "active", role: "user" });
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
    logs: success({
      output: "<script>runner output</script>\n",
      cursor: "cursor-first",
    }),
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
      throw new Error("Unexpected runner method: " + method);
    });
  const cookie =
    "__Host-dev-mcp-session=" + (await users.createSession(admin)).token;
  const get = (url: string, selectedCookie = cookie) =>
    inject(app, { method: "GET", url, headers: { cookie: selectedCookie } });
  const audit = new AuditLogger(dataDir);
  const write = async (event: Record<string, unknown> = {}) => {
    await audit.write({
      at: "2026-10-01T10:00:00.000Z",
      event: "mcp_tool",
      actor: admin.id,
      userId: owner.id,
      tool: "process_start",
      processId: process.id,
      ...event,
    });
    const entry = (await audit.recent()).records[0]!;
    return createHash("sha256")
      .update(JSON.stringify(entry))
      .digest("base64url")
      .slice(0, 20);
  };
  return { app, users, admin, owner, dataDir, process, state, ipc, get, write };
}

describe("inline audit details and live updates over HTTP", () => {
  it("shows escaped tool reasons in the list, makes them searchable, and preserves the full reason in inline and no-JavaScript details", async () => {
    const { get, write, ipc } = await fixture();
    const reason =
      (
        '실패 원인 <script>alert("reason")</script> & 입력값을 확인합니다. ' +
        "공유 신호의 재현 경로와 실행 결과를 비교합니다. ".repeat(20)
      ).slice(0, 490) + " 마지막검증지점끝";
    const id = await write({ event: "tool_call", reason });
    const list = await get(
      "/admin/audit?q=" + encodeURIComponent("마지막검증지점끝"),
    );
    expect(list.statusCode).toBe(200);
    expect(ipc).not.toHaveBeenCalled();
    const row = new RegExp(
      `<tr\\b[^>]*id="audit-row-${id}"[^>]*>([\\s\\S]*?)<\\/tr>`,
    ).exec(list.payload)?.[1];
    expect(row).toContain('<code class="audit-tool">process_start</code>');
    expect(row).toContain('<p class="audit-reason">');
    expect(row).toContain("&lt;script&gt;alert(&quot;reason&quot;)");
    expect(row).toContain("마지막검증지점끝");
    expect(row).not.toContain("<script>");
    expect(row).toContain(`aria-controls="audit-detail-${id}"`);
    expect(row).toContain('aria-expanded="false"');
    for (const url of [
      `/admin/audit/${id}/detail`,
      `/admin/audit?detail=${id}`,
    ]) {
      const detail = await get(url);
      expect(detail.statusCode).toBe(200);
      const reasonSection =
        /<section class="audit-reason-section">([\s\S]*?)<\/section>/.exec(
          detail.payload,
        )?.[1];
      expect(reasonSection).toContain("작업 이유");
      expect(reasonSection).toContain(
        "&lt;script&gt;alert(&quot;reason&quot;)",
      );
      expect(reasonSection).toContain("마지막검증지점끝");
      expect(reasonSection).not.toContain("<script>");
      expect(detail.payload).toContain("&quot;reason&quot;:");
    }
  });

  it("omits reason UI for legacy, blank and malformed records without inventing a reason from tool parameters", async () => {
    const { get, write } = await fixture();
    for (const reason of [undefined, null, "", "   ", 42, { note: "legacy" }]) {
      const id = await write({
        event: "tool_call",
        reason,
        tool: "project_list",
        processId: undefined,
        params: { reason: "legacy parameter is not a recorded reason" },
      });
      const detail = await get(`/admin/audit/${id}/detail`);
      expect(detail.statusCode).toBe(200);
      expect(detail.payload).not.toContain('class="audit-reason-section"');
    }
    const list = await get("/admin/audit");
    expect(list.payload).toContain(
      '<code class="audit-tool">project_list</code>',
    );
    expect(list.payload).not.toContain('class="audit-reason"');
  });

  it("requires an admin session before any runner access", async () => {
    const { get, write, ipc, users, owner } = await fixture();
    const id = await write();
    const anonymous = await get(`/admin/audit/${id}/detail`, "");
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe("/login");
    const activeOwner = (await users.get(owner.id))!;
    const cookie =
      "__Host-dev-mcp-session=" +
      (await users.createSession(activeOwner)).token;
    for (const suffix of ["", "?metadata=1"]) {
      expect(
        (await get(`/admin/audit/${id}/detail${suffix}`, cookie)).statusCode,
      ).toBe(403);
    }
    expect(ipc).not.toHaveBeenCalled();
  });

  it("renders escaped fragments and loads only the audited owner's process logs", async () => {
    const { get, write, ipc, admin, owner, dataDir, process } = await fixture();
    const id = await write({
      params: { command: '<img src=x onerror="audit()">' },
    });
    const detail = await get(`/admin/audit/${id}/detail?owner=${admin.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers["content-type"]).toContain("text/html");
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(detail.payload).not.toMatch(
      /<!doctype|<html\b|aria-label="관리 메뉴"/i,
    );
    expect(detail.payload).toContain("&lt;img");
    expect(detail.payload).toContain("&lt;script&gt;command&lt;/script&gt;");
    expect(logBlocks(detail.payload)).toEqual([
      "&lt;script&gt;runner output&lt;/script&gt;\n",
    ]);
    expect(detail.payload).not.toContain("<script>");
    expect(detail.payload).toContain("data-audit-fragment");
    expect(detail.payload).toContain("data-audit-processes");
    expect(detail.payload).toContain(`data-audit-process="${process.id}"`);
    expect(detail.payload).toContain("data-audit-process-header");
    expect(detail.payload).toContain('data-running="true"');
    expect(detail.payload).toContain(
      `/admin/processes/${owner.id}/${process.id}/live`,
    );
    expect(detail.payload).toContain('data-cursor="cursor-first"');
    expect(ipc.mock.calls.map(([method]) => method)).toEqual([
      "process_list",
      "process_logs",
    ]);
    expect(ipc).toHaveBeenCalledWith(
      "process_logs",
      { process_id: process.id, max_bytes: 16 * 1024 },
      `admin:${admin.id}:owner:${owner.id}`,
      { timeoutMs: 5000 },
    );
    for (const context of ipc.mock.contexts) {
      expect(context).toMatchObject({
        socketPath: path.join(dataDir, "runners", owner.id, "runner.sock"),
      });
    }
  });

  it("finds selected records beyond the visible page and independently of list filters", async () => {
    const { get, write } = await fixture();
    const id = await write({
      event: "older-process-event",
      at: "2026-09-01T00:00:00.000Z",
    });
    for (let index = 0; index < 30; index += 1) {
      await write({
        event: "newer-event",
        message: String(index),
        processId: undefined,
        tool: undefined,
      });
    }
    const firstPage = await get("/admin/audit");
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.payload).not.toContain(`id="audit-row-${id}"`);
    const filteredDetail = await get(
      `/admin/audit/${id}/detail?q=newer&event=newer-event&page=1`,
    );
    expect(filteredDetail.statusCode).toBe(200);
    expect(filteredDetail.payload).toContain("older-process-event");
    expect(logBlocks(filteredDetail.payload)).toHaveLength(1);
  });

  it("rejects unknown IDs before IPC and does not guess a missing owner's runner", async () => {
    const { get, write, ipc } = await fixture();
    for (const id of ["missing", "A".repeat(20), "%3Cscript%3E"]) {
      expect((await get(`/admin/audit/${id}/detail`)).statusCode).toBe(404);
    }
    expect(ipc).not.toHaveBeenCalled();
    const deletedOwner = await write({ userId: "deleted-user" });
    const detail = await get(`/admin/audit/${deletedOwner}/detail`);
    expect(detail.statusCode).toBe(200);
    expect(detail.payload).toContain("소유 사용자를 확인할 수 없습니다");
    expect(ipc).not.toHaveBeenCalled();
  });

  it("renders immutable events and malformed audit parameters without runner requests", async () => {
    const { get, write, ipc } = await fixture();
    for (const params of [
      "<script>not an object</script>",
      ["process_id", "process-a"],
      null,
      { command: "<img src=x onerror=bad()>" },
    ]) {
      const id = await write({
        event: "<script>event</script>",
        actor: "<img src=x onerror=actor()>",
        processId: undefined,
        tool: undefined,
        params,
      });
      const detail = await get(`/admin/audit/${id}/detail`);
      expect(detail.statusCode).toBe(200);
      expect(detail.payload).toContain("&lt;script&gt;event&lt;/script&gt;");
      expect(detail.payload).not.toContain("<script>");
      expect(detail.payload).not.toContain("<img");
      expect(logBlocks(detail.payload)).toHaveLength(0);
    }
    expect(ipc).not.toHaveBeenCalled();
  });

  it("refreshes related process metadata without rereading initial logs", async () => {
    const { get, write, ipc, state, process } = await fixture();
    const id = await write();
    state.processes = success({
      processes: [{ ...process, status: "exited", exitCode: 0 }],
    });
    const metadata = await get(`/admin/audit/${id}/detail?metadata=1`);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers["cache-control"]).toBe("no-store");
    expect(metadata.payload).toContain(process.id);
    expect(metadata.payload).toContain("완료");
    expect(metadata.payload).toContain('data-running="false"');
    expect(metadata.payload).not.toContain("runner output");
    expect(ipc.mock.calls.map(([method]) => method)).toEqual(["process_list"]);
  });

  it("keeps failed or empty log placeholders outside actual log output", async () => {
    const { get, write, state } = await fixture();
    const id = await write();
    state.logs = fail("RUNNER_UNAVAILABLE", "<script>log unavailable</script>");
    const failed = await get(`/admin/audit/${id}/detail`);
    expect(failed.statusCode).toBe(200);
    expect(failed.payload).toContain(
      "&lt;script&gt;log unavailable&lt;/script&gt;",
    );
    expect(logBlocks(failed.payload)).toEqual([""]);
    state.logs = success({ output: "", nextOffset: 0 });
    const empty = await get(`/admin/audit/${id}/detail`);
    expect(empty.statusCode).toBe(200);
    expect(logBlocks(empty.payload)).toEqual([""]);
    const cursor = /data-cursor="([^"]+)"/.exec(empty.payload)?.[1];
    expect(cursor).toBeTruthy();
    expect(
      JSON.parse(Buffer.from(cursor!, "base64url").toString("utf8")),
    ).toEqual({
      v: 1,
      kind: "process-log",
      id: "process-a",
      offset: 0,
    });
  });

  it("opts into audit updates and preserves filters and server-rendered detail links", async () => {
    const { get, write, ipc } = await fixture();
    const id = await write({ event: "selected-event", message: "needle" });
    const list = await get(
      "/admin/audit?q=needle&event=selected-event&sort=event&direction=asc",
    );
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.headers["content-security-policy"]).toContain(
      "connect-src 'self'",
    );
    expect(list.payload).toContain("data-live-audit");
    expect(list.payload).toContain('src="/assets/audit-updates.js" defer');
    expect(list.payload).not.toContain('src="/assets/live-updates.js"');
    expect(list.payload).not.toContain("자동 갱신 중");
    expect(list.payload).not.toContain('class="audit-detail-panel"');
    expect(ipc).not.toHaveBeenCalled();
    const row = new RegExp(
      `<tr\\b[^>]*id="audit-row-${id}"[^>]*>([\\s\\S]*?)<\\/tr>`,
    ).exec(list.payload)?.[1];
    const encodedHref = /<a\b[^>]*href="([^"]+)"/.exec(row ?? "")?.[1];
    expect(encodedHref).toBeTruthy();
    const href = encodedHref!.replaceAll("&amp;", "&");
    const url = new URL(href, "https://dev.example.test");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "needle",
      event: "selected-event",
      sort: "event",
      direction: "asc",
      detail: id,
    });
    const fallback = await get(url.pathname + url.search);
    expect(fallback.statusCode).toBe(200);
    expect(fallback.payload).toContain(`id="audit-detail-${id}"`);
    expect(fallback.payload).toContain('aria-expanded="true"');
    expect(fallback.payload).toContain("연관 프로세스·작동 로그");
    expect(logBlocks(fallback.payload)).toEqual([
      "&lt;script&gt;runner output&lt;/script&gt;\n",
    ]);
    const script = await get("/assets/audit-updates.js");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("javascript");
  });
});
