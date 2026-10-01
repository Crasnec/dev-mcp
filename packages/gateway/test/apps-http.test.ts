import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../src/app.ts";
import { AppStore, MAX_APPS_PER_ACCOUNT } from "../src/app-store.ts";
import { AppService } from "../src/apps.ts";
import { AuditLogger } from "../src/audit.ts";
import type { GatewayConfig } from "../src/config.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { createMcpServer } from "../src/mcp-tools.ts";
import type { ToolResult } from "../src/protocol.ts";
import { RunnerRouter } from "../src/runner-router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { UserStore, type User } from "../src/user-store.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const origin = "https://dev.example.test";
const success = (data: unknown): ToolResult => ({
  ok: true,
  data,
  truncated: false,
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-apps-"));
  temporary.push(dataDir);
  const users = new UserStore(dataDir);
  const admin = await adminAccount(users, dataDir);
  const account = async (name: string) =>
    users.update(admin.id, (await pendingAccount(users, dataDir, name)).id, {
      status: "active",
      role: "user",
    });
  const alice = await account("alice");
  const bob = await account("bob");
  const config: GatewayConfig = {
    port: 3000,
    publicBaseUrl: origin,
    dataDir,
    userRunnerSocketDir: path.join(dataDir, "runners"),
    previewDomain: "apps.example.net",
    google: { clientId: "test-client", clientSecret: "test-secret" },
  };
  // A fake runner per account: projects plus tracked processes.
  const calls: Array<{
    owner: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const processes = new Map<string, string>();
  let next = 0;
  vi.spyOn(IpcClient.prototype, "call").mockImplementation(async function (
    this: IpcClient,
    method,
    params,
  ) {
    const socketPath = (this as unknown as { socketPath: string }).socketPath;
    const owner = path.basename(path.dirname(socketPath));
    calls.push({ owner, method, params });
    switch (method) {
      case "project_list":
        return success({
          projects: [
            { id: "project-" + owner, name: "Demo", relativePath: "demo" },
          ],
        });
      case "process_start": {
        const id = "process-" + ++next;
        processes.set(id, "running");
        return success({
          process: { id, projectId: params.project_id, status: "running" },
        });
      }
      case "process_list":
        return success({
          processes: [...processes].map(([id, status]) => ({ id, status })),
        });
      case "process_stop":
        processes.set(String(params.process_id), "stopped");
        return success({
          process: { id: params.process_id, status: "stopped" },
        });
      default:
        return success({});
    }
  });
  const apps = new AppStore(dataDir);
  const settings = new SettingsStore(dataDir);
  const audit = new AuditLogger(dataDir);
  const app = createApp(config, { users, apps, settings, audit });
  // One browser session per account, so forms keep their CSRF token.
  const sessions = new Map<string, string>();
  const cookie = async (user: User) => {
    if (!sessions.has(user.id)) {
      sessions.set(
        user.id,
        "__Host-dev-mcp-session=" +
          (await users.createSession((await users.get(user.id))!)).token,
      );
    }
    return sessions.get(user.id)!;
  };
  const page = async (user: User, url: string) => {
    const response = await inject(app, {
      method: "GET",
      url,
      headers: { cookie: await cookie(user) },
    });
    return {
      response,
      csrf: /name="csrf" value="([^"]+)"/.exec(response.payload)?.[1] ?? "",
    };
  };
  const post = async (
    user: User,
    url: string,
    values: Record<string, string>,
  ) =>
    inject(app, {
      method: "POST",
      url,
      headers: {
        cookie: await cookie(user),
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams(values).toString(),
    });
  return {
    dataDir,
    users,
    admin,
    alice,
    bob,
    config,
    apps,
    settings,
    audit,
    calls,
    processes,
    page,
    post,
  };
}

const form = (overrides: Record<string, string> = {}) => ({
  name: "todo",
  project_id: "",
  command: "npm run dev -- --host 0.0.0.0",
  port: "5173",
  visibility: "private",
  network_intent: "none",
  ...overrides,
});

describe("app definitions", () => {
  it("validates names, ports and per-account limits", async () => {
    const { apps, alice, bob } = await fixture();
    const base = {
      slug: "todo",
      projectId: "p",
      command: "node server.js",
      port: 5173,
      visibility: "private" as const,
      networkIntent: "none" as const,
    };
    for (const bad of [
      { slug: "Todo" },
      { slug: "-todo" },
      { slug: "todo-" },
      { slug: "www" },
      { slug: "a".repeat(41) },
      { port: 80 },
      { port: 70000 },
      { command: " " },
      { visibility: "everyone" as never },
    ]) {
      await expect(apps.save(alice.id, { ...base, ...bad })).rejects.toThrow();
    }
    await apps.save(alice.id, base);
    await expect(apps.save(bob.id, base)).rejects.toThrow("다른 계정");
    for (let index = 1; index < MAX_APPS_PER_ACCOUNT; index += 1) {
      await apps.save(alice.id, { ...base, slug: "todo-" + index });
    }
    await expect(
      apps.save(alice.id, { ...base, slug: "one-too-many" }),
    ).rejects.toThrow("10개");
    expect((await apps.save(alice.id, { ...base, port: 3000 })).port).toBe(
      3000,
    );
  });
});

describe("app console", () => {
  it("deploys, restarts, stops and deletes an account's own app", async () => {
    const { alice, page, post, calls, apps, processes, dataDir } =
      await fixture();
    const list = await page(alice, "/account/apps");
    expect(list.response.statusCode).toBe(200);
    expect(list.response.payload).toContain("새 앱 배포");
    const projectId = "project-" + alice.id;
    const created = await post(alice, "/account/apps", {
      ...form({ project_id: projectId }),
      csrf: list.csrf,
    });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe("/account/apps/todo?saved=1");
    const stored = await apps.get("todo");
    expect(stored).toMatchObject({
      ownerId: alice.id,
      projectId,
      port: 5173,
      processId: "process-1",
    });
    expect(calls.find((call) => call.method === "process_start")).toMatchObject(
      {
        owner: alice.id,
        params: {
          project_id: projectId,
          command: "npm run dev -- --host 0.0.0.0",
          network_intent: "none",
        },
      },
    );
    const detail = await page(alice, "/account/apps/todo");
    expect(detail.response.payload).toContain("https://todo.apps.example.net");
    expect(detail.response.payload).toContain("실행 중");
    // Restarting stops the old process first.
    await post(alice, "/account/apps/todo/start", { csrf: detail.csrf });
    expect(processes.get("process-1")).toBe("stopped");
    expect((await apps.get("todo"))?.processId).toBe("process-2");
    await post(alice, "/account/apps/todo/stop", { csrf: detail.csrf });
    expect(processes.get("process-2")).toBe("stopped");
    expect((await apps.get("todo"))?.processId).toBeUndefined();
    expect(
      (
        await post(alice, "/account/apps/todo/delete", {
          csrf: detail.csrf,
          confirm: "wrong",
        })
      ).statusCode,
    ).toBe(400);
    await post(alice, "/account/apps/todo/delete", {
      csrf: detail.csrf,
      confirm: "todo",
    });
    expect(await apps.get("todo")).toBeUndefined();
    const audit = await readFile(path.join(dataDir, "audit.jsonl"), "utf8");
    for (const event of ["app_deployed", "app_stopped", "app_deleted"]) {
      expect(audit).toContain(`"event":"${event}"`);
    }
  });

  it("keeps accounts apart and lets administrators manage any app", async () => {
    const { alice, bob, admin, page, post, apps } = await fixture();
    const list = await page(alice, "/account/apps");
    await post(alice, "/account/apps", {
      ...form({ project_id: "project-" + alice.id }),
      csrf: list.csrf,
    });
    const bobPage = await page(bob, "/account/apps");
    expect(bobPage.response.payload).not.toContain("todo.apps.example.net");
    expect((await page(bob, "/account/apps/todo")).response.statusCode).toBe(
      404,
    );
    for (const action of ["start", "stop", "visibility", "delete"]) {
      expect(
        (
          await post(bob, `/account/apps/todo/${action}`, {
            csrf: bobPage.csrf,
            confirm: "todo",
            visibility: "public",
          })
        ).statusCode,
      ).toBe(404);
    }
    // The name is taken across accounts.
    expect(
      (
        await post(bob, "/account/apps", {
          ...form({ project_id: "project-" + bob.id }),
          csrf: bobPage.csrf,
        })
      ).statusCode,
    ).toBe(400);
    const adminList = await page(admin, "/admin/apps");
    expect(adminList.response.payload).toContain("todo.apps.example.net");
    expect(adminList.response.payload).toContain("alice");
    await post(admin, "/admin/apps/todo/visibility", {
      csrf: adminList.csrf,
      visibility: "public",
    });
    expect((await apps.get("todo"))?.visibility).toBe("public");
    // Missing CSRF is refused.
    expect(
      (await post(alice, "/account/apps/todo/stop", { csrf: "nope" }))
        .statusCode,
    ).toBe(403);
  });

  it("refuses public links when an administrator disabled them", async () => {
    const { alice, admin, page, post, apps } = await fixture();
    const settingsPage = await page(admin, "/admin/settings");
    expect(settingsPage.response.payload).toContain(
      "https://&lt;이름&gt;.apps.example.net",
    );
    await post(admin, "/admin/settings/apps", { csrf: settingsPage.csrf });
    const list = await page(alice, "/account/apps");
    expect(list.response.payload).not.toContain('value="public"');
    const refused = await post(alice, "/account/apps", {
      ...form({ project_id: "project-" + alice.id, visibility: "public" }),
      csrf: list.csrf,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.payload).toContain("공개 링크를 꺼 두었습니다");
    expect(await apps.get("todo")).toBeUndefined();
  });
});

describe("app MCP tools", () => {
  async function client(f: Awaited<ReturnType<typeof fixture>>, owner: User) {
    const runners = new RunnerRouter(f.config);
    const server = createMcpServer({
      scopes: ["command:run"],
      actor: owner.id + ":client",
      principal: { userId: owner.id, authVersion: owner.authVersion },
      ipc: runners.forUser(owner),
      audit: f.audit,
      resourceMetadataUrl: origin + "/.well-known/oauth-protected-resource",
      apps: {
        service: new AppService(f.apps, runners, f.config),
        owner,
        publicAllowed: async () => (await f.settings.read()).publicApps,
      },
    });
    const mcp = new Client({ name: "apps-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await mcp.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({
        name,
        arguments: { reason: "Deploy the requested app", ...args },
      });
      return result.structuredContent as ToolResult;
    };
    return call;
  }

  it("deploys and lists an app with its URL, and keeps other accounts' apps private", async () => {
    const f = await fixture();
    const alice = await client(f, f.alice);
    const deployed = await alice("app_deploy", {
      name: "todo",
      project_id: "00000000-0000-4000-8000-000000000001",
      command: "node server.js",
      port: 8080,
      network_intent: "none",
    });
    expect(deployed).toMatchObject({
      ok: true,
      data: {
        app: {
          name: "todo",
          url: "https://todo.apps.example.net",
          port: 8080,
          visibility: "private",
          state: "running",
        },
      },
    });
    expect((await alice("app_list", {})).data).toMatchObject({
      apps: [{ name: "todo", state: "running" }],
    });
    // Network intent needs the network scope, like process_start.
    expect(
      await alice("app_deploy", {
        name: "todo",
        project_id: "00000000-0000-4000-8000-000000000001",
        command: "node server.js",
        port: 8080,
        network_intent: "read",
      }),
    ).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_SCOPE" } });
    const bob = await client(f, f.bob);
    expect((await bob("app_list", {})).data).toEqual({ apps: [] });
    for (const tool of ["app_stop", "app_delete"]) {
      expect(await bob(tool, { name: "todo" })).toMatchObject({
        ok: false,
        error: { code: "APP_ERROR" },
      });
    }
    expect(
      await bob("app_deploy", {
        name: "todo",
        project_id: "00000000-0000-4000-8000-000000000002",
        command: "node server.js",
        port: 8080,
        network_intent: "none",
      }),
    ).toMatchObject({ ok: false, error: { code: "APP_ERROR" } });
    await f.settings.save({ publicApps: false });
    expect(
      await alice("app_deploy", {
        name: "todo",
        project_id: "00000000-0000-4000-8000-000000000001",
        command: "node server.js",
        port: 8080,
        visibility: "public",
        network_intent: "none",
      }),
    ).toMatchObject({ ok: false, error: { code: "PUBLIC_APPS_DISABLED" } });
    expect(await alice("app_stop", { name: "todo" })).toMatchObject({
      ok: true,
    });
    expect(await alice("app_delete", { name: "todo" })).toMatchObject({
      ok: true,
    });
    expect(await f.apps.get("todo")).toBeUndefined();
  });
});
