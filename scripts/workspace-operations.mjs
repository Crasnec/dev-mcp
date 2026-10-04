import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { OperationError, validUser } from "./runner-operations.mjs";
import { workspaceContainer, parseSshPublicKey } from "./ssh-access.mjs";
import {
  developmentContainer,
  developmentHome,
  gitAuthVolume,
  ownsDevelopment,
  runtimeContainer,
  runtimeName,
} from "./runtime-names.mjs";
import { splitRuntime } from "./split-runtime.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const validWorkspaceControl = (request) =>
  !!request &&
  uuid.test(request.revision) &&
  uuid.test(request.actorId) &&
  Number.isSafeInteger(request.requestedAt) &&
  ["create", "start", "stop", "restart"].includes(request.action);

export class WorkspaceOperations {
  constructor(docker, runners, registry, project, options = {}) {
    this.docker = docker;
    this.runners = runners;
    this.registry = registry;
    this.project = project;
    this.imageName =
      options.image ??
      process.env.WORKSPACE_IMAGE ??
      "dev-mcp-workspace:latest";
    this.authVolume =
      options.authVolume ??
      process.env.WORKSPACE_AUTH_VOLUME ??
      project + "-workspace-auth";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(this.authVolume)) {
      throw new Error("Invalid workspace auth volume");
    }
  }
  async owned(user) {
    if (!validUser(user)) {
      throw new Error("Invalid workspace owner");
    }
    const name = developmentContainer(user);
    let info = await this.runners.inspect(name);
    if (
      info &&
      (info.Config.Labels?.["dev-mcp.user"] !== user.id ||
        info.Config.Labels?.["dev-mcp.role"] !== "workspace")
    ) {
      throw new Error("Workspace 컨테이너 소유권을 확인할 수 없습니다.");
    }
    if (!info) {
      const ids = await this.docker(
        "ps",
        "-a",
        "--filter",
        "label=dev-mcp.user=" + user.id,
        "--filter",
        "label=dev-mcp.role=workspace",
        "--format",
        "{{.Names}}",
      );
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        const candidate = await this.runners.inspect(id);
        if (ownsDevelopment(user, candidate)) {
          if (info) {
            throw new Error("Multiple development containers for one account");
          }
          info = candidate;
        }
      }
    }
    return { name: info?.Name?.replace(/^\//, "") ?? name, info };
  }
  async image() {
    const id = await this.docker(
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      this.imageName,
    ).catch(() => "");
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) {
      throw new OperationError(
        "Workspace 이미지가 없습니다. runner 이미지를 빌드한 뒤 workspace 이미지를 빌드해 주세요.",
      );
    }
    return id;
  }
  async identity(image) {
    this.identities ??= new Map();
    if (!this.identities.has(image)) {
      const identity = JSON.parse(
        await this.docker(
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--entrypoint",
          "node",
          image,
          "-p",
          "JSON.stringify({uid:process.getuid(),gid:process.getgid()})",
        ),
      );
      if (
        !Number.isSafeInteger(identity.uid) ||
        identity.uid < 1 ||
        !Number.isSafeInteger(identity.gid) ||
        identity.gid < 1
      ) {
        throw new Error("Workspace는 일반 사용자로 실행해야 합니다.");
      }
      this.identities.set(image, identity);
    }
    return this.identities.get(image);
  }
  async entry() {
    const id = await this.docker(
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${this.project}`,
      "--filter",
      "label=com.docker.compose.service=ssh-entry",
      "--filter",
      "label=com.docker.compose.oneoff=False",
      "--format",
      "{{.ID}}",
    );
    if (!/^[a-f0-9]{12,64}$/.test(id)) {
      throw new OperationError(
        "공용 SSH 입구가 없습니다. ssh-entry 서비스를 시작해 주세요.",
      );
    }
    const info = JSON.parse(await this.docker("inspect", id))[0];
    if (
      info.Config.Labels?.["com.docker.compose.project"] !== this.project ||
      info.Config.Labels?.["com.docker.compose.service"] !== "ssh-entry"
    ) {
      throw new Error("Invalid SSH entry service");
    }
    return { id, info };
  }
  async network(user) {
    const network = "dev-mcp-ssh-" + user.id;
    const id = await this.docker(
      "network",
      "ls",
      "--filter",
      "name=^" + network + "$",
      "--format",
      "{{.ID}}",
    );
    if (!id) {
      await this.docker(
        "network",
        "create",
        "--internal",
        "--label",
        "dev-mcp.user=" + user.id,
        "--label",
        "dev-mcp.role=workspace-ssh",
        network,
      );
    }
    const info = JSON.parse(
      await this.docker("network", "inspect", network),
    )[0];
    if (
      !info.Internal ||
      info.Labels?.["dev-mcp.user"] !== user.id ||
      info.Labels?.["dev-mcp.role"] !== "workspace-ssh"
    ) {
      throw new Error("Invalid workspace SSH network");
    }
    const entry = await this.entry();
    if (!entry.info.NetworkSettings.Networks[network]) {
      await this.docker("network", "connect", network, entry.id);
    }
    return network;
  }
  async template(user) {
    const { info } = await this.runners.owned(user);
    if (!info) {
      throw new OperationError("Runner를 먼저 생성해 주세요.");
    }
    const mount = info.Mounts?.find(
      (entry) => entry.Destination === "/workspace",
    );
    let workspace;
    if (mount?.Type === "bind") {
      const entry = await this.runners.hostWorkspace(user, info);
      await this.runners.verifyWorkspace(entry);
      workspace = `type=bind,source=${entry.path},target=/workspace`;
    } else if (
      info.Config.Labels?.["dev-mcp.storage"] === "quota" &&
      mount?.Name === this.runners.pool
    ) {
      await this.runners.storage();
      workspace = `type=volume,source=${this.runners.pool},target=/workspace,volume-subpath=${user.id}/workspace`;
    } else if (
      mount?.Type === "volume" &&
      [
        runtimeContainer(user) + "-workspace",
        `dev-mcp-user-${user.id}-workspace`,
      ].includes(mount.Name)
    ) {
      workspace = `type=volume,source=${mount.Name},target=/workspace`;
    } else throw new Error("사용자 전용 작업 볼륨을 확인할 수 없습니다.");
    return {
      workspace,
      source: hash(workspace),
      limits: this.runners.limits(info),
      home: developmentHome(user),
      gitAuth: gitAuthVolume(user),
    };
  }
  async create(user, template, start, imageOverride) {
    const image = imageOverride ?? (await this.image());
    const { uid, gid } = await this.identity(image);
    await this.registry.prepare(user, uid, gid);
    const network = await this.network(user);
    const name = developmentContainer(user);
    const { limits } = template;
    const args = [
      "create",
      "--name",
      name,
      "--hostname",
      name,
      "--label",
      "dev-mcp.user=" + user.id,
      "--label",
      "dev-mcp.role=workspace",
      "--label",
      "dev-mcp.name=" + runtimeName(user),
      "--label",
      "dev-mcp.runtime=split",
      "--label",
      "dev-mcp.workspace-source=" + template.source,
      "--network",
      network,
      "--network-alias",
      workspaceContainer(user.id),
      "--init",
      "--restart",
      "unless-stopped",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,exec,mode=1777",
      "--mount",
      template.workspace,
      "--mount",
      `type=volume,source=${template.home},target=/workspace/.dev-mcp-home`,
      "--mount",
      `type=volume,source=${template.gitAuth},target=/run/dev-mcp-git-auth`,
      "--mount",
      `type=volume,source=${this.authVolume},target=/run/dev-mcp-ssh,volume-subpath=${user.id},readonly`,
      "--env",
      "GIT_AUTHOR_NAME=" +
        (user.email?.split("@")[0] ?? "Dev MCP user " + user.id),
      "--env",
      "GIT_AUTHOR_EMAIL=" + (user.email ?? user.id + "@users.dev-mcp.invalid"),
      "--env",
      "HOME=/workspace/.dev-mcp-home",
      "--env",
      "GH_CONFIG_DIR=/workspace/.dev-mcp-home/.config/gh",
      "--env",
      "SSH_WORKSPACE=true",
      "--env",
      "SSH_MANIFEST_FILE=/run/dev-mcp-ssh/access.json",
      "--env",
      "SSH_CONFIG_FILE=/etc/ssh/dev-mcp-sshd_config",
      "--health-cmd",
      'node -e \'const s=require("node:net").connect(2222,"127.0.0.1",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1))\'',
      "--health-interval",
      "5s",
      "--health-timeout",
      "3s",
      "--health-start-period",
      "5s",
      "--health-retries",
      "2",
    ];
    if (limits.memoryMiB) {
      args.push(
        "--memory",
        limits.memoryMiB + "m",
        "--memory-swap",
        limits.memoryMiB + "m",
      );
    }
    if (limits.cpus) {
      args.push("--cpus", String(limits.cpus));
    }
    if (limits.pids) {
      args.push("--pids-limit", String(limits.pids));
    }
    if (limits.fileSizeMiB) {
      args.push(
        "--ulimit",
        `fsize=${limits.fileSizeMiB * 1048576}:${limits.fileSizeMiB * 1048576}`,
      );
    }
    await this.prepareStorage(user, template);
    await this.internet(user);
    await this.docker(
      ...args,
      image,
      "node",
      "/opt/dev-mcp/scripts/development-workspace.mjs",
    );
    if (limits.network) {
      await this.docker("network", "connect", name, name);
    }
    if (start) {
      await this.docker("start", name);
    }
  }
  async internet(user) {
    const name = developmentContainer(user);
    const found = await this.docker(
      "network",
      "ls",
      "--filter",
      "name=^" + name + "$",
      "--format",
      "{{.ID}}",
    );
    if (!found) {
      await this.docker(
        "network",
        "create",
        "--label",
        "dev-mcp.user=" + user.id,
        "--label",
        "dev-mcp.role=workspace",
        name,
      );
    }
    const info = JSON.parse(await this.docker("network", "inspect", name))[0];
    if (
      info.Labels?.["dev-mcp.user"] !== user.id ||
      info.Labels?.["dev-mcp.role"] !== "workspace"
    ) {
      throw new Error("Invalid development network ownership");
    }
  }
  async prepareStorage(user, template) {
    for (const name of [template.home, template.gitAuth]) {
      if (await this.runners.volumeExists(name)) {
        const info = JSON.parse(
          await this.docker("volume", "inspect", name),
        )[0];
        if (info.Labels?.["dev-mcp.user"] !== user.id) {
          throw new Error("Development storage ownership mismatch");
        }
      } else {
        await this.docker(
          "volume",
          "create",
          "--label",
          "dev-mcp.user=" + user.id,
          name,
        );
      }
    }
    const image = await this.image();
    const { uid, gid } = await this.identity(image);
    await this.docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "FOWNER",
      "--security-opt",
      "no-new-privileges:true",
      "--mount",
      `type=volume,source=${template.home},target=/home-volume`,
      "--mount",
      `type=volume,source=${template.gitAuth},target=/git-auth`,
      "--entrypoint",
      "node",
      image,
      "-e",
      'const fs=require("node:fs");for(const p of ["/home-volume","/git-auth"]){fs.chownSync(p,Number(process.argv[1]),Number(process.argv[2]));fs.chmodSync(p,448)}',
      String(uid),
      String(gid),
    );
  }
  async migrate(user, options) {
    return splitRuntime(this, user, options);
  }
  async beforeNamingMigration(user) {
    const { name, info } = await this.runners.owned(user);
    const target = runtimeContainer(user);
    const copy =
      info?.Config.Labels?.["dev-mcp.storage"] !== "quota" &&
      info?.Mounts?.some(
        (mount) =>
          mount.Type === "volume" &&
          ["/workspace", "/var/lib/dev-mcp"].includes(mount.Destination) &&
          mount.Name !==
            target +
              (mount.Destination === "/workspace" ? "-workspace" : "-data"),
      );
    return info && (name !== target || copy)
      ? this.beforeRunnerOperation(user, { action: "workspace" })
      : false;
  }
  // Storage copying must never race with writes from VS Code.
  async beforeRunnerOperation(user, request) {
    if (!["create", "apply", "workspace"].includes(request.action)) {
      return false;
    }
    const { info: runner } = await this.runners.owned(user);
    const current = runner && this.runners.limits(runner);
    const changesStorage =
      request.action === "workspace" ||
      request.limits?.storageMiB > 0 ||
      runner?.Config.Labels?.["dev-mcp.storage"] === "quota";
    const changesFileSize =
      request.limits &&
      current &&
      request.limits.fileSizeMiB !== current.fileSizeMiB;
    if (!changesStorage && !changesFileSize) {
      return false;
    }
    const { name, info } = await this.owned(user);
    if (!info?.State.Running) {
      return false;
    }
    await this.docker("stop", "--time", "10", name);
    return true;
  }
  async sync(user, { autoStart = true, resume = false } = {}) {
    await this.migrate(user);
    let { name, info } = await this.owned(user);
    if (user.status !== "active") {
      if (info?.State.Running) {
        await this.docker("stop", "--time", "10", name);
      }
      return;
    }
    const template = await this.template(user);
    if (!info) {
      const { info: runner } = await this.runners.owned(user);
      await this.create(
        user,
        template,
        resume || (autoStart && runner?.State.Running),
      );
      return;
    }
    const actual = this.runners.limits(info);
    const desired = template.limits;
    const recreate =
      name !== developmentContainer(user) ||
      info.Config.Labels["dev-mcp.workspace-source"] !== template.source ||
      actual.fileSizeMiB !== desired.fileSizeMiB ||
      (actual.memoryMiB > 0 && !desired.memoryMiB) ||
      (actual.cpus > 0 && !desired.cpus);
    if (recreate) {
      const previous = name + "-previous";
      if (await this.runners.inspect(previous)) {
        throw new OperationError(
          "이전 workspace가 남아 있습니다. 복구 후 다시 요청해 주세요.",
        );
      }
      const running = info.State.Running || resume;
      if (info.State.Running) {
        await this.docker("stop", "--time", "10", name);
      }
      let image;
      if (name !== developmentContainer(user)) {
        image = await this.docker("commit", name);
        if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
          throw new OperationError(
            "개발 환경의 설치 파일을 보존하지 못했습니다.",
          );
        }
      }
      await this.docker("rename", name, previous);
      try {
        await this.create(user, template, running, image);
      } catch (error) {
        const target = developmentContainer(user);
        if (
          (await this.runners.inspect(target))?.Config.Labels?.[
            "dev-mcp.user"
          ] === user.id
        ) {
          await this.docker("rm", "--force", target);
        }
        await this.docker("rename", previous, name);
        if (running) {
          await this.docker("start", name);
        }
        throw error;
      }
      await this.docker("rm", previous);
      return;
    }
    await this.network(user);
    if (
      ["memoryMiB", "cpus", "pids"].some((key) => actual[key] !== desired[key])
    ) {
      await this.docker(
        "update",
        "--memory",
        String(desired.memoryMiB * 1048576),
        "--memory-swap",
        desired.memoryMiB ? String(desired.memoryMiB * 1048576) : "-1",
        "--cpus",
        String(desired.cpus),
        "--pids-limit",
        String(desired.pids || -1),
        name,
      );
    }
    const internet = developmentContainer(user);
    const ssh = "dev-mcp-ssh-" + user.id;
    for (const attached of Object.keys(info.NetworkSettings.Networks))
      if (attached !== ssh && (!desired.network || attached !== internet)) {
        await this.docker("network", "disconnect", attached, name);
      }
    if (desired.network && !info.NetworkSettings.Networks[internet]) {
      await this.internet(user);
      await this.docker("network", "connect", internet, name);
    }
    if (resume || (autoStart && info.State.Status === "created")) {
      await this.docker("start", name);
    }
  }
  async apply(user, request) {
    if (!validWorkspaceControl(request) || request.actorId !== user.id) {
      throw new Error("Invalid workspace request");
    }
    if (request.action !== "stop" && user.status !== "active") {
      throw new OperationError("승인된 계정의 workspace만 시작할 수 있습니다.");
    }
    if (["create", "start", "restart"].includes(request.action)) {
      await this.sync(user, { autoStart: false });
    }
    const { name, info } = await this.owned(user);
    if (!info) {
      throw new OperationError("Workspace가 없습니다. 먼저 생성해 주세요.");
    }
    if (request.action === "stop") {
      await this.docker("stop", "--time", "10", name);
    } else
      await this.docker(
        request.action === "restart" && info.State.Running
          ? "restart"
          : "start",
        name,
      );
  }
  async observe(user) {
    const { info } = await this.owned(user);
    const state = {
      state: info?.State.Status ?? "missing",
      observedAt: Date.now(),
      sshReady: false,
    };
    if (!info) {
      return state;
    }
    try {
      const directory = path.join(this.registry.authDir, user.id);
      const manifest = JSON.parse(
        await readFile(path.join(directory, "access.json"), "utf8"),
      );
      state.sshRevision = manifest.revision;
      state.sshHostFingerprint = parseSshPublicKey(
        await readFile(
          path.join(directory, "ssh_host_ed25519_key.pub"),
          "utf8",
        ),
      ).fingerprint;
      state.entryFingerprint = this.registry.entryFingerprint;
      const entry = await this.entry();
      state.sshReady =
        info.State.Running &&
        info.State.Health?.Status === "healthy" &&
        entry.info.State.Running &&
        entry.info.State.Health?.Status === "healthy" &&
        manifest.enabled &&
        manifest.expiresAt > Date.now();
    } catch {
      // An incomplete key/lease update cannot claim a ready connection.
    }
    return state;
  }
}
