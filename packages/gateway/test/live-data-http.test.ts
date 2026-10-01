import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { AuditLogger } from "../src/audit.ts";
import type { IpcClient } from "../src/ipc-client.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-live-data-"));
  directories.push(dataDir);
  const users = new UserStore(dataDir, "unused-fixture-hash");
  const admin = (await users.list())[0]!;
  const session = await users.createSession(admin);
  const pending = (
    await users.googleAccount(
      { sub: "second", email: "second@example.test" },
      true,
    )
  ).user;
  const other = await users.update(admin.id, pending.id, {
    role: "admin",
    status: "active",
  });
  const otherSession = await users.createSession(other);
  const processes = [
    {
      id: "process-1",
      command: "echo <script>untrusted</script>",
      status: "running",
      pid: 11,
      projectId: "project-1",
      startedAt: "2026-10-01T01:00:00Z",
    },
  ];
  const projects = [
    {
      id: "project-1",
      name: "example",
      relativePath: "example",
      createdAt: "2026-10-01T00:00:00Z",
    },
  ];
  const logs = { output: "", cursor: "last-cursor" };
  const call = vi.fn(async (method: string) => {
    const data =
      method === "process_list"
        ? { processes }
        : method === "project_list"
          ? { projects }
          : method === "process_logs"
            ? logs
            : undefined;
    if (!data) {
      throw new Error("Unexpected method");
    }
    return { ok: true, truncated: false, data };
  });
  const runnerStatusDir = path.join(dataDir, "status");
  await mkdir(runnerStatusDir);
  const observation = {
    state: "running",
    observedAt: Date.now(),
    cpus: 2,
    memoryMiB: 512,
    network: true,
  };
  const saveObservation = () =>
    writeFile(
      path.join(runnerStatusDir, "status.json"),
      JSON.stringify({ entries: { [admin.id]: observation } }),
    );
  await saveObservation();
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      runnerSocket: path.join(dataDir, "runner.sock"),
      runnerStatusDir,
      adminPasswordHash: "unused-fixture-hash",
    },
    { users, ipc: { call } as unknown as IpcClient },
  );
  const get = (url: string, token = session.token) =>
    inject(app, {
      method: "GET",
      url,
      headers: {
        accept: "application/json",
        ...(token ? { cookie: "__Host-dev-mcp-session=" + token } : {}),
      },
    });
  const audit = new AuditLogger(dataDir);
  const record = (suffix: string, extra = {}) =>
    audit.write({
      at: new Date().toISOString(),
      event: "tool_call",
      actor: admin.id,
      userId: admin.id,
      tool: "process_start",
      processId: "process-1",
      reason: "inspect " + suffix,
      params: { command: "a private long command " + suffix },
      ...extra,
    });
  return {
    app,
    session,
    users,
    admin,
    otherSession,
    get,
    processes,
    projects,
    logs,
    call,
    record,
    observation,
    saveObservation,
  };
}

