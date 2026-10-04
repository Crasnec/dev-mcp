import { fileURLToPath } from "node:url";
import path from "node:path";
import { OperationError, readJson, writeJson } from "./runner-operations.mjs";
import { developmentContainer } from "./runtime-names.mjs";
import { workspaceContainer } from "./ssh-access.mjs";

// Keep the unified container and a snapshot until both replacements are ready.
// Storage, account identity, IPC keys and SSH host keys are never regenerated.
export async function splitRuntime(workspaces, user, { retry = false } = {}) {
  const runners = workspaces.runners;
  const docker = workspaces.docker;
  const { name, info } = await runners.owned(user);
  if (!info || info.Config.Labels?.["dev-mcp.runtime"] === "split") {
    return;
  }
  const file = path.join(runners.statusDir, "runtime-splits.json");
  const journal = await readJson(file, { users: {} });
  if (journal.users[user.id]?.phase === "failed" && !retry) {
    throw new OperationError(
      "컨테이너 분리 실패 후 기존 환경을 보존했습니다. 확인 후 새 운영 요청으로 다시 시도해 주세요.",
    );
  }
  const previous = name + "-before-split";
  const development = developmentContainer(user);
  if (
    (await runners.inspect(previous)) ||
    (await runners.inspect(development))
  ) {
    throw new OperationError(
      "이전 분리 작업의 컨테이너가 남아 있습니다. 복구 후 다시 요청해 주세요.",
    );
  }
  const template = await workspaces.template(user);
  const running = info.State.Running && user.status === "active";
  const save = async (phase, extra = {}) => {
    journal.users[user.id] = { phase, runner: name, development, ...extra };
    await writeJson(file, journal);
  };
  await save("preparing");
  let renamed = false;
  let detached = false;
  const sshNetwork = "dev-mcp-ssh-" + user.id;
  let snapshot;
  try {
    if (info.State.Running) {
      await docker("stop", "--time", "10", name);
    }
    if (info.NetworkSettings?.Networks?.[sshNetwork]) {
      await docker("network", "disconnect", sshNetwork, name);
      detached = true;
    }
    await workspaces.prepareStorage(user, template);
    // Preserve directly installed development packages without importing that
    // image or its programs into the new MCP runner.
    for (const script of [
      "development-workspace.mjs",
      "development-home.mjs",
      "git-auth.mjs",
      "ssh-server.mjs",
    ]) {
      await docker(
        "cp",
        fileURLToPath(new URL(script, import.meta.url)),
        name + ":/opt/dev-mcp/scripts/" + script,
      );
    }
    await docker(
      "cp",
      fileURLToPath(
        new URL("../docker/workspace-sshd_config", import.meta.url),
      ),
      name + ":/etc/ssh/dev-mcp-sshd_config",
    );
    snapshot = await docker("commit", name);
    if (!/^sha256:[a-f0-9]{64}$/.test(snapshot)) {
      throw new Error("Invalid development snapshot");
    }
    await save("preparing", { snapshot });
    await docker(
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
      "DAC_OVERRIDE",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "FOWNER",
      "--security-opt",
      "no-new-privileges:true",
      "--mount",
      template.workspace.replace(
        "target=/workspace",
        "target=/source,readonly",
      ),
      "--mount",
      `type=volume,source=${template.home},target=/home-volume`,
      "--entrypoint",
      "sh",
      await runners.helperImage(),
      "-c",
      "if [ -L /source/.dev-mcp-home ]; then exit 1; fi; if [ -d /source/.dev-mcp-home ]; then rsync -aAX --numeric-ids --delete /source/.dev-mcp-home/ /home-volume/; fi",
    );
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--mount",
      `type=volume,source=${template.home},target=/workspace/.dev-mcp-home`,
      "--mount",
      `type=volume,source=${template.gitAuth},target=/run/dev-mcp-git-auth`,
      "--entrypoint",
      "node",
      snapshot,
      "--input-type=module",
      "-e",
      'import { initializeGitAuth, exportGitAuth } from "/opt/dev-mcp/scripts/git-auth.mjs"; const home="/workspace/.dev-mcp-home", auth="/run/dev-mcp-git-auth"; await initializeGitAuth(home,auth); await exportGitAuth(home,auth,{name:process.argv[1],email:process.argv[2]});',
      user.email?.split("@")[0] ?? "Dev MCP user " + user.id,
      user.email ?? user.id + "@users.dev-mcp.invalid",
    );
    await docker("rename", name, previous);
    renamed = true;
    const host = info.Mounts?.find(
      (mount) => mount.Destination === "/workspace" && mount.Type === "bind",
    );
    await runners.provision(
      user,
      runners.limits(info),
      info.Config.Labels?.["dev-mcp.storage"] === "quota",
      false,
      host?.Source ?? "",
      !running,
    );
    await workspaces.create(user, template, false, snapshot);
    if (running) {
      await docker("start", development);
      await docker("start", name);
      await runners.waitReady(name);
      await docker(
        "exec",
        development,
        "node",
        "-e",
        String.raw`
        const fs = require("node:fs"), net = require("node:net");
        const end = Date.now() + 40000;
        function probe() {
          if (!fs.existsSync("/run/dev-mcp-git-auth/gitconfig")) {
            return Date.now() > end ? process.exit(1) : setTimeout(probe, 500);
          }
          const access = JSON.parse(fs.readFileSync("/run/dev-mcp-ssh/access.json", "utf8"));
          if (!access.enabled) {
            return process.exit(0);
          }
          const socket = net.connect(2222, "127.0.0.1", () => { socket.destroy(); process.exit(0); });
          socket.on("error", () => Date.now() > end ? process.exit(1) : setTimeout(probe, 500));
          socket.setTimeout(1000, () => socket.destroy(new Error("timeout")));
        }
        probe();
      `,
      );
    }
    await save("ready", { snapshot });
  } catch (error) {
    for (const replacement of [development, ...(renamed ? [name] : [])]) {
      const current = await runners.inspect(replacement);
      if (current?.Config.Labels?.["dev-mcp.user"] === user.id) {
        await docker("rm", "--force", replacement);
      }
    }
    if (renamed) {
      await docker("rename", previous, name);
    }
    if (detached) {
      await docker(
        "network",
        "connect",
        "--alias",
        workspaceContainer(user.id),
        sshNetwork,
        name,
      );
    }
    if (info.State.Running) {
      await docker("start", name);
    }
    await save("failed", { snapshot });
    throw error;
  }
  await docker("rm", previous);
}
