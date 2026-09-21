import type { Express, Request, Response } from "express";
import express from "express";
import { ALL_SCOPES, type GatewayConfig, type Scope } from "./config.ts";
import { AuthStore } from "./auth-store.ts";
import type { UserStore } from "./user-store.ts";
import { LoginLimiter, credentialRateKey } from "./login-limiter.ts";
import type { AuditLogger } from "./audit.ts";
import { authorizationPage, errorPage, sendPage } from "./pages.ts";
import { browserSession, cookie } from "./browser-session.ts";
import { randomToken, tokenHash } from "./crypto.ts";

export function installOAuthRoutes(
  app: Express,
  config: GatewayConfig,
  store: AuthStore,
  audit: AuditLogger,
  users: UserStore,
  loginLimiter: LoginLimiter,
  googleEnabled = false,
): void {
  const resource = `${config.publicBaseUrl}/mcp`;
  const authorizationEndpoint = `${config.publicBaseUrl}/oauth/authorize`;
  const browser = browserSession(config, users);
  const consentCookie = config.publicBaseUrl.startsWith("https:")
    ? "__Host-dev-mcp-consent"
    : "dev-mcp-consent";
  const context = async (req: Request, res: Response) => {
    const session = await browser.current(req);
    const csrf = session?.csrf ?? randomToken();
    if (!session) {
      res.cookie(browser.formCookie, csrf, {
        ...browser.cookieOptions,
        maxAge: 60 * 60_000,
      });
    }
    return {
      csrf,
      signedInUsername: session?.user.email ?? session?.user.username,
      googleEnabled,
    };
  };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Dev MCP workspace",
    });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: `${config.publicBaseUrl}/oauth/token`,
      registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
      revocation_endpoint: `${config.publicBaseUrl}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ALL_SCOPES,
    });
  });

  app.post(
    "/oauth/register",
    express.json({ limit: "32kb" }),
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        if (
          !Array.isArray(body.redirect_uris) ||
          body.redirect_uris.length < 1 ||
          body.redirect_uris.length > 10 ||
          !body.redirect_uris.every((uri) => typeof uri === "string")
        ) {
          return oauthJsonError(
            res,
            400,
            "invalid_client_metadata",
            "redirect_uris must contain 1-10 URI strings",
          );
        }
        const redirectUris = [...new Set(body.redirect_uris as string[])];
        for (const uri of redirectUris) validateRedirectUri(uri);
        if (
          body.token_endpoint_auth_method !== undefined &&
          body.token_endpoint_auth_method !== "none"
        ) {
          return oauthJsonError(
            res,
            400,
            "invalid_client_metadata",
            "Only public clients using token_endpoint_auth_method=none are supported",
          );
        }
        const client = await store.registerClient(
          typeof body.client_name === "string"
            ? body.client_name.slice(0, 200)
            : "ChatGPT",
          redirectUris,
        );
        await audit.write({
          event: "oauth_client_registered",
          clientId: client.clientId,
          redirectUris,
        });
        return res.status(201).json({
          client_id: client.clientId,
          client_id_issued_at: Math.floor(client.createdAt / 1000),
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      } catch (error) {
        return oauthJsonError(
          res,
          400,
          "invalid_client_metadata",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  app.get("/oauth/authorize", async (req, res) => {
    try {
      const responseType = query(req, "response_type");
      const clientId = query(req, "client_id");
      const redirectUri = query(req, "redirect_uri");
      const challenge = query(req, "code_challenge");
      const challengeMethod = query(req, "code_challenge_method");
      const state = optionalQuery(req, "state");
      const requestedResource = optionalQuery(req, "resource");
      if (responseType !== "code") {
        throw new OAuthRequestError(
          "unsupported_response_type",
          "Only response_type=code is supported",
        );
      }
      if (
        challengeMethod !== "S256" ||
        challenge.length < 43 ||
        challenge.length > 128
      ) {
        throw new OAuthRequestError("invalid_request", "PKCE S256 is required");
      }
      if (requestedResource && requestedResource !== resource) {
        throw new OAuthRequestError(
          "invalid_target",
          "The requested resource is not this MCP endpoint",
        );
      }
      const client = await store.client(clientId);
      if (!client) {
        throw new OAuthRequestError("unauthorized_client", "Unknown client_id");
      }
      if (!client.redirectUris.includes(redirectUri)) {
        throw new OAuthRequestError(
          "invalid_request",
          "redirect_uri is not registered",
        );
      }
      const scopes = parseScopes(
        optionalQuery(req, "scope") ?? "workspace:read",
      );
      const binding = randomToken();
      res.cookie(consentCookie, binding, {
        ...browser.cookieOptions,
        maxAge: 10 * 60_000,
      });
      const transaction = await store.createPending({
        browserBinding: tokenHash(binding),
        clientId,
        redirectUri,
        scopes,
        codeChallenge: challenge,
        ...(state ? { state } : {}),
        ...(requestedResource ? { resource: requestedResource } : {}),
        expiresAt: Date.now() + 10 * 60_000,
      });
      return sendPage(
        res,
        200,
        authorizationPage({
          transaction,
          clientName: client.clientName,
          scopes,
          authorizationEndpoint,
          ...(await context(req, res)),
        }),
        [
          authorizationEndpoint,
          new URL(redirectUri).origin,
          "'self'",
          ...(googleEnabled ? ["https://accounts.google.com"] : []),
        ],
      );
    } catch (error) {
      const oauth =
        error instanceof OAuthRequestError
          ? error
          : new OAuthRequestError(
              "invalid_request",
              error instanceof Error ? error.message : String(error),
            );
      return sendPage(
        res,
        400,
        errorPage({
          status: 400,
          title: "Authorization request rejected",
          message: oauth.message,
          code: oauth.code,
        }),
      );
    }
  });

  app.get("/oauth/consent", async (req, res) => {
    const transaction =
      typeof req.query.transaction === "string" ? req.query.transaction : "";
    const pending = await store.pendingAuthorization(transaction);
    if (
      !pending ||
      !pending.browserBinding ||
      pending.browserBinding !== tokenHash(cookie(req, consentCookie))
    ) {
      return sendPage(
        res,
        400,
        errorPage({
          status: 400,
          title: "연결 요청이 만료되었습니다",
          message: "MCP 클라이언트에서 연결을 다시 시작해 주세요.",
        }),
      );
    }
    const client = await store.client(pending.clientId);
    if (!client) {
      return sendPage(
        res,
        400,
        errorPage({
          status: 400,
          title: "연결 요청이 취소되었습니다",
          message: "클라이언트를 다시 등록해 주세요.",
        }),
      );
    }
    return sendPage(
      res,
      200,
      authorizationPage({
        transaction,
        clientName: client.clientName,
        scopes: pending.scopes,
        authorizationEndpoint,
        ...(await context(req, res)),
      }),
      [
        authorizationEndpoint,
        new URL(pending.redirectUri).origin,
        "'self'",
        ...(googleEnabled ? ["https://accounts.google.com"] : []),
      ],
    );
  });

  app.post(
    "/oauth/authorize",
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      const username =
        typeof req.body.username === "string" ? req.body.username : "";
      const rateKey = credentialRateKey(req.ip, username);
      if (
        req.body.authentication !== "session" &&
        loginLimiter.blocked(rateKey)
      ) {
        res.setHeader("Retry-After", "900");
        return sendPage(
          res,
          429,
          errorPage({
            status: 429,
            title: "Too many attempts",
            message: "Wait 15 minutes before trying to authorize again.",
          }),
        );
      }
      const transaction =
        typeof req.body.transaction === "string" ? req.body.transaction : "";
      const pending = await store.pendingAuthorization(transaction);
      if (!pending) {
        return sendPage(
          res,
          400,
          errorPage({
            status: 400,
            title: "Authorization expired",
            message:
              "Return to the requesting client and start a new connection.",
          }),
        );
      }
      const sessionMode = req.body.authentication === "session";
      const session = sessionMode ? await browser.current(req) : undefined;
      if (
        sessionMode &&
        (!session ||
          !browser.validCsrf(req, session.csrf) ||
          !pending.browserBinding ||
          pending.browserBinding !== tokenHash(cookie(req, consentCookie)))
      ) {
        return sendPage(
          res,
          403,
          errorPage({
            status: 403,
            title: "연결 승인을 확인할 수 없습니다",
            message: "로그인과 연결 요청을 다시 시작해 주세요.",
          }),
        );
      }
      if (req.body.decision === "deny") {
        await store.consumePending(transaction);
        await audit.write({
          event: "oauth_authorization_denied",
          clientId: pending.clientId,
        });
        return redirectOAuth(res, pending.redirectUri, {
          error: "access_denied",
          error_description: "The resource owner denied the request",
          state: pending.state,
        });
      }
      const password =
        typeof req.body.password === "string" ? req.body.password : "";
      if (!sessionMode) {
        loginLimiter.failed(rateKey);
      }
      const user =
        session?.user ??
        (password.length <= 256
          ? await users.authenticate(username, password)
          : undefined);
      if (!user) {
        await audit.write({
          event: "oauth_login_failed",
          clientId: pending.clientId,
          remote: req.ip,
        });
        return sendPage(
          res,
          401,
          authorizationPage({
            transaction,
            clientName:
              (await store.client(pending.clientId))?.clientName ?? "ChatGPT",
            scopes: pending.scopes,
            username,
            authorizationEndpoint,
            error:
              "아이디·비밀번호를 확인해 주세요. 승인 대기 또는 중지된 계정은 연결할 수 없습니다.",
            ...(await context(req, res)),
          }),
          [
            authorizationEndpoint,
            new URL(pending.redirectUri).origin,
            "'self'",
          ],
        );
      }
      loginLimiter.succeeded(rateKey);
      const consumed = await store.consumePending(transaction);
      if (!consumed) {
        return sendPage(
          res,
          400,
          errorPage({
            status: 400,
            title: "Authorization expired",
            message:
              "Return to the requesting client and start a new connection.",
          }),
        );
      }
      const code = await store.createCode(consumed, {
        userId: user.id,
        authVersion: user.authVersion,
      });
      await audit.write({
        event: "oauth_authorization_approved",
        userId: user.id,
        clientId: consumed.clientId,
        scopes: consumed.scopes,
      });
      return redirectOAuth(res, consumed.redirectUri, {
        code,
        state: consumed.state,
      });
    },
  );

  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const grantType =
        typeof req.body.grant_type === "string" ? req.body.grant_type : "";
      const clientId =
        typeof req.body.client_id === "string" ? req.body.client_id : "";
      if (!(await store.client(clientId))) {
        return oauthJsonError(res, 401, "invalid_client", "Unknown client_id");
      }
      if (grantType === "authorization_code") {
        const code = typeof req.body.code === "string" ? req.body.code : "";
        const redirectUri =
          typeof req.body.redirect_uri === "string"
            ? req.body.redirect_uri
            : "";
        const verifier =
          typeof req.body.code_verifier === "string"
            ? req.body.code_verifier
            : "";
        if (verifier.length < 43 || verifier.length > 128) {
          return oauthJsonError(
            res,
            400,
            "invalid_grant",
            "code_verifier is invalid",
          );
        }
        const exchanged = await store.exchangeCode({
          code,
          clientId,
          redirectUri,
          verifier,
        });
        if (!exchanged || !(await users.valid(exchanged))) {
          return oauthJsonError(
            res,
            400,
            "invalid_grant",
            "Authorization code is invalid, expired, used, or PKCE verification failed",
          );
        }
        const tokens = await store.issueTokens(
          clientId,
          exchanged.scopes,
          exchanged,
        );
        await audit.write({
          event: "oauth_token_issued",
          userId: exchanged.userId,
          clientId,
          scopes: exchanged.scopes,
        });
        return tokenResponse(res, tokens, exchanged.scopes);
      }
      if (grantType === "refresh_token") {
        const refreshToken =
          typeof req.body.refresh_token === "string"
            ? req.body.refresh_token
            : "";
        let requestedScopes: Scope[] | undefined;
        try {
          if (typeof req.body.scope === "string") {
            requestedScopes = parseScopes(req.body.scope);
          }
        } catch (error) {
          return oauthJsonError(
            res,
            400,
            "invalid_scope",
            error instanceof Error ? error.message : String(error),
          );
        }
        const refreshed = await store.refresh({
          refreshToken,
          clientId,
          ...(requestedScopes ? { requestedScopes } : {}),
        });
        if (!refreshed || !(await users.valid(refreshed))) {
          return oauthJsonError(
            res,
            400,
            "invalid_grant",
            "Refresh token is invalid, expired, or cannot grant the requested scope",
          );
        }
        await audit.write({
          event: "oauth_token_refreshed",
          userId: refreshed.userId,
          clientId,
          scopes: refreshed.scopes,
        });
        return tokenResponse(res, refreshed, refreshed.scopes);
      }
      return oauthJsonError(
        res,
        400,
        "unsupported_grant_type",
        "Supported grants are authorization_code and refresh_token",
      );
    },
  );

  app.post(
    "/oauth/revoke",
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      if (typeof req.body.token === "string") {
        await store.revoke(req.body.token);
      }
      await audit.write({ event: "oauth_token_revoked" });
      return res.status(200).end();
    },
  );
}

class OAuthRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseScopes(value: string): Scope[] {
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !ALL_SCOPES.includes(scope as Scope))
  ) {
    throw new OAuthRequestError(
      "invalid_scope",
      "One or more scopes are unsupported",
    );
  }
  return scopes as Scope[];
}
function validateRedirectUri(value: string): void {
  const url = new URL(value);
  if (url.hash || url.username || url.password) {
    throw new Error("Redirect URIs cannot contain fragments or credentials");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "Redirect URIs must use HTTPS, except loopback HTTP callbacks",
    );
  }
}
function query(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== "string") {
    throw new OAuthRequestError(
      "invalid_request",
      `${name} is required exactly once`,
    );
  }
  return value;
}
function optionalQuery(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new OAuthRequestError(
      "invalid_request",
      `${name} must be supplied exactly once`,
    );
  }
  return value;
}
function oauthJsonError(
  res: Response,
  status: number,
  error: string,
  description: string,
): Response {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ error, error_description: description });
}
function tokenResponse(
  res: Response,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  scopes: Scope[],
): Response {
  return res.json({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: scopes.join(" "),
  });
}
function redirectOAuth(
  res: Response,
  redirectUri: string,
  params: {
    code?: string;
    error?: string;
    error_description?: string;
    state?: string;
  },
): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  res.redirect(302, url.toString());
}
