import path from "node:path";

export interface RunnerConfig {
  workspaceRoot: string;
  dataDir: string;
  socketPath: string;
  ipcSecretFile?: string;
  maxConcurrentCommands: number;
  maxConcurrentProcesses: number;
  defaultCommandTimeoutMs: number;
  maxOutputBytes: number;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    workspaceRoot: path.resolve(env.WORKSPACE_ROOT ?? "/workspace"),
    dataDir: path.resolve(env.RUNNER_DATA_DIR ?? "/var/lib/dev-mcp"),
    socketPath: path.resolve(env.RUNNER_SOCKET ?? "/ipc/runner.sock"),
    ipcSecretFile: env.RUNNER_IPC_SECRET_FILE,
    maxConcurrentCommands: nonNegativeInt(env.MAX_CONCURRENT_COMMANDS, 4) || 1,
    maxConcurrentProcesses:
      nonNegativeInt(env.MAX_CONCURRENT_PROCESSES, 8) || 1,
    defaultCommandTimeoutMs: nonNegativeInt(env.DEFAULT_COMMAND_TIMEOUT_MS, 0),
    maxOutputBytes:
      nonNegativeInt(env.MAX_OUTPUT_BYTES, 64 * 1024) || 64 * 1024,
    ...(env.GIT_AUTHOR_NAME ? { gitAuthorName: env.GIT_AUTHOR_NAME } : {}),
    ...(env.GIT_AUTHOR_EMAIL ? { gitAuthorEmail: env.GIT_AUTHOR_EMAIL } : {}),
  };
}
