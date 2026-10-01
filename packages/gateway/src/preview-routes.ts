import type { Express } from "express";
import type { GatewayConfig } from "./config.ts";
import type { UserStore } from "./user-store.ts";
import type { AppStore } from "./app-store.ts";
import { browserSession } from "./browser-session.ts";
import { errorPage, sendPage } from "./pages.ts";
import { previewOrigin, type PreviewAuth } from "./preview-proxy.ts";

// After Google sign-in the browser may only come back to this exact shape.
export const previewAuthorizeReturn =
  /^\/preview\/authorize\?app=[a-z0-9-]{1,40}&return=[A-Za-z0-9%*+._-]{0,2048}$/;
const safePath = /^\/(?![/\\])[^\s\\]{0,2047}$/;

// Console side of private app access: confirms the signed-in viewer may open
// the app, then hands the app host a one-time code.
export function installPreviewRoutes(
  app: Express,
  config: GatewayConfig,
  users: UserStore,
  apps: AppStore,
  auth: PreviewAuth,
): void {
  const browser = browserSession(config, users);
  app.get("/preview/authorize", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const slug = typeof req.query.app === "string" ? req.query.app : "";
    const record = await apps.get(slug);
    const origin = previewOrigin(config, slug);
    if (!record || !origin) {
      return sendPage(
        res,
        404,
        errorPage({
          status: 404,
          title: "앱을 찾을 수 없습니다",
          message: "주소를 다시 확인해 주세요.",
        }),
      );
    }
    const session = await browser.current(req);
    if (!session) {
      return res.redirect(
        303,
        previewAuthorizeReturn.test(req.originalUrl)
          ? "/login?returnTo=" + encodeURIComponent(req.originalUrl)
          : "/login",
      );
    }
    if (session.user.id !== record.ownerId && session.user.role !== "admin") {
      return sendPage(
        res,
        403,
        errorPage({
          status: 403,
          title: "이 앱을 볼 수 없습니다",
          message: "앱 소유자나 관리자만 비공개 앱을 열 수 있습니다.",
        }),
      );
    }
    const requested =
      typeof req.query.return === "string" ? req.query.return : "/";
    const code = auth.issueCode(
      slug,
      session.user,
      safePath.test(requested) ? requested : "/",
    );
    return res.redirect(
      303,
      `${origin}/__dev-mcp/auth?code=${encodeURIComponent(code)}`,
    );
  });
}
