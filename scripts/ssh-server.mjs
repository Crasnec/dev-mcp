import { readFile, mkdir, lstat, chmod, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// OpenSSH handles the protocol. The supervisor enforces the controller's
// short authorization lease and closes SSH sessions when keys change.
const manifestFile = process.env.SSH_MANIFEST_FILE;
const configFile = process.env.SSH_CONFIG_FILE;
let child,
  revision,
  stopping = false;
const connections = new Set();
async function trackConnections() {
  if (!child) {
    return;
  }
  const processes = new Map();
  for (const entry of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(entry)) {
      continue;
    }
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.set(Number(entry), {
        parent: Number(fields[1]),
        name: (await readFile(`/proc/${entry}/comm`, "utf8")).trim(),
      });
    } catch {}
  }
  const descendants = new Set([child.pid]);
  for (let pass = 0; pass < processes.size; pass++) {
    let changed = false;
    for (const [pid, info] of processes) {
      if (!descendants.has(pid) && descendants.has(info.parent)) {
        descendants.add(pid);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  for (const pid of descendants) {
    if (processes.get(pid)?.name.startsWith("sshd")) {
      connections.add(pid);
    }
  }
  for (const pid of connections) {
    if (!processes.get(pid)?.name.startsWith("sshd")) {
      connections.delete(pid);
    }
  }
}
async function stopSsh() {
  await trackConnections();
  for (const pid of connections) {
    try {
      if (
        (await readFile(`/proc/${pid}/comm`, "utf8")).trim().startsWith("sshd")
      ) {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // A connection may have exited while reading /proc.
    }
  }
  connections.clear();
  if (child) {
    const old = child;
    old.kill("SIGTERM");
    if (old.exitCode === null && old.signalCode === null) {
      await Promise.race([
        new Promise((resolve) => old.once("exit", resolve)),
        delay(2000),
      ]);
    }
    if (old.exitCode === null && old.signalCode === null) {
      old.kill("SIGKILL");
    }
    child = undefined;
  }
}
if (!manifestFile || !configFile) {
  throw new Error("SSH configuration missing");
}
if (process.env.SSH_WORKSPACE === "true") {
  const home = "/workspace/.dev-mcp-home";
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error("Workspace home must be an owned directory");
  }
  await chmod(home, 0o700);
  process.chdir("/workspace");
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    stopping = true;
  });
}
while (!stopping) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch {}
  const now = Date.now();
  const ready =
    manifest?.enabled === true &&
    /^[a-f0-9]{64}$/.test(manifest.revision) &&
    Number.isSafeInteger(manifest.expiresAt) &&
    manifest.expiresAt > now &&
    manifest.expiresAt <= now + 35_000;
  if (!ready || (child && revision !== manifest.revision)) {
    await stopSsh();
  }
  if (ready && !child) {
    revision = manifest.revision;
    child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", configFile], {
      stdio: "inherit",
    });
    const current = child;
    current.once("error", () => {
      if (child === current) {
        child = undefined;
      }
    });
    current.once("exit", () => {
      if (child === current) {
        child = undefined;
      }
    });
  }
  await trackConnections();
  await delay(1000);
}
await stopSsh();
