#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { RunnerOperations } from "./runner-operations.mjs";
import { runtimeContainer, runtimeName } from "./runtime-names.mjs";
import { WorkspaceOperations } from "./workspace-operations.mjs";
import { SshRegistry, atomicFile } from "./ssh-registry.mjs";
import {
  parseSshPublicKey,
  workspaceContainer,
  sshLogin,
} from "./ssh-access.mjs";

// Run only in workspace-test.Dockerfile with two fresh registry volumes and
// the Docker socket. All container/network names use fresh random account IDs.
const project = process.env.SSH_TEST_PROJECT;
if (!/^dev-mcp-ws-test-[a-z0-9-]+$/.test(project ?? "")) {
  throw new Error("Set a unique SSH_TEST_PROJECT");
}
const execute = promisify(execFile);
const snapshots = [];
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
  process.env.SSH_TEST_RUNNER_IMAGE ?? "dev-mcp-runner:workspace-test";
process.env.RUNNER_IMAGE = runnerImage;
const entryImage =
  process.env.SSH_TEST_ENTRY_IMAGE ?? "dev-mcp-ssh-entry:workspace-test";
const entry = project + "-entry";
const clientNetwork = project + "-clients";
const temp = await mkdtemp("/tmp/ssh-test-");
const users = [0, 1].map(() => {
  const id = randomUUID();
  return { id, runner: id, status: "active", authVersion: 1 };
});
const [alice, bob] = users;
const registry = new SshRegistry("/ssh-entry-data", "/workspace-auth");
const provision = async (
  user,
  _limits,
  _quota,
  _start,
  _workspace,
  _keepStopped,
  imageOverride,
) => {
  const runner = runtimeContainer(user);
  const image = imageOverride ?? (await runners.runnerImage());
  const { uid, gid } = await workspaces.identity(image);
  await registry.prepare(user, uid, gid);
  if (
    !(await docker(
      "network",
      "ls",
      "--filter",
      "name=^" + runner + "$",
      "--format",
      "{{.ID}}",
    ))
  ) {
    await docker(
      "network",
      "create",
      "--label",
      "dev-mcp.user=" + user.id,
      runner,
    );
  }
  await docker(
    "run",
    "--rm",
    "--user",
    "0:0",
    "--network",
    "none",
    "--mount",
    `type=volume,source=${runner}-ipc,target=/ipc`,
    "--entrypoint",
    "node",
    image,
    "-e",
    'const fs=require("node:fs");fs.chmodSync("/ipc",511);fs.writeFileSync("/ipc/secret","a".repeat(64),{mode:292})',
  );
  await docker(
    "create",
    "--name",
    runner,
    "--hostname",
    runner,
    "--label",
    "dev-mcp.user=" + user.id,
    "--label",
    "dev-mcp.name=" + runtimeName(user),
    "--label",
    "dev-mcp.runtime=unified",
    ...(_keepStopped ? ["--label", "dev-mcp.keep-stopped=true"] : []),
    "--network",
    runner,
    "--init",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,mode=1777",
    "--mount",
    `type=volume,source=${runner}-workspace,target=/workspace`,
    "--mount",
    `type=volume,source=${runner}-data,target=/var/lib/dev-mcp`,
    "--mount",
    `type=volume,source=${runner}-ipc,target=/ipc`,
    "--mount",
    `type=volume,source=${project}-auth,target=/run/dev-mcp-ssh,volume-subpath=${user.id},readonly`,
    "--env",
    "RUNNER_IPC_SECRET_FILE=/ipc/secret",
    "--env",
    "SSH_WORKSPACE=true",
    "--env",
    "SSH_MANIFEST_FILE=/run/dev-mcp-ssh/access.json",
    "--env",
    "SSH_CONFIG_FILE=/etc/ssh/dev-mcp-sshd_config",
    image,
  );
};
const runners = new RunnerOperations(docker, provision, temp, project);
const workspaces = new WorkspaceOperations(docker, runners, registry, project, {
  authVolume: project + "-auth",
});
const clients = new Set();
const containers = [],
  networks = [],
  volumes = [];
