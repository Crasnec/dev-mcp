import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);
const quote = (value) => JSON.stringify(value).replaceAll("\\u", "\\\\u");

// Only Git identity and HTTPS credentials cross the container boundary.
// Never export shell startup, Git aliases/hooks/helpers, SSH or AI credentials.
export async function initializeGitAuth(home, directory) {
  await mkdir(path.join(directory, "gh"), { recursive: true, mode: 0o700 });
}

export async function exportGitAuth(home, directory, defaults = {}) {
  const sourceHosts = path.join(home, ".config", "gh", "hosts.yml");
  await exportFile(
    path.join(directory, "gh", "hosts.yml"),
    (await regularFile(home, ".config/gh/hosts.yml"))
      ? await readFile(sourceHosts)
      : Buffer.alloc(0),
  );
  const identity = {};
  for (const key of ["name", "email"]) {
    const result = (await regularFile(home, ".gitconfig"))
      ? await execute(
          "/usr/bin/git",
          [
            "config",
            "--no-includes",
            "--file",
            path.join(home, ".gitconfig"),
            "--get",
            "user." + key,
          ],
          { timeout: 5000, maxBuffer: 8192 },
        ).catch(() => undefined)
      : undefined;
    identity[key] = result?.stdout.trim() || defaults[key];
  }
  let config = "[user]\n";
  for (const key of ["name", "email"]) {
    if (identity[key]) {
      config += `\t${key} = ${quote(identity[key])}\n`;
    }
  }
  config +=
    "[credential]\n\thelper =\n\thelper = store --file=/run/dev-mcp-git-auth/git-credentials\n\thelper = !/usr/bin/gh auth git-credential\n";
  const stored = path.join(home, ".git-credentials");
  const credentials = (await regularFile(home, ".git-credentials"))
    ? await readFile(stored)
    : Buffer.alloc(0);
  const credentialFile = path.join(directory, "git-credentials");
  await exportFile(credentialFile, credentials);
  const filename = path.join(directory, "gitconfig");
  if ((await readFile(filename, "utf8").catch(() => "")) !== config) {
    await writeFile(filename + ".tmp", config, { mode: 0o600 });
    await rename(filename + ".tmp", filename);
  }
}

async function regularFile(home, relative) {
  let filename = home;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part);
    const info = await lstat(filename).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    if (
      !info ||
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    ) {
      return false;
    }
  }
  return true;
}

async function exportFile(filename, value) {
  const previous = await readFile(filename).catch(() => undefined);
  if (!previous?.equals(value)) {
    await writeFile(filename + ".tmp", value, { mode: 0o600 });
    await rename(filename + ".tmp", filename);
  }
}
