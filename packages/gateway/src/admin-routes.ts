import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { GatewayConfig } from "./config.ts";
import type { User, UserStore } from "./user-store.ts";
import type { AuthStore } from "./auth-store.ts";
import type { AuditLogger } from "./audit.ts";
import type { RunnerRouter } from "./runner-router.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { ProjectSummary } from "./account-pages.ts";
import { browserSession, field } from "./browser-session.ts";
import { errorPage, sendPage } from "./pages.ts";
import {
  adminView,
  dateLabel,
  pageOf,
  query,
  sortList,
  statusLabel,
  userRow,
  type AdminSession,
} from "./admin-view.ts";

interface ProcessSummary {
  id: string;
  projectId: string;
  command: string;
  status: string;
  pid: number;
  startedAt: string;
  exitCode?: number;
}
class AdminError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function installAdminRoutes(
  app: Express,
  config: GatewayConfig,
  users: UserStore,
  auth: AuthStore,
  runners: RunnerRouter,
  audit: AuditLogger,
  settings: SettingsStore,
): void {
  const router = express.Router();
  const browser = browserSession(config, users);
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));
  router.use(async (req, res, next) => {
    const session = await browser.current(req);
    if (!session) {
      return req.method === "GET"
        ? res.redirect(303, "/login")
        : sendPage(
            res,
            403,
            errorPage({
              status: 403,
              title: "로그인이 필요합니다",
              message: "다시 로그인해 주세요.",
            }),
          );
    }
    if (session.user.role !== "admin") {
      return sendPage(
        res,
        403,
        errorPage({
          status: 403,
          title: "관리자 전용 화면입니다",
          message: "내 계정 화면을 이용해 주세요.",
        }),
      );
    }
    res.locals.admin = session;
    if (req.method !== "GET" && !browser.validCsrf(req, session.csrf)) {
      return adminView(
        req,
        res,
        "dashboard",
        "admin/error",
        {
          error:
            "요청을 확인할 수 없습니다. 화면을 새로 열고 다시 시도해 주세요.",
        },
        403,
      );
    }
    next();
  });
  const actor = (res: Response) => (res.locals.admin as AdminSession).user;
  const user = async (id: string) => {
    const found = await users.get(id);
    if (!found) {
      throw new AdminError("사용자를 찾을 수 없습니다.", 404);
    }
    return found;
  };
  const selected = async (req: Request, res: Response) => {
    const owner = await user(query(req, "owner") || actor(res).id);
    const owners = (await users.list()).map((entry) => ({
      ...userRow(entry),
      selected: entry.id === owner.id,
    }));
    return { owner, owners };
  };
  const call = async (
    owner: User,
    res: Response,
    method: string,
    params: Record<string, unknown> = {},
  ) =>
    runners
      .forUser(owner)
      .call(method, params, "admin:" + actor(res).id + ":owner:" + owner.id, {
        timeoutMs: 5000,
      });
  const projectsFor = async (owner: User, res: Response) => {
    const result = await call(owner, res, "project_list");
    const projects = (
      result.data as { projects?: ProjectSummary[] } | undefined
    )?.projects;
    return {
      ready: result.ok && Array.isArray(projects),
      projects: Array.isArray(projects) ? projects : [],
    };
  };
  const processList = async (owner: User, res: Response) => {
    const result = await call(owner, res, "process_list");
    const processes = (
      result.data as { processes?: ProcessSummary[] } | undefined
    )?.processes;
    return {
      ready: result.ok && Array.isArray(processes),
      processes: Array.isArray(processes) ? processes : [],
    };
  };
  const projectFor = async (owner: User, id: string, res: Response) => {
    const state = await projectsFor(owner, res);
    if (!state.ready) {
      throw new AdminError("실행 환경에 연결할 수 없습니다.", 503);
    }
    const found = state.projects.find((project) => project.id === id);
    if (!found) {
      throw new AdminError("이 사용자의 프로젝트를 찾을 수 없습니다.", 404);
    }
    return found;
  };
  const record = (
    res: Response,
    event: string,
    details: Record<string, unknown>,
  ) => audit.write({ event, actor: actor(res).id, ...details });

  router.get("/", async (req, res) => {
    if (query(req, "user")) {
      return res.redirect(
        303,
        "/admin/runners/" + encodeURIComponent(query(req, "user")),
      );
    }
    const [all, sessions, clients, recent] = await Promise.all([
      users.list(),
      users.browserSessions(),
      auth.clients(),
      audit.recent(),
    ]);
    return adminView(req, res, "dashboard", "admin/dashboard", {
      metrics: [
        { label: "전체 사용자", value: all.length, href: "/admin/users" },
        {
          label: "승인 대기",
          value: all.filter((entry) => entry.status === "pending").length,
          href: "/admin/users?status=pending",
        },
        {
          label: "브라우저 세션",
          value: sessions.length,
          href: "/admin/connections",
        },
        {
          label: "MCP 클라이언트",
          value: clients.length,
          href: "/admin/connections",
        },
      ],
      pending: all
        .filter((entry) => entry.status === "pending")
        .slice(0, 8)
        .map(userRow),
      recent: recent.records.slice(0, 8).map((entry) => auditRow(entry, all)),
    });
  });
  router.get("/users", async (req, res) => {
    const q = query(req, "q").toLowerCase();
    const status = query(req, "status");
    const all = (await users.list()).filter(
      (entry) =>
        (!q ||
          (entry.username + " " + (entry.email ?? ""))
            .toLowerCase()
            .includes(q)) &&
        (!status || entry.status === status),
    );
    const sorted = sortList(all.map(userRow), req, [
      { key: "username", label: "사용자", value: (entry) => entry.username },
      { key: "role", label: "역할", value: (entry) => entry.roleLabel },
      { key: "status", label: "상태", value: (entry) => entry.statusLabel },
      {
        key: "created",
        label: "가입일",
        value: (entry) => entry.createdAt,
        initialDirection: "desc",
      },
    ]);
    return adminView(req, res, "users", "admin/users", {
      ...pageOf(sorted.items, req),
      q,
      sort: sorted.state,
      sortHeaders: sorted.headers,
      statuses: ["pending", "active", "disabled"].map((value) => ({
        value,
        label: statusLabel(value),
        selected: value === status,
      })),
    });
  });
  router.get("/users/:id", async (req, res) => {
    const target = await user(String(req.params.id));
    const sessions = (await users.browserSessions()).filter(
      (session) => session.userId === target.id,
    );
    return adminView(req, res, "users", "admin/user-detail", {
      target: userRow(target),
      sessionCount: sessions.length,
      statuses: ["pending", "active", "disabled"].map((value) => ({
        value,
        label: statusLabel(value),
        selected: value === target.status,
      })),
      roles: [
        { value: "user", label: "사용자", selected: target.role === "user" },
        { value: "admin", label: "관리자", selected: target.role === "admin" },
      ],
    });
  });
  router.post("/users/:id", async (req, res) => {
    const role = field(req, "role"),
      status = field(req, "status");
    if (
      (role !== "admin" && role !== "user") ||
      (status !== "pending" && status !== "active" && status !== "disabled")
    ) {
      throw new AdminError("올바른 역할과 계정 상태를 선택해 주세요.");
    }
    await users.update(actor(res).id, String(req.params.id), { role, status });
    await record(res, "user_updated", { userId: req.params.id, role, status });
    return res.redirect(
      303,
      "/admin/users/" + encodeURIComponent(String(req.params.id)) + "?saved=1",
    );
  });
  router.post("/users/:id/revoke", async (req, res) => {
    await users.revokeAccess(actor(res).id, String(req.params.id));
    await record(res, "user_access_revoked", { userId: req.params.id });
    return res.redirect(
      303,
      "/admin/users/" + encodeURIComponent(String(req.params.id)) + "?saved=1",
    );
  });

  router.get("/projects", async (req, res) => {
    const selection = await selected(req, res);
    const state = await projectsFor(selection.owner, res);
    const q = query(req, "q").toLowerCase();
    const rows = state.projects
      .filter((project) =>
        (project.name + " " + project.relativePath).toLowerCase().includes(q),
      )
      .map((project) => ({
        ...project,
        href:
          "/admin/projects/" +
          selection.owner.id +
          "/" +
          encodeURIComponent(project.id),
      }));
    const sorted = sortList(rows, req, [
      { key: "name", label: "프로젝트", value: (entry) => entry.name },
      {
        key: "path",
        label: "작업 공간 내 경로",
        value: (entry) => entry.relativePath,
      },
    ]);
    return adminView(req, res, "projects", "admin/projects", {
      ...selection,
      ...state,
      ...pageOf(sorted.items, req),
      q,
      sort: sorted.state,
      sortHeaders: sorted.headers,
    });
  });
  router.post("/projects", async (req, res) => {
    const owner = await user(field(req, "owner"));
    const name = field(req, "name").trim(),
      relativePath = field(req, "relative_path");
    if (
      !name ||
      name.length > 200 ||
      !relativePath ||
      relativePath.length > 4096
    ) {
      throw new AdminError(
        "프로젝트 이름과 작업 공간 내 경로를 입력해 주세요.",
      );
    }
    const result = await call(owner, res, "project_register", {
      name,
      relative_path: relativePath,
    });
    if (!result.ok) {
      throw new AdminError(
        result.error?.message ?? "프로젝트를 등록하지 못했습니다.",
      );
    }
    await record(res, "admin_project_registered", { userId: owner.id, name });
    return res.redirect(303, "/admin/projects?owner=" + owner.id + "&saved=1");
  });
  router.get("/projects/:owner/:id", async (req, res) => {
    const owner = await user(String(req.params.owner));
    const project = await projectFor(owner, String(req.params.id), res);
    const git = await call(owner, res, "git_read", {
      project_id: project.id,
      operation: "status",
    });
    return adminView(req, res, "projects", "admin/project-detail", {
      owner,
      project,
      gitOutput: git.ok
        ? (git.data as { output: string }).output
        : "Git 저장소 상태를 가져올 수 없습니다.",
    });
  });
  for (const operation of ["unregister", "delete"] as const) {
    router.post("/projects/:owner/:id/" + operation, async (req, res) => {
      const owner = await user(String(req.params.owner));
      const project = await projectFor(owner, String(req.params.id), res);
      if (
        operation === "delete" &&
        field(req, "confirmation") !== project.name
      ) {
        throw new AdminError(
          "영구 삭제하려면 프로젝트 이름을 정확히 입력해 주세요.",
        );
      }
      const result = await call(owner, res, "project_" + operation, {
        project_id: project.id,
      });
      if (!result.ok) {
        throw new AdminError(
          result.error?.message ?? "프로젝트 작업에 실패했습니다.",
        );
      }
      await record(res, "admin_project_" + operation, {
        userId: owner.id,
        projectId: project.id,
        name: project.name,
      });
      return res.redirect(
        303,
        "/admin/projects?owner=" + owner.id + "&saved=1",
      );
    });
  }

  router.get("/runners", async (req, res) => {
    const q = query(req, "q").toLowerCase();
    const sorted = sortList(
      (await users.list()).filter((entry) =>
        (entry.username + " " + (entry.email ?? "")).toLowerCase().includes(q),
      ),
      req,
      [
        {
          key: "username",
          label: "사용자",
          value: (entry) => entry.email ?? entry.username,
        },
        {
          key: "status",
          label: "계정 상태",
          value: (entry) => statusLabel(entry.status),
        },
      ],
    );
    const list = pageOf(sorted.items, req);
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < list.rows.length; index += 4) {
      rows.push(
        ...(await Promise.all(
          list.rows.slice(index, index + 4).map(async (owner) => {
            const state = await projectsFor(owner, res);
            return {
              ...userRow(owner),
              ...state,
              projectCount: state.projects.length,
              href: "/admin/runners/" + owner.id,
            };
          }),
        )),
      );
    }
    return adminView(req, res, "runners", "admin/runners", {
      ...list,
      rows,
      q,
      sort: sorted.state,
      sortHeaders: sorted.headers,
    });
  });
  router.get("/runners/:id", async (req, res) => {
    const owner = await user(String(req.params.id));
    const state = await projectsFor(owner, res);
    return adminView(req, res, "runners", "admin/runner-detail", {
      owner: userRow(owner),
      ...state,
      primary: owner.runner === "primary",
      provisionCommand: "./scripts/provision-user.sh " + owner.id,
      stopCommand: "docker stop dev-mcp-user-" + owner.id,
    });
  });
  router.get("/processes", async (req, res) => {
    const selection = await selected(req, res);
    const state = await processList(selection.owner, res);
    const q = query(req, "q").toLowerCase(),
      status = query(req, "status");
    const rows = state.processes
      .filter(
        (entry) =>
          entry.command.toLowerCase().includes(q) &&
          (!status || entry.status === status),
      )
      .map((entry) => ({
        ...entry,
        statusLabel: statusLabel(entry.status),
        startedLabel: dateLabel(entry.startedAt),
        href:
          "/admin/processes/" +
          selection.owner.id +
          "/" +
          encodeURIComponent(entry.id),
      }));
    const sorted = sortList(
      rows,
      req,
      [
        { key: "command", label: "명령", value: (entry) => entry.command },
        { key: "status", label: "상태", value: (entry) => entry.statusLabel },
        { key: "pid", label: "PID", value: (entry) => entry.pid },
        {
          key: "started",
          label: "시작 시각",
          value: (entry) => entry.startedAt,
          initialDirection: "desc",
        },
      ],
      { defaultKey: "started", defaultDirection: "desc" },
    );
    return adminView(req, res, "processes", "admin/processes", {
      ...selection,
      ...state,
      ...pageOf(sorted.items, req),
      q,
      sort: sorted.state,
      sortHeaders: sorted.headers,
      statuses: ["running", "exited", "stopped"].map((value) => ({
        value,
        label: statusLabel(value),
        selected: status === value,
      })),
    });
  });
  router.get("/processes/:owner/:id", async (req, res) => {
    const owner = await user(String(req.params.owner));
    const state = await processList(owner, res);
    if (!state.ready) {
      throw new AdminError("실행 환경에 연결할 수 없습니다.", 503);
    }
    const process = state.processes.find((entry) => entry.id === req.params.id);
    if (!process) {
      throw new AdminError("이 사용자의 프로세스를 찾을 수 없습니다.", 404);
    }
    const cursor =
      typeof req.query.cursor === "string"
        ? req.query.cursor.slice(0, 4096)
        : undefined;
    const logs = await call(owner, res, "process_logs", {
      process_id: process.id,
      ...(cursor ? { cursor } : {}),
    });
    return adminView(req, res, "processes", "admin/process-detail", {
      owner,
      process: {
        ...process,
        statusLabel: statusLabel(process.status),
        startedLabel: dateLabel(process.startedAt),
      },
      running: process.status === "running",
      output: logs.ok
        ? (logs.data as { output: string }).output
        : logs.error?.message,
      nextLog: logs.continuation
        ? "/admin/processes/" +
          owner.id +
          "/" +
          encodeURIComponent(process.id) +
          "?cursor=" +
          encodeURIComponent(logs.continuation)
        : undefined,
    });
  });
  router.post("/processes/:owner/:id/stop", async (req, res) => {
    const owner = await user(String(req.params.owner));
    const result = await call(owner, res, "process_stop", {
      process_id: String(req.params.id),
    });
    if (!result.ok) {
      throw new AdminError(
        result.error?.message ?? "프로세스를 종료하지 못했습니다.",
      );
    }
    await record(res, "admin_process_stopped", {
      userId: owner.id,
      processId: req.params.id,
    });
    return res.redirect(
      303,
      "/admin/processes/" +
        owner.id +
        "/" +
        encodeURIComponent(String(req.params.id)) +
        "?saved=1",
    );
  });

  router.get("/connections", async (req, res) => {
    const all = await users.list();
    const names = new Map(
      all.map((entry) => [entry.id, entry.email ?? entry.username]),
    );
    const [sessions, clients, grants] = await Promise.all([
      users.browserSessions(),
      auth.clients(),
      auth.connectionSummary(
        all
          .filter((entry) => entry.status === "active")
          .map((entry) => ({
            userId: entry.id,
            authVersion: entry.authVersion,
          })),
      ),
    ]);
    const q = query(req, "q").toLowerCase();
    const clientRows = clients
      .filter((client) =>
        (client.clientName + " " + client.clientId).toLowerCase().includes(q),
      )
      .map((client) => ({
        ...client,
        createdLabel: dateLabel(client.createdAt),
        grants: grants
          .filter((grant) => grant.clientId === client.clientId)
          .map((grant) => ({
            ...grant,
            username: names.get(grant.userId) ?? "알 수 없음",
          })),
      }));
    const sortedClients = sortList(
      clientRows,
      req,
      [
        {
          key: "name",
          label: "이름",
          value: (entry) => entry.clientName,
        },
        {
          key: "created",
          label: "등록일",
          value: (entry) => entry.createdAt,
          initialDirection: "desc",
        },
      ],
      {
        defaultKey: "created",
        defaultDirection: "desc",
        sortKey: "clientSort",
        directionKey: "clientDirection",
      },
    );
    const sessionRows = sessions
      .filter((session) =>
        (names.get(session.userId) ?? "").toLowerCase().includes(q),
      )
      .map((session) => ({
        ...session,
        username: names.get(session.userId) ?? "알 수 없음",
        createdLabel: dateLabel(session.createdAt),
        expiresLabel: dateLabel(session.expiresAt),
      }));
    const sortedSessions = sortList(
      sessionRows,
      req,
      [
        {
          key: "username",
          label: "사용자",
          value: (entry) => entry.username,
        },
        {
          key: "created",
          label: "로그인 시각",
          value: (entry) => entry.createdAt,
          initialDirection: "desc",
        },
        {
          key: "expires",
          label: "만료 시각",
          value: (entry) => entry.expiresAt,
          initialDirection: "desc",
        },
      ],
      {
        defaultKey: "created",
        defaultDirection: "desc",
        sortKey: "sessionSort",
        directionKey: "sessionDirection",
        pageKey: "sessionsPage",
      },
    );
    const sessionPage = pageOf(sortedSessions.items, req, "sessionsPage");
    return adminView(req, res, "connections", "admin/connections", {
      ...pageOf(sortedClients.items, req),
      q,
      clientSort: sortedClients.state,
      clientSortHeaders: sortedClients.headers,
      sessions: sessionPage.rows,
      sessionSort: sortedSessions.state,
      sessionSortHeaders: sortedSessions.headers,
      sessionPaging: { pagination: sessionPage.pagination },
    });
  });
  router.post("/connections/sessions/:id/revoke", async (req, res) => {
    await users.revokeBrowserSession(actor(res).id, String(req.params.id));
    await record(res, "admin_session_revoked", {});
    return res.redirect(303, "/admin/connections?saved=1");
  });
  router.post("/connections/clients/:id/delete", async (req, res) => {
    const id = String(req.params.id);
    if (field(req, "confirmation") !== id) {
      throw new AdminError(
        "연결을 해제하려면 클라이언트 ID를 정확히 입력해 주세요.",
      );
    }
    await auth.removeClient(id);
    await record(res, "admin_client_removed", { clientId: id });
    return res.redirect(303, "/admin/connections?saved=1");
  });
  router.get("/audit", async (req, res) => {
    const [recent, all] = await Promise.all([audit.recent(), users.list()]);
    const q = query(req, "q").toLowerCase(),
      event = query(req, "event");
    const rows = recent.records
      .map((entry) => auditRow(entry, all))
      .filter(
        (entry) =>
          (!event || entry.event === event) &&
          (!q || Object.values(entry).join(" ").toLowerCase().includes(q)),
      );
    const sorted = sortList(
      rows,
      req,
      [
        {
          key: "at",
          label: "시각",
          value: (entry) => entry.sortAt,
          initialDirection: "desc",
        },
        { key: "event", label: "이벤트", value: (entry) => entry.event },
        { key: "actor", label: "실행자", value: (entry) => entry.actor },
      ],
      { defaultKey: "at", defaultDirection: "desc" },
    );
    return adminView(req, res, "audit", "admin/audit", {
      ...pageOf(sorted.items, req),
      q,
      event,
      sort: sorted.state,
      sortHeaders: sorted.headers,
      clipped: recent.clipped,
      events: [
        ...new Set(recent.records.map((entry) => String(entry.event ?? ""))),
      ]
        .sort()
        .map((value) => ({ value, selected: value === event })),
    });
  });
  router.get("/settings", async (req, res) => {
    return adminView(req, res, "settings", "admin/settings", {
      settings: await settings.read(),
      publicBaseUrl: config.publicBaseUrl,
    });
  });
  router.post("/settings", async (req, res) => {
    await settings.save({
      registrationOpen: field(req, "registrationOpen") === "on",
      registrationMessage: field(req, "registrationMessage"),
    });
    await record(res, "admin_settings_updated", {
      registrationOpen: field(req, "registrationOpen") === "on",
    });
    return res.redirect(303, "/admin/settings?saved=1");
  });
  router.use((req, res) =>
    adminView(
      req,
      res,
      "dashboard",
      "admin/error",
      { error: "관리자 페이지를 찾을 수 없습니다." },
      404,
    ),
  );
  router.use(
    (error: unknown, req: Request, res: Response, _next: NextFunction) => {
      return adminView(
        req,
        res,
        req.path.split("/")[1] || "dashboard",
        "admin/error",
        {
          error:
            error instanceof Error
              ? error.message
              : "요청을 처리하지 못했습니다.",
        },
        error instanceof AdminError ? error.status : 400,
      );
    },
  );
  app.use("/admin", router);
}

function auditRow(entry: Record<string, unknown>, users: User[]) {
  const actorId =
    typeof entry.actor === "string"
      ? entry.actor
      : typeof entry.userId === "string"
        ? entry.userId
        : "";
  const actor =
    users.find(
      (user) => actorId === user.id || actorId.startsWith(user.id + ":"),
    )?.username ?? actorId;
  const details: Record<string, unknown> = {};
  for (const key of [
    "userId",
    "clientId",
    "projectId",
    "processId",
    "name",
    "role",
    "status",
    "tool",
    "ok",
    "errorCode",
    "registrationOpen",
  ]) {
    if (entry[key] !== undefined) {
      details[key] = entry[key];
    }
  }
  return {
    at: dateLabel(typeof entry.at === "string" ? entry.at : undefined),
    sortAt: typeof entry.at === "string" ? entry.at : "",
    event: String(entry.event ?? "unknown"),
    actor: actor || "시스템",
    details: JSON.stringify(details),
  };
}
