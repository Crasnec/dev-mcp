import { readFile } from "node:fs/promises";
import path from "node:path";
import { OperationError, validUser } from "./runner-operations.mjs";
import { workspaceContainer, parseSshPublicKey } from "./ssh-access.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
    return this.runners.owned(user);
  }
  async image() {
    return this.runners.runnerImage();
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
  async beforeRunnerOperation() {
    // MCP and SSH now stop together with the same container.
    return false;
  }
  async attach(user) {
    const network = await this.network(user);
    const { name, info } = await this.owned(user);
    if (!info.NetworkSettings.Networks[network]) {
      await this.docker(
        "network",
        "connect",
        "--alias",
        workspaceContainer(user.id),
        network,
        name,
      );
    }
  }
  async migrate(user) {
    const { name, info } = await this.owned(user);
    if (!info || info.Config.Labels?.["dev-mcp.runtime"] === "unified") {
      return;
    }
    const legacy = workspaceContainer(user.id);
    const workspace = await this.runners.inspect(legacy);
    if (
      workspace &&
      (workspace.Config.Labels?.["dev-mcp.user"] !== user.id ||
        workspace.Config.Labels?.["dev-mcp.role"] !== "workspace")
    ) {
      throw new Error("Legacy workspace ownership mismatch");
    }
    const previous = name + "-previous";
    const oldWorkspace = legacy + "-previous";
    if (
      (await this.runners.inspect(previous)) ||
      (await this.runners.inspect(oldWorkspace))
    ) {
      throw new OperationError(
        "이전 개발 컨테이너가 남아 있습니다. 복구 후 다시 요청해 주세요.",
      );
    }
    const running =
      info.State.Running &&
      (!workspace || workspace.State.Running) &&
      user.status === "active";
    const sshNetwork = "dev-mcp-ssh-" + user.id;
    const workspaceNetwork = workspace?.NetworkSettings.Networks[sshNetwork];
    if (workspace?.State.Running) {
      await this.docker("stop", "--time", "10", legacy);
    }
    if (info.State.Running) {
      await this.docker("stop", "--time", "10", name);
    }
    await this.docker("rename", name, previous);
    try {
      if (workspace) {
        await this.docker("rename", legacy, oldWorkspace);
        if (workspaceNetwork) {
          await this.docker("network", "disconnect", sshNetwork, oldWorkspace);
        }
      }
      const limits = this.runners.limits(info);
      const host = info.Mounts?.find(
        (mount) => mount.Destination === "/workspace" && mount.Type === "bind",
      );
      if (host) {
        const entry = await this.runners.hostWorkspace(user, info);
        await this.runners.verifyWorkspace(entry);
      }
      if (info.Config.Labels?.["dev-mcp.storage"] === "quota") {
        await this.runners.storage();
      }
      await this.runners.provision(
        user,
        limits,
        info.Config.Labels?.["dev-mcp.storage"] === "quota",
        false,
        host?.Source ?? "",
        !running,
      );
      await this.attach(user);
      if (running) {
        await this.docker("start", name);
        // Retain both old containers until the MCP socket accepts connections.
        await this.docker(
          "exec",
          name,
          "node",
          "-e",
          `
          const net = require("node:net");
          const fs = require("node:fs");
          const sshEnabled = JSON.parse(fs.readFileSync("/run/dev-mcp-ssh/access.json", "utf8")).enabled === true;
          const end = Date.now() + 40000;
          function connect(target) {
            return new Promise((resolve, reject) => {
              const socket = net.connect(target, () => { socket.destroy(); resolve(); });
              socket.on("error", reject);
              socket.setTimeout(1000, () => socket.destroy(new Error("timeout")));
            });
          }
          function probe() {
            const targets = [{ path: "/ipc/runner.sock" }, ...(sshEnabled ? [{ port: 2222, host: "127.0.0.1" }] : [])];
            Promise.all(targets.map(connect)).then(() => process.exit(0)).catch(() => {
              if (Date.now() > end) {
                process.exit(1);
              }
              setTimeout(probe, 500);
            });
          }
          probe();
        `,
        );
      }
    } catch (error) {
      if ((await this.owned(user)).info) {
        await this.docker("rm", "--force", name);
      }
      await this.docker("rename", previous, name);
      if (workspace && (await this.runners.inspect(oldWorkspace))) {
        await this.docker("rename", oldWorkspace, legacy);
        if (workspaceNetwork) {
          await this.docker("network", "connect", sshNetwork, legacy);
        }
        if (workspace.State.Running) {
          await this.docker("start", legacy);
        }
      }
      if (info.State.Running) {
        await this.docker("start", name);
      }
      throw error;
    }
    await this.docker("rm", previous);
    if (workspace) {
      await this.docker("rm", oldWorkspace);
    }
  }
  async sync(user, { autoStart = true, resume = false } = {}) {
    await this.migrate(user);
    const { name, info } = await this.owned(user);
    if (!info) {
      if (user.status === "active" && (autoStart || resume)) {
        await this.runners.create(user);
        await this.attach(user);
      }
      return;
    }
    if (user.status !== "active") {
      if (info.State.Running) {
        await this.docker("stop", "--time", "10", name);
      }
      return;
    }
    await this.attach(user);
    if (
      resume ||
      (autoStart &&
        info.State.Status === "created" &&
        info.Config.Labels?.["dev-mcp.keep-stopped"] !== "true")
    ) {
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
    const { name, info } = await this.owned(user);
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
        (await this.docker(
          "exec",
          name,
          "node",
          "-e",
          'const s=require("node:net").connect(2222,"127.0.0.1",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1))',
        ).then(
          () => true,
          () => false,
        )) &&
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
