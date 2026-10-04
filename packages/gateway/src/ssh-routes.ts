import express, { type Express, type Request, type Response } from "express";
import type { GatewayConfig } from "./config.ts";
import type { UserStore } from "./user-store.ts";
import type { AuditLogger } from "./audit.ts";
import type { User } from "./user-store.ts";
import { browserSession, field } from "./browser-session.ts";
import { adminView, dateIso } from "./admin-view.ts";
import { SshAccessStore } from "./ssh-access-store.ts";
import { RunnerControlStore } from "./runner-control-store.ts";
import { WorkspaceControlStore } from "./workspace-control-store.ts";
import {
  sshAccessRevision,
  sshLogin,
  workspaceContainer,
} from "../../../scripts/ssh-access.mjs";
import { runtimeName } from "../../../scripts/runtime-names.mjs";

export function workspaceSshConfig(
  user: User,
  ssh: NonNullable<GatewayConfig["ssh"]>,
) {
  const alias = runtimeName(user) + "." + ssh.host;
  const legacyAlias = user.id + "." + ssh.host;
  const entryAlias = "dev-mcp-entry-" + user.id;
  return {
    alias,
    text: [
      `Host ${entryAlias}`,
      `    HostName ${ssh.host}`,
      `    Port ${ssh.port}`,
      `    User ${sshLogin(user.id)}`,
      "    IdentityFile ~/.ssh/id_ed25519",
      "    IdentitiesOnly yes",
      "",
      `Host ${[...new Set([alias, legacyAlias])].join(" ")}`,
      `    HostName ${workspaceContainer(user.id)}`,
      "    Port 2222",
      "    User workspace",
      `    ProxyJump ${entryAlias}`,
      `    HostKeyAlias ${legacyAlias}`,
      "    IdentityFile ~/.ssh/id_ed25519",
      "    IdentitiesOnly yes",
      "",
    ].join("\n"),
  };
}

