import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { RunnerRuntime } from "../src/runtime.ts";
import { cleanEnvironment, execFile } from "../src/subprocess.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-development-"));
  temporary.push(directory);
  const root = path.join(directory, "repo"),
    home = path.join(directory, "home");
  await mkdir(root);
  await mkdir(home);
  const runtime = new RunnerRuntime({
    workspaceRoot: directory,
    dataDir: path.join(directory, "data"),
    userHome: home,
    discoverWorkspaceProcesses: true,
    socketPath: path.join(directory, "runner.sock"),
    maxConcurrentCommands: 2,
    maxConcurrentProcesses: 2,
    defaultCommandTimeoutMs: 0,
    maxOutputBytes: 8192,
    gitAuthorName: "Default Identity",
    gitAuthorEmail: "default@example.test",
  });
  await runtime.initialize();
  const registered = await runtime.projects.register("repo", "repo");
  const id = (registered.data as { project: { id: string } }).project.id;
  return { root, home, runtime, id };
}
it("uses the same persisted HOME for commands and Git commits, honoring user configuration", async () => {
  const f = await fixture();
  const env = cleanEnvironment({ home: f.home });
  await execFile("git", ["init"], { cwd: f.root, env });
  await execFile("git", ["config", "--global", "user.name", "Developer"], {
    cwd: f.root,
    env,
  });
  await execFile(
    "git",
    ["config", "--global", "user.email", "developer@example.test"],
    { cwd: f.root, env },
  );
  await writeFile(path.join(f.root, "test.txt"), "development");
  expect((await f.runtime.git.commit(f.id, "Initial")).ok).toBe(true);
  const log = await execFile("git", ["log", "-1", "--format=%an <%ae>"], {
    cwd: f.root,
    env,
  });
  expect(log.stdout.toString().trim()).toBe(
    "Developer <developer@example.test>",
  );
  const command = await f.runtime.commands.run(f.id, 'printf "%s" "$HOME"');
  expect(command.ok).toBe(true);
  expect((command.data as { output: string }).output).toContain(f.home);
});
it("discovers and stops terminal processes in registered projects while rejecting stale PIDs", async () => {
  const f = await fixture();
  const child = spawn("sleep", ["60"], { cwd: f.root, stdio: "ignore" });
  try {
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    const listed = await f.runtime.processes.list(f.id);
    const records = (
      listed.data as {
        processes: Array<{ id: string; pid: number; origin: string }>;
      }
    ).processes;
    const external = records.find((entry) => entry.pid === child.pid)!;
    expect(external.origin).toBe("terminal");
    const stale = external.id.replace(/:[0-9]+$/, ":0");
    expect((await f.runtime.processes.stop(stale)).ok).toBe(false);
    expect(child.exitCode).toBeNull();
    const logs = await f.runtime.processes.logs(external.id);
    expect(logs.ok).toBe(true);
    expect(logs.data).toMatchObject({
      output: "",
      captureAvailable: false,
      logSource: "terminal",
      offset: 0,
      nextOffset: 0,
      cursor: expect.any(String),
    });
    const cursor = (logs.data as { cursor: string }).cursor;
    expect(cursor).not.toBe("");
    for (let poll = 0; poll < 3; poll += 1) {
      expect(await f.runtime.processes.logs(external.id, cursor)).toEqual(logs);
    }
    expect((await f.runtime.processes.stop(external.id)).ok).toBe(true);
    await new Promise<void>((resolve) =>
      child.exitCode !== null || child.signalCode !== null
        ? resolve()
        : child.once("exit", () => resolve()),
    );
    expect(
      (
        (await f.runtime.processes.list(f.id)).data as {
          processes: Array<{ pid: number }>;
        }
      ).processes.some((entry) => entry.pid === child.pid),
    ).toBe(false);
  } finally {
    child.kill();
  }
});