let heartbeat;
const access = { entries: {} };
const keyFiles = [];
async function key(user, name) {
  const file = temp + "/" + name;
  await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
  const parsed = parseSshPublicKey(await readFile(file + ".pub", "utf8"));
  access.entries[user.id] ??= {
    revision: randomUUID(),
    authVersion: user.authVersion,
    keys: [],
  };
  const record = { id: randomUUID(), name, ...parsed, createdAt: Date.now() };
  access.entries[user.id].keys.push(record);
  keyFiles.push(file);
  return { file, record };
}
async function waitFor(callback, label, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await callback()) {
      return;
    }
    await delay(500);
  }
  throw new Error("Timed out: " + label);
}
async function config(user, identity, target = workspaceContainer(user.id)) {
  const file = temp + "/config-" + randomUUID();
  const text = `Host entry\n HostName ${entry}\n Port 2222\n User ${sshLogin(user.id)}\n IdentityFile ${identity}\n IdentitiesOnly yes\n StrictHostKeyChecking accept-new\n UserKnownHostsFile ${temp}/known_hosts\n ConnectTimeout 5\n BatchMode yes\nHost workspace\n HostName ${target}\n Port 2222\n User workspace\n ProxyJump entry\n IdentityFile ${identity}\n IdentitiesOnly yes\n StrictHostKeyChecking accept-new\n UserKnownHostsFile ${temp}/known_hosts\n ConnectTimeout 5\n BatchMode yes\n`;
  await writeFile(file, text, { mode: 0o600 });
  return file;
}
const ssh = async (file, ...args) =>
  (await execute("ssh", ["-F", file, ...args], { timeout: 12_000 })).stdout;
