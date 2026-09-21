import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig, Scope } from "./config.ts";
import { AuthStore, type TokenInfo } from "./auth-store.ts";
import { AuditLogger } from "./audit.ts";
import { installOAuthRoutes } from "./oauth.ts";
import { IpcClient } from "./ipc-client.ts";
import { createMcpServer } from "./mcp-tools.ts";
import { verifyMediaToken } from "./media.ts";
import { errorPage, landingPage, sendPage } from "./pages.ts";
import { UserStore } from "./user-store.ts";
import { RunnerRouter } from "./runner-router.ts";
import { installAccountRoutes } from "./account-routes.ts";
import { LoginLimiter } from "./login-limiter.ts";
import { SettingsStore } from "./settings-store.ts";
import { installAdminRoutes } from "./admin-routes.ts";
import { GoogleLogin, type GoogleProvider } from "./google-login.ts";
import { installGoogleRoutes } from "./google-routes.ts";

const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

interface McpSession {
  actor: string;
  userId: string;
  authVersion: number;
  scopeKey: string;
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  idleTimer?: NodeJS.Timeout;
}

export interface AppDependencies {
  ipc?: IpcClient;
  users?: UserStore;
  google?: GoogleProvider;
}

export function createApp(
  config: GatewayConfig,
  dependencies: AppDependencies = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const auth = new AuthStore(config.dataDir);
  const audit = new AuditLogger(config.dataDir);
  const users =
    dependencies.users ??
    new UserStore(config.dataDir, config.adminPasswordHash);
  const runners = new RunnerRouter(config, dependencies.ipc);
  const loginLimiter = new LoginLimiter();
  const sessions = new Map<string, McpSession>();
  app.use(async (_req, _res, next) => {
    await users.initialize();
    next();
  });

  const forgetSession = (sessionId: string, session: McpSession): void => {
    if (sessions.get(sessionId) !== session) {
      return;
    }
    sessions.delete(sessionId);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
  };

  const closeSession = async (
    sessionId: string,
    session: McpSession,
  ): Promise<void> => {
    forgetSession(sessionId, session);
    await session.server.close();
  };

  const touchSession = (sessionId: string, session: McpSession): void => {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      void closeSession(sessionId, session);
    }, SESSION_IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  };

  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
      index: false,
    }),
  );
  const settings = new SettingsStore(config.dataDir);
  const google =
    dependencies.google ??
    (config.google
      ? new GoogleLogin(
          config.google,
          config.publicBaseUrl + "/auth/google/callback",
        )
      : undefined);
  installGoogleRoutes(
    app,
    config,
    users,
    settings,
    audit,
    loginLimiter,
    google,
  );
  installAccountRoutes(
    app,
    config,
    users,
    runners,
    audit,
    loginLimiter,
    settings,
    !!google,
  );
  installAdminRoutes(app, config, users, auth, runners, audit, settings);
  installOAuthRoutes(app, config, auth, audit, users, loginLimiter, !!google);

  app.get("/", (_req, res) => {
    return sendPage(res, 200, landingPage(config.publicBaseUrl));
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/media/:token", async (req, res) => {
    const claims = verifyMediaToken(config.adminPasswordHash, req.params.token);
    if (!claims) {
      return res.status(404).send("Image URL is invalid or expired");
    }
    const user = await users.valid(claims);
    if (!user) {
      return res.status(404).send("Image URL is invalid or expired");
    }
    const result = await runners
      .forUser(user)
      .call(
        "image_read",
        { project_id: claims.projectId, path: claims.path },
        `media:${claims.actor}`,
      );
    if (!result.ok) {
      return res.status(404).send("Image is no longer available");
    }
    const image = result.data as {
      mimeType?: unknown;
      base64?: unknown;
    };
    if (
      typeof image.mimeType !== "string" ||
      typeof image.base64 !== "string"
    ) {
      return res.status(502).send("Runner returned invalid image data");
    }
    let content: Buffer;
    try {
      content = Buffer.from(image.base64, "base64");
    } catch {
      return res.status(502).send("Runner returned invalid image data");
    }
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Content-Length", content.length);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(content);
  });
  app.post("/mcp", express.json({ limit: "2mb" }), async (req, res) => {
    const token = await authenticate(req, res, auth, config, users);
    if (!token) {
      return;
    }
    try {
      const sessionId = sessionHeader(req);
      if (sessionId) {
        const session = authorizedSession(sessions, sessionId, token, res);
        if (!session) {
          return;
        }
        touchSession(sessionId, session);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!isInitializeRequest(req.body)) {
        sendMcpError(
          res,
          400,
          -32000,
          "Mcp-Session-Id is required for non-initialization requests",
        );
        return;
      }

      let session: McpSession;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (createdSessionId) => {
          sessions.set(createdSessionId, session);
          touchSession(createdSessionId, session);
        },
        onsessionclosed: (closedSessionId) => {
          forgetSession(closedSessionId, session);
        },
      });
      const server = createMcpServer({
        scopes: token.scopes,
        actor: `${token.userId}:${token.clientId}`,
        principal: { userId: token.userId, authVersion: token.authVersion },
        ipc: runners.forUser(token.user),
        audit,
        resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
        mediaBaseUrl: config.publicBaseUrl,
        mediaSigningSecret: config.adminPasswordHash,
      });
      session = {
        actor: token.clientId,
        userId: token.userId,
        authVersion: token.authVersion,
        scopeKey: scopeKey(token.scopes),
        server,
        transport,
      };
      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) {
          forgetSession(closedSessionId, session);
        }
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        await server.close();
        throw error;
      }
      if (!transport.sessionId) {
        await server.close();
      }
    } catch (error) {
      await audit.write({
        event: "mcp_error",
        actor: token.clientId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendMcpError(res, 500, -32603, "Internal server error");
      }
    }
  });
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", async (req: Request, res: Response) => {
      const token = await authenticate(req, res, auth, config, users);
      if (!token) {
        return;
      }
      const sessionId = sessionHeader(req);
      if (!sessionId) {
        sendMcpError(res, 400, -32000, "Mcp-Session-Id header is required");
        return;
      }
      const session = authorizedSession(sessions, sessionId, token, res);
      if (!session) {
        return;
      }
      touchSession(sessionId, session);
      try {
        await session.transport.handleRequest(req, res);
      } catch (error) {
        await audit.write({
          event: "mcp_error",
          actor: token.clientId,
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendMcpError(res, 500, -32603, "Internal server error");
        }
      }
    });
  }
  app.use((req, res) => {
    if (req.accepts(["html", "json"]) === "html") {
      return sendPage(
        res,
        404,
        errorPage({
          status: 404,
          title: "Page not found",
          message: "The requested page does not exist on this gateway.",
        }),
      );
    }
    return res.status(404).json({ error: "not_found" });
  });
  return app;
}

