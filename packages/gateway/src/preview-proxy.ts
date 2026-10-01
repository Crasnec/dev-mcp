import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { GatewayConfig } from "./config.ts";
import type { AuditLogger } from "./audit.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { User, UserStore } from "./user-store.ts";
import type { RunnerRouter } from "./runner-router.ts";
import { appNamePattern, type AppRecord, type AppStore } from "./app-store.ts";

const CODE_TTL_MS = 60_000;
const TOKEN_TTL_MS = 12 * 60 * 60_000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const previewCookieName = (config: GatewayConfig) =>
  config.publicBaseUrl.startsWith("https:")
    ? "__Host-dev-mcp-preview"
    : "dev-mcp-preview";

export function previewOrigin(config: GatewayConfig, slug: string) {
  return config.previewDomain
    ? `${new URL(config.publicBaseUrl).protocol}//${slug}.${config.previewDomain}`
    : undefined;
}

// Private apps live on another site than the console, so they cannot see the
// console session. The console hands out a one-time code; the app host turns
// it into its own signed cookie.
export class PreviewAuth {
  private secret?: Buffer;
  private readonly codes = new Map<
    string,
    {
      slug: string;
      userId: string;
      authVersion: number;
      returnTo: string;
      expiresAt: number;
    }
  >();
  constructor(private readonly dataDir: string) {}