async function rejected(file, ...args) {
  await assert.rejects(() => ssh(file, ...args));
}
async function deniedChannel(file, ...args) {
  await assert.rejects(() => ssh(file, ...args), /administratively prohibited/);
}
function client(file, ...args) {
  const process = spawn("ssh", ["-F", file, ...args], { stdio: "ignore" });
  clients.add(process);
  process.once("exit", () => clients.delete(process));
  return process;
}
const request = (action) => ({
  revision: randomUUID(),
  action,
  actorId: alice.id,
  requestedAt: Date.now(),
});
try {
  await registry.init();
  const laptop = await key(alice, "alice-laptop");
  const desktop = await key(alice, "alice-desktop");
  const bobKey = await key(bob, "bob-laptop");
  await registry.sync(users, access);
  heartbeat = setInterval(() => {
    registry.sync(users, access).catch(() => {});
  }, 5000);
  networks.push(clientNetwork);
  await docker(
    "network",
    "create",
    "--label",
    "dev-mcp.test=" + project,
    clientNetwork,
  );
  await docker("network", "connect", clientNetwork, process.env.HOSTNAME);
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
    clientNetwork,
    "--publish",
    "127.0.0.1::2222",
    "--read-only",
    "--init",
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
    "--health-cmd",
    "nc -z -w 2 127.0.0.1 2222",
    "--health-interval",
    "2s",
    "--health-retries",
    "2",
    entryImage,
  );
  for (const user of users) {
    const runner = "dev-mcp-user-" + user.id;
    assert.equal(await runners.inspect(runner), undefined);
    networks.push(runner, "dev-mcp-ssh-" + user.id);
    volumes.push(runner + "-workspace", runner + "-data", runner + "-ipc");
    containers.push(runner);
    await runners.create(user);
    await workspaces.sync(user);
  }
  await registry.sync(users, access);
  await waitFor(
    async () =>
      (await workspaces.observe(alice)).sshReady &&
      (await workspaces.observe(bob)).sshReady,
    "SSH servers healthy",
  );
  for (const user of users) {
    const old = runtimeContainer(user);
    await docker(
      "exec",
      "--user",
      "0:0",
      old,
      "node",
      "-e",
      'const fs=require("node:fs");fs.writeFileSync("/workspace/naming-root-file","root-owned",{mode:256});fs.writeFileSync("/var/lib/dev-mcp/naming-data-file","runtime-data")',
    );
    await docker(
      "exec",
      "--user",
      "0:0",
      old,
      "node",
      "-e",
      'require("node:fs").writeFileSync("/opt/naming-container-file","writable-layer")',
    );
    const before = (await workspaces.observe(user)).sshHostFingerprint;
    user.email = "ssh-test-" + user.id + "@example.test";
    const named = runtimeContainer(user);
    containers.push(named, named + "-previous");
    networks.push(named);
    volumes.push(named + "-workspace", named + "-data", named + "-ipc");
    await runners.migrateNames(user);
    await workspaces.sync(user);
    assert.equal((await workspaces.observe(user)).sshHostFingerprint, before);
    const preserved = JSON.parse(
      await docker(
        "exec",
        "--user",
        "0:0",
        named,
        "node",
        "-p",
        'JSON.stringify({owner:require("node:fs").statSync("/workspace/naming-root-file").uid,contents:require("node:fs").readFileSync("/workspace/naming-root-file","utf8"),data:require("node:fs").readFileSync("/var/lib/dev-mcp/naming-data-file","utf8"),layer:require("node:fs").readFileSync("/opt/naming-container-file","utf8")})',
      ),
    );
    assert.deepEqual(preserved, {
      owner: 0,
      contents: "root-owned",
      data: "runtime-data",
      layer: "writable-layer",
    });
    assert.equal(await runners.inspect(old), undefined);
    assert.equal(await runners.volumeExists(old + "-workspace"), true);
  }
  console.log(
    "PASS email naming preserves root-owned files, runtime data, original volumes and SSH host keys",
  );
  const disabledId = randomUUID();
  const disabled = {
    id: disabledId,
    runner: disabledId,
    status: "disabled",
    authVersion: 1,
  };
  const disabledOld = runtimeContainer(disabled);
  containers.push(disabledOld);
  networks.push(disabledOld);
  volumes.push(
    disabledOld + "-workspace",
    disabledOld + "-data",
    disabledOld + "-ipc",
  );
  await provision(disabled);
  disabled.email = "ssh-disabled-" + disabledId + "@example.test";
  const disabledNamed = runtimeContainer(disabled);
  containers.push(disabledNamed, disabledNamed + "-previous");
  networks.push(disabledNamed);
  volumes.push(
    disabledNamed + "-workspace",
    disabledNamed + "-data",
    disabledNamed + "-ipc",
  );
  await runners.migrateNames(disabled);
  const disabledInfo = (await runners.owned(disabled)).info;
  assert.equal(disabledInfo.State.Status, "created");
  assert.equal(disabledInfo.Config.Labels["dev-mcp.keep-stopped"], "true");
  console.log(
    "PASS email naming preserves an unstarted disabled account without starting it",
  );
  const aliceConfig = await config(alice, laptop.file);
  const desktopConfig = await config(alice, desktop.file);
  const bobConfig = await config(bob, bobKey.file);
  const results = await Promise.all([
    ssh(aliceConfig, "workspace", "cat /proc/sys/kernel/hostname"),
    ssh(desktopConfig, "workspace", "cat /proc/sys/kernel/hostname"),
  ]);
  assert.deepEqual(
    results.map((value) => value.trim()),
    [runtimeContainer(alice), runtimeContainer(alice)],
  );
  assert.equal(
    (await ssh(bobConfig, "workspace", "cat /proc/sys/kernel/hostname")).trim(),
    runtimeContainer(bob),
  );
  console.log(
    "PASS native ProxyJump and concurrent clients reach their own workspace",
  );

  await assert.rejects(
    () => ssh(aliceConfig, "entry", "echo forbidden"),
    /channel 0: open failed/,
  );
  await deniedChannel(
    aliceConfig,
    "-W",
    workspaceContainer(bob.id) + ":2222",
    "entry",
  );
  await deniedChannel(
    aliceConfig,
    "-W",
    workspaceContainer(alice.id) + ":22",
    "entry",
  );
  const wrongTarget = await config(
    alice,
    laptop.file,
    workspaceContainer(bob.id),
  );
  await deniedChannel(wrongTarget, "workspace", "true");
  const wrongIdentity = await config(bob, laptop.file);
  await rejected(wrongIdentity, "workspace", "true");
  await assert.rejects(
    () =>
      ssh(wrongIdentity, "-W", workspaceContainer(bob.id) + ":2222", "entry"),
    /Permission denied [(]publickey[)]/,
  );
  console.log(
    "PASS entry denies shell, foreign destinations, wrong ports and keys",
  );

  const ownRunner = runtimeContainer(alice);
  await docker(
    "exec",
    ownRunner,
    "node",
    "-e",
    'require("node:fs").writeFileSync("/workspace/from-runner", "shared-files")',
  );
  assert.equal(
    (await ssh(aliceConfig, "workspace", "cat /workspace/from-runner")).trim(),
    "shared-files",
  );
  await ssh(
    aliceConfig,
    "workspace",
    "printf persistent > /workspace/.dev-mcp-home/keep; printf workspace-files > /workspace/from-workspace",
  );
  assert.equal(
    await docker("exec", ownRunner, "cat", "/workspace/from-workspace"),
    "workspace-files",
  );
  assert.match(
    await ssh(aliceConfig, "-tt", "workspace", "test -t 0 && printf pty-ok"),
    /pty-ok/,
  );
  await writeFile(temp + "/upload", "sftp-files");
  await writeFile(
    temp + "/batch",
    `put ${temp}/upload /workspace/upload\nget /workspace/upload ${temp}/download\n`,
  );
  await execute(
    "sftp",
    ["-F", aliceConfig, "-b", temp + "/batch", "workspace"],
    { timeout: 15_000 },
  );
  assert.equal(await readFile(temp + "/download", "utf8"), "sftp-files");
  assert.equal(
    (await ssh(aliceConfig, "workspace", "sudo -n id -u")).trim(),
    "0",
  );
  await ssh(
    aliceConfig,
    "workspace",
    "git config --global dev-mcp.shared yes; dev-mcp-install jq",
  );
  assert.equal(
    await docker(
      "exec",
      ownRunner,
      "git",
      "config",
      "--global",
      "dev-mcp.shared",
    ),
    "yes",
  );
  assert.equal(await docker("exec", ownRunner, "sudo", "-n", "id", "-u"), "0");
  console.log(
    "PASS shared HOME and Git credentials, sudo, package manifest, PTY and SFTP",
  );

  const http = client(
    aliceConfig,
    "workspace",
    `node -e 'require("node:http").createServer((q,s)=>s.end("ssh-forward" )).listen(34567,"127.0.0.1")'`,
  );
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const localPort = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const forward = client(
    aliceConfig,
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:34567`,
    "workspace",
  );
  await waitFor(async () => {
    try {
      return (
        (await (await fetch(`http://127.0.0.1:${localPort}`)).text()) ===
        "ssh-forward"
      );
    } catch {
      return false;
    }
  }, "VS Code TCP forwarding");
  http.kill();
  forward.kill();
  console.log("PASS loopback TCP forwarding");

  await docker("network", "disconnect", ownRunner, ownRunner);
  await workspaces.sync(alice);
  const isolated = (await workspaces.owned(alice)).info;
  assert.deepEqual(Object.keys(isolated.NetworkSettings.Networks), [
    "dev-mcp-ssh-" + alice.id,
  ]);
  assert.equal(
    (
      await ssh(aliceConfig, "workspace", "printf network-blocked-ssh-ok")
    ).trim(),
    "network-blocked-ssh-ok",
  );
  await workspaces.apply(alice, request("stop"));
  assert.equal((await runners.owned(alice)).info.State.Running, false);
  await workspaces.sync(alice, { autoStart: false });
  assert.equal((await workspaces.owned(alice)).info.State.Running, false);
  await workspaces.apply(alice, request("start"));
  await waitFor(
    async () => (await workspaces.observe(alice)).sshReady,
    "workspace restarted",
  );
  assert.equal(
    (
      await ssh(aliceConfig, "workspace", "cat /workspace/.dev-mcp-home/keep")
    ).trim(),
    "persistent",
  );
  console.log(
    "PASS network blocking retains SSH and unified development lifecycle preserves data",
  );

  const previousHostKey = (await workspaces.observe(alice)).sshHostFingerprint;
  await docker("rm", "--force", ownRunner);
  await workspaces.sync(alice);
  await waitFor(
    async () => (await workspaces.observe(alice)).sshReady,
    "workspace recreated",
  );
  assert.equal(
    (await workspaces.observe(alice)).sshHostFingerprint,
    previousHostKey,
  );
  assert.equal(
    (
      await ssh(aliceConfig, "workspace", "cat /workspace/.dev-mcp-home/keep")
    ).trim(),
    "persistent",
  );
  assert.match(
    await ssh(aliceConfig, "workspace", "cat ~/.dev-mcp/packages.txt"),
    /jq/,
  );
  console.log(
    "PASS recreation preserves work files, HOME, package manifest and host key",
  );

  const existing = client(aliceConfig, "workspace", "sleep 60");
  await delay(1500);
  access.entries[alice.id].keys = [desktop.record];
  await registry.sync(users, access);
  await waitFor(
    async () => existing.exitCode !== null || existing.signalCode !== null,
    "removed key disconnects existing SSH",
  );
  await rejected(aliceConfig, "workspace", "true");
  await waitFor(async () => {
    try {
      return (
        (await ssh(desktopConfig, "workspace", "printf new-key-ok")).trim() ===
        "new-key-ok"
      );
    } catch {
      return false;
    }
  }, "retained key authenticates");
  console.log("PASS key removal disconnects sessions and blocks removed keys");

  const held = client(desktopConfig, "workspace", "sleep 60");
  await delay(1500);
  clearInterval(heartbeat);
  heartbeat = undefined;
  await atomicFile(
    "/workspace-auth/" + alice.id + "/access.json",
    JSON.stringify({
      enabled: true,
      revision: (await workspaces.observe(alice)).sshRevision,
      expiresAt: Date.now() - 1,
    }),
  );
  await waitFor(
    async () => held.exitCode !== null || held.signalCode !== null,
    "authorization lease expires",
  );
  await rejected(desktopConfig, "workspace", "true");
  await registry.sync(users, access);
  alice.authVersion++;
  await registry.sync(users, access);
  await rejected(desktopConfig, "workspace", "true");
  alice.status = "disabled";
  await registry.sync(users, access);
  await workspaces.sync(alice);
  assert.equal((await workspaces.owned(alice)).info.State.Running, false);
  console.log(
    "PASS lease expiry, credential revocation and account disablement close access",
  );
  await registry.sync(users, access);
  const entryHeld = client(bobConfig, "workspace", "sleep 60");
  await delay(1500);
  const entryManifest = JSON.parse(
    await readFile("/ssh-entry-data/access.json", "utf8"),
  );
  await atomicFile(
    "/ssh-entry-data/access.json",
    JSON.stringify({ ...entryManifest, expiresAt: Date.now() - 1 }),
  );
  await waitFor(
    async () => entryHeld.exitCode !== null || entryHeld.signalCode !== null,
    "entry authorization lease expires",
  );
  await rejected(bobConfig, "workspace", "true");
  console.log(
    "PASS entry lease expiry closes authenticated forwarding connections",
  );
} catch (error) {
  for (const name of containers) {
    const logs = await execute("docker", ["logs", "--tail", "30", name]).catch(
      () => ({ stdout: "", stderr: "" }),
    );
    const output = logs.stdout + logs.stderr;
    if (output) {
      console.error(name, output);
    }
  }
  throw error;
} finally {
  clearInterval(heartbeat);
  for (const process of clients) process.kill();
  for (const name of containers.reverse())
    await docker("rm", "--force", name).catch(() => {});
  await docker(
    "network",
    "disconnect",
    clientNetwork,
    process.env.HOSTNAME,
  ).catch(() => {});
  for (const name of networks.reverse())
    await docker("network", "rm", name).catch(() => {});
  for (const name of volumes)
    await docker("volume", "rm", name).catch(() => {});
  for (const image of new Set(snapshots))
    await docker("image", "rm", image).catch(() => {});
}
