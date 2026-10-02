import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { startIpcServer } from "../../runner/src/ipc-server.ts";
import type { RunnerRuntime } from "../../runner/src/runtime.ts";
import { createApp } from "../src/app.ts";
import { AppStore } from "../src/app-store.ts";
import { AuditLogger } from "../src/audit.ts";
import type { GatewayConfig } from "../src/config.ts";
import { validatePreviewDomain } from "../src/config.ts";
import { createPreviewServer, PreviewAuth } from "../src/preview-proxy.ts";
import { RunnerRouter } from "../src/runner-router.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { UserStore } from "../src/user-store.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});
const domain = "apps.example.net";
const listen = async (server: net.Server | http.Server) => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(
    () =>
      new Promise<void>((done) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => done());
      }),
  );
  return (server.address() as net.AddressInfo).port;
};

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-preview-"));
  closers.push(() => rm(dataDir, { recursive: true, force: true }));
  // Unix socket paths are limited to 108 bytes; keep them short.
  const runnersDir = dataDir;
  const users = new UserStore(dataDir);
  const admin = await adminAccount(users, dataDir);
  const ownerPending = await pendingAccount(users, dataDir, "owner");
  const owner = await users.update(admin.id, ownerPending.id, {
    status: "active",
    role: "user",
  });
  const otherPending = await pendingAccount(users, dataDir, "other");
  const other = await users.update(admin.id, otherPending.id, {
    status: "active",
    role: "user",
  });
  // The owner's runner: a real signed IPC server.
  const key = "e".repeat(64);
  await writeFile(path.join(runnersDir, owner.id + ".key"), key);
  const runner = await startIpcServer(
    path.join(runnersDir, owner.id, "runner.sock"),
    {
      dispatch: async () => ({ ok: true, data: {}, truncated: false }),
    } as unknown as RunnerRuntime,
    key,
  );
  closers.push(() => new Promise<void>((done) => runner.close(() => done())));
  // The app server running "inside" the runner.
  const upstream = http.createServer((req, res) => {
    if (req.url === "/set-cookies") {
      res.setHeader("set-cookie", [
        "__Host-dev-mcp-preview=forged; Path=/; Secure",
        "theme=dark; Path=/",
      ]);
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie ?? null,
        forwardedHost: req.headers["x-forwarded-host"],
        forwardedProto: req.headers["x-forwarded-proto"],
      }),
    );
  });
  upstream.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.pipe(socket);
  });
  const appPort = await listen(upstream);
  const config: GatewayConfig = {
    port: 3000,
    publicBaseUrl: "https://dev.example.test",
    dataDir,
    userRunnerSocketDir: runnersDir,
    previewDomain: domain,
    google: { clientId: "test-client", clientSecret: "test-secret" },
  };
  const apps = new AppStore(dataDir);
  const settings = new SettingsStore(dataDir);
  const auth = new PreviewAuth(dataDir);
  const audit = new AuditLogger(dataDir);
  for (const [slug, visibility] of [
    ["demo", "private"],
    ["open", "public"],
  ] as const) {
    await apps.save(owner.id, {
      slug,
      projectId: "project",
      command: "node server.js",
      port: appPort,
      visibility,
      networkIntent: "none",
    });
  }
  const previewPort = await listen(
    createPreviewServer({
      config,
      apps,
      users,
      runners: new RunnerRouter(config),
      settings,
      auth,
      audit,
    }),
  );
  const console = createApp(config, {
    users,
    apps,
    previewAuth: auth,
    settings,
    audit,
  });
  const preview = (
    host: string,
    url: string,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: previewPort,
          path: url,
          headers: { host, ...headers },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              body,
            }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
  const session = async (userId: string) =>
    "__Host-dev-mcp-session=" +
    (await users.createSession((await users.get(userId))!)).token;
  // Console authorize → app host code exchange → preview cookie.
  const login = async (userId: string, slug = "demo", returnTo = "/") => {
    const authorize = await inject(console, {
      method: "GET",
      url: `/preview/authorize?app=${slug}&return=${encodeURIComponent(returnTo)}`,
      headers: { cookie: await session(userId) },
    });
    if (authorize.statusCode !== 303) {
      return { authorize };
    }
    const target = new URL(String(authorize.headers.location));
    const exchanged = await preview(
      target.host,
      target.pathname + target.search,
    );
    const cookie = String(
      [exchanged.headers["set-cookie"]].flat()[0] ?? "",
    ).split(";")[0]!;
    return { authorize, target, exchanged, cookie };
  };
  return {
    users,
    admin,
    owner,
    other,
    apps,
    settings,
    console,
    preview,
    session,
    login,
    previewPort,
    appPort,
  };
}

