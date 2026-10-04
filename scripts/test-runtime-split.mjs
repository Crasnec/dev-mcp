#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RunnerOperations } from "./runner-operations.mjs";
import { WorkspaceOperations } from "./workspace-operations.mjs";
import { SshRegistry } from "./ssh-registry.mjs";
import {
  runtimeContainer,
  developmentContainer,
  developmentHome,
  gitAuthVolume,
} from "./runtime-names.mjs";
import {
  parseSshPublicKey,
  workspaceContainer,
  sshLogin,
} from "./ssh-access.mjs";

const project = process.env.SSH_TEST_PROJECT;
if (!/^dev-mcp-ws-test-[a-z0-9-]+$/.test(project ?? "")) {
  throw new Error("Set a unique SSH_TEST_PROJECT and fresh registry volumes");
}
const execute = promisify(execFile);
const snapshots = [];
const containers = [],
  networks = [],
  volumes = [];
const docker = async (...args) => {
  const output = (
    await execute("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
  if (args[0] === "commit") {
    snapshots.push(output);
  }
  return output;
};
const runnerImage =
  process.env.SSH_TEST_RUNNER_IMAGE ?? "dev-mcp-runner:split-test";
const unifiedImage =
  process.env.SSH_TEST_UNIFIED_IMAGE ?? "dev-mcp-runner:latest";
const workspaceImage =
  process.env.SSH_TEST_WORKSPACE_IMAGE ?? "dev-mcp-workspace:split-test";
const entryImage =
  process.env.SSH_TEST_ENTRY_IMAGE ?? "dev-mcp-ssh-entry:latest";
process.env.RUNNER_IMAGE = runnerImage;
const temp = await mkdtemp("/tmp/split-test-");
const entry = project + "-entry",
  clients = project + "-clients";
const registry = new SshRegistry("/ssh-entry-data", "/workspace-auth");
const users = ["active", "disabled"].map((status) => {
  const id = randomUUID();
  return {
    id,
    runner: id,
    email: "split-" + id.slice(0, 8) + "@example.test",
    status,
    authVersion: 1,
  };
});
const [user, disabled] = users;
const provision = async (
  owner,
  _limits,
  _quota,
  _start,
  _host,
  keepStopped,
) => {
  const name = runtimeContainer(owner);
  const image = await runners.runnerImage();
  if (!(await runners.inspect(name))) {
    const network = await docker(
      "network",
      "ls",
      "--filter",
      "name=^" + name + "$",
      "--format",
      "{{.ID}}",
    );
    if (!network) {
      await docker(
        "network",
        "create",
        "--label",
        "dev-mcp.user=" + owner.id,
        name,
      );
      networks.push(name);
    }
  }
  const args = [
    "create",
    "--name",
    name,
    "--label",
    "dev-mcp.user=" + owner.id,
    "--label",
    "dev-mcp.name=" + owner.email.split("@")[0],
    "--label",
    "dev-mcp.runtime=split",
    "--label",
    "dev-mcp.role=runner",
    "--network",
    name,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,mode=1777",
    "--tmpfs",
    "/home/runner:rw,nosuid,nodev,exec,mode=0700,uid=1000,gid=1000",
    "--tmpfs",
    "/workspace/.dev-mcp-home:ro,nosuid,nodev,noexec,mode=000",
    "--mount",
    `type=volume,source=${name}-workspace,target=/workspace`,
    "--mount",
    `type=volume,source=${name}-data,target=/var/lib/dev-mcp`,
    "--mount",
    `type=volume,source=dev-mcp-user-${owner.id}-ipc,target=/ipc`,
    "--mount",
    `type=volume,source=${gitAuthVolume(owner)},target=/run/dev-mcp-git-auth,readonly`,
    "--env",
    "RUNNER_IPC_SECRET_FILE=/ipc/secret",
  ];
  if (keepStopped) {
    args.push("--label", "dev-mcp.keep-stopped=true");
  }
  await docker(...args, image);
};
const runners = new RunnerOperations(
  docker,
  provision,
  temp,
  project,
  undefined,
  runnerImage,
);
const workspaces = new WorkspaceOperations(docker, runners, registry, project, {
  image: workspaceImage,
  authVolume: project + "-auth",
});
const access = { entries: {} };
let heartbeat;
async function waitFor(callback, label) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (await callback()) {
      return;
    }
    await delay(500);
  }
  throw new Error("Timed out: " + label);
}
const rpc = async (owner, method, params = {}) =>
  JSON.parse(
    await docker(
      "exec",
      runtimeContainer(owner),
      "node",
      "-e",
      String.raw`
  const fs=require("node:fs"),net=require("node:net"),crypto=require("node:crypto");
  const request={id:crypto.randomUUID(),method:process.argv[1],params:JSON.parse(process.argv[2])};
  const payload=JSON.stringify(request),secret=fs.readFileSync("/ipc/secret","utf8");
  const signature=crypto.createHmac("sha256",secret).update(payload).digest("hex");
  const socket=net.connect("/ipc/runner.sock",()=>socket.write(JSON.stringify({id:request.id,method:"__authenticated_call",params:{payload,signature}})+"\n"));
  let output="";socket.on("data",chunk=>output+=chunk);socket.on("end",()=>console.log(JSON.stringify(JSON.parse(output).result)));socket.on("error",()=>process.exit(1));socket.setTimeout(10000,()=>process.exit(1));
`,
      method,
      JSON.stringify(params),
    ),
  );

