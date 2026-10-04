import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { initializeDevelopmentHome } from "./development-home.mjs";
import { initializeGitAuth, exportGitAuth } from "./git-auth.mjs";

const home = process.env.HOME;
const auth = "/run/dev-mcp-git-auth";
await initializeDevelopmentHome(home);
await initializeGitAuth(home, auth);
const defaults = {
  name: process.env.GIT_AUTHOR_NAME,
  email: process.env.GIT_AUTHOR_EMAIL,
};
const execute = promisify(execFile);
for (const key of ["name", "email"]) {
  if (!defaults[key]) {
    continue;
  }
  const existing = await execute("/usr/bin/git", [
    "config",
    "--global",
    "--get",
    "user." + key,
  ]).catch(() => undefined);
  if (!existing?.stdout.trim()) {
    await execute("/usr/bin/git", [
      "config",
      "--global",
      "user." + key,
      defaults[key],
    ]);
  }
}
await exportGitAuth(home, auth, defaults);
let exporting = false;
const timer = setInterval(() => {
  if (exporting) {
    return;
  }
  exporting = true;
  void exportGitAuth(home, auth, defaults)
    .catch(() => console.error("Git identity export failed"))
    .finally(() => {
      exporting = false;
    });
}, 5000);
const ssh = spawn(process.execPath, ["/opt/dev-mcp/scripts/ssh-server.mjs"], {
  stdio: "inherit",
});
const restore = spawn("dev-mcp-install", ["--restore"], { stdio: "inherit" });
restore.once("error", () => console.error("Package restore failed"));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearInterval(timer);
    ssh.kill(signal);
    restore.kill(signal);
  });
}
ssh.once("error", () => {
  clearInterval(timer);
  process.exitCode = 1;
});
ssh.once("exit", (code) => {
  clearInterval(timer);
  restore.kill("SIGTERM");
  process.exitCode = code ?? 1;
});
