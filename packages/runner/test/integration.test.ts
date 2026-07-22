import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import type { RunnerConfig } from "../src/config.ts";
import { RunnerRuntime } from "../src/runtime.ts";

const exec = promisify(execFileCallback);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function runtimeFixture(
  maxOutputBytes = 64 * 1024,
): Promise<{ runtime: RunnerRuntime; root: string; projectId: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "mcp-integration-"));
  temporary.push(base);
  const workspace = path.join(base, "workspace");
  const data = path.join(base, "runner-data");
  const root = path.join(workspace, "demo");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "hello.txt"), "hello\n");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.name", "Fixture"], { cwd: root });
  await exec("git", ["config", "user.email", "fixture@example.test"], {
    cwd: root,
  });
  await exec("git", ["add", "hello.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "initial"], { cwd: root });
  const config: RunnerConfig = {
    workspaceRoot: workspace,
    dataDir: data,
    socketPath: path.join(base, "runner.sock"),
    maxConcurrentCommands: 2,
    maxConcurrentProcesses: 2,
    defaultCommandTimeoutMs: 0,
    maxOutputBytes,
    gitAuthorName: "MCP Runner",
    gitAuthorEmail: "runner@example.test",
  };
  const runtime = new RunnerRuntime(config);
  await runtime.initialize();
  const registered = await runtime.projects.register("demo", "demo");
  expect(registered.ok).toBe(true);
  const projectId = (registered.data as { project: { id: string } }).project.id;
  return { runtime, root, projectId };
}

describe("workspace workflow", () => {
  it("registers, searches, patches, runs, diffs, and commits", async () => {
    const { runtime, root, projectId } = await runtimeFixture();
    const search = await runtime.files.search(projectId, "hello");
    expect(search.ok).toBe(true);
    expect((search.data as { matches: string[] }).matches[0]).toContain(
      "hello.txt",
    );

    const patch = [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+hello world",
      "",
    ].join("\n");
    expect((await runtime.files.applyPatch(projectId, patch)).ok).toBe(true);
    const command = await runtime.commands.run(
      projectId,
      "printf 'generated\\n' > generated.txt",
      ".",
      undefined,
      "none",
    );
    expect(command.ok).toBe(true);
    expect(await readFile(path.join(root, "generated.txt"), "utf8")).toBe(
      "generated\n",
    );

    const diff = await runtime.git.diff(projectId);
    expect((diff.data as { output: string }).output).toContain("hello world");
    const commit = await runtime.git.commit(projectId, "update fixture");
    expect(commit.ok).toBe(true);
    expect((commit.data as { commit: string }).commit).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it("paginates long command output", async () => {
    const { runtime, projectId } = await runtimeFixture(128);
    const result = await runtime.commands.run(
      projectId,
      "i=0; while [ $i -lt 100 ]; do echo 1234567890; i=$((i+1)); done",
      ".",
      undefined,
      "none",
    );
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.continuation).toBeTruthy();
    const next = await runtime.outputs.read(result.continuation!);
    expect(next.ok).toBe(true);
    const timed = await runtime.commands.run(
      projectId,
      "sleep 30",
      ".",
      100,
      "none",
    );
    expect(timed.ok).toBe(true);
    expect((timed.data as { timedOut: boolean }).timedOut).toBe(true);
  });

  it("tracks logs and stops background process groups", async () => {
    const { runtime, projectId } = await runtimeFixture();
    const started = await runtime.processes.start(
      projectId,
      "printf 'ready\\n'; sleep 30",
      ".",
      "none",
    );
    expect(started.ok).toBe(true);
    const id = (started.data as { process: { id: string } }).process.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const logs = await runtime.processes.logs(id);
    expect((logs.data as { output: string }).output).toContain("ready");
    const stopped = await runtime.processes.stop(id);
    expect(stopped.ok).toBe(true);
    expect(
      (stopped.data as { process: { status: string } }).process.status,
    ).toBe("stopped");
  });
});
