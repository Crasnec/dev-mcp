import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { AuthStore } from "../src/auth-store.ts";
import { GoogleLogin } from "../src/google-login.ts";
import { hashPassword, pkceChallenge } from "../src/crypto.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const base = "https://dev.example.test";
const identity = { sub: "google-subject-123", email: "alice@example.test" };
type App = ReturnType<typeof createApp>;
function cookies(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((value) => String(value).split(";")[0])
    .join("; ");
}
function merged(...values: string[]): string {
  const jar = new Map<string, string>();
  for (const value of values.join("; ").split("; ")) {
    const at = value.indexOf("=");
    if (at > 0) {
      jar.set(value.slice(0, at), value.slice(at + 1));
    }
  }
  return [...jar].map(([key, value]) => key + "=" + value).join("; ");
}
const csrf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
function get(app: App, url: string, cookie = "") {
  return inject(app, { method: "GET", url, headers: { cookie } });
}
function post(
  app: App,
  url: string,
  data: Record<string, string>,
  cookie = "",
) {
  return inject(app, {
    method: "POST",
    url,
    headers: {
      cookie,
      origin: base,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams(data).toString(),
  });
}
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-google-"));
  temporary.push(dataDir);
  const adminPasswordHash = await hashPassword("admin-test-password");
  const users = new UserStore(dataDir, adminPasswordHash);
  const admin = (await users.list())[0]!;
  const real = new GoogleLogin(
    { clientId: "test-client", clientSecret: "test-secret" },
    base + "/auth/google/callback",
  );
  const google = {
    authorizationUrl: vi.fn(real.authorizationUrl.bind(real)),
    exchange: vi.fn(async () => identity),
  };
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: base,
      dataDir,
      runnerSocket: path.join(dataDir, "none.sock"),
      userRunnerSocketDir: path.join(dataDir, "runners"),
      adminPasswordHash,
    },
    { users, google },
  );
  return {
    app,
    users,
    admin,
    google,
    dataDir,
    settings: new SettingsStore(dataDir),
    auth: new AuthStore(dataDir),
  };
}
async function start(
  app: App,
  data: Record<string, string> = {},
  currentCookie = "",
  pageUrl = "/login",
) {
  const page = await get(app, pageUrl, currentCookie);
  const jar = merged(currentCookie, cookies(page));
  const response = await post(
    app,
    "/auth/google",
    { csrf: csrf(page.payload), ...data },
    jar,
  );
  expect(response.statusCode).toBe(303);
  const url = new URL(String(response.headers.location));
  return {
    callback:
      "/auth/google/callback?" +
      new URLSearchParams({
        state: url.searchParams.get("state")!,
        code: "provider-code",
      }),
    jar: merged(jar, cookies(response)),
    url,
  };
}