function sessionHeader(req: Request): string | undefined {
  const value = req.header("mcp-session-id")?.trim();
  return value || undefined;
}

function scopeKey(scopes: Scope[]): string {
  return [...new Set(scopes)].sort().join(" ");
}

function authorizedSession(
  sessions: Map<string, McpSession>,
  sessionId: string,
  token: TokenInfo,
  res: Response,
): McpSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) {
    sendMcpError(res, 404, -32001, "Session not found");
    return undefined;
  }
  if (session.actor !== token.clientId || session.userId !== token.userId) {
    sendMcpError(res, 404, -32001, "Session not found");
    return undefined;
  }
  if (
    session.scopeKey !== scopeKey(token.scopes) ||
    session.authVersion !== token.authVersion
  ) {
    sendMcpError(
      res,
      403,
      -32003,
      "Session authorization changed; initialize a new session",
    );
    return undefined;
  }
  return session;
}

function sendMcpError(
  res: Response,
  status: number,
  code: number,
  message: string,
): Response {
  return res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

async function authenticate(
  req: Request,
  res: Response,
  auth: AuthStore,
  config: GatewayConfig,
  users: UserStore,
): Promise<(TokenInfo & { user: import("./user-store.ts").User }) | undefined> {
  const authorization = req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  const token = match?.[1] ? await auth.access(match[1]) : undefined;
  const user = token ? await users.valid(token) : undefined;
  if (token && user) {
    return { ...token, user };
  }
  const metadata = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
  res.setHeader(
    "WWW-Authenticate",
    `Bearer resource_metadata="${metadata}", scope="workspace:read"`,
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authentication required" },
    id: null,
  });
  return undefined;
}
