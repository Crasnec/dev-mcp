import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig, Scope } from "./config.ts";
import { AuthStore, type TokenInfo } from "./auth-store.ts";
import { AuditLogger } from "./audit.ts";
import { installOAuthRoutes } from "./oauth.ts";
import { IpcClient } from "./ipc-client.ts";
import { createMcpServer } from "./mcp-tools.ts";
import { errorPage, landingPage, securityPage, sendPage } from "./pages.ts";

const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;

interface McpSession {
  actor: string;
  scopeKey: string;
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  idleTimer?: NodeJS.Timeout;
}

export function createApp(config: GatewayConfig): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const auth = new AuthStore(config.dataDir);
  const audit = new AuditLogger(config.dataDir);
  const ipc = new IpcClient(config.runnerSocket);
  const sessions = new Map<string, McpSession>();

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

  installOAuthRoutes(app, config, auth, audit);

  app.get("/", (_req, res) => {
    return sendPage(res, 200, landingPage(config.publicBaseUrl));
  });
  app.get("/security", (_req, res) => {
    return sendPage(res, 200, securityPage());
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.post("/mcp", express.json({ limit: "2mb" }), async (req, res) => {
    const token = await authenticate(req, res, auth, config);
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
        actor: token.clientId,
        ipc,
        audit,
        resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
      });
      session = {
        actor: token.clientId,
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
      const token = await authenticate(req, res, auth, config);
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
  if (session.actor !== token.clientId) {
    sendMcpError(res, 404, -32001, "Session not found");
    return undefined;
  }
  if (session.scopeKey !== scopeKey(token.scopes)) {
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
): Promise<TokenInfo | undefined> {
  const authorization = req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  const token = match?.[1] ? await auth.access(match[1]) : undefined;
  if (token) {
    return token;
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