describe("Google-only registration and browser login", () => {
  it("keeps browser form origins and allows Google redirects without accepting invalid CSRF requests", async () => {
    const { app, google } = await fixture();
    for (const route of ["/login", "/signup"]) {
      const page = await get(app, route);
      expect(page.headers["referrer-policy"]).toBe("same-origin");
      expect(page.headers["content-security-policy"]).toContain(
        "form-action 'self' https://accounts.google.com;",
      );
      const jar = cookies(page);
      const token = csrf(page.payload);
      for (const origin of ["null", "https://evil.example"]) {
        const rejected = await inject(app, {
          method: "POST",
          url: "/auth/google",
          headers: {
            cookie: jar,
            origin,
            "content-type": "application/x-www-form-urlencoded",
          },
          payload: new URLSearchParams({ csrf: token }).toString(),
        });
        expect(rejected.statusCode).toBe(403);
      }
      expect(
        (await post(app, "/auth/google", { csrf: "wrong" }, jar)).statusCode,
      ).toBe(403);
      expect(
        (await post(app, "/auth/google", { csrf: token })).statusCode,
      ).toBe(403);
      expect(google.authorizationUrl).not.toHaveBeenCalled();
    }
    await start(app);
    expect(google.authorizationUrl).toHaveBeenCalledOnce();
  });

  it("removes password signup and creates only pending, isolated Google users", async () => {
    const { app, users, dataDir } = await fixture();
    const page = await get(app, "/signup");
    expect(page.payload).toContain("Google로 가입하기");
    expect(page.payload).not.toContain('name="password"');
    expect(page.payload).not.toContain('name="username"');
    expect(
      (
        await post(
          app,
          "/signup",
          {
            username: "bypass",
            password: "long-password",
            csrf: csrf(page.payload),
          },
          cookies(page),
        )
      ).statusCode,
    ).toBe(403);
    expect((await post(app, "/auth/google", {})).statusCode).toBe(403);
    const flow = await start(app, { role: "admin", status: "active" });
    expect(flow.url.origin).toBe("https://accounts.google.com");
    expect(flow.url.searchParams.get("scope")).toBe("openid email");
    expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.url.searchParams.has("client_secret")).toBe(false);
    const callback = await get(app, flow.callback, flow.jar);
    expect(callback.statusCode).toBe(200);
    expect(callback.payload).toContain("승인");
    expect(cookies(callback)).not.toContain("__Host-dev-mcp-session=");
    const user = (await users.list()).find((user) => user.googleLinked)!;
    expect(user).toMatchObject({
      role: "user",
      status: "pending",
      runner: user.id,
      email: identity.email,
      passwordLogin: false,
    });
    expect(
      await users.authenticate(user.username, "admin-test-password"),
    ).toBeUndefined();
    const stored = JSON.parse(
      await readFile(path.join(dataDir, "users.json"), "utf8"),
    );
    expect(
      stored.users.find((entry: { id: string }) => entry.id === user.id)
        .passwordHash,
    ).toBeUndefined();
    expect((await get(app, flow.callback, flow.jar)).statusCode).toBe(400);
    const second = await start(app);
    await get(app, second.callback, second.jar);
    expect(await users.list()).toHaveLength(2);
  });

  it("requires approval, respects disabled accounts and closed registrations without blocking existing users", async () => {
    const { app, users, admin, google, settings } = await fixture();
    const { user } = await users.googleAccount(identity, true);
    await users.update(admin.id, user.id, { status: "active", role: "user" });
    await settings.save({
      registrationOpen: false,
      registrationMessage: "Closed",
    });
    let flow = await start(app);
    let response = await get(app, flow.callback, flow.jar);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/account");
    expect(cookies(response)).toContain("__Host-dev-mcp-session=");
    const account = await get(app, "/account", cookies(response));
    expect(account.payload).toContain(identity.email);
    expect(account.payload).not.toContain('action="/account/password"');
    await users.update(admin.id, user.id, { status: "disabled", role: "user" });
    flow = await start(app);
    response = await get(app, flow.callback, flow.jar);
    expect(response.statusCode).toBe(403);
    google.exchange.mockResolvedValue({
      sub: "new-sub",
      email: identity.email,
    });
    flow = await start(app);
    expect((await get(app, flow.callback, flow.jar)).statusCode).toBe(400);
    expect(await users.list()).toHaveLength(2);
  });

  it("binds state to the initiating browser, expires it, and never reflects provider secrets", async () => {
    const { app, google, dataDir } = await fixture();
    const flow = await start(app);
    expect((await get(app, flow.callback)).statusCode).toBe(400);
    expect(google.exchange).not.toHaveBeenCalled();
    google.exchange.mockRejectedValue(
      new Error("provider-code test-secret raw-id-token"),
    );
    const result = await get(app, flow.callback, flow.jar);
    expect(result.statusCode).toBe(400);
    expect(result.payload).not.toContain("test-secret");
    const audit = await readFile(path.join(dataDir, "audit.jsonl"), "utf8");
    expect(audit).not.toContain("provider-code");
    expect(audit).not.toContain("test-secret");
    expect((await get(app, flow.callback, flow.jar)).statusCode).toBe(400);
    const expired = await start(app);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await get(app, expired.callback, expired.jar)).statusCode).toBe(
      400,
    );
  });

  it("links Google explicitly to an authenticated legacy admin without changing its workspace or role", async () => {
    const { app, users, admin, auth } = await fixture();
    const session = await users.createSession(admin);
    const adminCookie = "__Host-dev-mcp-session=" + session.token;
    const client = await auth.registerClient("test", [
      "https://chat.example/callback",
    ]);
    const issued = await auth.issueTokens(client.clientId, ["workspace:read"], {
      userId: admin.id,
      authVersion: admin.authVersion,
    });
    const flow = await start(app, { mode: "link" }, adminCookie, "/account");
    expect((await get(app, flow.callback, flow.jar)).statusCode).toBe(303);
    expect(await users.list()).toHaveLength(1);
    expect(await users.get(admin.id)).toMatchObject({
      role: "admin",
      runner: "primary",
      email: identity.email,
      googleLinked: true,
    });
    expect(await users.session(session.token)).toBeUndefined();
    expect(
      await users.valid((await auth.access(issued.accessToken))!),
    ).toBeUndefined();
    const login = await start(app);
    const result = await get(app, login.callback, login.jar);
    expect(result.headers.location).toBe("/admin");
    expect((await get(app, "/admin", cookies(result))).statusCode).toBe(200);
  });

  it("rejects linking after session revocation and never merges different Google subjects by email", async () => {
    const { app, users, admin } = await fixture();
    const session = await users.createSession(admin);
    const flow = await start(
      app,
      { mode: "link" },
      "__Host-dev-mcp-session=" + session.token,
      "/account",
    );
    await users.logout(session.token);
    expect((await get(app, flow.callback, flow.jar)).statusCode).toBe(403);
    const first = await users.googleAccount(identity, true);
    const second = await users.googleAccount(
      { ...identity, sub: "other-sub" },
      true,
    );
    expect(first.user.id).not.toBe(second.user.id);
    await expect(
      users.linkGoogle(
        { userId: admin.id, authVersion: admin.authVersion },
        identity,
      ),
    ).rejects.toThrow("이미 연결된");
  });

  it("resumes MCP consent after Google login and requires explicit browser-bound CSRF-protected approval", async () => {
    const { app, users, admin, auth } = await fixture();
    const { user } = await users.googleAccount(identity, true);
    await users.update(admin.id, user.id, { status: "active", role: "user" });
    const client = await auth.registerClient("Google MCP", [
      "https://chat.example/callback",
    ]);
    const verifier = "v".repeat(64);
    const request =
      "/oauth/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUris[0]!,
        scope: "workspace:read",
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        state: "mcp-state",
      });
    const page = await get(app, request);
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.headers["content-security-policy"]).toContain(
      "https://accounts.google.com",
    );
    const transaction = /name="transaction" value="([^"]+)"/.exec(
      page.payload,
    )![1]!;
    const returnTo = "/oauth/consent?transaction=" + transaction;
    const resumedPage = await get(app, returnTo, cookies(page));
    expect(resumedPage.headers["referrer-policy"]).toBe("same-origin");
    expect(resumedPage.headers["content-security-policy"]).toContain(
      "https://accounts.google.com",
    );
    const started = await post(
      app,
      "/auth/google",
      { csrf: csrf(resumedPage.payload), returnTo },
      merged(cookies(page), cookies(resumedPage)),
    );
    const state = new URL(String(started.headers.location)).searchParams.get(
      "state",
    )!;
    const before = merged(cookies(page), cookies(started));
    const callback = await get(
      app,
      "/auth/google/callback?" + new URLSearchParams({ state, code: "code" }),
      before,
    );
    expect(callback.headers.location).toBe(returnTo);
    expect(String(callback.headers.location)).not.toContain(
      "https://chat.example",
    );
    const jar = merged(before, cookies(callback));
    const consent = await get(app, returnTo, jar);
    expect(consent.statusCode).toBe(200);
    expect(consent.payload).toContain(identity.email);
    expect(consent.payload).not.toContain('name="password"');
    const body = {
      transaction,
      authentication: "session",
      decision: "allow",
      csrf: csrf(consent.payload),
    };
    expect(
      (await post(app, "/oauth/authorize", { ...body, csrf: "wrong" }, jar))
        .statusCode,
    ).toBe(403);
    expect(
      (await post(app, "/oauth/authorize", body, cookies(callback))).statusCode,
    ).toBe(403);
    const approved = await post(app, "/oauth/authorize", body, jar);
    expect(approved.statusCode).toBe(302);
    const target = new URL(String(approved.headers.location));
    expect(target.searchParams.get("state")).toBe("mcp-state");
    const exchanged = await post(app, "/oauth/token", {
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: target.searchParams.get("code")!,
      redirect_uri: client.redirectUris[0]!,
      code_verifier: verifier,
    });
    expect(exchanged.statusCode).toBe(200);
    expect((await auth.access(exchanged.json().access_token))?.userId).toBe(
      user.id,
    );
  });

  it("does not accept an external post-login redirect", async () => {
    const { app, users, admin } = await fixture();
    const { user } = await users.googleAccount(identity, true);
    await users.update(admin.id, user.id, { status: "active", role: "user" });
    const flow = await start(app, { returnTo: "https://evil.test/steal" });
    expect((await get(app, flow.callback, flow.jar)).headers.location).toBe(
      "/account",
    );
  });
});
