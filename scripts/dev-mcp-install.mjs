#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const directory = path.join(process.env.HOME, ".dev-mcp");
await mkdir(directory, { recursive: true, mode: 0o700 });
const filename = path.join(directory, "packages.txt");
const status = async (phase) =>
  writeFile(
    path.join(directory, "packages-status.json"),
    JSON.stringify({ phase, at: Date.now() }),
    { mode: 0o600 },
  );
let saved = [];
try {
  saved = (await readFile(filename, "utf8")).split(/\s+/).filter(Boolean);
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
const restore = process.argv.length === 3 && process.argv[2] === "--restore";
const packages = [...new Set(restore ? saved : process.argv.slice(2))];
if (
  packages.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9+_.-]{0,127}$/.test(name)) ||
  (!restore && !packages.length)
) {
  throw new Error("Usage: dev-mcp-install <Fedora package names>");
}
const execute = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
await status("restoring");
try {
  const missing = [];
  for (const name of packages) {
    if ((await execute("rpm", ["-q", name])) !== 0) {
      missing.push(name);
    }
  }
  if (
    missing.length &&
    (await execute("sudo", [
      "-n",
      "dnf",
      "install",
      "-y",
      "--",
      ...missing,
    ])) !== 0
  ) {
    throw new Error(
      "Package installation failed; run dev-mcp-install --restore to retry",
    );
  }
  if (!restore) {
    const temporary = filename + "." + process.pid;
    await writeFile(
      temporary,
      [...new Set([...saved, ...packages])].sort().join("\n") + "\n",
      { mode: 0o600 },
    );
    await rename(temporary, filename);
  }
  await status("ready");
} catch (error) {
  await status("failed");
  throw error;
}
