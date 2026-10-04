import { spawn } from "node:child_process";
import { cp, mkdir, lstat, chmod, access } from "node:fs/promises";
import path from "node:path";
import { initializeDevelopmentHome } from "./development-home.mjs";

const home = process.env.RUNNER_USER_HOME ?? "/workspace/.dev-mcp-home";
await mkdir(home, { recursive: true, mode: 0o700 });
const info = await lstat(home);
if (!info.isDirectory() || info.uid !== process.getuid()) {
  throw new Error("Development home must be an owned directory");
}
await chmod(home, 0o700);
// Migrate earlier MCP credentials only when the shared home has no equivalent.
for (const name of [".gitconfig", ".ssh", ".config/gh", ".npmrc"]) {
  const source = path.join(
    process.env.RUNNER_DATA_DIR ?? "/var/lib/dev-mcp",
    name,
  );
  const target = path.join(home, name);
  try {
    await access(target);
  } catch {
    try {
      await access(source);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
await initializeDevelopmentHome(home);
for (const [key, value] of [
  ["user.name", process.env.GIT_AUTHOR_NAME],
  ["user.email", process.env.GIT_AUTHOR_EMAIL],
]) {
  if (value) {
    const read = spawn("git", ["config", "--global", "--get", key], {
      stdio: "ignore",
    });
    const code = await new Promise((resolve) => read.once("exit", resolve));
    if (code === 1) {
      const write = spawn("git", ["config", "--global", key, value], {
        stdio: "inherit",
      });
      await new Promise((resolve) => write.once("exit", resolve));
    }
  }
}
const children = [];
let stopping = false;
const stop = (signal = "SIGTERM") => {
  stopping = true;
  for (const child of children) {
    child.kill(signal);
  }
};
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}
const runner = spawn(process.execPath, ["packages/runner/dist/index.js"], {
  stdio: "inherit",
});
children.push(runner);
if (process.env.SSH_WORKSPACE === "true") {
  const ssh = spawn(process.execPath, ["scripts/ssh-server.mjs"], {
    stdio: "inherit",
  });
  children.push(ssh);
}
for (const child of children) {
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
    stop();
  });
  child.once("exit", (code) => {
    if (!stopping) {
      process.exitCode = code || 1;
      stop();
    }
  });
}
// A slow package mirror must not delay MCP or SSH availability.
const restore = spawn("dev-mcp-install", ["--restore"], { stdio: "inherit" });
children.push(restore);
restore.once("error", (error) =>
  console.error("Package restore: " + error.message),
);
