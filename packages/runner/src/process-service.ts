import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { NetworkIntent, ToolResult } from "./protocol.ts";
import { errorMessage, fail, ok } from "./protocol.ts";
import type { RunnerConfig } from "./config.ts";
import { JsonStore } from "./json-store.ts";
import type { ProjectService } from "./project-service.ts";
import { resolveExisting } from "./paths.ts";
import { cleanEnvironment } from "./subprocess.ts";

interface ProcessRecord {
  id: string;
  projectId: string;
  command: string;
  cwd: string;
  networkIntent: NetworkIntent;
  pid: number;
  procStart: string;
  startedAt: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  endedAt?: string;
  logFile: string;
}
interface ProcessRegistry {
  processes: ProcessRecord[];
}

export class ProcessService {
  private readonly store: JsonStore<ProcessRegistry>;
  private readonly logDir: string;

  constructor(
    private readonly config: RunnerConfig,
    private readonly projects: ProjectService,
  ) {
    this.store = new JsonStore(
      path.join(config.dataDir, "processes.json"),
      () => ({ processes: [] }),
    );
    this.logDir = path.join(config.dataDir, "process-logs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.logDir, { recursive: true, mode: 0o700 });
    await this.store.update(async (registry) => {
      for (const record of registry.processes) {
        if (
          record.status === "running" &&
          !(await sameProcess(record.pid, record.procStart))
        ) {
          record.status = "exited";
          record.exitCode = null;
          record.endedAt = new Date().toISOString();
        }
      }
    });
  }

  async start(
    projectId: string,
    command: string,
    cwd = ".",
    networkIntent: NetworkIntent = "none",
  ): Promise<ToolResult> {
    try {
      if (!command.trim()) {
        return fail("INVALID_COMMAND", "Command cannot be empty");
      }
      if (!new Set(["none", "read", "write"]).has(networkIntent)) {
        return fail("INVALID_NETWORK_INTENT", "network_intent is invalid");
      }
      const registry = await this.store.read();
      const running = registry.processes.filter(
        (record) => record.status === "running",
      ).length;
      if (running >= this.config.maxConcurrentProcesses) {
        return fail(
          "PROCESS_LIMIT",
          "Maximum concurrent background processes reached",
        );
      }
      const { root } = await this.projects.get(projectId);
      const workingDirectory = await resolveExisting(root, cwd);
      const id = randomUUID();
      const logFile = path.join(this.logDir, `${id}.log`);
      await writeFile(logFile, "", { flag: "a", mode: 0o600 });
      const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd: workingDirectory,
        env: cleanEnvironment({
          home: this.config.dataDir,
          ...(this.config.gitAuthorName
            ? { gitAuthorName: this.config.gitAuthorName }
            : {}),
          ...(this.config.gitAuthorEmail
            ? { gitAuthorEmail: this.config.gitAuthorEmail }
            : {}),
        }),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) {
        return fail("PROCESS_START_FAILED", "Process did not return a PID");
      }
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      const record: ProcessRecord = {
        id,
        projectId,
        command,
        cwd,
        networkIntent,
        pid: child.pid,
        procStart: await processStart(child.pid),
        startedAt: new Date().toISOString(),
        status: "running",
        logFile,
      };
      await this.store.update((value) => {
        value.processes.push(record);
      });
      child.once("close", (exitCode, signal) => {
        log.end();
        void this.store.update((value) => {
          const current = value.processes.find((entry) => entry.id === id);
          if (current && current.status === "running") {
            current.status = "exited";
            current.exitCode = exitCode;
            current.signal = signal;
            current.endedAt = new Date().toISOString();
          }
        });
      });
      child.unref();
      return ok({ process: publicRecord(record) });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "PROCESS_START_FAILED",
        errorMessage(error),
      );
    }
  }

  async list(projectId?: string): Promise<ToolResult> {
    await this.refresh();
    const registry = await this.store.read();
    return ok({
      processes: registry.processes
        .filter((entry) => !projectId || entry.projectId === projectId)
        .map(publicRecord),
    });
  }

  private async status(id: string): Promise<ToolResult> {
    await this.refresh();
    const record = (await this.store.read()).processes.find(
      (entry) => entry.id === id,
    );
    return record
      ? ok({ process: publicRecord(record) })
      : fail("PROCESS_NOT_FOUND", `Unknown process: ${id}`);
  }

  async logs(
    id: string,
    cursor?: string,
    maxBytes = this.config.maxOutputBytes,
  ): Promise<ToolResult> {
    try {
      const record = (await this.store.read()).processes.find(
        (entry) => entry.id === id,
      );
      if (!record) {
        return fail("PROCESS_NOT_FOUND", `Unknown process: ${id}`);
      }
      const offset = cursor ? decodeLogCursor(cursor, id) : 0;
      const size = (await stat(record.logFile)).size;
      const end = Math.min(
        size,
        offset + Math.min(Math.max(maxBytes, 1), this.config.maxOutputBytes),
      );
      const handle = await open(record.logFile, "r");
      const content = Buffer.alloc(Math.max(0, end - offset));
      const { bytesRead } = await handle.read(
        content,
        0,
        content.length,
        offset,
      );
      await handle.close();
      return ok(
        {
          output: content.subarray(0, bytesRead).toString("utf8"),
          offset,
          nextOffset: offset + bytesRead,
        },
        {
          truncated: end < size,
          ...(end < size ? { continuation: encodeLogCursor(id, end) } : {}),
        },
      );
    } catch (error) {
      return fail("PROCESS_LOG_FAILED", errorMessage(error));
    }
  }

  async stop(id: string): Promise<ToolResult> {
    try {
      const record = (await this.store.read()).processes.find(
        (entry) => entry.id === id,
      );
      if (!record) {
        return fail("PROCESS_NOT_FOUND", `Unknown process: ${id}`);
      }
      if (record.status !== "running") {
        return ok({ process: publicRecord(record), alreadyStopped: true });
      }
      if (!(await sameProcess(record.pid, record.procStart))) {
        await this.markDead(id, "exited");
        return fail(
          "PROCESS_STALE",
          "PID no longer refers to the recorded process",
        );
      }
      try {
        process.kill(-record.pid, "SIGTERM");
      } catch {
        process.kill(record.pid, "SIGTERM");
      }
      if (!(await waitForExit(record.pid, record.procStart, 2_000))) {
        try {
          process.kill(-record.pid, "SIGKILL");
        } catch {
          process.kill(record.pid, "SIGKILL");
        }
        if (!(await waitForExit(record.pid, record.procStart, 2_000))) {
          return fail(
            "PROCESS_STOP_FAILED",
            "Process remained alive after SIGKILL",
          );
        }
      }
      await this.store.update((registry) => {
        const current = registry.processes.find((entry) => entry.id === id);
        if (current) {
          current.status = "stopped";
          current.signal = "SIGTERM";
          current.endedAt = new Date().toISOString();
        }
      });
      return this.status(id);
    } catch (error) {
      return fail("PROCESS_STOP_FAILED", errorMessage(error));
    }
  }

  private async refresh(): Promise<void> {
    await this.store.update(async (registry) => {
      for (const record of registry.processes) {
        if (
          record.status === "running" &&
          !(await sameProcess(record.pid, record.procStart))
        ) {
          record.status = "exited";
          record.exitCode = null;
          record.endedAt = new Date().toISOString();
        }
      }
    });
  }

  private async markDead(
    id: string,
    status: "exited" | "stopped",
  ): Promise<void> {
    await this.store.update((registry) => {
      const record = registry.processes.find((entry) => entry.id === id);
      if (record) {
        record.status = status;
        record.endedAt = new Date().toISOString();
      }
    });
  }
}

function publicRecord(
  record: ProcessRecord,
): Omit<ProcessRecord, "logFile" | "procStart"> {
  const { logFile: _, procStart: __, ...safe } = record;
  return safe;
}
async function processStart(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(")") + 2).split(" ")[19] ?? "";
}
async function sameProcess(pid: number, expected: string): Promise<boolean> {
  try {
    return (await processStart(pid)) === expected;
  } catch {
    return false;
  }
}
async function waitForExit(
  pid: number,
  expected: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await sameProcess(pid, expected))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !(await sameProcess(pid, expected));
}
function encodeLogCursor(id: string, offset: number): string {
  return Buffer.from(
    JSON.stringify({ v: 1, kind: "process-log", id, offset }),
  ).toString("base64url");
}
function decodeLogCursor(token: string, id: string): number {
  const value = JSON.parse(
    Buffer.from(token, "base64url").toString("utf8"),
  ) as { v?: number; kind?: string; id?: string; offset?: number };
  if (
    value.v !== 1 ||
    value.kind !== "process-log" ||
    value.id !== id ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset ?? -1) < 0
  ) {
    throw new Error("Invalid process log cursor");
  }
  return value.offset as number;
}
