import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
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
  origin?: "mcp" | "terminal";
}
interface ProcessRegistry {
  processes: ProcessRecord[];
}
interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class ProcessService {
  private readonly store: JsonStore<ProcessRegistry>;
  private readonly logDir: string;
  private readonly logCompletions = new Map<string, Promise<ProcessExit>>();
  private readonly discovered = new Map<string, ProcessRecord>();

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
          home: this.config.userHome ?? this.config.dataDir,
          ...(!this.config.userHome && this.config.gitAuthorName
            ? { gitAuthorName: this.config.gitAuthorName }
            : {}),
          ...(!this.config.userHome && this.config.gitAuthorEmail
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
      const completion = new Promise<ProcessExit>((resolve) => {
        child.once("close", (exitCode, signal) => {
          log.end(() => resolve({ exitCode, signal }));
        });
      });
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
        origin: "mcp",
      };
      this.logCompletions.set(id, completion);
      await this.store.update((value) => {
        value.processes.push(record);
      });
      void completion.then(async ({ exitCode, signal }) => {
        try {
          await this.store.update((value) => {
            const current = value.processes.find((entry) => entry.id === id);
            if (current && current.status === "running") {
              current.status = "exited";
              current.exitCode = exitCode;
              current.signal = signal;
              current.endedAt = new Date().toISOString();
            }
          });
        } finally {
          this.logCompletions.delete(id);
        }
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
      processes: [
        ...registry.processes,
        ...(await this.discover(registry.processes)),
      ]
        .filter((entry) => !projectId || entry.projectId === projectId)
        .map(publicRecord),
    });
  }

  private async status(id: string): Promise<ToolResult> {
    await this.refresh();
    const record = [
      ...(await this.store.read()).processes,
      ...this.discovered.values(),
    ].find((entry) => entry.id === id);
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
      if (id.startsWith("workspace:")) {
        const record = await this.external(id);
        return record
          ? ok({
              output:
                "터미널에서 시작한 프로세스입니다. 출력은 시작한 터미널에서 확인하세요. MCP process_start로 실행하면 로그를 여기서 볼 수 있습니다.",
              cursor: "",
              offset: 0,
              nextOffset: 0,
            })
          : fail("PROCESS_NOT_FOUND", "Terminal process is no longer running");
      }
      const record = (await this.store.read()).processes.find(
        (entry) => entry.id === id,
      );
      if (!record) {
        return fail("PROCESS_NOT_FOUND", `Unknown process: ${id}`);
      }
      const { offset, pending } = cursor
        ? decodeLogCursor(cursor, id)
        : { offset: 0, pending: Buffer.alloc(0) };
      const size = (await stat(record.logFile)).size;
      const end = Math.min(
        size,
        offset + Math.min(Math.max(maxBytes, 1), this.config.maxOutputBytes),
      );
      const handle = await open(record.logFile, "r");
      const content = Buffer.alloc(Math.max(0, end - offset));
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(content, 0, content.length, offset));
      } finally {
        await handle.close();
      }
      const nextOffset = offset + bytesRead;
      const truncated = nextOffset < size;
      const combined = Buffer.concat([pending, content.subarray(0, bytesRead)]);
      let nextPending = incompleteUtf8Suffix(combined);
      if (
        nextPending.length &&
        !truncated &&
        (record.status !== "running" ||
          (!this.logCompletions.has(id) &&
            !(await sameProcess(record.pid, record.procStart))))
      ) {
        nextPending = Buffer.alloc(0);
      }
      const nextCursor = encodeLogCursor(id, nextOffset, nextPending);
      return ok(
        {
          output: combined
            .subarray(0, combined.length - nextPending.length)
            .toString("utf8"),
          offset,
          nextOffset,
          cursor: nextCursor,
        },
        {
          truncated,
          ...(truncated ? { continuation: nextCursor } : {}),
        },
      );
    } catch (error) {
      return fail("PROCESS_LOG_FAILED", errorMessage(error));
    }
  }

  async stop(id: string): Promise<ToolResult> {
    try {
      if (id.startsWith("workspace:")) {
        return this.stopExternal(id);
      }
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
        if (!this.logCompletions.has(id)) {
          await this.markDead(id, "exited");
        }
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
      const completion = this.logCompletions.get(id);
      if (completion && !(await finishesWithin(completion, 2_000))) {
        return fail(
          "PROCESS_STOP_FAILED",
          "Process exited but its output is still draining",
        );
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
          !this.logCompletions.has(record.id) &&
          !(await sameProcess(record.pid, record.procStart))
        ) {
          record.status = "exited";
          record.exitCode = null;
          record.endedAt = new Date().toISOString();
        }
      }
    });
  }

  private async discover(managed: ProcessRecord[]): Promise<ProcessRecord[]> {
    if (!this.config.discoverWorkspaceProcesses) {
      return [];
    }
    const listed = await this.projects.list();
    if (!listed.ok) {
      return [];
    }
    const roots: Array<{ id: string; root: string }> = [];
    for (const project of (listed.data as { projects: Array<{ id: string }> })
      .projects) {
      try {
        roots.push({
          id: project.id,
          root: (await this.projects.get(project.id)).root,
        });
      } catch {}
    }
    const processes = new Map<
      number,
      {
        start: string;
        parent: number;
        cwd: string;
        command: string;
        uid: number;
      }
    >();
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/.test(name)) {
        continue;
      }
      try {
        const pid = Number(name);
        const value = await readFile(`/proc/${pid}/stat`, "utf8");
        const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
        const cwd = await readlink(`/proc/${pid}/cwd`);
        const command = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
        const uid = (await stat(`/proc/${pid}`)).uid;
        if (fields[0] !== "Z") {
          processes.set(pid, {
            start: fields[19]!,
            parent: Number(fields[1]),
            cwd,
            command,
            uid,
          });
        }
      } catch {}
    }
    const managedPids = new Set(
      managed
        .filter((entry) => processes.get(entry.pid)?.start === entry.procStart)
        .map((entry) => entry.pid),
    );
    const candidates = new Map<number, ProcessRecord>();
    for (const [pid, info] of processes) {
      if (
        pid === process.pid ||
        info.uid !== process.getuid?.() ||
        ["bash", "sh", "sshd", "sshd-session", "sshd-auth"].includes(
          info.command,
        )
      ) {
        continue;
      }
      const root = roots.find(
        (entry) =>
          info.cwd === entry.root || info.cwd.startsWith(entry.root + path.sep),
      );
      if (!root) {
        continue;
      }
      let ancestor = pid;
      const visited = new Set<number>();
      while (ancestor && !visited.has(ancestor) && !managedPids.has(ancestor)) {
        visited.add(ancestor);
        ancestor = processes.get(ancestor)?.parent ?? 0;
      }
      if (managedPids.has(ancestor)) {
        continue;
      }
      const id = `workspace:${pid}:${info.start}`;
      candidates.set(pid, {
        id,
        pid,
        procStart: info.start,
        projectId: root.id,
        command: info.command,
        cwd: path.relative(root.root, info.cwd) || ".",
        networkIntent: "none",
        startedAt:
          this.discovered.get(id)?.startedAt ?? new Date().toISOString(),
        status: "running",
        logFile: "",
        origin: "terminal",
      });
    }
    const result = [...candidates.values()].filter(
      (entry) => !candidates.has(processes.get(entry.pid)!.parent),
    );
    this.discovered.clear();
    for (const entry of result) {
      this.discovered.set(entry.id, entry);
    }
    return result;
  }
  private async external(id: string): Promise<ProcessRecord | undefined> {
    await this.discover((await this.store.read()).processes);
    return this.discovered.get(id);
  }
  private async stopExternal(id: string): Promise<ToolResult> {
    const record = await this.external(id);
    if (!record || !(await sameProcess(record.pid, record.procStart))) {
      return fail("PROCESS_STALE", "Terminal process is no longer running");
    }
    process.kill(record.pid, "SIGTERM");
    if (!(await waitForExit(record.pid, record.procStart, 2000))) {
      // Revalidate immediately before sending a signal to a potentially reused PID.
      if (await sameProcess(record.pid, record.procStart)) {
        process.kill(record.pid, "SIGKILL");
      }
      if (!(await waitForExit(record.pid, record.procStart, 2000))) {
        return fail("PROCESS_STOP_FAILED", "Terminal process remained alive");
      }
    }
    record.status = "stopped";
    record.endedAt = new Date().toISOString();
    this.discovered.delete(id);
    return ok({ process: publicRecord(record) });
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
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[19] === expected;
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
async function finishesWithin(
  completion: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function encodeLogCursor(id: string, offset: number, pending: Buffer): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "process-log",
      id,
      offset,
      ...(pending.length ? { pending: pending.toString("base64url") } : {}),
    }),
  ).toString("base64url");
}
function decodeLogCursor(
  token: string,
  id: string,
): { offset: number; pending: Buffer } {
  const value = JSON.parse(
    Buffer.from(token, "base64url").toString("utf8"),
  ) as {
    v?: number;
    kind?: string;
    id?: string;
    offset?: number;
    pending?: unknown;
  };
  if (
    value.v !== 1 ||
    value.kind !== "process-log" ||
    value.id !== id ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset ?? -1) < 0
  ) {
    throw new Error("Invalid process log cursor");
  }
  let pending = Buffer.alloc(0);
  if (value.pending !== undefined) {
    if (
      typeof value.pending !== "string" ||
      !/^[A-Za-z0-9_-]{2,4}$/.test(value.pending)
    ) {
      throw new Error("Invalid process log cursor");
    }
    pending = Buffer.from(value.pending, "base64url");
    if (
      pending.toString("base64url") !== value.pending ||
      pending.length > (value.offset as number) ||
      incompleteUtf8Suffix(pending).length !== pending.length
    ) {
      throw new Error("Invalid process log cursor");
    }
  }
  return { offset: value.offset as number, pending };
}

// Carry at most three unfinished UTF-8 bytes across pages and live EOF reads.
function incompleteUtf8Suffix(content: Buffer): Buffer {
  const tail = content.subarray(Math.max(0, content.length - 3));
  let start = tail.length - 1;
  while (start > 0 && (tail[start]! & 0xc0) === 0x80) {
    start -= 1;
  }
  const suffix = tail.subarray(Math.max(0, start));
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    if (decoder.decode(suffix, { stream: true }) === "") {
      return suffix;
    }
  } catch {
    // Invalid bytes are decoded normally rather than deferred indefinitely.
  }
  return Buffer.alloc(0);
}
