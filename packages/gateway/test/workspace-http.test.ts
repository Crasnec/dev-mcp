import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { AuditLogger } from "../src/audit.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { fail, type ToolResult } from "../src/protocol.ts";
import { UserStore, type User } from "../src/user-store.ts";
import { adminAccount } from "./accounts.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const success = (data: unknown): ToolResult => ({
  ok: true,
  data,
  truncated: false,
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-workspace-http-"));
  directories.push(dataDir);
  const users = new UserStore(dataDir);
  const admin = await adminAccount(users, dataDir);
  async function account(name: string) {
    const pending = (
      await users.googleAccount(
        { sub: "workspace-" + name, email: name + "@example.test" },
        true,
      )
    ).user;
    return users.update(admin.id, pending.id, {
      role: "user",
      status: "active",
    });
  }
  const alice = await account("alice");
  const bob = await account("bob");
  const sessions = new Map(
    await Promise.all(
      [admin, alice, bob].map(
        async (owner) => [owner.id, await users.createSession(owner)] as const,
      ),
    ),
  );
  const states = new Map(
    [admin, alice, bob].map((owner) => [
      owner.id,
      {
        project: {
          id: "project-" + owner.id,
          name: "Project " + owner.email,
          relativePath: "work/" + owner.id,
        },
        process: {
          id: "process-" + owner.id,
          projectId: "project-" + owner.id,
          command: "echo <" + owner.email + ">",
          status: "running",
          pid: 4321,
          startedAt: "2026-10-01T10:00:00Z",
        },
        output: "private output for " + owner.email + "\n",
        cursor: "cursor-" + owner.id,
      },
    ]),
  );
  const calls: Array<{
    ownerId: string;
    method: string;
    params: Record<string, unknown>;
    actor: string;
  }> = [];
  const ipc = vi
    .spyOn(IpcClient.prototype, "call")
    .mockImplementation(async function (
      this: IpcClient,
      method,
      params,
      actor,
    ) {
      const socketPath = (this as unknown as { socketPath: string }).socketPath;
      // The administrator's runner is reached like every other account's.
      const owner = [admin, alice, bob].find(
        (entry) =>
          socketPath === path.join(dataDir, "runners", entry.id, "runner.sock"),
      );
      if (!owner) {
        throw new Error("Unexpected runner socket: " + socketPath);
      }
      calls.push({ ownerId: owner.id, method, params, actor });
      const state = states.get(owner.id)!;
      switch (method) {
        case "development_status":
          return success({ githubInstalled: true, githubConnected: false });
        case "project_list":
          return success({ projects: [state.project] });
        case "project_register":
          return success({ ...state.project, name: params.name });
        case "project_unregister":
        case "project_delete":
          return params.project_id === state.project.id
            ? success({ removed: true })
            : fail("NOT_FOUND", "Project not found");
        case "git_read":
          return params.project_id === state.project.id
            ? success({ output: "git status for " + owner.email })
            : fail("NOT_FOUND", "Project not found");
        case "process_list":
          return success({ processes: [state.process] });
        case "process_start":
          return params.project_id === state.project.id
            ? success({
                process: {
                  ...state.process,
                  id: "started-" + owner.id,
                  command: params.command,
                },
              })
            : fail("NOT_FOUND", "Project not found");
        case "process_stop":
          return params.process_id === state.process.id
            ? success({ stopped: true })
            : fail("NOT_FOUND", "Process not found");
        case "process_logs":
          if (
            params.process_id !== state.process.id ||
            (params.cursor && params.cursor !== state.cursor)
          ) {
            return fail(
              "INVALID_CURSOR",
              "Cursor does not belong to this process",
            );
          }
          return success({
            output: params.cursor ? "" : state.output,
            cursor: state.cursor,
          });
        default:
          throw new Error("Unexpected runner method: " + method);
      }
    });
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      userRunnerSocketDir: path.join(dataDir, "runners"),
      runnerStatusDir: path.join(dataDir, "status"),
      google: { clientId: "fixture-google", clientSecret: "fixture-secret" },
    },
    { users },
  );
  const cookie = (owner: User | undefined) =>
    owner ? "__Host-dev-mcp-session=" + sessions.get(owner.id)!.token : "";
  const get = (url: string, owner: User | undefined = alice) =>
    inject(app, { method: "GET", url, headers: { cookie: cookie(owner) } });
  const post = (
    url: string,
    values: Record<string, string> | URLSearchParams = {},
    owner: User | undefined = alice,
    options: { csrf?: string; origin?: string } = {},
  ) => {
    const payload = new URLSearchParams(values);
    if (!payload.has("csrf")) {
      payload.set(
        "csrf",
        options.csrf ?? (owner ? sessions.get(owner.id)!.csrf : ""),
      );
    }
    return inject(app, {
      method: "POST",
      url,
      headers: {
        cookie: cookie(owner),
        origin: options.origin ?? "https://dev.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: payload.toString(),
    });
  };
  const audit = new AuditLogger(dataDir);
  const write = async (value: Record<string, unknown>) => {
    await audit.write({ at: "2026-10-01T10:00:00Z", ...value });
    const record = (await audit.recent()).records[0]!;
    return createHash("sha256")
      .update(JSON.stringify(record))
      .digest("base64url")
      .slice(0, 20);
  };
  const clear = () => {
    calls.length = 0;
    ipc.mockClear();
  };
  return {
    app,
    users,
    admin,
    alice,
    bob,
    sessions,
    states,
    calls,
    ipc,
    get,
    post,
    write,
    audit,
    clear,
  };
}

