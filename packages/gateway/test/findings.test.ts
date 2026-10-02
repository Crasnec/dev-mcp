import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { AuthStore } from "../src/auth-store.ts";
import { AuditLogger } from "../src/audit.ts";
import { IpcClient } from "../src/ipc-client.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-findings-"));
  temporary.push(dataDir);
  const users = new UserStore(dataDir);
  const pendingAdmin = await users.googleAccount(
    { sub: "admin", email: "admin@example.test" },
    true,
  );
  const admin = await users.promoteFirstAdmin(pendingAdmin.user.id);
  const pending = await users.googleAccount(
    { sub: "owner", email: "owner@example.test" },
    true,
  );
  const owner = await users.update(admin.id, pending.user.id, {
    role: "user",
    status: "active",
  });
  const session = await users.createSession(admin);
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      userRunnerSocketDir: path.join(dataDir, "runners"),
    },
    { users },
  );
  const cookie = "__Host-dev-mcp-session=" + session.token;
  const get = (url: string) =>
    inject(app, { method: "GET", url, headers: { cookie } });
  const post = (url: string, body: Record<string, string> = {}) =>
    inject(app, {
      method: "POST",
      url,
      headers: {
        cookie,
        origin: "https://dev.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ csrf: session.csrf, ...body }).toString(),
    });
  return {
    app,
    users,
    admin,
    owner,
    get,
    post,
    dataDir,
    auth: new AuthStore(dataDir),
    audit: new AuditLogger(dataDir),
  };
}
it("shows email and system actors, filters by actor or target, and preserves raw audit details", async () => {
  const f = await fixture();
  await f.audit.write({
    event: "ssh_key_added",
    actor: f.owner.id,
    userId: f.owner.id,
    keyId: "test-key",
    fingerprint: "SHA256:test-fingerprint",
  });
  await f.audit.write({
    event: "onboarding_completed",
    actor: "local_installer",
    workspaceRoot: null,
  });
  await f.audit.write({
    event: "user_updated",
    actor: f.admin.id,
    userId: f.owner.id,
  });
  const all = await f.get("/admin/audit");
  expect(all.payload).toContain("시스템 · 초기 설치");
  expect(all.payload).toContain(
    '<td class="audit-actor" role="cell">owner@example.test</td>',
  );
  for (const url of [
    "/admin/audit?q=owner%40example.test",
    "/admin/audit?owner=" + f.owner.id,
  ]) {
    const filtered = await f.get(url);
    expect((filtered.payload.match(/data-audit-id=/g) ?? []).length).toBe(2);
    expect(filtered.payload).not.toContain(
      "<strong>onboarding_completed</strong>",
    );
  }
  const source = (await f.audit.recent()).records.find(
    (entry) => entry.event === "ssh_key_added",
  )!;
  const id = createHash("sha256")
    .update(JSON.stringify(source))
    .digest("base64url")
    .slice(0, 20);
  const detail = await f.get("/admin/audit/" + id + "/detail");
  expect(detail.payload).toContain("SHA256:test-fingerprint");
  expect(detail.payload).toContain(f.owner.id);
  expect(detail.payload).toContain("test-key");
  const live = await f.get("/admin/audit/live?q=owner%40example.test");
  expect(live.statusCode).toBe(200);
  expect(live.payload).toContain("owner@example.test");
});
it("keeps unchanged account saves signed in and only invalidates actual changes", async () => {
  const f = await fixture();
  const login = await f.users.createSession(f.owner);
  const unchanged = await f.users.update(f.admin.id, f.owner.id, {
    role: "user",
    status: "active",
  });
  expect(unchanged.authVersion).toBe(f.owner.authVersion);
  expect(await f.users.session(login.token)).toBeTruthy();
  const changed = await f.users.update(f.admin.id, f.owner.id, {
    role: "user",
    status: "disabled",
  });
  expect(changed.authVersion).toBe(f.owner.authVersion + 1);
  expect(await f.users.session(login.token)).toBeUndefined();
});
it("revokes a user's grant and refresh retries without affecting the same client for others", async () => {
  const f = await fixture();
  const client = await f.auth.registerClient("Shared MCP client", [
    "https://example.test/callback",
  ]);
  const own = await f.auth.issueTokens(client.clientId, ["workspace:read"], {
    userId: f.owner.id,
    authVersion: f.owner.authVersion,
  });
  const other = await f.auth.issueTokens(client.clientId, ["workspace:read"], {
    userId: f.admin.id,
    authVersion: f.admin.authVersion,
  });
  const input = { clientId: client.clientId, refreshToken: own.refreshToken };
  const refreshed = await f.auth.refresh(input);
  expect(refreshed).toBeTruthy();
  expect((await f.get("/admin/users/" + f.owner.id)).payload).toContain(
    "Shared MCP client",
  );
  const revoked = await f.post(
    `/admin/users/${f.owner.id}/connections/${client.clientId}/revoke`,
  );
  expect(revoked.statusCode).toBe(303);
  expect(await f.auth.access(own.accessToken)).toBeUndefined();
  expect(await f.auth.access(refreshed!.accessToken)).toBeUndefined();
  expect(await f.auth.refresh(input)).toBeUndefined();
  expect(await f.auth.access(other.accessToken)).toBeTruthy();
  expect(
    await f.auth.refresh({
      clientId: client.clientId,
      refreshToken: other.refreshToken,
    }),
  ).toBeTruthy();
  expect(await f.auth.clients()).toHaveLength(1);
  expect((await f.audit.recent()).records[0]).toMatchObject({
    event: "admin_connection_revoked",
    userId: f.owner.id,
    clientId: client.clientId,
  });
});
it("scopes browser logout to the displayed user and audits both target and session", async () => {
  const f = await fixture();
  const login = await f.users.createSession(f.owner);
  const browser = (await f.users.browserSessions()).find(
    (session) => session.userId === f.owner.id,
  )!;
  expect(
    (await f.post(`/admin/users/${f.admin.id}/sessions/${browser.id}/revoke`))
      .statusCode,
  ).toBe(404);
  expect(await f.users.session(login.token)).toBeTruthy();
  expect(
    (await f.post(`/admin/users/${f.owner.id}/sessions/${browser.id}/revoke`))
      .statusCode,
  ).toBe(303);
  expect(await f.users.session(login.token)).toBeUndefined();
  expect((await f.audit.recent()).records[0]).toMatchObject({
    event: "admin_session_revoked",
    userId: f.owner.id,
    sessionId: browser.id,
  });
  expect(
    (await f.get("/admin/connections?q=owner%40example.test")).headers.location,
  ).toBe("/admin/users?q=owner%40example.test");
});
it("offers clone and automatically registers it only in the authenticated workspace", async () => {
  const f = await fixture();
  const call = vi.spyOn(IpcClient.prototype, "call").mockResolvedValue({
    ok: true,
    truncated: false,
    data: { project: { id: "new-project" } },
  });
  const login = await f.users.createSession(f.owner);
  const post = (owner: string) =>
    inject(f.app, {
      method: "POST",
      url: "/account/projects/clone",
      headers: {
        cookie: "__Host-dev-mcp-session=" + login.token,
        origin: "https://dev.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({
        csrf: login.csrf,
        owner,
        name: "repo",
        repo_url: "https://github.com/owner/repo.git",
        ref: "main",
      }).toString(),
    });
  expect((await post(f.admin.id)).statusCode).toBe(404);
  expect(call).not.toHaveBeenCalled();
  expect((await post(f.owner.id)).statusCode).toBe(303);
  expect(call).toHaveBeenCalledWith(
    "project_clone",
    expect.objectContaining({
      repo_url: "https://github.com/owner/repo.git",
      ref: "main",
    }),
    expect.any(String),
    { timeoutMs: 310_000 },
  );
});
