import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import {
  NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isLegacyRequest,
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import type { GatewayConfig, Scope } from "./config.ts";
import { AuthStore, type TokenInfo } from "./auth-store.ts";
import { AuditLogger } from "./audit.ts";
import { installOAuthRoutes } from "./oauth.ts";
import { IpcClient } from "./ipc-client.ts";
import { createMcpServer } from "./mcp-tools.ts";
import { errorPage, landingPage, sendPage } from "./pages.ts";
import { UserStore } from "./user-store.ts";
import { RunnerRouter } from "./runner-router.ts";
import { installAccountRoutes } from "./account-routes.ts";
import { LoginLimiter } from "./login-limiter.ts";
import { SettingsStore } from "./settings-store.ts";
import { installAdminRoutes } from "./admin-routes.ts";
import { GoogleLogin, type GoogleProvider } from "./google-login.ts";
import { installGoogleRoutes } from "./google-routes.ts";
import { installTelemetryRoutes } from "./telemetry-routes.ts";
import { RunnerTelemetryStore } from "./telemetry-store.ts";
import { InstallationStore } from "./installation-store.ts";
import { AppStore } from "./app-store.ts";
import { AppService } from "./apps.ts";
import { PreviewAuth } from "./preview-proxy.ts";
import { installPreviewRoutes } from "./preview-routes.ts";
import { installSshRoutes } from "./ssh-routes.ts";
import { SshAccessStore } from "./ssh-access-store.ts";
import type { McpSessionManager } from "./mcp-sessions.ts";
import { McpSessionRegistry } from "./mcp-session-registry.ts";
import {
  mcpMessageKind,
  safeMcpMethod,
  safeMcpTool,
  type McpFailure,
} from "./mcp-audit.ts";

interface McpSession {
  createdAt: number;
  lastSeenAt: number;
  actor: string;
  userId: string;
  authVersion: number;
  scopeKey: string;
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
}

export interface AppDependencies {
  ipc?: IpcClient;
  users?: UserStore;
  google?: GoogleProvider;
  telemetry?: RunnerTelemetryStore;
  // Shared with the onboarding listener: JSON stores serialize writes per
  // instance only.
  settings?: SettingsStore;
  audit?: AuditLogger;
  installation?: InstallationStore;
  // Shared with the preview listener (one-time codes are held in memory).
  apps?: AppStore;
  previewAuth?: PreviewAuth;
  sshAccess?: SshAccessStore;
}

export function createApp(
  config: GatewayConfig,
  dependencies: AppDependencies = {},
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  const auth = new AuthStore(config.dataDir);
  const audit = dependencies.audit ?? new AuditLogger(config.dataDir);
  const users = dependencies.users ?? new UserStore(config.dataDir);
  const runners = new RunnerRouter(config, dependencies.ipc);
  const appStore = dependencies.apps ?? new AppStore(config.dataDir);
  const apps = new AppService(appStore, runners, config);
  const previewAuth =
    dependencies.previewAuth ?? new PreviewAuth(config.dataDir);
  const loginLimiter = new LoginLimiter();
  const registry = new McpSessionRegistry<McpSession>((session) =>
    session.server.close(),
  );
  const sessions = registry.sessions;

  const forgetSession = (sessionId: string, session: McpSession): void => {
    registry.forget(sessionId, session);
  };

  const closeSession = async (
    sessionId: string,
    session: McpSession,
  ): Promise<void> => {
    forgetSession(sessionId, session);
    await session.server.close();
  };

  const mcpSessions: McpSessionManager = {
    list: (userId) =>
      [...sessions]
        .filter(([, session]) => session.userId === userId)
        .map(([id, session]) => ({
          id,
          clientId: session.actor,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
        })),
    close: async (userId, filter = {}) => {
      await Promise.all(
        [...sessions]
          .filter(
            ([id, session]) =>
              session.userId === userId &&
              (!filter.id || id === filter.id) &&
              (!filter.clientId || session.actor === filter.clientId),
          )
          .map(([id, session]) => closeSession(id, session)),
      );
    },
  };

  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
      index: false,
    }),
  );
  const settings = dependencies.settings ?? new SettingsStore(config.dataDir);
  const installation =
    dependencies.installation ??
    new InstallationStore(
      config.dataDir,
      config.runnerStatusDir ?? "/runner-status",
    );
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
  installAccountRoutes(app, config, users, runners, settings, !!google);
  installSshRoutes(
    app,
    config,
    users,
    dependencies.sshAccess ?? new SshAccessStore(config.dataDir),
    audit,
  );
  installTelemetryRoutes(
    app,
    config,
    users,
    dependencies.telemetry ??
      new RunnerTelemetryStore(config.runnerStatusDir ?? "/runner-status"),
  );
  installPreviewRoutes(app, config, users, appStore, previewAuth);
  installAdminRoutes(
    app,
    config,
    users,
    auth,
    runners,
    audit,
    settings,
    installation,
    apps,
    mcpSessions,
  );
  installOAuthRoutes(app, config, auth, audit, users, !!google);

  app.get("/", (_req, res) => {
    return sendPage(res, 200, landingPage(config.publicBaseUrl));
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  const recordHttpFailure = (req: Request, res: Response): void => {
    if (
      res.locals.mcpFailureAudited ||
      (res.statusCode < 400 && !res.locals.mcpFailure)
    ) {
      return;
    }
    res.locals.mcpFailureAudited = true;
    const failure: McpFailure =
      res.locals.mcpFailure ?? transportHttpFailure(req, res.statusCode);
    const principal = res.locals.mcpPrincipal as TokenInfo | undefined;
    void audit
      .write({
        event: "mcp_error",
        actor: principal
          ? `${principal.userId}:${principal.clientId}`
          : "unauthenticated",
        userId: principal?.userId,
        clientId: principal?.clientId,
        sessionId: auditedSessionHeader(req),
        sessionHeaderPresent: !!sessionHeader(req),
        requestMethod: safeMcpMethod(req.body?.method),
        requestKind: mcpMessageKind(req.body),
        tool: safeMcpTool(req.body?.params?.name),
        httpMethod: req.method,
        httpStatus: res.statusCode,
        rpcErrorCode: res.locals.mcpRpcErrorCode,
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(
          req.header("mcp-protocol-version") ?? "",
        )
          ? req.header("mcp-protocol-version")
          : undefined,
        ok: false,
        ...failure,
      })
      .catch(() => undefined);
  };
  app.all("/mcp", (req, res, next) => {
    res.on("finish", () => recordHttpFailure(req, res));
    next();
  });
  app.post("/mcp", express.json({ limit: "2mb" }), async (req, res) => {
    const token = await authenticate(req, res, auth, config, users);
    if (!token) {
      return;
    }
    try {
      // The SDK classifies malformed modern claims as modern too, so a bad
      // envelope cannot fall through to the legacy session/initialize path.
      const webRequest = await toWebRequest(req, req.body);
      if (!(await isLegacyRequest(webRequest, req.body))) {
        const modern = createMcpHandler(
          () =>
            createMcpServer({
              scopes: token.scopes,
              actor: `${token.userId}:${token.clientId}`,
              principal: {
                userId: token.userId,
                authVersion: token.authVersion,
              },
              clientId: token.clientId,
              ipc: runners.forUser(token.user),
              audit,
              protocolEra: "modern",
              failureRecorded: () => {
                res.locals.mcpFailureAudited = true;
              },
              apps: {
                service: apps,
                owner: token.user,
                publicAllowed: async () => (await settings.read()).publicApps,
              },
              resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
            }),
          { legacy: "reject", maxRequestBodySize: 2 * 1024 * 1024 },
        );
        try {
          await toNodeHandler({
            fetch: async (request, options) => {
              const response = await modern.fetch(request, options);
              if (
                response.status >= 400 &&
                response.headers
                  .get("content-type")
                  ?.includes("application/json")
              ) {
                const reply = await response
                  .clone()
                  .json()
                  .catch(() => undefined);
                const code = reply?.error?.code;
                if (typeof code === "number") {
                  res.locals.mcpRpcErrorCode = code;
                  res.locals.mcpFailure = modernHttpFailure(code);
                }
              }
              return response;
            },
          })(req, res, req.body);
        } finally {
          await modern.close();
        }
        return;
      }
      const sessionId = sessionHeader(req);
      if (sessionId) {
        const session = authorizedSession(sessions, sessionId, token, res);
        if (!session) {
          return;
        }
        const endRequest = registry.begin(session);
        try {
          await session.transport.handleRequest(req, res, req.body);
        } finally {
          endRequest();
        }
        return;
      }
      if (!isInitializeRequest(req.body)) {
        res.locals.mcpFailure = {
          stage: "session",
          errorCode: "MCP_SESSION_ID_REQUIRED",
          message: "Mcp-Session-Id is required for non-initialization requests",
        };
        sendMcpError(
          res,
          400,
          -32000,
          "Mcp-Session-Id is required for non-initialization requests",
        );
        return;
      }

      const releaseReservation = registry.reserve(token.userId, token.clientId);
      if (!releaseReservation) {
        res.locals.mcpFailure = {
          stage: "session",
          errorCode: "MCP_SESSION_LIMIT_REACHED",
          message:
            "All available MCP sessions are busy; retry initialization later",
        };
        res.setHeader("Retry-After", "5");
        sendMcpError(
          res,
          429,
          -32000,
          "MCP session limit reached; retry later",
        );
        return;
      }
      let session: McpSession;
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (createdSessionId) => {
            releaseReservation();
            registry.register(createdSessionId, session);
          },
          onsessionclosed: (closedSessionId) => {
            forgetSession(closedSessionId, session);
          },
        });
        const server = createMcpServer({
          scopes: token.scopes,
          actor: `${token.userId}:${token.clientId}`,
          principal: { userId: token.userId, authVersion: token.authVersion },
          clientId: token.clientId,
          ipc: runners.forUser(token.user),
          audit,
          requestStarted: () => registry.begin(session),
          apps: {
            service: apps,
            owner: token.user,
            publicAllowed: async () => (await settings.read()).publicApps,
          },
          resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
        });
        session = {
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
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
      } finally {
        releaseReservation();
      }
    } catch (error) {
      res.locals.mcpFailure = {
        stage: "handler",
        errorCode: "MCP_INTERNAL_ERROR",
        message: "MCP request handler failed",
      };
      if (!res.headersSent) {
        sendMcpError(res, 500, -32603, "Internal server error");
      } else {
        recordHttpFailure(req, res);
      }
    }
  });
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", async (req: Request, res: Response) => {
      const token = await authenticate(req, res, auth, config, users);
      if (!token) {
        return;
      }
      const revision = req.header("mcp-protocol-version") ?? "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(revision) && revision >= "2026-01-01") {
        res.locals.mcpFailure = {
          stage: "transport",
          errorCode: "MCP_HTTP_METHOD_NOT_ALLOWED",
          message: "Modern MCP requests require HTTP POST",
        };
        res.setHeader("Allow", "POST");
        sendMcpError(res, 405, -32600, "Modern MCP requests require HTTP POST");
        return;
      }
      const sessionId = sessionHeader(req);
      if (!sessionId) {
        res.locals.mcpFailure = {
          stage: "session",
          errorCode: "MCP_SESSION_ID_REQUIRED",
          message: "Mcp-Session-Id header is required",
        };
        sendMcpError(res, 400, -32000, "Mcp-Session-Id header is required");
        return;
      }
      const session = authorizedSession(sessions, sessionId, token, res);
      if (!session) {
        return;
      }
      registry.touch(session);
      // GET streams remain usable between protocol requests. A dropped HTTP
      // connection does not release the separate pin held by a tool request.
      const endStream = method === "get" ? registry.begin(session) : undefined;
      if (endStream) {
        res.once("finish", endStream);
        res.once("close", endStream);
      }
      try {
        await session.transport.handleRequest(req, res);
      } catch (error) {
        endStream?.();
        res.locals.mcpFailure = {
          stage: "handler",
          errorCode: "MCP_INTERNAL_ERROR",
          message: "MCP request handler failed",
        };
        if (!res.headersSent) {
          sendMcpError(res, 500, -32603, "Internal server error");
        } else {
          recordHttpFailure(req, res);
        }
      }
    });
  }
  app.use(
    "/mcp",
    async (
      error: unknown,
      req: Request,
      res: Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        res.locals.mcpFailure = {
          stage: "handler",
          errorCode: "MCP_INTERNAL_ERROR",
          message: "MCP request failed after response headers were sent",
        };
        recordHttpFailure(req, res);
        next(error);
        return;
      }
      const kind = (error as { type?: string })?.type;
      const tooLarge = kind === "entity.too.large";
      const invalidJson = kind === "entity.parse.failed";
      // The JSON parser runs before authentication. Recover only persisted
      // principal metadata to attribute parser errors without logging headers.
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(
        req.header("authorization") ?? "",
      );
      if (match?.[1] && !res.locals.mcpPrincipal) {
        res.locals.mcpPrincipal = (await auth.inspectAccess(match[1]))?.token;
      }
      res.locals.mcpFailure = {
        stage: "http_input",
        errorCode: tooLarge
          ? "MCP_BODY_TOO_LARGE"
          : invalidJson
            ? "MCP_INVALID_JSON"
            : "MCP_INTERNAL_ERROR",
        message: tooLarge
          ? "MCP request body exceeds the size limit"
          : invalidJson
            ? "MCP request body is not valid JSON"
            : "MCP request could not be processed",
      };
      sendMcpError(
        res,
        tooLarge ? 413 : invalidJson ? 400 : 500,
        invalidJson ? -32700 : -32603,
        res.locals.mcpFailure.message,
      );
    },
  );
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