describe("data-only management polling", () => {
  it("retires already-open HTML pollers without blocking normal page navigation", async () => {
    const h = await fixture();
    for (const url of [
      "/admin/runners",
      "/admin/runners/" + h.admin.id,
      "/admin/processes",
      "/admin/audit",
    ]) {
      const old = await inject(h.app, {
        method: "GET",
        url,
        headers: {
          cookie: "__Host-dev-mcp-session=" + h.session.token,
          accept: "text/html",
          "sec-fetch-dest": "empty",
        },
      });
      expect(old.statusCode).toBe(409);
      expect(old.json()).toEqual({ error: "refresh_required" });
      expect(old.rawPayload.byteLength).toBeLessThan(50);
      const page = await h.get(url);
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
    }
  });

  it("sends only changed process rows, no layout, and empty bodies for idle polls", async () => {
    const h = await fixture();
    const initial = await h.get("/admin/processes/live");
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["content-type"]).toContain("application/json");
    expect(initial.headers["cache-control"]).toBe("private, no-store");
    const first = initial.json();
    expect(first.kind).toBe("processes");
    expect(first.reset).toBe(true);
    expect(first.changes["row:process-1"].command).toBe(
      h.processes[0]!.command,
    );
    expect(initial.payload).not.toContain("<html");
    expect(initial.payload).not.toContain("<table");
    expect(JSON.stringify(first.changes.pagination)).not.toContain("/live");
    const idle = await h.get("/admin/processes/live?since=" + first.revision);
    expect(idle.statusCode).toBe(204);
    expect(idle.payload).toBe("");
    h.processes[0]!.status = "exited";
    const changed = (
      await h.get("/admin/processes/live?since=" + first.revision)
    ).json();
    expect(changed.reset).toBe(false);
    expect(Object.keys(changed.changes)).toEqual(["row:process-1"]);
    expect(changed.changes["row:process-1"].status).toBe("exited");
    h.processes.pop();
    const removed = (
      await h.get("/admin/processes/live?since=" + changed.revision)
    ).json();
    expect(removed.removed).toEqual(["row:process-1"]);
    expect(removed.changes.order).toEqual([]);
  });

  it("scopes baselines to the authenticated administrator and active filters and rechecks auth before cache access", async () => {
    const h = await fixture();
    const initial = (await h.get("/admin/runners/live")).json();
    expect(initial.changes["row:" + h.admin.id]).not.toHaveProperty("projects");
    expect(
      (
        await h.get(
          "/admin/runners/live?since=" + initial.revision,
          h.otherSession.token,
        )
      ).json().reset,
    ).toBe(true);
    expect(
      (
        await h.get("/admin/runners/live?q=absent&since=" + initial.revision)
      ).json(),
    ).toMatchObject({ reset: true, changes: { order: [] } });
    expect((await h.get("/admin/runners/live?since=invalid")).statusCode).toBe(
      400,
    );
    h.call.mockClear();
    for (const route of [
      "/admin/runners/live",
      "/admin/runners/" + h.admin.id + "/live",
      "/admin/processes/live",
      "/admin/audit/live",
      "/admin/audit/aaaaaaaaaaaaaaaaaaaa/live",
      "/admin/processes/" + h.admin.id + "/process-1/live",
    ]) {
      const denied = await h.get(route, "");
      expect(denied.statusCode).toBe(401);
      expect(denied.headers.location).toBeUndefined();
      expect(denied.headers["content-type"]).toContain("application/json");
    }
    expect(h.call).not.toHaveBeenCalled();
  });

  it("updates runner observations without resending projects, resource forms or account details", async () => {
    const h = await fixture();
    const url = "/admin/runners/" + h.admin.id + "/live";
    const initial = (await h.get(url)).json();
    expect(initial.changes.projects).toEqual([
      { id: "project-1", name: "example", relativePath: "example" },
    ]);
    expect(initial.changes).not.toHaveProperty("limits");
    expect(initial.changes).not.toHaveProperty("owner");
    h.observation.observedAt += 1000;
    await h.saveObservation();
    const changed = (await h.get(url + "?since=" + initial.revision)).json();
    expect(changed.reset).toBe(false);
    expect(changed.changes).toHaveProperty("observedDateTime");
    expect(changed.changes).not.toHaveProperty("projects");
    expect(changed.changes).not.toHaveProperty("observed");
  });

  it("keeps audit list summaries small and sends raw details once, with logs only on their cursor endpoint", async () => {
    const h = await fixture();
    await h.record("first", {
      params: { command: "large-log-test".repeat(1000) },
    });
    const first = (await h.get("/admin/audit/live")).json();
    const id = first.changes.order[0];
    expect(first.changes["row:" + id]).not.toHaveProperty("details");
    expect(first.changes["row:" + id]).not.toHaveProperty("source");
    expect(JSON.stringify(first).length).toBeLessThan(2000);
    const detailUrl = "/admin/audit/" + id + "/live";
    const detail = (await h.get(detailUrl)).json();
    expect(detail.changes.record.details).toContain("large-log-test");
    expect(detail.changes["process:process-1"]).not.toHaveProperty("output");
    expect(
      h.call.mock.calls.every(([method]) => method !== "process_logs"),
    ).toBe(true);
    expect(
      (await h.get(detailUrl + "?since=" + detail.revision)).statusCode,
    ).toBe(204);
    h.processes[0]!.status = "exited";
    const update = (
      await h.get(detailUrl + "?since=" + detail.revision)
    ).json();
    expect(Object.keys(update.changes)).toEqual(["process:process-1"]);
    expect(JSON.stringify(update).length).toBeLessThan(1000);
    await h.record("second");
    const listUpdate = (
      await h.get("/admin/audit/live?since=" + first.revision)
    ).json();
    expect(
      Object.keys(listUpdate.changes).filter((key) => key.startsWith("row:")),
    ).toHaveLength(1);
    expect(listUpdate.changes).not.toHaveProperty("row:" + id);
    expect(JSON.stringify(listUpdate.changes.pagination)).not.toContain(
      "since=",
    );
  });

  it("omits idle log bodies while still delivering status transitions and new bytes", async () => {
    const h = await fixture();
    const url =
      "/admin/processes/" +
      h.admin.id +
      "/process-1/live?cursor=last-cursor&status=running";
    const idle = await h.get(url);
    expect(idle.statusCode).toBe(204);
    expect(idle.payload).toBe("");
    h.processes[0]!.status = "exited";
    expect((await h.get(url)).json().process.status).toBe("exited");
    h.logs.output = "a new final line\n";
    h.logs.cursor = "next-cursor";
    const next = await h.get(url);
    expect(next.statusCode).toBe(200);
    expect(next.json().output).toBe("a new final line\n");
  });
});
