import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunnerRuntime } from "../src/runtime.ts";
import type { ExecutionRecord } from "../src/process-service.ts";
import type { ToolResult } from "../src/protocol.ts";

const fixtures: Array<{ base: string; runtime: RunnerRuntime }> = [];
afterEach(async () => {
  for (const { base, runtime } of fixtures.splice(0)) {
    const listed = await runtime.processes.list();
    for (const record of (listed.data as { processes: ExecutionRecord[] })
      .processes) {
      if (record.status === "running") {
        await runtime.processes.stop(record.id);
      }
    }
    await rm(base, { recursive: true, force: true });
  }
});

async function fixture(maxOutputBytes = 64 * 1024) {
  const base = await mkdtemp(path.join(os.tmpdir(), "mcp-execution-"));
  const root = path.join(base, "workspace", "demo");
  await mkdir(root, { recursive: true });
  const config = {
    workspaceRoot: path.dirname(root),
    dataDir: path.join(base, "data"),
    socketPath: path.join(base, "runner.sock"),
    maxConcurrentCommands: 1,
    maxConcurrentProcesses: 1,
    defaultCommandTimeoutMs: 0,
    maxOutputBytes,
  };
  const runtime = new RunnerRuntime(config);
  fixtures.push({ base, runtime });
  await runtime.initialize();
  const registered = await runtime.projects.register("demo", "demo");
  const projectId = (registered.data as { project: { id: string } }).project.id;
  const call = (method: string, command: string, extra = {}) =>
    runtime.dispatch({
      id: "execution-test",
      method,
      params: {
        project_id: projectId,
        command,
        network_intent: "none",
        ...extra,
      },
    });
  return { base, root, config, runtime, projectId, call };
}

function processOf(result: ToolResult): ExecutionRecord {
  expect(result.ok).toBe(true);
  return (result.data as { process: ExecutionRecord }).process;
}

async function output(runtime: RunnerRuntime, id: string, cursor?: string) {
  const logs = await runtime.processes.logs(id, cursor);
  expect(logs.ok).toBe(true);
  return logs.data as { output: string; cursor: string; logWarning?: string };
}

