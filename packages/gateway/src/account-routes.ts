import express, { type Express, type Response } from "express";
import { browserSession, cookie } from "./browser-session.ts";
import type { SettingsStore } from "./settings-store.ts";
import { randomToken } from "./crypto.ts";
import type { GatewayConfig } from "./config.ts";
import type { UserStore } from "./user-store.ts";
import type { RunnerRouter } from "./runner-router.ts";
import { sendPage, errorPage } from "./pages.ts";
import { previewAuthorizeReturn } from "./preview-routes.ts";
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
      // Only an app authorization may be resumed after signing in here.
      const returnTo =
        typeof req.query.returnTo === "string" &&
        previewAuthorizeReturn.test(req.query.returnTo)
          ? req.query.returnTo
          : undefined;
      if (await current(req)) {
        return res.redirect(303, returnTo ?? "/account");
      }
      const csrf = randomToken();
      res.cookie(formCookie, csrf, { ...cookieOptions, maxAge: 60 * 60_000 });
      return sendPage(
        res,
        200,
        credentialsPage(
          kind,
          csrf,
          await settings.read(),
          googleEnabled,
          returnTo,
        ),
        forms,
      );
    });
    app.post("/" + kind, (_req, res) =>
      sendPage(
        res,
        kind === "login" ? 410 : 403,
        errorPage({
          status: kind === "login" ? 410 : 403,
          title: "Google로 로그인해 주세요",
          message:
            "아이디·비밀번호 로그인과 가입은 지원하지 않습니다. 로그인 화면에서 Google 인증을 진행해 주세요.",
        }),
      ),
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
        googleEnabled,
      ),
      forms,
    );
  });
  app.post("/account/password", (_req, res) =>
    sendPage(
      res,
      410,
      errorPage({
        status: 410,
        title: "비밀번호 변경은 지원하지 않습니다",
        message: "Google 계정으로 로그인해 주세요.",
      }),
    ),
  );
}