export function installSshRoutes(
  app: Express,
  config: GatewayConfig,
  users: UserStore,
  access: SshAccessStore,
  audit: AuditLogger,
) {
  const browser = browserSession(config, users);
  const statusDir = config.runnerStatusDir ?? "/runner-status";
  const runners = new RunnerControlStore(config.dataDir, statusDir);
  const controls = new WorkspaceControlStore(config.dataDir, statusDir);
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));
  router.use(async (req, res, next) => {
    const session = await browser.current(req);
    if (!session) {
      return res.redirect(303, "/login");
    }
    res.locals.admin = session;
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && !browser.validCsrf(req, session.csrf)) {
      return res
        .status(403)
        .send(
          "요청을 확인할 수 없습니다. 페이지를 새로 열고 다시 시도해 주세요.",
        );
    }
    if (
      Object.keys(req.query).some((key) => key !== "saved") ||
      Object.keys(req.body ?? {}).some(
        (key) =>
          !["csrf", "name", "publicKey", "revision", "action"].includes(key),
      )
    ) {
      return res.status(400).send("내 계정의 workspace만 관리할 수 있습니다.");
    }
    next();
  });
  async function page(req: Request, res: Response, error?: string) {
    const user = res.locals.admin.user as User;
    const entry = await access.get(user.id);
    const { observation, control } = await controls.read(user.id);
    const runner = await runners.read(user.id);
    const activeEntry =
      entry?.authVersion === user.authVersion ? entry : undefined;
    const keys = activeEntry?.keys ?? [];
    const fresh =
      !!observation && Date.now() - observation.observedAt <= 30_000;
    const state = fresh ? observation.state : "unknown";
    const available =
      !!config.ssh &&
      keys.length > 0 &&
      fresh &&
      state === "running" &&
      observation.sshReady === true &&
      observation.sshRevision === sshAccessRevision(user, activeEntry);
    const busy =
      !!control &&
      (control.revision !== observation?.revision ||
        observation.phase === "applying");
    const stateLabel = (value: string) =>
      ({
        running: "실행 중",
        exited: "중지됨",
        created: "준비됨",
        missing: "생성 전",
        restarting: "재시작 중",
        unknown: "확인 중",
      })[value] ?? value;
    const message = !config.ssh
      ? "서버에서 workspace SSH 접속을 아직 활성화하지 않았습니다. 관리자에게 문의해 주세요."
      : !keys.length
        ? "SSH 공개키를 등록하면 VS Code로 내 workspace에 접속할 수 있습니다."
        : state === "exited"
          ? "Workspace가 중지되어 있습니다. 시작한 뒤 접속해 주세요."
          : available
            ? "VS Code로 내 workspace에 접속할 수 있습니다."
            : "Workspace와 공개키를 준비하고 있습니다. 잠시 후 새로고침해 주세요.";
    const connection = config.ssh
      ? workspaceSshConfig(user, config.ssh)
      : undefined;
    return adminView(
      req,
      res,
      "workspace",
      "admin/ssh",
      {
        selfScope: true,
        title: "내 개발 workspace",
        description:
          "Workspace 상태와 SSH 공개키를 관리하고 VS Code로 접속합니다.",
        enabled: !!config.ssh,
        error,
        message,
        available,
        busy,
        workspaceState: stateLabel(state),
        runnerState: stateLabel(
          runner.observation &&
            Date.now() - runner.observation.observedAt <= 30_000
            ? runner.observation.state
            : "unknown",
        ),
        revision: control?.revision ?? "",
        operationMessage:
          control?.revision === observation?.revision
            ? observation?.message
            : control
              ? "Workspace 운영 요청을 기다리고 있습니다."
              : undefined,
        operationFailed:
          control?.revision === observation?.revision &&
          observation?.phase === "failed",
        operations:
          state === "running"
            ? [
                { action: "stop", label: "Workspace 중지", danger: true },
                { action: "restart", label: "Workspace 재시작" },
              ]
            : [
                {
                  action: state === "missing" ? "create" : "start",
                  label:
                    state === "missing" ? "Workspace 생성" : "Workspace 시작",
                },
              ],
        keys: keys.map((key) => ({
          ...key,
          createdAtIso: dateIso(key.createdAt),
        })),
        connection:
          connection && keys.length
            ? {
                sshConfig: connection.text,
                command: "ssh " + connection.alias,
                vscodeUrl: `vscode://vscode-remote/ssh-remote+${connection.alias}/workspace`,
                fingerprint: fresh
                  ? observation?.sshHostFingerprint
                  : undefined,
                entryFingerprint: fresh
                  ? observation?.entryFingerprint
                  : undefined,
              }
            : undefined,
      },
      error ? 400 : 200,
    );
  }
  router.get("/", (req, res) =>
    req.baseUrl === "/account/ssh"
      ? res.redirect(303, "/account/workspace")
      : page(req, res),
  );
  router.get("/config", (req, res) => {
    if (!config.ssh) {
      return page(req, res, "SSH 접속이 활성화되지 않았습니다.");
    }
    return res
      .type("text/plain")
      .attachment("dev-mcp-ssh.conf")
      .send(workspaceSshConfig(res.locals.admin.user, config.ssh).text);
  });
  router.post("/keys", async (req, res) => {
    if (!config.ssh) {
      return page(req, res, "SSH 접속이 활성화되지 않았습니다.");
    }
    if (
      Object.keys(req.body).some(
        (key) => !["csrf", "name", "publicKey"].includes(key),
      )
    ) {
      return page(req, res, "공개키 입력값을 확인해 주세요.");
    }
    try {
      const user = res.locals.admin.user;
      const key = await access.add(
        user,
        field(req, "name"),
        field(req, "publicKey"),
      );
      await audit.write({
        event: "ssh_key_added",
        actor: user.id,
        userId: user.id,
        fingerprint: key.fingerprint,
        name: key.name,
      });
      return res.redirect(303, "/account/workspace?saved=1");
    } catch (error) {
      return page(
        req,
        res,
        error instanceof Error
          ? error.message
          : "공개키를 등록하지 못했습니다.",
      );
    }
  });
  router.post("/keys/:id/delete", async (req, res) => {
    if (Object.keys(req.body).some((key) => key !== "csrf")) {
      return page(req, res, "공개키 입력값을 확인해 주세요.");
    }
    try {
      const user = res.locals.admin.user;
      await access.remove(user, String(req.params.id));
      await audit.write({
        event: "ssh_key_removed",
        actor: user.id,
        userId: user.id,
        keyId: req.params.id,
      });
      return res.redirect(303, "/account/workspace?saved=1");
    } catch (error) {
      return page(
        req,
        res,
        error instanceof Error
          ? error.message
          : "공개키를 삭제하지 못했습니다.",
      );
    }
  });
  router.post("/operations", async (req, res) => {
    if (!config.ssh) {
      return page(req, res, "Workspace가 활성화되지 않았습니다.");
    }
    if (
      Object.keys(req.body).some(
        (key) => !["csrf", "revision", "action"].includes(key),
      )
    ) {
      return page(req, res, "Workspace 요청값을 확인해 주세요.");
    }
    try {
      const user = res.locals.admin.user;
      const request = await controls.request(
        user,
        field(req, "revision"),
        field(req, "action"),
      );
      await audit.write({
        event: "workspace_operation_requested",
        actor: user.id,
        userId: user.id,
        action: request.action,
        revision: request.revision,
      });
      return res.redirect(303, "/account/workspace?saved=1");
    } catch (error) {
      return page(
        req,
        res,
        error instanceof Error
          ? error.message
          : "Workspace 요청을 저장하지 못했습니다.",
      );
    }
  });
  app.use(["/account/workspace", "/account/ssh"], router);
}
