import type { NetworkIntent, ToolResult } from "./protocol.ts";
import { errorMessage, fail, ok } from "./protocol.ts";
import type { RunnerConfig } from "./config.ts";
import type { OutputStore } from "./output-store.ts";
import type { ExecutionRecord, ProcessService } from "./process-service.ts";
import { Semaphore } from "./subprocess.ts";

export class CommandService {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly config: RunnerConfig,
    private readonly processes: ProcessService,
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
    logFile?: string,
  ): Promise<ToolResult> {
    try {
      if (
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
      ) {
        return fail(
          "INVALID_TIMEOUT",
          "timeout_ms must be a non-negative integer",
        );
      }
      return await this.semaphore.use(async () => {
        const result = await this.processes.run(
          projectId,
          command,
          cwd,
          networkIntent,
          timeoutMs ?? this.config.defaultCommandTimeoutMs,
          logFile,
        );
        if (!result.ok) {
          return result;
        }
        const process = (result.data as { process: ExecutionRecord }).process;
        const saved = await this.outputs.finalize(process.id);
        return ok(
          {
            processId: process.id,
            process,
            exitCode: process.exitCode,
            signal: process.signal,
            timedOut: process.timedOut ?? false,
            networkIntent,
            output: saved.preview,
            ...(process.logWarning ? { logWarning: process.logWarning } : {}),
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
