import type { NetworkIntent, ToolResult } from "./protocol.ts";
import { errorMessage, fail, ok } from "./protocol.ts";
import type { RunnerConfig } from "./config.ts";
import { OutputStore } from "./output-store.ts";
import type { ProjectService } from "./project-service.ts";
import { resolveExisting } from "./paths.ts";
import { cleanEnvironment, Semaphore } from "./subprocess.ts";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";

export class CommandService {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly config: RunnerConfig,
    private readonly projects: ProjectService,
    private readonly outputs: OutputStore,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrentCommands);
  }

  async run(
    projectId: string,
    command: string,
    cwd = ".",
    timeoutMs?: number,
    networkIntent: NetworkIntent = "none",
  ): Promise<ToolResult> {
    try {
      if (!command.trim()) {
        return fail("INVALID_COMMAND", "Command cannot be empty");
      }
      if (!new Set(["none", "read", "write"]).has(networkIntent)) {
        return fail("INVALID_NETWORK_INTENT", "network_intent is invalid");
      }
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
      ) {
        return fail(
          "INVALID_TIMEOUT",
          "timeout_ms must be a non-negative integer",
        );
      }
      const { root } = await this.projects.get(projectId);
      const workingDirectory = await resolveExisting(root, cwd);
      return await this.semaphore.use(async () => {
        const allocated = await this.outputs.allocate();
        const log = createWriteStream(allocated.filename, {
          flags: "wx",
          mode: 0o600,
        });
        log.write("[combined stdout/stderr]\n");
        const result = await runToLog("/bin/bash", ["-lc", command], log, {
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
          timeoutMs: timeoutMs ?? this.config.defaultCommandTimeoutMs,
        });
        const saved = await this.outputs.finalize(allocated.id);
        return ok(
          {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            networkIntent,
            output: saved.preview,
          },
          {
            truncated: saved.truncated,
            ...(saved.continuation ? { continuation: saved.continuation } : {}),
          },
        );
      });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "COMMAND_FAILED",
        errorMessage(error),
      );
    }
  }
}

async function runToLog(
  executable: string,
  args: string[],
  log: ReturnType<typeof createWriteStream>,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", (error) => {
      log.end();
      reject(error);
    });
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child.pid, "SIGTERM");
            setTimeout(
              () => killProcessGroup(child.pid, "SIGKILL"),
              2_000,
            ).unref();
          }, options.timeoutMs)
        : undefined;
    timer?.unref();
    child.once("close", (exitCode, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      log.end();
      void finished(log).then(
        () => resolve({ exitCode, signal, timedOut }),
        reject,
      );
    });
  });
}

function killProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already exited */
    }
  }
}