try {
  await registry.init();
  const identity = temp + "/identity";
  await execute("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    identity,
  ]);
  const key = parseSshPublicKey(await readFile(identity + ".pub", "utf8"));
  access.entries[user.id] = {
    revision: randomUUID(),
    authVersion: 1,
    keys: [{ id: randomUUID(), name: "test", ...key, createdAt: Date.now() }],
  };
  for (const owner of users) {
    await registry.prepare(owner, 1000, 1000);
  }
  await registry.sync(users, access);
  heartbeat = setInterval(() => {
    void registry.sync(users, access);
  }, 5000);
  networks.push(clients);
  await docker("network", "create", clients);
  await docker("network", "connect", clients, process.env.HOSTNAME);
  containers.push(entry);
  await docker(
    "run",
    "--detach",
    "--name",
    entry,
    "--label",
    "com.docker.compose.project=" + project,
    "--label",
    "com.docker.compose.service=ssh-entry",
    "--label",
    "com.docker.compose.oneoff=False",
    "--network",
    clients,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SYS_CHROOT",
    "--cap-add",
    "KILL",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,mode=1777",
    "--tmpfs",
    "/run:rw,nosuid,nodev,noexec,mode=0755",
    "--mount",
    `type=volume,source=${project}-entry,target=/registry,readonly`,
    entryImage,
  );
  for (const owner of users) {
    const name = runtimeContainer(owner);
    const development = developmentContainer(owner);
    containers.push(
      name,
      name + "-before-split",
      development,
      development + "-previous",
    );
    networks.push(name, development, "dev-mcp-ssh-" + owner.id);
    for (const volume of [
      name + "-workspace",
      name + "-data",
      "dev-mcp-user-" + owner.id + "-ipc",
      developmentHome(owner),
      gitAuthVolume(owner),
    ]) {
      volumes.push(volume);
      await docker(
        "volume",
        "create",
        "--label",
        "dev-mcp.user=" + owner.id,
        volume,
      );
    }
    await docker(
      "network",
      "create",
      "--label",
      "dev-mcp.user=" + owner.id,
      name,
    );
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--mount",
      `type=volume,source=dev-mcp-user-${owner.id}-ipc,target=/ipc`,
      "--entrypoint",
      "node",
      unifiedImage,
      "-e",
      'require("node:fs").writeFileSync("/ipc/secret","a".repeat(64),{mode:292})',
    );
    await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${name}-workspace,target=/workspace`,
      "--entrypoint",
      "node",
      unifiedImage,
      "-e",
      String.raw`
      const fs=require("node:fs"),home="/workspace/.dev-mcp-home";
      for(const name of [".codex",".claude",".config/gh/extensions",".local/bin"]){fs.mkdirSync(home+"/"+name,{recursive:true})}
      fs.mkdirSync("/workspace/repo");fs.writeFileSync("/workspace/repo/preserved","workspace-files");
      fs.writeFileSync(home+"/.codex/auth.json","synthetic-agent-secret");fs.writeFileSync(home+"/.claude/auth.json","synthetic-agent-secret");
      fs.writeFileSync(home+"/.local/bin/codex","#!/bin/sh\necho synthetic-agent\n",{mode:493});
      fs.writeFileSync(home+"/.config/gh/hosts.yml","github.com:\n    user: developer\n    oauth_token: synthetic-git-token\n    git_protocol: https\n");
      fs.writeFileSync(home+"/.config/gh/config.yml","aliases:\n    delegate: '!codex exec'\n");
      fs.writeFileSync(home+"/.config/gh/extensions/agent","synthetic-agent-program");
      fs.writeFileSync(home+"/.gitconfig","[user]\n name = Developer\n email = developer@example.test\n[alias]\n delegate = !codex exec\n");
    `,
    );
    await docker(
      "create",
      "--name",
      name,
      "--label",
      "dev-mcp.user=" + owner.id,
      "--label",
      "dev-mcp.name=" + owner.email.split("@")[0],
      "--label",
      "dev-mcp.runtime=unified",
      "--network",
      name,
      "--mount",
      `type=volume,source=${name}-workspace,target=/workspace`,
      "--mount",
      `type=volume,source=${name}-data,target=/var/lib/dev-mcp`,
      "--mount",
      `type=volume,source=dev-mcp-user-${owner.id}-ipc,target=/ipc`,
      "--env",
      "RUNNER_IPC_SECRET_FILE=/ipc/secret",
      unifiedImage,
    );
    if (owner.status === "active") {
      await docker("start", name);
      await runners.waitReady(name);
      await docker(
        "exec",
        "--user",
        "0:0",
        name,
        "node",
        "-e",
        'require("node:fs").writeFileSync("/opt/direct-package-check","preserved-layer")',
      );
      const originalCreate = workspaces.create;
      workspaces.create = async () => {
        throw new Error("Injected development creation failure");
      };
      try {
        await assert.rejects(
          () => workspaces.migrate(owner),
          /Injected development creation failure/,
        );
      } finally {
        workspaces.create = originalCreate;
      }
      assert.equal(
        (await runners.inspect(name)).Config.Labels["dev-mcp.runtime"],
        "unified",
      );
      assert.equal((await runners.inspect(name)).State.Running, true);
      await assert.rejects(() => workspaces.migrate(owner), /보존/);
      console.log(
        "PASS failed split restores the original running container and requires an explicit retry",
      );
    }
    await workspaces.migrate(owner, { retry: true });
    await workspaces.sync(owner);
  }
  const mcpName = runtimeContainer(user),
    devName = developmentContainer(user);
  const [mcp, development] = await Promise.all([
    runners.inspect(mcpName),
    runners.inspect(devName),
  ]);
  assert.equal(mcp.HostConfig.ReadonlyRootfs, true);
  assert.ok(mcp.HostConfig.CapDrop.includes("ALL"));
  assert.ok(mcp.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(development.HostConfig.ReadonlyRootfs, false);
  assert.equal(
    await docker("exec", devName, "cat", "/opt/direct-package-check"),
    "preserved-layer",
  );
  await docker(
    "exec",
    mcpName,
    "sh",
    "-c",
    "test ! -e /opt/direct-package-check",
  );
  assert.ok(
    !development.Mounts.some((mount) =>
      ["/ipc", "/var/lib/dev-mcp", "/run/dev-mcp-ipc-key"].includes(
        mount.Destination,
      ),
    ),
  );
  assert.ok(
    Object.keys(mcp.NetworkSettings.Networks).every(
      (name) => !development.NetworkSettings.Networks[name],
    ),
  );
  await docker(
    "exec",
    mcpName,
    "sh",
    "-c",
    'test "$HOME" = /home/runner && ! command -v sudo && ! command -v codex && ! command -v claude && test ! -r /workspace/.dev-mcp-home/.codex/auth.json && test ! -r /workspace/.dev-mcp-home/.claude/auth.json && test ! -w /run/dev-mcp-git-auth && test ! -e /run/dev-mcp-git-auth/gh/config.yml && test ! -e /run/dev-mcp-git-auth/gh/extensions',
  );
  console.log(
    "PASS MCP cannot see development AI credentials, installed programs, aliases, sudo, SSH or its network",
  );
  const projectResult = await rpc(user, "project_register", {
    name: "repo",
    relative_path: "repo",
  });
  assert.equal(projectResult.ok, true);
  const projectId = projectResult.data.project.id;
  const command = await rpc(user, "command_run", {
    project_id: projectId,
    command:
      'test "$(gh auth token --hostname github.com)" = synthetic-git-token && git config --global --get user.email',
  });
  assert.equal(command.ok, true);
  assert.equal(command.data.exitCode, 0, command.data.output);
  assert.ok(command.data.output.includes("developer@example.test"));
  assert.equal(
    await docker("exec", mcpName, "cat", "/workspace/repo/preserved"),
    "workspace-files",
  );
  console.log(
    "PASS signed MCP commands retain Git/gh authentication and workspace files",
  );
  const config = temp + "/ssh-config";
  await writeFile(
    config,
    `Host entry\n HostName ${entry}\n Port 2222\n User ${sshLogin(user.id)}\n IdentityFile ${identity}\n IdentitiesOnly yes\n StrictHostKeyChecking accept-new\n UserKnownHostsFile ${temp}/known_hosts\n ConnectTimeout 5\n BatchMode yes\nHost development\n HostName ${workspaceContainer(user.id)}\n Port 2222\n User workspace\n ProxyJump entry\n IdentityFile ${identity}\n IdentitiesOnly yes\n StrictHostKeyChecking accept-new\n UserKnownHostsFile ${temp}/known_hosts\n ConnectTimeout 5\n BatchMode yes\n`,
  );
  const ssh = async (...args) =>
    (
      await execute("ssh", ["-F", config, ...args], { timeout: 12_000 })
    ).stdout.trim();
  await waitFor(
    async () =>
      ssh("development", "true").then(
        () => true,
        () => false,
      ),
    "native SSH",
  );
  assert.equal(await ssh("development", "sudo -n id -u"), "0");
  assert.equal(
    await ssh("development", "cat /workspace/.dev-mcp-home/.codex/auth.json"),
    "synthetic-agent-secret",
  );
  await ssh(
    "development",
    "printf from-development > /workspace/repo/new-file",
  );
  assert.equal(
    await docker("exec", mcpName, "cat", "/workspace/repo/new-file"),
    "from-development",
  );
  await assert.rejects(() => ssh("entry", "true"));
  const wrongConfig = temp + "/wrong-ssh-config";
  await writeFile(
    wrongConfig,
    (await readFile(config, "utf8")).replace(
      workspaceContainer(user.id),
      workspaceContainer(disabled.id),
    ),
  );
  await assert.rejects(() =>
    execute("ssh", ["-F", wrongConfig, "development", "true"], {
      timeout: 12_000,
    }),
  );
  console.log(
    "PASS native ProxyJump, development sudo, shared project files and cross-account SSH denial",
  );
  await ssh(
    "development",
    "printf 'third-token' > /workspace/.dev-mcp-home/.config/gh/hosts.yml",
  );
  await waitFor(
    async () =>
      (await docker(
        "exec",
        mcpName,
        "cat",
        "/run/dev-mcp-git-auth/gh/hosts.yml",
      )) === "third-token",
    "updated gh auth",
  );
  await ssh("development", "rm /workspace/.dev-mcp-home/.config/gh/hosts.yml");
  await waitFor(
    async () =>
      (await docker(
        "exec",
        mcpName,
        "cat",
        "/run/dev-mcp-git-auth/gh/hosts.yml",
      )) === "",
    "gh logout propagation",
  );
  console.log(
    "PASS Git authentication changes and logout propagate without exposing gh aliases or extensions",
  );
  assert.equal(
    (await runners.inspect(runtimeContainer(disabled))).State.Running,
    false,
  );
  assert.equal(
    (await runners.inspect(developmentContainer(disabled))).State.Running,
    false,
  );
  assert.equal(
    (await runners.inspect(runtimeContainer(disabled))).Config.Labels[
      "dev-mcp.keep-stopped"
    ],
    "true",
  );
  assert.ok((await workspaces.observe(user)).sshHostFingerprint);
  console.log(
    "PASS disabled account stays stopped and persistent SSH host keys remain available",
  );
  await workspaces.apply(user, {
    revision: randomUUID(),
    actorId: user.id,
    action: "stop",
    requestedAt: Date.now(),
  });
  assert.equal((await runners.inspect(mcpName)).State.Running, true);
  await workspaces.sync(user, { autoStart: false });
  assert.equal((await runners.inspect(devName)).State.Running, false);
  await workspaces.apply(user, {
    revision: randomUUID(),
    actorId: user.id,
    action: "start",
    requestedAt: Date.now(),
  });
  console.log(
    "PASS independent workspace lifecycle leaves MCP running and respects deliberate stops",
  );
  const renamedUser = {
    ...user,
    email: "renamed-" + user.id.slice(0, 8) + "@example.test",
  };
  const renamedMcp = runtimeContainer(renamedUser),
    renamedDev = developmentContainer(renamedUser);
  containers.push(
    renamedMcp,
    renamedMcp + "-previous",
    renamedDev,
    devName + "-previous",
  );
  networks.push(renamedDev);
  volumes.push(renamedMcp + "-workspace", renamedMcp + "-data");
  const resume = await workspaces.beforeNamingMigration(renamedUser);
  assert.equal(resume, true);
  await runners.migrateNames(renamedUser);
  await workspaces.sync(renamedUser, { resume });
  await runners.waitReady(renamedMcp);
  assert.equal(
    await docker("exec", renamedDev, "cat", "/opt/direct-package-check"),
    "preserved-layer",
  );
  assert.equal(
    await docker(
      "exec",
      renamedDev,
      "cat",
      "/workspace/.dev-mcp-home/.codex/auth.json",
    ),
    "synthetic-agent-secret",
  );
  assert.equal(
    await docker("exec", renamedMcp, "cat", "/workspace/repo/new-file"),
    "from-development",
  );
  const renamedInfo = await runners.inspect(renamedMcp);
  assert.equal(
    renamedInfo.Mounts.find((m) => m.Destination === "/run/dev-mcp-git-auth")
      .Name,
    gitAuthVolume(user),
  );
  console.log(
    "PASS account renaming retains private HOME, Git credentials, installed packages and shared files",
  );
} finally {
  clearInterval(heartbeat);
  for (const name of containers.reverse()) {
    await docker("rm", "--force", name).catch(() => {});
  }
  for (const name of networks.reverse()) {
    await docker(
      "network",
      "disconnect",
      "--force",
      name,
      process.env.HOSTNAME,
    ).catch(() => {});
    await docker("network", "rm", name).catch(() => {});
  }
  for (const name of volumes) {
    await docker("volume", "rm", name).catch(() => {});
  }
  for (const image of snapshots) {
    await docker("image", "rm", image).catch(() => {});
  }
}
