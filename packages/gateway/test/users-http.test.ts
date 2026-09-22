import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcClient } from "../src/ipc-client.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { legacyUser } from "./legacy-user.ts";
import { AuthStore } from "../src/auth-store.ts";
import { hashPassword, pkceChallenge } from "../src/crypto.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const password = "a-long-user-password";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-users-http-"));
  temporary.push(dataDir);
  const adminPasswordHash = await hashPassword(password);
  const users = new UserStore(dataDir, adminPasswordHash);
  const admin = (await users.list())[0]!;
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      runnerSocket: path.join(dataDir, "primary.sock"),
      userRunnerSocketDir: path.join(dataDir, "runners"),
      adminPasswordHash,
      google: { clientId: "test-client", clientSecret: "test-secret" },
    },
    { users },
  );
  return { app, users, admin, dataDir, auth: new AuthStore(dataDir) };
}
type App = ReturnType<typeof createApp>;
function post(
  app: App,
  url: string,
  values: Record<string, string>,
  cookie = "",
) {
  return inject(app, {
    method: "POST",
    url,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: "https://dev.example.test",
    },
    payload: new URLSearchParams(values).toString(),
  });
}
function cookies(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((v) => String(v).split(";")[0])
    .join("; ");
}
function csrf(html: string): string {
  return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
}
async function login(app: App, username: string, secret = password) {
  const page = await inject(app, { method: "GET", url: "/login" });
  const result = await post(
    app,
    "/login",
    { username, password: secret, csrf: csrf(page.payload) },
    cookies(page),
  );
  return { result, cookie: cookies(result) };
}