  private async key(): Promise<Buffer> {
    if (!this.secret) {
      const file = path.join(this.dataDir, "preview-secret");
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      try {
        await writeFile(file, randomBytes(32).toString("hex"), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      const value = (await readFile(file, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error("Invalid preview secret");
      }
      this.secret = Buffer.from(value, "hex");
    }
    return this.secret;
  }

  issueCode(slug: string, user: User, returnTo: string): string {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) {
        this.codes.delete(code);
      }
    }
    if (this.codes.size >= 1000) {
      throw new Error(
        "미리보기 인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, {
      slug,
      userId: user.id,
      authVersion: user.authVersion,
      returnTo,
      expiresAt: now + CODE_TTL_MS,
    });
    return code;
  }

  redeem(code: string, slug: string) {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    return entry && entry.slug === slug && entry.expiresAt > Date.now()
      ? entry
      : undefined;
  }

  async token(slug: string, user: User): Promise<string> {
    const payload = Buffer.from(
      JSON.stringify({
        slug,
        userId: user.id,
        authVersion: user.authVersion,
        exp: Date.now() + TOKEN_TTL_MS,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", await this.key())
      .update(payload)
      .digest("base64url");
    return payload + "." + signature;
  }

  async verify(
    token: string,
    slug: string,
  ): Promise<{ userId: string; authVersion: number } | undefined> {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) {
      return undefined;
    }
    const expected = createHmac("sha256", await this.key())
      .update(payload)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return undefined;
    }
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      return value.slug === slug &&
        typeof value.userId === "string" &&
        typeof value.authVersion === "number" &&
        typeof value.exp === "number" &&
        value.exp > Date.now()
        ? { userId: value.userId, authVersion: value.authVersion }
        : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface PreviewServerOptions {
  config: GatewayConfig;
  apps: AppStore;
  users: UserStore;
  runners: RunnerRouter;
  settings: SettingsStore;
  auth: PreviewAuth;
  audit: AuditLogger;
}

// Serves only published apps; no console route exists on this listener.
export function createPreviewServer(
  options: PreviewServerOptions,
): http.Server {
  const { config, apps, users, runners, settings, auth, audit } = options;
  const cookieName = previewCookieName(config);
  const secure = config.publicBaseUrl.startsWith("https:");

  const slugFor = (host: string | undefined) => {
    const name = (host ?? "").toLowerCase().replace(/:\d+$/, "");
    const suffix = "." + config.previewDomain;
    if (!config.previewDomain || !name.endsWith(suffix)) {
      return undefined;
    }
    const slug = name.slice(0, -suffix.length);
    return appNamePattern.test(slug) ? slug : undefined;
  };

  // Resolves the app and decides whether this browser may open it.
  const resolve = async (req: http.IncomingMessage) => {
    const slug = slugFor(req.headers.host);
    const app = slug ? await apps.get(slug) : undefined;
    const owner = app ? await users.get(app.ownerId) : undefined;
    if (!app || owner?.status !== "active") {
      return { kind: "missing" as const };
    }
    if (app.visibility === "public" && (await settings.read()).publicApps) {
      return { kind: "allowed" as const, app, owner };
    }
    const token = readCookie(req.headers.cookie, cookieName);
    const claims = token ? await auth.verify(token, app.slug) : undefined;
    const viewer = claims ? await users.get(claims.userId) : undefined;
    if (
      viewer?.status === "active" &&
      viewer.authVersion === claims?.authVersion &&
      (viewer.id === app.ownerId || viewer.role === "admin")
    ) {
      return { kind: "allowed" as const, app, owner };
    }
    return { kind: "login" as const, app };
  };

  const upstreamHeaders = (req: http.IncomingMessage, app: AppRecord) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && value !== undefined) {
        headers[name] = value;
      }
    }
    const cookies = stripCookie(req.headers.cookie, cookieName);
    if (cookies) {
      headers.cookie = cookies;
    } else {
      delete headers.cookie;
    }
    const forwarded = [req.headers["x-forwarded-for"], req.socket.remoteAddress]
      .flat()
      .filter(Boolean)
      .join(", ");
    headers["x-forwarded-for"] = forwarded;
    headers["x-forwarded-host"] = req.headers.host ?? "";
    headers["x-forwarded-proto"] = secure ? "https" : "http";
    // Development servers commonly accept only localhost Host headers.
    headers.host = "localhost:" + app.port;
    return headers;
  };

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://preview.invalid");
    if (url.pathname === "/__dev-mcp/tls-allowed") {
      // Caddy on-demand TLS asks before issuing a certificate.
      const slug = slugFor(url.searchParams.get("domain") ?? "");
      const allowed = slug ? !!(await apps.get(slug)) : false;
      res.writeHead(allowed ? 200 : 404, { "content-type": "text/plain" });
      res.end(allowed ? "ok\n" : "unknown app\n");
      return;
    }
    const target = await resolve(req);
    if (target.kind === "missing") {
      return page(
        res,
        404,
        "앱을 찾을 수 없습니다",
        "주소를 다시 확인해 주세요.",
      );
    }
    if (url.pathname === "/__dev-mcp/auth") {
      const entry = auth.redeem(
        url.searchParams.get("code") ?? "",
        target.app.slug,
      );
      const viewer = entry ? await users.get(entry.userId) : undefined;
      if (
        !entry ||
        viewer?.status !== "active" ||
        viewer.authVersion !== entry.authVersion ||
        (viewer.id !== target.app.ownerId && viewer.role !== "admin")
      ) {
        return page(
          res,
          403,
          "앱을 열 수 없습니다",
          "인증 링크가 만료되었거나 이 앱을 볼 권한이 없습니다. 다시 열어 주세요.",
        );
      }
      await audit.write({
        event: "app_preview_authorized",
        userId: viewer.id,
        app: target.app.slug,
      });
      res.writeHead(303, {
        location: entry.returnTo,
        "set-cookie": `${cookieName}=${await auth.token(target.app.slug, viewer)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL_MS / 1000}${secure ? "; Secure" : ""}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    if (target.kind === "login") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return page(
          res,
          401,
          "로그인이 필요합니다",
          "앱을 먼저 브라우저에서 열어 주세요.",
        );
      }
      const authorize = new URL("/preview/authorize", config.publicBaseUrl);
      authorize.searchParams.set("app", target.app.slug);
      authorize.searchParams.set("return", url.pathname + url.search);
      res.writeHead(303, {
        location: authorize.toString(),
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    const tunnel = await runners
      .forUser(target.owner)
      .tunnel(target.app.port, "preview:" + target.app.slug);
    if (!(tunnel instanceof net.Socket)) {
      return page(
        res,
        502,
        "앱 서버가 실행 중이 아닙니다",
        `실행 환경의 ${target.app.port}번 포트에서 응답이 없습니다. 콘솔의 앱 화면에서 앱을 시작해 주세요.`,
      );
    }
    const upstream = http.request(
      {
        method: req.method,
        path: req.url,
        headers: upstreamHeaders(req, target.app),
        createConnection: () => {
          process.nextTick(() => tunnel.resume());
          return tunnel;
        },
      },
      (response) => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (HOP_BY_HOP.has(name) || value === undefined) {
            continue;
          }
          headers[name] =
            name === "set-cookie"
              ? (value as string[]).filter(
                  (cookie) => !cookie.trim().startsWith(cookieName + "="),
                )
              : value;
        }
        res.writeHead(
          response.statusCode ?? 502,
          response.statusMessage,
          headers,
        );
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) {
        res.destroy();
      } else {
        page(
          res,
          502,
          "앱 서버 응답이 끊겼습니다",
          "잠시 후 다시 시도해 주세요.",
        );
      }
    });
    req.pipe(upstream);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        page(res, 502, "앱을 열지 못했습니다", "잠시 후 다시 시도해 주세요.");
      } else {
        res.destroy();
      }
    });
  });
  // WebSockets (for example development hot reload) pass through as raw bytes.
  server.on("upgrade", (req, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      const target = await resolve(req);
      if (target.kind !== "allowed") {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const tunnel = await runners
        .forUser(target.owner)
        .tunnel(target.app.port, "preview:" + target.app.slug);
      if (!(tunnel instanceof net.Socket)) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
      }
      const headers = upstreamHeaders(req, target.app);
      headers.connection = "Upgrade";
      headers.upgrade = req.headers.upgrade ?? "websocket";
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of [value].flat()) {
          if (item !== undefined && !/[\r\n]/.test(String(item))) {
            lines.push(`${name}: ${item}`);
          }
        }
      }
      tunnel.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) {
        tunnel.write(head);
      }
      tunnel.on("error", () => socket.destroy());
      socket.on("close", () => tunnel.destroy());
      tunnel.on("close", () => socket.destroy());
      tunnel.pipe(socket);
      socket.pipe(tunnel);
      tunnel.resume();
    })().catch(() => socket.destroy());
  });
  return server;
}

function readCookie(header: string | undefined, name: string): string {
  return (
    (header ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}

function stripCookie(header: string | undefined, name: string): string {
  return (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(name + "="))
    .join("; ");
}

function page(
  res: http.ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character]!,
    );
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "cache-control": "no-store",
  });
  res.end(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Dev MCP</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f3f4f7;color:#1c2130}main{max-width:420px;padding:32px;background:#fff;border:1px solid #e2e5eb;border-radius:14px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#5a6172;line-height:1.7}@media (prefers-color-scheme:dark){body{background:#12151c;color:#e7e9ee}main{background:#1a1e27;border-color:#2b303b}p{color:#a6adbb}}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`,
  );
}
