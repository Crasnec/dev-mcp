import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bootstrapGoogleAdmin } from "../../../scripts/bootstrap-google-admin.mjs";
import type { AuditLogger } from "./audit.ts";
import type { UserStore } from "./user-store.ts";
import {
  reservedContaining,
  type InstallationStore,
} from "./installation-store.ts";
import { LoginLimiter } from "./login-limiter.ts";
import { cookie, field } from "./browser-session.ts";
import { dateLabel } from "./admin-view.ts";
import { sendPage } from "./pages.ts";
import { renderView } from "./views.ts";

// The local onboarding listener is published only on the Docker host's
// loopback interface. A one-time code from the gateway log is the boundary;
// the Host check additionally stops DNS-rebinding pages in the installer's
// browser from talking to it.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_COOKIE = "dev-mcp-onboarding";
const SESSION_TTL_MS = 60 * 60_000;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface OnboardingOptions {
  users: UserStore;
  installation: InstallationStore;
  audit: AuditLogger;
  code: string;
  googleEnabled: boolean;
  publicBaseUrl: string;
}

// 25 characters of 5 bits each, grouped for copying from a log line.
export function onboardingCode(): string {
  const characters = [...randomBytes(25)]
    .map((byte) => CODE_ALPHABET[byte & 31])
    .join("");
  return characters.match(/.{5}/g)!.join("-");
}

const normalized = (value: string) =>
  value.toUpperCase().replace(/[\s-]+/g, "");
const digest = (value: string) => createHash("sha256").update(value).digest();

class OnboardingError extends Error {}