describe("multi-user accounts and administration", () => {
  it("authorizes runner operations, validates limits and rejects stale admin forms", async () => {
    const { app, users, admin, dataDir } = await fixture();
    const signedIn = await login(app, "admin");
    const page = await inject(app, {
      method: "GET",
      url: "/admin/runners/" + admin.id,
      headers: { cookie: signedIn.cookie },
    });
    const token = csrf(page.payload);
    const target = await legacyUser(users, dataDir, "runner-user", password);
    const url = "/admin/runners/" + target.id + "/operations";
    const limits = {
      action: "apply",
      revision: "",
      csrf: token,
      network: "on",
      memoryMiB: "512",
      cpus: "1.5",
      pids: "64",
      storageMiB: "1024",
      fileSizeMiB: "64",
    };
    expect((await post(app, url, limits)).statusCode).toBe(403);
    expect(
      (await post(app, url, { ...limits, csrf: "wrong" }, signedIn.cookie))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(app, url, { ...limits, action: "start" }, signedIn.cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          app,
          "/admin/runners/" + admin.id + "/operations",
          limits,
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(400);
    for (const bad of [
      { memoryMiB: "1" },
      { storageMiB: "-1" },
      { storageMiB: "102401" },
      { cpus: "Infinity" },
      { pids: "1" },
      { fileSizeMiB: "1;touch /tmp/injected" },
    ]) {
      expect(
        (await post(app, url, { ...limits, ...bad }, signedIn.cookie))
          .statusCode,
      ).toBe(400);
    }
    await users.update(admin.id, target.id, { status: "active", role: "user" });
    const regular = await login(app, target.username);
    expect((await post(app, url, limits, regular.cookie)).statusCode).toBe(403);
    expect((await post(app, url, limits, signedIn.cookie)).statusCode).toBe(
      303,
    );
    const db = JSON.parse(
      await readFile(path.join(dataDir, "runner-controls.json"), "utf8"),
    );
    expect(db.entries[target.id]).toMatchObject({
      action: "apply",
      actorId: admin.id,
      limits: {
        network: true,
        memoryMiB: 512,
        cpus: 1.5,
        pids: 64,
        storageMiB: 1024,
        fileSizeMiB: 64,
      },
    });
    expect(
      (await post(app, url, { ...limits, action: "stop" }, signedIn.cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          app,
          url,
          {
            csrf: token,
            revision: db.entries[target.id].revision,
            action: "stop",
          },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    const view = await inject(app, {
      method: "GET",
      url: "/admin/runners/" + target.id,
      headers: { cookie: signedIn.cookie },
    });
    expect(view.payload).toContain("운영 요청을 처리 중");
    expect(view.payload).toContain('name="storageMiB"');
    expect(view.payload).toContain('value="512"');
    expect(view.payload).not.toContain("scrypt:");
  });

  it("serves separate ERP pages and assets, enforces guards on every management action", async () => {
    const { app, users, admin, dataDir } = await fixture();
    const signedIn = await login(app, "admin");
    const dashboard = await inject(app, {
      method: "GET",
      url: "/admin",
      headers: { cookie: signedIn.cookie },
    });
    const token = csrf(dashboard.payload);
    for (const route of [
      "",
      "/users",
      "/users/" + admin.id,
      "/projects",
      "/runners",
      "/runners/" + admin.id,
      "/processes",
      "/connections",
      "/audit",
      "/settings",
    ]) {
      const response = await inject(app, {
        method: "GET",
        url: "/admin" + route,
        headers: { cookie: signedIn.cookie },
      });
      expect(response.statusCode, route).toBe(200);
      expect(response.payload).toContain('aria-label="관리 메뉴"');
      expect(response.payload).toContain('href="/assets/admin.css"');
      expect(response.payload).toContain(
        'src="/assets/message-dialogs.js" defer',
      );
      expect(response.payload).not.toContain("<style");
      expect(response.payload).not.toContain("scrypt:");
      expect(response.headers["content-security-policy"]).toContain(
        "script-src 'self'",
      );
      expect(response.headers["content-security-policy"]).not.toContain(
        "unsafe-inline",
      );
      if (route === "/users/" + admin.id) {
        expect(response.payload).toContain(
          'class="button refresh-link" href="/admin/users/' + admin.id + '"',
        );
      }
    }
    for (const asset of ["auth", "admin", "message-dialogs"]) {
      const response = await inject(app, {
        method: "GET",
        url: "/assets/" + asset + ".css",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/css");
    }
    const modalScript = await inject(app, {
      method: "GET",
      url: "/assets/message-dialogs.js",
    });
    expect(modalScript.statusCode).toBe(200);
    expect(modalScript.headers["content-type"]).toContain("javascript");
    expect(modalScript.payload).toContain("dialog.showModal()");
    expect(modalScript.payload).toContain("history.replaceState");
    const account = await inject(app, {
      method: "GET",
      url: "/account",
      headers: { cookie: signedIn.cookie },
    });
    expect(account.payload).toContain('class="admin-shell');
    expect(account.payload).toContain('href="/assets/admin.css"');
    expect(account.payload).toContain(
      'href="/account" class="active" aria-current="page"',
    );
    expect(account.payload).toContain('href="/admin/users"');
    expect(account.payload).toContain('class="account-grid"');
    expect(account.payload).toContain('class="context-message"');
    expect(account.payload).not.toContain('class="notice"');
    const alice = await legacyUser(users, dataDir, "alice", password);
    await users.update(admin.id, alice.id, { status: "active", role: "user" });
    const ordinary = await login(app, "alice");
    const ordinaryAccount = await inject(app, {
      method: "GET",
      url: "/account",
      headers: { cookie: ordinary.cookie },
    });
    expect(ordinaryAccount.statusCode).toBe(200);
    expect(ordinaryAccount.payload).toContain('aria-label="관리 메뉴"');
    expect(ordinaryAccount.payload).toContain(
      'href="/account" class="active" aria-current="page"',
    );
    expect(ordinaryAccount.payload).toContain("일반 사용자");
    expect(ordinaryAccount.payload).toContain("내 프로젝트");
    expect(ordinaryAccount.payload).not.toContain('href="/admin"');
    expect(ordinaryAccount.payload).not.toContain('href="/admin/users"');
    const forbiddenAdmin = await inject(app, {
      method: "GET",
      url: "/admin",
      headers: { cookie: ordinary.cookie },
    });
    expect(forbiddenAdmin.statusCode).toBe(403);
    expect(forbiddenAdmin.payload).toContain("관리자 전용 화면입니다");
    for (const route of [
      "/users/" + alice.id,
      "/users/" + alice.id + "/revoke",
      "/projects",
      "/projects/" + admin.id + "/p/delete",
      "/projects/" + admin.id + "/p/unregister",
      "/processes/" + admin.id + "/p/stop",
      "/connections/sessions/s/revoke",
      "/connections/clients/c/delete",
      "/settings",
    ]) {
      expect((await post(app, "/admin" + route, {})).statusCode, route).toBe(
        403,
      );
      expect(
        (await post(app, "/admin" + route, { csrf: token }, ordinary.cookie))
          .statusCode,
        route,
      ).toBe(403);
      expect(
        (await post(app, "/admin" + route, { csrf: "wrong" }, signedIn.cookie))
          .statusCode,
        route,
      ).toBe(403);
    }
    const crossOrigin = await inject(app, {
      method: "POST",
      url: "/admin/settings",
      headers: {
        cookie: signedIn.cookie,
        origin: "https://evil.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ csrf: token }).toString(),
    });
    expect(crossOrigin.statusCode).toBe(403);
  });

  it("sorts admin lists and keeps filters when changing sort direction", async () => {
    const { app, users, admin, dataDir } = await fixture();
    for (const username of ["alpha", "zeta"]) {
      const created = await legacyUser(users, dataDir, username, password);
      await users.update(admin.id, created.id, {
        status: "active",
        role: "user",
      });
    }
    const signedIn = await login(app, "admin");
    const response = await inject(app, {
      method: "GET",
      url: "/admin/users?q=a&status=active&page=2&sort=username&direction=desc",
      headers: { cookie: signedIn.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.indexOf(">zeta</a>")).toBeLessThan(
      response.payload.indexOf(">alpha</a>"),
    );
    expect(response.payload.indexOf(">alpha</a>")).toBeLessThan(
      response.payload.indexOf(">admin</a>"),
    );
    expect(response.payload).toContain('aria-sort="descending"');
    expect(response.payload).toContain(
      'class="button refresh-link" href="/admin/users?q=a&amp;status=active&amp;page=2&amp;sort=username&amp;direction=desc"',
    );
    expect(response.payload).toContain(
      "/admin/users?q=a&amp;status=active&amp;sort=username&amp;direction=asc",
    );
    expect(response.payload).not.toContain(
      "/admin/users?q=a&amp;status=active&amp;page=2&amp;sort=username&amp;direction=asc",
    );
    const saved = await inject(app, {
      method: "GET",
      url: "/admin/users?saved=1",
      headers: { cookie: signedIn.cookie },
    });
    expect(saved.payload).toContain('class="notice" role="status"');
    expect(saved.payload).toContain(
      'class="button refresh-link" href="/admin/users"',
    );
  });

  it("persists signup settings, escapes messages, and revokes sessions and OAuth clients", async () => {
    const { app, users, auth, admin, dataDir } = await fixture();
    const signedIn = await login(app, "admin");
    const dashboard = await inject(app, {
      method: "GET",
      url: "/admin",
      headers: { cookie: signedIn.cookie },
    });
    const token = csrf(dashboard.payload);
    const signup = await inject(app, { method: "GET", url: "/signup" });
    expect(
      (
        await post(
          app,
          "/admin/settings",
          { csrf: token, registrationMessage: '<script>alert("x")</script>' },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    const closed = await inject(app, { method: "GET", url: "/signup" });
    expect(closed.payload).toContain("&lt;script&gt;");
    expect(closed.payload).not.toContain('<script>alert("x")</script>');
    expect(
      (
        await post(
          app,
          "/signup",
          { csrf: csrf(signup.payload), username: "blocked", password },
          cookies(signup),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await users.list()).some((user) => user.username === "blocked"),
    ).toBe(false);
    expect(
      (
        await post(
          app,
          "/admin/settings",
          { csrf: token, registrationOpen: "on" },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    const extra = await users.createSession(admin);
    const sessions = await users.browserSessions();
    const row = sessions[sessions.length - 1]!;
    expect(
      (
        await post(
          app,
          "/admin/connections/sessions/" + row.id + "/revoke",
          { csrf: token },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    expect(await users.session(extra.token)).toBeUndefined();
    const client = await auth.registerClient("<img src=x onerror=alert(1)>", [
      "https://chat.example/callback",
    ]);
    const issued = await auth.issueTokens(client.clientId, ["workspace:read"], {
      userId: admin.id,
      authVersion: admin.authVersion,
    });
    const connections = await inject(app, {
      method: "GET",
      url: "/admin/connections",
      headers: { cookie: signedIn.cookie },
    });
    expect(connections.payload).toContain("&lt;img");
    expect(connections.payload).toContain('class="client-summary"');
    expect(connections.payload).toContain('class="client-created"');
    expect(connections.payload).not.toContain(issued.accessToken);
    expect(connections.payload).not.toContain(issued.refreshToken);
    const url = "/admin/connections/clients/" + client.clientId + "/delete";
    expect(
      (
        await post(
          app,
          url,
          { csrf: token, confirmation: "wrong" },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(await auth.access(issued.accessToken)).toBeTruthy();
    expect(
      (
        await post(
          app,
          url,
          { csrf: token, confirmation: client.clientId },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    expect(await auth.access(issued.accessToken)).toBeUndefined();
    const audit = await inject(app, {
      method: "GET",
      url: "/admin/audit",
      headers: { cookie: signedIn.cookie },
    });
    expect(audit.payload).toContain("admin_client_removed");
    expect(audit.payload).toContain("admin_settings_updated");
  });

  it("routes project and process actions to their owner, checks deletion confirmation and escapes runner data", async () => {
    const { app, users, admin, dataDir } = await fixture();
    const alice = await legacyUser(users, dataDir, "alice", password);
    const calls: Array<{
      method: string;
      actor: string;
      params: Record<string, unknown>;
    }> = [];
    const ipc = vi
      .spyOn(IpcClient.prototype, "call")
      .mockImplementation(async (method, params, actor) => {
        calls.push({ method, actor, params });
        if (method === "project_list") {
          return {
            ok: true,
            data: {
              projects: [
                {
                  id: "project-a",
                  name: "Project Alpha",
                  relativePath: "alpha",
                },
              ],
            },
          };
        }
        if (method === "process_list") {
          return {
            ok: true,
            data: {
              processes: [
                {
                  id: "process-a",
                  projectId: "project-a",
                  command: "echo <script>x</script>",
                  status: "running",
                  pid: 123,
                  startedAt: new Date().toISOString(),
                },
              ],
            },
          };
        }
        return { ok: true, data: { output: "<script>runner data</script>" } };
      });
    const signedIn = await login(app, "admin");
    const dashboard = await inject(app, {
      method: "GET",
      url: "/admin",
      headers: { cookie: signedIn.cookie },
    });
    const token = csrf(dashboard.payload);
    for (const url of [
      "/admin/projects/" + alice.id + "/project-a",
      "/admin/processes/" + alice.id + "/process-a",
    ]) {
      const page = await inject(app, {
        method: "GET",
        url,
        headers: { cookie: signedIn.cookie },
      });
      expect(page.statusCode).toBe(200);
      expect(page.payload).toContain("&lt;script&gt;");
      expect(page.payload).not.toContain("<script>runner data</script>");
    }
    const url = "/admin/projects/" + alice.id + "/project-a/delete";
    expect(
      (
        await post(
          app,
          url,
          { csrf: token, confirmation: "wrong" },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(calls.some((call) => call.method === "project_delete")).toBe(false);
    expect(
      (
        await post(
          app,
          url,
          { csrf: token, confirmation: "Project Alpha" },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await post(
          app,
          "/admin/processes/" + alice.id + "/process-a/stop",
          { csrf: token },
          signedIn.cookie,
        )
      ).statusCode,
    ).toBe(303);
    expect(
      calls
        .filter((call) =>
          ["project_delete", "process_stop"].includes(call.method),
        )
        .every(
          (call) => call.actor === "admin:" + admin.id + ":owner:" + alice.id,
        ),
    ).toBe(true);
    const auditList = await inject(app, {
      method: "GET",
      url: "/admin/audit",
      headers: { cookie: signedIn.cookie },
    });
    expect(auditList.statusCode).toBe(200);
    expect(auditList.payload).not.toContain("<details>");
    const stoppedDetailHref =
      /<strong>admin_process_stopped<\/strong>[\s\S]*?<a class="button small audit-detail-toggle" href="([^"]+)"/.exec(
        auditList.payload,
      )?.[1];
    expect(stoppedDetailHref).toBeTruthy();
    const auditDetail = await inject(app, {
      method: "GET",
      url: stoppedDetailHref!.replaceAll("&amp;", "&").split("#")[0]!,
      headers: { cookie: signedIn.cookie },
    });
    expect(auditDetail.statusCode).toBe(200);
    expect(auditDetail.payload).toContain('class="audit-detail-row"');
    expect(auditDetail.payload).toContain("연관 프로세스·작동 로그");
    expect(auditDetail.payload).toContain(
      "echo &lt;script&gt;x&lt;/script&gt;",
    );
    expect(auditDetail.payload).toContain(
      "&lt;script&gt;runner data&lt;/script&gt;",
    );
    expect(auditDetail.payload).not.toContain("<script>runner data</script>");
    expect(
      calls.some(
        (call) =>
          call.method === "process_logs" &&
          call.params.process_id === "process-a" &&
          call.params.max_bytes === 16 * 1024,
      ),
    ).toBe(true);
    const count = ipc.mock.calls.length;
    expect(
      (
        await inject(app, {
          method: "GET",
          url: "/admin/projects?owner=nonexistent",
          headers: { cookie: signedIn.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(ipc.mock.calls.length).toBe(count);
  });

  it("does not let another account's successful login reset a user's attempt limit", async () => {
    const { app, users, admin, dataDir } = await fixture();
    const alice = await legacyUser(users, dataDir, "alice", password);
    await users.update(admin.id, alice.id, { status: "active", role: "user" });
    for (let attempt = 0; attempt < 8; attempt++) {
      expect((await login(app, "alice", "incorrect")).result.statusCode).toBe(
        401,
      );
    }
    expect((await login(app, "admin")).result.statusCode).toBe(303);
    expect((await login(app, "alice")).result.statusCode).toBe(429);
  });

  it("requires approval, protects admin writes with sessions and CSRF, and keeps the last admin", async () => {
    const { app, users, admin, dataDir } = await fixture();
    const page = await inject(app, { method: "GET", url: "/signup" });
    const signup = await post(
      app,
      "/signup",
      {
        username: "alice",
        password,
        csrf: csrf(page.payload),
        role: "admin",
        status: "active",
      },
      cookies(page),
    );
    expect(signup.statusCode).toBe(403);
    expect((await users.list()).some((user) => user.username === "alice")).toBe(
      false,
    );
    const alice = await legacyUser(users, dataDir, "alice", password);
    expect(alice).toMatchObject({
      role: "user",
      status: "pending",
      runner: alice.id,
    });
    expect((await login(app, "alice")).result.statusCode).toBe(401);
    const adminLogin = await login(app, "admin");
    expect(adminLogin.result.statusCode).toBe(303);
    expect(adminLogin.result.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HttpOnly"),
        expect.stringContaining("Secure"),
      ]),
    );
    const dashboard = await inject(app, {
      method: "GET",
      url: "/admin",
      headers: { cookie: adminLogin.cookie },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.payload).toContain("alice");
    expect(dashboard.payload).not.toContain("scrypt:");
    const update = {
      status: "active",
      role: "user",
      csrf: csrf(dashboard.payload),
    };
    expect(
      (
        await post(
          app,
          "/admin/users/" + alice.id,
          { ...update, csrf: "wrong" },
          adminLogin.cookie,
        )
      ).statusCode,
    ).toBe(403);
    expect((await users.get(alice.id))?.status).toBe("pending");
    expect(
      (await post(app, "/admin/users/" + alice.id, update, adminLogin.cookie))
        .statusCode,
    ).toBe(303);
    const aliceLogin = await login(app, "alice");
    expect(aliceLogin.result.statusCode).toBe(303);
    const forbidden = await inject(app, {
      method: "GET",
      url: "/admin",
      headers: { cookie: aliceLogin.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      (await post(app, "/admin/users/" + admin.id, update, aliceLogin.cookie))
        .statusCode,
    ).toBe(403);
    const lastAdmin = await post(
      app,
      "/admin/users/" + admin.id,
      update,
      adminLogin.cookie,
    );
    expect(lastAdmin.statusCode).toBe(400);
    expect(lastAdmin.payload).toContain("마지막 관리자");
    expect((await users.get(admin.id))?.role).toBe("admin");
    const environment = await inject(app, {
      method: "GET",
      url: "/admin/runners/" + alice.id,
      headers: { cookie: adminLogin.cookie },
    });
    expect(environment.payload).toContain(
      'action="/admin/runners/' + alice.id + '/operations"',
    );
    expect(environment.payload).toContain("연결 대기");
    const stored = await readFile(path.join(dataDir, "users.json"), "utf8");
    expect(stored).not.toContain(password);
    expect(stored).not.toContain(
      aliceLogin.cookie.split("=")[1]!.split(";")[0]!,
    );
  });

  it("invalidates browser sessions and OAuth credentials on password change and never resets bootstrap credentials", async () => {
    const { app, users, auth, admin, dataDir } = await fixture();
    const principal = { userId: admin.id, authVersion: admin.authVersion };
    const client = await auth.registerClient("test", [
      "https://chat.example/callback",
    ]);
    const issued = await auth.issueTokens(
      client.clientId,
      ["workspace:read"],
      principal,
    );
    const signedIn = await login(app, "admin");
    const account = await inject(app, {
      method: "GET",
      url: "/account",
      headers: { cookie: signedIn.cookie },
    });
    const newPassword = "a-new-long-password";
    const changed = await post(
      app,
      "/account/password",
      {
        csrf: csrf(account.payload),
        current_password: password,
        password: newPassword,
      },
      signedIn.cookie,
    );
    expect(changed.statusCode).toBe(303);
    expect(
      (
        await inject(app, {
          method: "GET",
          url: "/admin",
          headers: { cookie: signedIn.cookie },
        })
      ).statusCode,
    ).toBe(303);
    expect(
      (
        await inject(app, {
          method: "GET",
          url: "/mcp",
          headers: { authorization: "Bearer " + issued.accessToken },
        })
      ).statusCode,
    ).toBe(401);
    const refresh = await post(app, "/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: issued.refreshToken,
      client_id: client.clientId,
    });
    expect(refresh.statusCode).toBe(400);
    const reloaded = new UserStore(dataDir, await hashPassword(password));
    expect(await reloaded.authenticate("admin", password)).toBeUndefined();
    expect(await reloaded.authenticate("admin", newPassword)).toBeTruthy();
  });

  it("binds OAuth grants to each approved user and rejects cached refreshes after disabling an account", async () => {
    const { app, users, auth, admin, dataDir } = await fixture();
    const alice = await legacyUser(users, dataDir, "alice", password);
    await users.update(admin.id, alice.id, { status: "active", role: "user" });
    const client = await auth.registerClient("shared-client", [
      "https://chat.example/callback",
    ]);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      scope: "workspace:read",
      code_challenge: pkceChallenge("v".repeat(64)),
      code_challenge_method: "S256",
    });
    const page = await inject(app, {
      method: "GET",
      url: "/oauth/authorize?" + query,
    });
    const transaction = /name="transaction" value="([^"]+)"/.exec(
      page.payload,
    )![1]!;
    const allowed = await post(app, "/oauth/authorize", {
      transaction,
      username: "alice",
      password,
      decision: "allow",
    });
    expect(allowed.statusCode).toBe(302);
    const code = new URL(String(allowed.headers.location)).searchParams.get(
      "code",
    )!;
    const exchanged = await post(app, "/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      code_verifier: "v".repeat(64),
    });
    expect(exchanged.statusCode).toBe(200);
    const tokens = exchanged.json();
    expect((await auth.access(tokens.access_token))?.userId).toBe(alice.id);
    const refreshBody = {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.clientId,
    };
    const first = await post(app, "/oauth/token", refreshBody);
    expect(first.statusCode).toBe(200);
    await users.update(admin.id, alice.id, {
      status: "disabled",
      role: "user",
    });
    expect((await post(app, "/oauth/token", refreshBody)).statusCode).toBe(400);
    expect(
      (
        await inject(app, {
          method: "GET",
          url: "/mcp",
          headers: { authorization: "Bearer " + first.json().access_token },
        })
      ).statusCode,
    ).toBe(401);
    await users.update(admin.id, alice.id, { status: "active", role: "user" });
    expect(
      (
        await inject(app, {
          method: "GET",
          url: "/mcp",
          headers: { authorization: "Bearer " + tokens.access_token },
        })
      ).statusCode,
    ).toBe(401);
  });
});