describe("ordinary-user workspace authorization", () => {
  it("serves own projects, process logs and a read-only runner with account-only navigation", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    for (const url of [
      "/account/projects",
      `/account/projects/${h.alice.id}/${own.project.id}`,
      "/account/processes",
      `/account/processes/${h.alice.id}/${own.process.id}`,
      `/account/runners/${h.alice.id}`,
    ]) {
      const response = await h.get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.payload).not.toMatch(
        /(?:href|action|data-live-url)="\/admin(?:\/|["?])/,
      );
      expect(response.payload).not.toContain(h.bob.id);
      expect(response.payload).not.toContain(h.bob.email);
    }
    const runner = await h.get(`/account/runners/${h.alice.id}`);
    expect(runner.payload).not.toContain('name="memoryMiB"');
    expect(runner.payload).not.toContain('/operations"');
    const redirect = await h.get("/account/runners");
    expect(redirect.statusCode).toBe(303);
    expect(redirect.headers.location).toBe(`/account/runners/${h.alice.id}`);
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((call) => call.ownerId === h.alice.id)).toBe(true);
  });

  it("denies anonymous and ordinary access to administrative and global routes before IPC", async () => {
    const h = await fixture();
    for (const url of [
      "/admin",
      "/admin/users",
      "/admin/projects",
      "/admin/processes/live",
      "/admin/runners/live",
      "/admin/audit/live",
      "/admin/settings",
      "/admin/connections",
      "/admin/telemetry?scope=host&stream=1",
    ]) {
      expect((await h.get(url)).statusCode, url).toBe(403);
    }
    for (const url of [
      "/account/processes/live",
      `/account/runners/${h.alice.id}/live`,
      "/account/audit/live",
    ]) {
      const response = await inject(h.app, { method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.headers.location).toBeUndefined();
    }
    for (const url of [
      "/account/users",
      "/account/settings",
      "/account/connections",
      `/account/runners/${h.alice.id}/operations`,
    ]) {
      const response = url.endsWith("/operations")
        ? await h.post(url, { action: "stop" })
        : await h.get(url);
      expect([403, 404]).toContain(response.statusCode);
    }
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("rejects foreign and ambiguous owner selectors before any runner access", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const foreign = h.states.get(h.bob.id)!;
    const routes = [
      `/account/projects?owner=${h.bob.id}`,
      `/account/projects?owner[]=${h.bob.id}`,
      `/account/processes/live?owner[id]=${h.bob.id}`,
      `/account/audit/live?scope[]=host`,
      `/account/processes?scope=host`,
      `/account/processes?owner=${h.bob.id}`,
      `/account/processes/live?owner=${h.bob.id}`,
      `/account/audit/live?owner=${h.bob.id}`,
      `/account/projects/${h.bob.id}/${foreign.project.id}`,
      `/account/processes/${h.bob.id}/${foreign.process.id}`,
      `/account/processes/${h.bob.id}/${foreign.process.id}/live?cursor=${foreign.cursor}`,
      `/account/runners/${h.bob.id}`,
      `/account/runners/${h.bob.id}/live`,
      `/account/projects?owner=${h.alice.id}&owner=${h.bob.id}`,
      `/account/processes/live?owner=${h.alice.id}&owner=${h.alice.id}`,
      `/account/processes/${h.alice.id}/${own.process.id}/live?owner=${h.bob.id}`,
    ];
    for (const url of routes) {
      const response = await h.get(url);
      expect([400, 403, 404], url).toContain(response.statusCode);
      expect(response.payload, url).not.toContain(foreign.output.trim());
    }
    expect(h.ipc).not.toHaveBeenCalled();
    for (const owner of [h.bob.id, `${h.alice.id}&owner=${h.bob.id}`]) {
      const values = new URLSearchParams(`owner=${owner}`);
      values.set("name", "Attacker project");
      values.set("relative_path", "work");
      expect([400, 403, 404]).toContain(
        (await h.post("/account/projects", values)).statusCode,
      );
      values.set("project_id", own.project.id);
      values.set("command", "true");
      expect([400, 403, 404]).toContain(
        (await h.post("/account/processes", values)).statusCode,
      );
    }
    for (const key of ["owner[]", "owner[id]", "scope", "scope[]"]) {
      const values = {
        [key]: h.bob.id,
        name: "Bad selector",
        relative_path: "work",
        project_id: own.project.id,
        command: "true",
      };
      expect([400, 403, 404]).toContain(
        (await h.post("/account/projects", values)).statusCode,
      );
      expect([400, 403, 404]).toContain(
        (await h.post("/account/processes", values)).statusCode,
      );
    }
    for (const route of [
      `/account/projects/${h.bob.id}/${foreign.project.id}/unregister`,
      `/account/projects/${h.bob.id}/${foreign.project.id}/delete`,
      `/account/processes/${h.bob.id}/${foreign.process.id}/stop`,
    ]) {
      expect([403, 404]).toContain(
        (await h.post(route, { confirmation: foreign.project.name }))
          .statusCode,
      );
    }
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("checks CSRF and Origin before every self-service mutation", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const actions: Array<[string, Record<string, string>]> = [
      ["/account/projects", { name: "Safe project", relative_path: "work" }],
      ["/account/processes", { project_id: own.project.id, command: "true" }],
      [`/account/projects/${h.alice.id}/${own.project.id}/unregister`, {}],
      [
        `/account/projects/${h.alice.id}/${own.project.id}/delete`,
        { confirmation: own.project.name },
      ],
      [`/account/processes/${h.alice.id}/${own.process.id}/stop`, {}],
    ];
    for (const [url, body] of actions) {
      expect(
        (await h.post(url, body, h.alice, { csrf: "wrong" })).statusCode,
        url,
      ).toBe(403);
      expect(
        (
          await h.post(url, body, h.alice, {
            origin: "https://attacker.example",
          })
        ).statusCode,
        url,
      ).toBe(403);
      const duplicate = new URLSearchParams(body);
      duplicate.append("csrf", h.sessions.get(h.alice.id)!.csrf);
      duplicate.append("csrf", h.sessions.get(h.alice.id)!.csrf);
      expect((await h.post(url, duplicate)).statusCode, url).toBe(403);
    }
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("never crosses runner boundaries for foreign object IDs or log cursors", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const foreign = h.states.get(h.bob.id)!;
    for (const url of [
      `/account/projects/${h.alice.id}/${foreign.project.id}`,
      `/account/processes/${h.alice.id}/${foreign.process.id}`,
      `/account/processes/${h.alice.id}/${foreign.process.id}/live?cursor=${foreign.cursor}`,
    ]) {
      expect((await h.get(url)).statusCode, url).toBe(404);
    }
    expect(
      h.calls.some((call) =>
        ["git_read", "process_logs"].includes(call.method),
      ),
    ).toBe(false);
    const cursor = await h.get(
      `/account/processes/${h.alice.id}/${own.process.id}/live?cursor=${foreign.cursor}`,
    );
    expect(cursor.statusCode).toBeGreaterThanOrEqual(400);
    expect(cursor.payload).not.toContain(foreign.output.trim());
    expect(h.calls.every((call) => call.ownerId === h.alice.id)).toBe(true);
    h.clear();
    const stop = await h.post(
      `/account/processes/${h.alice.id}/${foreign.process.id}/stop`,
    );
    expect(stop.statusCode).toBeGreaterThanOrEqual(400);
    expect(h.calls.every((call) => call.ownerId === h.alice.id)).toBe(true);
    expect(h.calls.some((call) => call.method === "process_stop")).toBe(false);
  });

  it("registers, starts and stops own work and records attributable workspace events", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const register = await h.post("/account/projects", {
      name: "New <project>",
      relative_path: "work/new",
    });
    expect(register.statusCode).toBe(303);
    expect(register.headers.location).toMatch(/^\/account\/projects/);
    expect(
      h.calls.find((call) => call.method === "project_register")?.params,
    ).toEqual({ name: "New <project>", relative_path: "work/new" });
    const start = await h.post("/account/processes", {
      project_id: own.project.id,
      command: "printf '<literal>'",
    });
    expect(start.statusCode).toBe(303);
    expect(start.headers.location).toBe(
      `/account/processes/${h.alice.id}/started-${h.alice.id}?saved=1`,
    );
    expect(
      h.calls.find((call) => call.method === "process_start")?.params,
    ).toMatchObject({
      project_id: own.project.id,
      command: "printf '<literal>'",
    });
    const stop = await h.post(
      `/account/processes/${h.alice.id}/${own.process.id}/stop`,
    );
    expect(stop.statusCode).toBe(303);
    expect(stop.headers.location).toMatch(/^\/account\/processes/);
    expect(h.calls.every((call) => call.ownerId === h.alice.id)).toBe(true);
    const records = (await h.audit.recent()).records;
    expect(records.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "workspace_project_registered",
        "workspace_process_started",
        "workspace_process_stopped",
      ]),
    );
    for (const record of records) {
      expect(record).toMatchObject({ actor: h.alice.id, userId: h.alice.id });
    }
    const page = await h.get("/account/audit");
    expect(page.statusCode).toBe(200);
    expect(page.payload).toContain("workspace_process_started");
    expect(page.payload).not.toMatch(/href="\/admin(?:\/|["?])/);
  });

  it("requires the project name before deletion and rejects invalid start fields without mutating", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const url = `/account/projects/${h.alice.id}/${own.project.id}`;
    expect(
      (await h.post(url + "/delete", { confirmation: "wrong" })).statusCode,
    ).toBe(400);
    expect(h.calls.some((call) => call.method === "project_delete")).toBe(
      false,
    );
    expect(
      (await h.post(url + "/delete", { confirmation: own.project.name }))
        .statusCode,
    ).toBe(303);
    expect((await h.post(url + "/unregister")).statusCode).toBe(303);
    for (const values of [
      { project_id: "", command: "true" },
      { project_id: own.project.id, command: "   " },
      { project_id: h.states.get(h.bob.id)!.project.id, command: "true" },
    ]) {
      const response = await h.post("/account/processes", values);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    const duplicate = new URLSearchParams({
      project_id: own.project.id,
      command: "true",
    });
    duplicate.append("project_id", own.project.id);
    expect([400, 404]).toContain(
      (await h.post("/account/processes", duplicate)).statusCode,
    );
    for (const values of [
      { project_id: own.project.id, command: "가".repeat(11000) },
      {
        project_id: own.project.id,
        command: "true",
        network_intent: "invalid",
      },
    ]) {
      expect((await h.post("/account/processes", values)).statusCode).toBe(400);
    }
    expect(h.calls.some((call) => call.method === "process_start")).toBe(false);
    expect(h.calls.every((call) => call.ownerId === h.alice.id)).toBe(true);
  });

  it("filters audit ownership before pagination/search and refuses foreign record details", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const ownId = await h.write({
      event: "tool_call",
      actor: h.alice.id,
      userId: h.alice.id,
      tool: "process_start",
      processId: own.process.id,
      reason: "OWN <literal reason>",
    });
    const adminActionId = await h.write({
      event: "admin_project_registered",
      actor: h.admin.id,
      userId: h.alice.id,
      reason: "OWN admin action",
    });
    const actorId = await h.write({
      event: "tool_call",
      actor: h.alice.id + ":client",
      tool: "project_list",
      reason: "OWN actor fallback",
    });
    let foreignId = "";
    for (let i = 0; i < 30; i++) {
      foreignId = await h.write({
        event: "foreign_event",
        actor: h.bob.id,
        userId: h.bob.id,
        reason: "FOREIGN SECRET " + i,
      });
    }
    await h.write({
      event: "foreign_event",
      actor: h.alice.id,
      userId: h.bob.id,
      reason: "FOREIGN owner takes priority",
    });
    await h.write({
      event: "global_event",
      actor: h.admin.id,
      params: { userId: h.alice.id },
      reason: "FOREIGN nested ID is not ownership",
    });
    const response = await h.get("/account/audit/live");
    expect(response.statusCode).toBe(200);
    expect(response.json().changes.order).toEqual(
      expect.arrayContaining([ownId, adminActionId, actorId]),
    );
    expect(response.json().changes.order).toHaveLength(3);
    expect(response.json().changes.pagination.total).toBe(3);
    expect(response.payload).not.toContain("FOREIGN");
    expect(response.payload).not.toContain(h.bob.id);
    const list = await h.get("/account/audit");
    expect(list.payload).not.toContain("foreign_event");
    expect(list.payload).not.toContain("FOREIGN");
    const search = await h.get("/account/audit/live?q=FOREIGN");
    expect(search.json().changes.order).toEqual([]);
    for (const suffix of ["/detail", "/live"]) {
      expect(
        (await h.get(`/account/audit/${foreignId}${suffix}`)).statusCode,
      ).toBe(404);
    }
    expect(h.ipc).not.toHaveBeenCalled();
    const ownDetail = await h.get(`/account/audit/${ownId}/live`);
    expect(ownDetail.statusCode).toBe(200);
    expect(ownDetail.json().changes.record.reason).toBe("OWN <literal reason>");
    expect(ownDetail.payload).not.toContain("/admin/");
    expect(h.calls.every((call) => call.ownerId === h.alice.id)).toBe(true);
  });

  it("scopes cached deltas to the authenticated owner and rechecks revoked sessions", async () => {
    const h = await fixture();
    const own = h.states.get(h.alice.id)!;
    const recordId = await h.write({
      event: "tool_call",
      actor: h.alice.id,
      userId: h.alice.id,
      tool: "process_start",
      processId: own.process.id,
    });
    const paths = [
      "/account/processes/live",
      `/account/runners/${h.alice.id}/live`,
      "/account/audit/live",
      `/account/audit/${recordId}/live`,
    ];
    const revisions = [];
    for (const url of paths) {
      const response = await h.get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-type"]).toContain("application/json");
      const revision = response.json().revision;
      expect(typeof revision).toBe("string");
      expect((await h.get(url + "?since=" + revision)).statusCode, url).toBe(
        204,
      );
      revisions.push(revision);
    }
    const other = await h.get(
      "/account/processes/live?since=" + revisions[0],
      h.bob,
    );
    expect(other.statusCode).toBe(200);
    expect(other.json().reset).toBe(true);
    expect(other.payload).not.toContain(own.process.id);
    const audit = await h.get(
      "/account/audit/live?since=" + revisions[2],
      h.bob,
    );
    expect(audit.json().changes.order).toEqual([]);
    expect(audit.payload).not.toContain(recordId);
    await h.users.revokeAccess(h.admin.id, h.alice.id);
    h.clear();
    for (const [index, url] of paths.entries()) {
      expect(
        (await h.get(url + "?since=" + revisions[index])).statusCode,
        url,
      ).toBe(401);
    }
    expect(
      (
        await h.get(
          `/account/processes/${h.alice.id}/${own.process.id}/live?cursor=${own.cursor}`,
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.post("/account/processes", {
          project_id: own.project.id,
          command: "true",
        })
      ).statusCode,
    ).toBe(403);
    expect(h.ipc).not.toHaveBeenCalled();
    const refreshed = (await h.users.get(h.alice.id))!;
    h.sessions.set(h.alice.id, await h.users.createSession(refreshed));
    const reauthenticated = await h.get(paths[0]! + "?since=" + revisions[0]);
    expect(reauthenticated.statusCode).toBe(200);
    expect(reauthenticated.json().reset).toBe(true);
    await h.users.update(h.admin.id, h.alice.id, {
      role: "user",
      status: "disabled",
    });
    h.clear();
    expect(
      (await h.get(paths[0]! + "?since=" + reauthenticated.json().revision))
        .statusCode,
    ).toBe(401);
    expect(h.ipc).not.toHaveBeenCalled();
  });
});