describe("shared execution records and redirected logs", () => {
  it("tracks commands while running, allows stopping them, and keeps concurrency limits independent", async () => {
    const f = await fixture();
    const background = processOf(await f.call("process_start", "sleep 30"));
    expect((await f.call("process_start", "sleep 30")).error?.code).toBe(
      "PROCESS_LIMIT",
    );
    const pending = f.call("command_run", "printf 'ready\\n'; sleep 30", {
      timeout_ms: 5000,
    });
    let command: ExecutionRecord | undefined;
    await expect
      .poll(async () => {
        const listed = await f.runtime.processes.list();
        command = (
          listed.data as { processes: ExecutionRecord[] }
        ).processes.find((record) => record.mode === "command");
        return command && (await output(f.runtime, command.id)).output;
      })
      .toContain("ready");
    const queued = f.call("command_run", "printf 'queued\\n'");
    expect((await f.runtime.processes.list()).data).toMatchObject({
      processes: [
        expect.objectContaining({ id: background.id }),
        expect.objectContaining({ id: command!.id }),
      ],
    });
    expect((await f.runtime.processes.stop(command!.id)).ok).toBe(true);
    expect(processOf(await pending)).toMatchObject({
      id: command!.id,
      mode: "command",
      status: "stopped",
    });
    expect((await queued).data).toMatchObject({
      output: "queued\n",
      exitCode: 0,
    });
  });

  it("returns exit status and compatible command pagination for the same process log", async () => {
    const f = await fixture(16);
    const result = await f.call(
      "command_run",
      "printf '%100s' '' | tr ' ' x; exit 7",
    );
    const record = processOf(result);
    expect(result.data).toMatchObject({
      processId: record.id,
      exitCode: 7,
      timedOut: false,
      output: "x".repeat(16),
    });
    expect(record).toMatchObject({
      mode: "command",
      status: "exited",
      exitCode: 7,
    });
    let combined = (result.data as { output: string }).output;
    let continuation = result.continuation;
    while (continuation) {
      const next = await f.runtime.dispatch({
        id: "output-test",
        method: "command_output",
        params: { continuation },
      });
      expect(next.ok).toBe(true);
      combined += (next.data as { output: string }).output;
      continuation = next.continuation;
    }
    expect(combined).toBe("x".repeat(100));
    expect((await output(f.runtime, record.id)).output).toBe("x".repeat(16));
    const silent = await f.call("command_run", "true");
    expect(silent.data).toMatchObject({ output: "", exitCode: 0 });
  });

  it.each(["command_run", "process_start"])(
    "captures redirected output for %s and preserves it after source deletion and reload",
    async (tool) => {
      const f = await fixture();
      await mkdir(path.join(f.root, "subdir"));
      const result = await f.call(
        tool,
        "printf '한글 file\\n' > ../build.log; printf 'stderr\\n' >&2",
        { cwd: "subdir", log_file: "build.log" },
      );
      const record = processOf(result);
      await expect
        .poll(async () => (await f.runtime.processes.list()).data)
        .toMatchObject({
          processes: [
            expect.objectContaining({
              id: record.id,
              status: "exited",
              exitCode: 0,
            }),
          ],
        });
      const logs = await output(f.runtime, record.id);
      expect(logs.output).toContain("한글 file\n");
      expect(logs.output).toContain("stderr\n");
      expect((await f.runtime.processes.logs(record.id)).data).toMatchObject({
        logSource: "file",
        logFile: "build.log",
      });
      if (tool === "command_run") {
        expect(result.data).toMatchObject({ output: logs.output });
      }
      await rm(path.join(f.root, "build.log"));
      const reloaded = new RunnerRuntime(f.config);
      await reloaded.initialize();
      expect((await output(reloaded, record.id)).output).toBe(logs.output);
    },
  );

  it("follows appends after EOF and captures observed rotation and truncation without repeating earlier bytes", async () => {
    const f = await fixture();
    const record = processOf(
      await f.call("process_start", "printf 'first\\n' > live.log; sleep 30", {
        log_file: "live.log",
      }),
    );
    let cursor: string | undefined;
    await expect
      .poll(async () => {
        const logs = await output(f.runtime, record.id);
        cursor = logs.cursor;
        return logs.output;
      })
      .toBe("first\n");
    expect((await output(f.runtime, record.id, cursor)).output).toBe("");
    await rename(path.join(f.root, "live.log"), path.join(f.root, "old.log"));
    await writeFile(path.join(f.root, "live.log"), "rotated\n");
    await expect
      .poll(async () => (await output(f.runtime, record.id)).output)
      .toBe("first\nrotated\n");
    await writeFile(path.join(f.root, "live.log"), "end\n");
    await expect
      .poll(async () => (await output(f.runtime, record.id)).output)
      .toBe("first\nrotated\nend\n");
    expect((await f.runtime.processes.stop(record.id)).ok).toBe(true);
    expect((await output(f.runtime, record.id, cursor)).output).toBe(
      "rotated\nend\n",
    );
  });

  it("drains large redirected output and termination-handler output before completing a timed-out command", async () => {
    const f = await fixture(512 * 1024);
    const result = await f.call(
      "command_run",
      "trap 'printf \"timeout final\\n\" >> timeout.log; exit 9' TERM; printf '%262144s' '' | tr ' ' x > timeout.log; while :; do sleep 0.1; done",
      { timeout_ms: 200, log_file: "timeout.log" },
    );
    const record = processOf(result);
    expect(result.data).toMatchObject({ timedOut: true, exitCode: 9 });
    expect(record).toMatchObject({ status: "exited", timedOut: true });
    const captured = (result.data as { output: string }).output;
    expect(captured.match(/x/g)?.length).toBe(262144);
    expect(captured.includes("timeout final\n")).toBe(true);
    expect((await output(f.runtime, record.id)).output).toBe(
      (result.data as { output: string }).output,
    );
  });

  it("reports missing files separately from successful command status", async () => {
    const f = await fixture();
    const result = await f.call("command_run", "printf 'stdout\\n'", {
      log_file: "missing.log",
    });
    const record = processOf(result);
    expect(result.data).toMatchObject({
      exitCode: 0,
      output: "stdout\n",
      logWarning: expect.stringContaining("has not been created"),
    });
    expect((await output(f.runtime, record.id)).logWarning).toContain(
      "has not been created",
    );
  });

  it("rejects escaping paths before execution and refuses a file replaced by an outside symlink", async () => {
    const f = await fixture();
    const secret = path.join(f.base, "outside.log");
    await writeFile(secret, "outside private content");
    await symlink(secret, path.join(f.root, "escape.log"));
    for (const log_file of ["../outside.log", secret, "escape.log", ""]) {
      const result = await f.call("command_run", "touch should-not-run", {
        log_file,
      });
      expect(result.error?.code).toBe("PATH_VIOLATION");
    }
    await expect(
      readFile(path.join(f.root, "should-not-run")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const record = processOf(
      await f.call("process_start", "printf 'safe\\n' > safe.log; sleep 30", {
        log_file: "safe.log",
      }),
    );
    await expect
      .poll(async () => (await output(f.runtime, record.id)).output)
      .toBe("safe\n");
    await rm(path.join(f.root, "safe.log"));
    await symlink(secret, path.join(f.root, "safe.log"));
    await expect
      .poll(async () => (await output(f.runtime, record.id)).logWarning)
      .toContain("Symlink leaves");
    expect((await output(f.runtime, record.id)).output).toBe("safe\n");
  });
});
