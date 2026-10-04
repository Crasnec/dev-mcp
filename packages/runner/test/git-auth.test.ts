import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  initializeGitAuth,
  exportGitAuth,
} from "../../../scripts/git-auth.mjs";
import { cleanEnvironment } from "../src/subprocess.ts";
import { GitAuthSync } from "../src/git-auth.ts";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-git-auth-"));
  temporary.push(dir);
  const home = path.join(dir, "home"),
    auth = path.join(dir, "auth");
  await mkdir(path.join(home, ".config", "gh", "extensions"), {
    recursive: true,
  });
  await initializeGitAuth(home, auth);
  return { dir, home, auth };
}

it("exports only Git identity, HTTPS credentials and gh hosts without startup, agents or executable aliases", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.home, ".gitconfig"),
    "[user]\n name = Developer\n email = developer@example.test\n[alias]\n delegate = !codex exec\n[credential]\n helper = !claude\n[include]\n path = /does-not-exist\n",
  );
  const hosts =
    "github.com:\n    user: developer\n    oauth_token: synthetic-test-token\n    git_protocol: https\n";
  await writeFile(path.join(f.home, ".config", "gh", "hosts.yml"), hosts);
  await writeFile(
    path.join(f.home, ".config", "gh", "config.yml"),
    "aliases:\n delegate: '!codex exec'\n",
  );
  await writeFile(
    path.join(f.home, ".config", "gh", "extensions", "agent"),
    "agent-program",
  );
  await writeFile(path.join(f.home, ".bash_profile"), "claude\n");
  await mkdir(path.join(f.home, ".codex"));
  await writeFile(
    path.join(f.home, ".codex", "auth.json"),
    "synthetic-agent-auth",
  );
  await writeFile(
    path.join(f.home, ".git-credentials"),
    "https://user:synthetic-password@git.example.test\n",
  );
  await exportGitAuth(f.home, f.auth);
  expect((await readdir(f.auth)).sort()).toEqual([
    "gh",
    "git-credentials",
    "gitconfig",
  ]);
  expect(await readdir(path.join(f.auth, "gh"))).toEqual(["hosts.yml"]);
  expect(await readFile(path.join(f.auth, "gh", "hosts.yml"), "utf8")).toBe(
    hosts,
  );
  const config = await readFile(path.join(f.auth, "gitconfig"), "utf8");
  expect(config).not.toMatch(/codex|claude|delegate|include/);
  const env = cleanEnvironment({
    home: path.join(f.dir, "mcp-home"),
    gitAuthDir: f.auth,
    gitAuthorName: "Fallback identity",
    gitAuthorEmail: "fallback@example.test",
  });
  expect(env.GIT_AUTHOR_NAME).toBeUndefined();
  expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  expect(env.GH_CONFIG_DIR).toBe(path.join(f.dir, "mcp-home", ".config", "gh"));
  const identity = await execute(
    "git",
    ["config", "--global", "--get", "user.email"],
    { env },
  );
  expect(identity.stdout.trim()).toBe("developer@example.test");
  const author = await execute("git", ["var", "GIT_AUTHOR_IDENT"], {
    env,
    cwd: f.dir,
  });
  expect(author.stdout).toMatch(/^Developer <developer@example.test>/);
  expect(env.HOME).not.toBe(f.home);
});

it("updates exported tokens and removes logged-out credentials without restoring stale authentication", async () => {
  const f = await fixture();
  const source = path.join(f.home, ".config", "gh", "hosts.yml");
  await writeFile(source, "first-token");
  await exportGitAuth(f.home, f.auth, {
    name: "Default",
    email: "default@example.test",
  });
  await writeFile(source, "second-token");
  await exportGitAuth(f.home, f.auth);
  expect(await readFile(path.join(f.auth, "gh", "hosts.yml"), "utf8")).toBe(
    "second-token",
  );
  await rm(source);
  await initializeGitAuth(f.home, f.auth);
  await exportGitAuth(f.home, f.auth);
  expect(await readFile(path.join(f.auth, "gh", "hosts.yml"), "utf8")).toBe("");
});

it("does not export credentials through file symlinks", async () => {
  const f = await fixture();
  const secret = path.join(f.home, "agent-auth");
  await writeFile(secret, "synthetic-agent-auth");
  await symlink(secret, path.join(f.home, ".git-credentials"));
  await symlink(secret, path.join(f.home, ".config", "gh", "hosts.yml"));
  await exportGitAuth(f.home, f.auth);
  expect(await readFile(path.join(f.auth, "git-credentials"), "utf8")).toBe("");
  expect(await readFile(path.join(f.auth, "gh", "hosts.yml"), "utf8")).toBe("");
  const elsewhere = path.join(f.dir, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, "hosts.yml"), "synthetic-agent-auth");
  await rm(path.join(f.home, ".config", "gh"), { recursive: true });
  await symlink(elsewhere, path.join(f.home, ".config", "gh"));
  await exportGitAuth(f.home, f.auth);
  expect(await readFile(path.join(f.auth, "gh", "hosts.yml"), "utf8")).toBe("");
});

it("gives gh a private configuration copy for migrations, updates and logout without writing to the export", async () => {
  const f = await fixture();
  const mcpHome = path.join(f.dir, "mcp-home");
  await writeFile(path.join(f.auth, "gh", "hosts.yml"), "legacy-token");
  const sync = new GitAuthSync({
    userHome: mcpHome,
    gitAuthDir: f.auth,
  } as never);
  const local = path.join(mcpHome, ".config", "gh", "hosts.yml");
  await sync.refresh();
  expect(await readFile(local, "utf8")).toBe("legacy-token");
  await writeFile(local, "migrated-token");
  await sync.refresh();
  expect(await readFile(local, "utf8")).toBe("migrated-token");
  expect(await readFile(path.join(f.auth, "gh", "hosts.yml"), "utf8")).toBe(
    "legacy-token",
  );
  await writeFile(path.join(f.auth, "gh", "hosts.yml"), "new-token");
  await sync.refresh();
  expect(await readFile(local, "utf8")).toBe("new-token");
  await writeFile(path.join(f.auth, "gh", "hosts.yml"), "");
  await sync.refresh();
  expect(await readFile(local, "utf8")).toBe("");
});
