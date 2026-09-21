import express, { type Express, type Request, type Response } from "express";
import { browserSession, cookie, field } from "./browser-session.ts";
import type { SettingsStore } from "./settings-store.ts";
import { randomToken } from "./crypto.ts";
import type { GatewayConfig } from "./config.ts";
import type { UserStore } from "./user-store.ts";
import type { RunnerRouter } from "./runner-router.ts";
import type { AuditLogger } from "./audit.ts";
import { LoginLimiter, credentialRateKey } from "./login-limiter.ts";
import { sendPage, errorPage } from "./pages.ts";
import {
  credentialsPage,
  accountPage,
  type RunnerSummary,
} from "./account-pages.ts";

export function installAccountRoutes(
  app: Express,
  config: GatewayConfig,
  users: UserStore,
  runners: RunnerRouter,
  audit: AuditLogger,
  limiter: LoginLimiter,
  settings: SettingsStore,
  googleEnabled = false,
): void {
  const { sessionCookie, formCookie, cookieOptions, current, validCsrf } =
    browserSession(config, users);
  const forms = [
    "'self'",
    ...(googleEnabled ? ["https://accounts.google.com"] : []),
  ];
  const rejectCsrf = (res: Response) =>
    sendPage(
      res,
      403,
      errorPage({
        status: 403,
        title: "요청을 확인할 수 없어요",
        message: "화면을 새로 열고 다시 시도해 주세요.",
      }),
    );
  const summary = async (userId: string): Promise<RunnerSummary> => {
    const user = await users.get(userId);
    if (!user) {
      return { ready: false, projects: [] };
    }
    const result = await runners
      .forUser(user)
      .call("project_list", {}, user.id);
    const projects = (
      result.data as { projects?: RunnerSummary["projects"] } | undefined
    )?.projects;
    return {
      ready: result.ok && Array.isArray(projects),
      projects: Array.isArray(projects) ? projects : [],
    };
  };
  for (const kind of ["login", "signup"] as const) {
    app.get("/" + kind, async (req, res) => {
      if (await current(req)) {
        return res.redirect(303, "/account");
      }
      const csrf = randomToken();
      res.cookie(formCookie, csrf, { ...cookieOptions, maxAge: 60 * 60_000 });
      return sendPage(
        res,
        200,
        credentialsPage(kind, csrf, "", await settings.read(), googleEnabled),
        forms,
      );
    });
    app.post(
      "/" + kind,
      express.urlencoded({ extended: false, limit: "8kb" }),
      async (req, res) => {
        if (kind === "signup") {
          return sendPage(
            res,
            403,
            errorPage({
              status: 403,
              title: "Google로 가입해 주세요",
              message:
                "아이디·비밀번호 가입은 지원하지 않습니다. 회원가입 화면에서 Google 인증을 진행해 주세요.",
            }),
          );
        }
        const csrf = cookie(req, formCookie);
        if (!validCsrf(req, csrf)) {
          return rejectCsrf(res);
        }
        const username = field(req, "username");
        const key = credentialRateKey(req.ip, username);
        if (limiter.blocked(key)) {
          res.setHeader("Retry-After", "900");
          return sendPage(
            res,
            429,
            credentialsPage(
              kind,
              csrf,
              "요청이 많습니다. 15분 후 다시 시도해 주세요.",
              undefined,
              googleEnabled,
            ),
            forms,
          );
        }
        const password = field(req, "password");
        limiter.failed(key);
        const user =
          password.length <= 256
            ? await users.authenticate(username, password)
            : undefined;
        if (!user) {
          return sendPage(
            res,
            401,
            credentialsPage(
              kind,
              csrf,
              "아이디·비밀번호를 확인해 주세요. 승인 대기 또는 중지된 계정은 로그인할 수 없습니다.",
              undefined,
              googleEnabled,
            ),
            forms,
          );
        }
        const session = await users.createSession(user);
        limiter.succeeded(key);
        res.cookie(sessionCookie, session.token, {
          ...cookieOptions,
          maxAge: 8 * 60 * 60_000,
        });
        res.clearCookie(formCookie, cookieOptions);
        await audit.write({ event: "user_login", userId: user.id });
        return res.redirect(303, user.role === "admin" ? "/admin" : "/account");
      },
    );
  }
  app.post(
    "/logout",
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req, res) => {
      const session = await current(req);
      if (!session || !validCsrf(req, session.csrf)) {
        return rejectCsrf(res);
      }
      await users.logout(cookie(req, sessionCookie));
      res.clearCookie(sessionCookie, cookieOptions);
      return res.redirect(303, "/login");
    },
  );
  app.get("/account", async (req, res) => {
    const session = await current(req);
    if (!session) {
      return res.redirect(303, "/login");
    }
    return sendPage(
      res,
      200,
      accountPage(
        session.user,
        session.csrf,
        await summary(session.user.id),
        config.publicBaseUrl,
        "",
        googleEnabled,
      ),
      forms,
    );
  });
  app.post(
    "/account/password",
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req, res) => {
      const session = await current(req);
      if (!session || !validCsrf(req, session.csrf)) {
        return rejectCsrf(res);
      }
      const key = credentialRateKey(req.ip, session.user.username);
      if (limiter.blocked(key)) {
        res.setHeader("Retry-After", "900");
        return sendPage(
          res,
          429,
          errorPage({
            status: 429,
            title: "잠시 기다려 주세요",
            message: "15분 후 다시 시도해 주세요.",
          }),
        );
      }
      limiter.failed(key);
      try {
        await users.changePassword(
          session.user.id,
          field(req, "current_password"),
          field(req, "password"),
        );
        await audit.write({
          event: "user_password_changed",
          userId: session.user.id,
        });
        limiter.succeeded(key);
        res.clearCookie(sessionCookie, cookieOptions);
        return res.redirect(303, "/login");
      } catch (error) {
        return sendPage(
          res,
          400,
          accountPage(
            session.user,
            session.csrf,
            await summary(session.user.id),
            config.publicBaseUrl,
            message(error),
            googleEnabled,
          ),
          forms,
        );
      }
    },
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
}
