import express, { type Express } from "express";
import type { GatewayConfig } from "./config.ts";
import type { UserStore, Principal } from "./user-store.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { AuditLogger } from "./audit.ts";
import type { GoogleProvider } from "./google-login.ts";
import type { LoginLimiter } from "./login-limiter.ts";
import { browserSession, cookie, field } from "./browser-session.ts";
import { randomToken, tokenHash } from "./crypto.ts";
import { errorPage, sendPage } from "./pages.ts";
import { pendingPage } from "./account-pages.ts";

interface LoginFlow {
  binding: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  returnTo: string;
  link?: Principal & { csrf: string };
}

export function installGoogleRoutes(
  app: Express,
  config: GatewayConfig,
  users: UserStore,
  settings: SettingsStore,
  audit: AuditLogger,
  limiter: LoginLimiter,
  google?: GoogleProvider,
): void {
  const browser = browserSession(config, users);
  const flowCookie = config.publicBaseUrl.startsWith("https:")
    ? "__Host-dev-mcp-google"
    : "dev-mcp-google";
  // Bounded, single-use, browser-bound state. Restarts safely expire unfinished logins.
  const flows = new Map<string, LoginFlow>();
  const fail = (res: express.Response, status: number, message: string) =>
    sendPage(
      res,
      status,
      errorPage({ status, title: "Google 로그인", message }),
    );
  app.post(
    "/auth/google",
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req, res) => {
      const session = await browser.current(req);
      if (
        !browser.validCsrf(
          req,
          session?.csrf ?? cookie(req, browser.formCookie),
        )
      ) {
        return fail(
          res,
          403,
          "요청을 확인할 수 없습니다. 로그인 화면에서 다시 시작해 주세요.",
        );
      }
      if (!google) {
        return fail(
          res,
          503,
          "Google 로그인이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요.",
        );
      }
      const link = field(req, "mode") === "link";
      if (link && (!session || session.user.googleLinked)) {
        return fail(
          res,
          403,
          "로그인한 기존 계정에서만 Google 계정을 연결할 수 있습니다.",
        );
      }
      const rateKey = "google-start:" + (req.ip ?? "unknown");
      if (limiter.blocked(rateKey)) {
        res.setHeader("Retry-After", "900");
        return fail(res, 429, "요청이 많습니다. 잠시 후 다시 시도해 주세요.");
      }
      for (const [key, value] of flows) {
        if (value.expiresAt <= Date.now()) {
          flows.delete(key);
        }
      }
      if (flows.size >= 2000) {
        return fail(
          res,
          503,
          "로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
      limiter.failed(rateKey);
      const state = randomToken(),
        binding = randomToken(),
        nonce = randomToken(),
        verifier = randomToken(48);
      const requested = field(req, "returnTo");
      const returnTo =
        /^\/oauth\/consent\?transaction=[A-Za-z0-9_-]{40,128}$/.test(requested)
          ? requested
          : "/account";
      flows.set(tokenHash(state), {
        binding: tokenHash(binding),
        nonce,
        verifier,
        expiresAt: Date.now() + 10 * 60_000,
        returnTo,
        ...(link && session
          ? {
              link: {
                userId: session.user.id,
                authVersion: session.user.authVersion,
                csrf: session.csrf,
              },
            }
          : {}),
      });
      res.cookie(flowCookie, binding, {
        ...browser.cookieOptions,
        maxAge: 10 * 60_000,
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      return res.redirect(303, google.authorizationUrl(state, nonce, verifier));
    },
  );

  app.get("/auth/google/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const key = tokenHash(state),
      flow = flows.get(key);
    if (
      !google ||
      !flow ||
      flow.expiresAt <= Date.now() ||
      flow.binding !== tokenHash(cookie(req, flowCookie))
    ) {
      return fail(
        res,
        400,
        "로그인 요청이 만료되었거나 이 브라우저에서 시작되지 않았습니다. 다시 시도해 주세요.",
      );
    }
    flows.delete(key);
    res.clearCookie(flowCookie, browser.cookieOptions);
    if (req.query.error !== undefined) {
      return fail(
        res,
        400,
        "Google 로그인이 취소되었습니다. 다시 시도할 수 있습니다.",
      );
    }
    if (
      typeof req.query.code !== "string" ||
      !req.query.code ||
      req.query.code.length > 4096
    ) {
      return fail(res, 400, "Google 인증 응답을 확인할 수 없습니다.");
    }
    try {
      const identity = await google.exchange(
        req.query.code,
        flow.nonce,
        flow.verifier,
      );
      let user;
      if (flow.link) {
        const current = await browser.current(req);
        if (
          !current ||
          current.user.id !== flow.link.userId ||
          current.csrf !== flow.link.csrf
        ) {
          return fail(
            res,
            403,
            "계정을 연결하려면 같은 계정으로 로그인한 상태를 유지해 주세요.",
          );
        }
        user = await users.linkGoogle(flow.link, identity);
        await audit.write({ event: "user_google_linked", userId: user.id });
      } else {
        const result = await users.googleAccount(
          identity,
          (await settings.read()).registrationOpen,
        );
        user = result.user;
        if (result.created) {
          await audit.write({
            event: "user_signup",
            userId: user.id,
            provider: "google",
          });
        }
      }
      if (user.status === "pending") {
        return sendPage(res, 200, pendingPage());
      }
      if (user.status !== "active") {
        return fail(
          res,
          403,
          "이 계정은 사용이 중지되었습니다. 관리자에게 문의해 주세요.",
        );
      }
      await users.logout(cookie(req, browser.sessionCookie));
      const session = await users.createSession(user);
      res.cookie(browser.sessionCookie, session.token, {
        ...browser.cookieOptions,
        maxAge: 8 * 60 * 60_000,
      });
      res.clearCookie(browser.formCookie, browser.cookieOptions);
      await audit.write({
        event: "user_login",
        userId: user.id,
        provider: "google",
      });
      return res.redirect(
        303,
        flow.returnTo === "/account" && user.role === "admin"
          ? "/admin"
          : flow.returnTo,
      );
    } catch {
      // Provider errors may contain codes, tokens or credentials: never serialize them.
      await audit.write({ event: "google_login_failed" });
      return fail(
        res,
        400,
        "Google 로그인을 완료하지 못했습니다. 가입 접수 상태 또는 기존 연결 여부를 확인하고 다시 시도해 주세요.",
      );
    }
  });
}