describe("published app preview", () => {
  it("routes only app hosts under the preview domain and answers TLS asks", async () => {
    const { preview } = await fixture();
    expect((await preview("dev.example.test", "/admin")).status).toBe(404);
    expect((await preview("missing." + domain, "/")).status).toBe(404);
    expect((await preview("a.b." + domain, "/")).status).toBe(404);
    expect(
      (await preview("x", "/__dev-mcp/tls-allowed?domain=demo." + domain))
        .status,
    ).toBe(200);
    for (const asked of ["missing." + domain, "demo.example.org", ""]) {
      expect(
        (await preview("x", "/__dev-mcp/tls-allowed?domain=" + asked)).status,
      ).toBe(404);
    }
  });

  it("sends private visitors through the console and grants a host-only cookie", async () => {
    const { preview, console, session, owner, other, admin, login, users } =
      await fixture();
    const first = await preview("demo." + domain, "/page?q=1");
    expect(first.status).toBe(303);
    const authorize = new URL(String(first.headers.location));
    expect(authorize.origin).toBe("https://dev.example.test");
    expect(authorize.pathname).toBe("/preview/authorize");
    expect(authorize.searchParams.get("return")).toBe("/page?q=1");
    // Signed out: to Google sign-in, resuming the authorization afterwards.
    const signedOut = await inject(console, {
      method: "GET",
      url: authorize.pathname + authorize.search,
    });
    expect(signedOut.statusCode).toBe(303);
    expect(String(signedOut.headers.location)).toBe(
      "/login?returnTo=" +
        encodeURIComponent(authorize.pathname + authorize.search),
    );
    const loginPage = await inject(console, {
      method: "GET",
      url: String(signedOut.headers.location),
    });
    expect(loginPage.payload).toContain(
      'name="returnTo" value="/preview/authorize?app=demo&amp;return=',
    );
    expect(
      (
        await inject(console, {
          method: "GET",
          url: authorize.pathname + authorize.search,
          headers: { cookie: await session(other.id) },
        })
      ).statusCode,
    ).toBe(403);
    const granted = await login(owner.id, "demo", "/page?q=1");
    expect(granted.target!.origin).toBe("https://demo." + domain);
    expect(granted.exchanged!.status).toBe(303);
    expect(granted.exchanged!.headers.location).toBe("/page?q=1");
    expect(String(granted.exchanged!.headers["set-cookie"])).toMatch(
      /^__Host-dev-mcp-preview=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
    );
    // Codes are single use.
    expect(
      (
        await preview(
          granted.target!.host,
          granted.target!.pathname + granted.target!.search,
        )
      ).status,
    ).toBe(403);
    const page = await preview("demo." + domain, "/page?q=1", {
      cookie: granted.cookie + "; theme=dark",
    });
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body)).toMatchObject({
      url: "/page?q=1",
      host: expect.stringMatching(/^localhost:\d+$/),
      cookie: "theme=dark",
      forwardedHost: "demo." + domain,
      forwardedProto: "https",
    });
    // The cookie is bound to one app.
    expect(
      (await preview("open." + domain, "/", { cookie: granted.cookie })).status,
    ).toBe(200);
    const adminGrant = await login(admin.id);
    expect(adminGrant.exchanged!.status).toBe(303);
    // Revoking the owner's access invalidates the preview cookie.
    await users.revokeAccess(admin.id, owner.id);
    expect(
      (await preview("demo." + domain, "/", { cookie: granted.cookie })).status,
    ).toBe(303);
  });

  it("filters the preview cookie from upstream responses and keeps app cookies", async () => {
    const { preview, owner, login } = await fixture();
    const { cookie } = await login(owner.id);
    const response = await preview("demo." + domain, "/set-cookies", {
      cookie,
    });
    expect([response.headers["set-cookie"]].flat()).toEqual([
      "theme=dark; Path=/",
    ]);
  });

  it("opens public apps without signing in unless public links are disabled", async () => {
    const { preview, settings, users, admin, owner } = await fixture();
    const open = await preview("open." + domain, "/hello");
    expect(open.status).toBe(200);
    expect(JSON.parse(open.body)).toMatchObject({
      url: "/hello",
      cookie: null,
    });
    await settings.save({ publicApps: false });
    expect((await preview("open." + domain, "/hello")).status).toBe(303);
    await settings.save({ publicApps: true });
    await users.update(admin.id, owner.id, {
      status: "disabled",
      role: "user",
    });
    expect((await preview("open." + domain, "/hello")).status).toBe(404);
  });

  it("reports a stopped app server and passes WebSocket upgrades", async () => {
    const { preview, apps, owner, previewPort } = await fixture();
    const unused = net.createServer();
    const port = await listen(unused);
    await new Promise<void>((done) => unused.close(() => done()));
    await apps.save(owner.id, {
      slug: "down",
      projectId: "project",
      command: "node server.js",
      port,
      visibility: "public",
      networkIntent: "none",
    });
    const down = await preview("down." + domain, "/");
    expect(down.status).toBe(502);
    expect(down.body).toContain("앱 서버가 실행 중이 아닙니다");
    const socket = net.createConnection(previewPort, "127.0.0.1");
    const reply = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.includes("ping")) {
          resolve(text);
        }
      });
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: open.${domain}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
      setTimeout(() => socket.write("ping"), 50);
    });
    socket.destroy();
    expect(reply).toContain("101 Switching Protocols");
    const denied = net.createConnection(previewPort, "127.0.0.1");
    const refusal = await new Promise<string>((resolve) => {
      let text = "";
      denied.on("data", (chunk) => (text += chunk));
      denied.on("close", () => resolve(text));
      denied.write(
        `GET /ws HTTP/1.1\r\nHost: demo.${domain}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
      );
    });
    expect(refusal).toContain("401");
  });

  it("keeps app hosts on origins of their own", () => {
    for (const [preview, secure] of [
      ["example.test", true],
      ["not a host", true],
      // Under the console host only when its cookies are __Host- (HTTPS).
      ["dev.example.test", false],
      ["apps.dev.example.test", false],
    ] as const) {
      expect(() =>
        validatePreviewDomain(preview, "dev.example.test", secure),
      ).toThrow();
    }
    for (const preview of [
      "dev.example.test",
      "apps.dev.example.test",
      "apps.example.net",
    ]) {
      expect(() =>
        validatePreviewDomain(preview, "dev.example.test", true),
      ).not.toThrow();
    }
  });
});
