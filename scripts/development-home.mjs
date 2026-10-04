import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";

export async function initializeDevelopmentHome(home) {
  const info = await lstat(home);
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error("Development home must be an owned directory");
  }
  await chmod(home, 0o700);
  await mkdir(path.join(home, ".local", "bin"), { recursive: true });
  // Seed Fedora's normal prompt and PATH without replacing personal settings.
  for (const name of [".bashrc", ".bash_profile"]) {
    await cp(path.join("/etc/skel", name), path.join(home, name), {
      force: false,
    });
  }
  const npmrc = path.join(home, ".npmrc");
  let settings = "";
  try {
    settings = await readFile(npmrc, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!/^\s*prefix\s*=/m.test(settings)) {
    await appendFile(
      npmrc,
      (settings && !settings.endsWith("\n") ? "\n" : "") +
        "prefix=${HOME}/.local\n",
      { mode: 0o600 },
    );
  }
}
