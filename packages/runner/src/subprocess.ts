import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export function cleanEnvironment(options: {
  home: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: options.home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    GIT_CONFIG_NOSYSTEM: "1",
    ...(options.gitAuthorName
      ? {
          GIT_AUTHOR_NAME: options.gitAuthorName,
          GIT_COMMITTER_NAME: options.gitAuthorName,
        }
      : {}),
    ...(options.gitAuthorEmail
      ? {
          GIT_AUTHOR_EMAIL: options.gitAuthorEmail,
          GIT_COMMITTER_EMAIL: options.gitAuthorEmail,
        }
      : {}),
  };
}

export async function execFile(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    maxCaptureBytes?: number;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const max = options.maxCaptureBytes ?? Number.POSITIVE_INFINITY;
    const capture = (
      chunks: Buffer[],
      current: number,
      chunk: Buffer,
    ): number => {
      const remaining = Math.max(0, max - current);
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
      }
      return current + chunk.length;
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, stdoutBytes, chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, stderrBytes, chunk);
    });
    child.once("error", reject);
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          }, options.timeoutMs)
        : undefined;
    timer?.unref();
    child.once("close", (exitCode, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
      });
    });
    if (options.input !== undefined) {
      child.stdin!.end(options.input);
    }
  });
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