function auditedSessionHeader(req: Request): string | undefined {
  const value = sessionHeader(req);
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function transportHttpFailure(req: Request, status: number): McpFailure {
  let errorCode = "MCP_HTTP_REJECTED";
  let message = "MCP HTTP request was rejected by the transport";
  if (status === 406) {
    errorCode = "MCP_ACCEPT_HEADER_INVALID";
    message = "Accept header does not support the required MCP response types";
  } else if (status === 415) {
    errorCode = "MCP_CONTENT_TYPE_INVALID";
    message = "Content-Type must be application/json for MCP requests";
  } else if (
    status === 400 &&
    req.header("mcp-protocol-version") &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(req.header("mcp-protocol-version")!)
  ) {
    errorCode = "MCP_PROTOCOL_VERSION_UNSUPPORTED";
    message = "MCP protocol version is not supported";
  }
  return { stage: "transport", errorCode, message };
}

function scopeKey(scopes: Scope[]): string {
  return [...new Set(scopes)].sort().join(" ");
}

function modernHttpFailure(code: number): McpFailure {
  const errors: Record<number, [string, string]> = {
    [-32020]: [
      "MCP_PROTOCOL_METADATA_INVALID",
      "MCP headers and request metadata are missing or inconsistent",
    ],
    [-32021]: [
      "MCP_CLIENT_CAPABILITY_REQUIRED",
      "MCP request requires a declared client capability",
    ],
    [-32022]: [
      "MCP_PROTOCOL_VERSION_UNSUPPORTED",
      "MCP protocol version is not supported",
    ],
    [-32601]: ["MCP_METHOD_NOT_FOUND", "MCP method is not supported"],
    [-32602]: ["MCP_INVALID_PARAMS", "MCP request parameters are invalid"],
  };
  const [errorCode, message] = errors[code] ?? [
    "MCP_PROTOCOL_ERROR",
    "MCP request was rejected by the protocol handler",
  ];
  return { stage: "protocol", errorCode, message };
}

function authorizedSession(
  sessions: Map<string, McpSession>,
  sessionId: string,
  token: TokenInfo,
  res: Response,
): McpSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) {
    res.locals.mcpFailure = {
      stage: "session",
      errorCode: "MCP_SESSION_NOT_FOUND",
      message:
        "Session not found; it may have expired, closed, or been lost on gateway restart",
    };
    sendMcpError(res, 404, -32001, "Session not found");
    return undefined;
  }
  if (session.actor !== token.clientId || session.userId !== token.userId) {
    res.locals.mcpFailure = {
      stage: "session",
      errorCode: "MCP_SESSION_OWNER_MISMATCH",
      message: "Session belongs to a different user or OAuth client",
    };
    sendMcpError(res, 404, -32001, "Session not found");
    return undefined;
  }
  if (
    session.scopeKey !== scopeKey(token.scopes) ||
    session.authVersion !== token.authVersion
  ) {
    res.locals.mcpFailure = {
      stage: "session",
      errorCode: "MCP_SESSION_AUTHORIZATION_CHANGED",
      message: "Session authorization changed; initialize a new session",
    };
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
  const checked = match?.[1] ? await auth.inspectAccess(match[1]) : undefined;
  const token = checked?.token;
  res.locals.mcpPrincipal = token;
  const user = token ? await users.get(token.userId) : undefined;
  if (
    token &&
    !checked?.errorCode &&
    user?.status === "active" &&
    user.authVersion === token.authVersion
  ) {
    return { ...token, user };
  }
  const errorCode = !authorization
    ? "MISSING_BEARER_TOKEN"
    : !match
      ? "INVALID_AUTHORIZATION_HEADER"
      : (checked?.errorCode ??
        (!user
          ? "USER_NOT_FOUND"
          : user.status !== "active"
            ? "USER_INACTIVE"
            : "AUTHORIZATION_REVOKED"));
  const messages: Record<string, string> = {
    MISSING_BEARER_TOKEN: "Bearer authorization is missing",
    INVALID_AUTHORIZATION_HEADER: "Authorization header has an invalid format",
    INVALID_ACCESS_TOKEN:
      "Access token is unknown, revoked, or no longer retained",
    ACCESS_TOKEN_EXPIRED: "Access token has expired",
    OAUTH_CLIENT_REMOVED: "OAuth client is no longer registered",
    USER_NOT_FOUND: "Token user no longer exists",
    USER_INACTIVE: "Token user is not active",
    AUTHORIZATION_REVOKED: "Token authorization version is no longer current",
  };
  res.locals.mcpFailure = {
    stage: "authentication",
    errorCode,
    message: messages[errorCode],
  };
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