export function createOnboardingApp(options: OnboardingOptions): Express {
  const { users, installation, audit } = options;
  const app = express();
  app.disable("x-powered-by");
  const limiter = new LoginLimiter();
  const expected = digest(normalized(options.code));
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();

  app.use((req, res, next) => {
    let hostname = "";
    try {
      hostname = new URL("http://" + (req.headers.host ?? "")).hostname;
    } catch {
      // Malformed Host headers are rejected below.
    }
    if (!LOOPBACK.has(hostname)) {
      return res
        .status(421)
        .type("text")
        .send("The onboarding page answers loopback addresses only.\n");
    }
    res.locals.origin = "http://" + req.headers.host;
    next();
  });
  app.use(
    "/assets",
    express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
      index: false,
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.use((req, res, next) => {
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.headers.origin &&
      req.headers.origin !== res.locals.origin
    ) {
      return res.status(403).type("text").send("Cross-origin request.\n");
    }
    next();
  });

  const session = (req: Request) => {
    const token = cookie(req, SESSION_COOKIE);
    const key = token && digest(token).toString("hex");
    const entry = key ? sessions.get(key) : undefined;
    if (!entry || entry.expiresAt < Date.now()) {
      return undefined;
    }
    return entry;
  };
  const page = (res: Response, status: number, view: string, model = {}) =>
    sendPage(
      res,
      status,
      renderView("onboarding/" + view, {
        title: "설치 온보딩",
        ...model,
      }),
      ["'self'"],
    );
  const requireSession = (req: Request) => {
    const current = session(req);
    if (!current || field(req, "csrf") !== current.csrf) {
      throw new OnboardingError(
        "세션이 만료되었습니다. 설치 코드를 다시 입력해 주세요.",
      );
    }
    return current;
  };

  const setupModel = async (csrf: string) => {
    const accounts = await users.list();
    const admin = accounts.find(
      (user) =>
        user.role === "admin" && user.status === "active" && user.googleLinked,
    );
    const pending = accounts
      .filter(
        (user) =>
          user.status === "pending" &&
          user.role === "user" &&
          user.googleLinked &&
          user.runner === user.id,
      )
      .map((user) => ({
        id: user.id,
        email: user.email,
        created: dateLabel(user.createdAt),
      }));
    const current = await installation.read();
    const observed = await installation.observed();
    const root = current.workspaceRoot;
    const rootStatus =
      root && observed.workspaceRoot?.path === root
        ? observed.workspaceRoot
        : undefined;
    // Rejected on save; shown if the observation arrives later.
    const overlap = root
      ? reservedContaining(root, observed.reservedWorkspaces)
      : undefined;
    const rootReady = rootStatus?.state === "ready";
    return {
      csrf,
      googleEnabled: options.googleEnabled,
      signupUrl: options.publicBaseUrl + "/signup",
      admin: admin?.email ?? admin?.username,
      pending,
      root,
      rootInput: root ?? "",
      rootChecking: !!root && !rootStatus,
      rootReady,
      rootInvalid: rootStatus?.state === "invalid",
      rootMessage: rootStatus?.message,
      overlap,
      canComplete: !!admin && (!root || (rootReady && !overlap)),
      refreshSeconds: root && !rootStatus ? 5 : undefined,
    };
  };

  app.get("/", async (req, res) => {
    const state = await installation.read();
    if (state.onboardingCompletedAt) {
      return page(res, 200, "done", {
        loginUrl: options.publicBaseUrl + "/login",
      });
    }
    const current = session(req);
    if (!current) {
      return page(res, 200, "code");
    }
    return page(res, 200, "setup", await setupModel(current.csrf));
  });

  app.post("/code", async (req, res) => {
    if ((await installation.read()).onboardingCompletedAt) {
      return res.redirect(303, "/");
    }
    const key = "onboarding-code";
    if (limiter.blocked(key)) {
      return page(res, 429, "code", {
        error:
          "입력 시도가 너무 많습니다. 15분 뒤에 다시 시도하거나 gateway를 재시작해 새 코드를 받으세요.",
      });
    }
    const supplied = digest(normalized(field(req, "code")));
    if (!timingSafeEqual(supplied, expected)) {
      limiter.failed(key);
      return page(res, 400, "code", {
        error:
          "설치 코드가 맞지 않습니다. gateway 로그의 최신 코드를 확인해 주세요.",
      });
    }
    limiter.succeeded(key);
    const token = randomBytes(32).toString("base64url");
    for (const [entry, value] of sessions) {
      if (value.expiresAt < Date.now() || sessions.size >= 20) {
        sessions.delete(entry);
      }
    }
    sessions.set(digest(token).toString("hex"), {
      csrf: randomBytes(24).toString("base64url"),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_TTL_MS,
    });
    return res.redirect(303, "/");
  });

  app.post("/admin", async (req, res) => {
    requireSession(req);
    const target = (await users.list()).find(
      (user) => user.id === field(req, "userId"),
    );
    if (!target?.email) {
      throw new OnboardingError("승인 대기 중인 Google 계정을 골라 주세요.");
    }
    try {
      await bootstrapGoogleAdmin({
        users,
        audit,
        userId: target.id,
        email: target.email,
        actor: "local_installer",
      });
    } catch {
      throw new OnboardingError(
        "이 계정을 관리자로 승인하지 못했습니다. 승인 대기 중인 Google 계정인지, 이미 활성 Google 관리자가 있는지 확인해 주세요.",
      );
    }
    return res.redirect(303, "/");
  });

  app.post("/workspace-root", async (req, res) => {
    requireSession(req);
    const value =
      field(req, "mode") === "none" ? undefined : field(req, "workspaceRoot");
    const updated = await installation.setWorkspaceRoot(value);
    await audit.write({
      event: "onboarding_workspace_root",
      actor: "local_installer",
      workspaceRoot: updated.workspaceRoot ?? null,
    });
    return res.redirect(303, "/");
  });

  app.post("/complete", async (req, res) => {
    const current = requireSession(req);
    const model = await setupModel(current.csrf);
    if (!model.canComplete) {
      throw new OnboardingError(
        "관리자 계정을 승인하고, 작업 공간 루트를 쓰는 경우 관리 서비스의 확인을 받은 뒤 완료할 수 있습니다.",
      );
    }
    const done = await installation.complete("local_installer");
    await audit.write({
      event: "onboarding_completed",
      actor: "local_installer",
      workspaceRoot: done.workspaceRoot ?? null,
    });
    sessions.clear();
    return res.redirect(303, "/");
  });

  app.use((_req, res) => page(res, 404, "code"));
  app.use(
    async (
      error: unknown,
      req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const current = session(req);
      const message =
        error instanceof Error
          ? error.message
          : "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
      if (!current) {
        return page(res, 400, "code", { error: message });
      }
      return page(res, 400, "setup", {
        ...(await setupModel(current.csrf)),
        error: message,
      });
    },
  );
  return app;
}
