import { mkdir, appendFile, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class AuditLogger {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filename: string;
  private readonly failures = new Map<
    string,
    {
      event: Record<string, unknown>;
      firstSeenAt: string;
      lastSeenAt: string;
      repeatCount: number;
      aggregationId: string;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(dataDir: string) {
    this.filename = path.join(dataDir, "audit.jsonl");
  }

  write(event: Record<string, unknown>): Promise<void> {
    if (event.event === "mcp_error") {
      // Attribute failures to their principal and exact sanitized diagnostics.
      // Tool calls and other audit events always retain individual records.
      const key = JSON.stringify(
        Object.entries(event)
          .filter(([key]) => key !== "at")
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      const now = new Date().toISOString();
      const existing = this.failures.get(key);
      if (existing) {
        existing.repeatCount += 1;
        existing.lastSeenAt = now;
        return Promise.resolve();
      }
      if (this.failures.size >= 1000)
        this.flushFailure(this.failures.keys().next().value!);
      const timer = setTimeout(() => this.flushFailure(key), 5 * 60_000);
      timer.unref();
      this.failures.set(key, {
        event: { ...event },
        firstSeenAt: now,
        lastSeenAt: now,
        repeatCount: 0,
        aggregationId: randomUUID(),
        timer,
      });
    }
    return this.append(event);
  }

  private summary(failure: {
    event: Record<string, unknown>;
    firstSeenAt: string;
    lastSeenAt: string;
    repeatCount: number;
    aggregationId: string;
  }) {
    return {
      ...failure.event,
      at: failure.lastSeenAt,
      aggregated: true,
      aggregationId: failure.aggregationId,
      repeatCount: failure.repeatCount,
      firstSeenAt: failure.firstSeenAt,
      lastSeenAt: failure.lastSeenAt,
    };
  }

  private flushFailure(key: string): void {
    const failure = this.failures.get(key);
    if (!failure) {
      return;
    }
    this.failures.delete(key);
    clearTimeout(failure.timer);
    if (failure.repeatCount)
      void this.append(this.summary(failure)).catch(() => undefined);
  }

  async flush(): Promise<void> {
    for (const key of this.failures.keys()) this.flushFailure(key);
    await this.queue;
  }

  private append(event: Record<string, unknown>): Promise<void> {
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.filename), {
        recursive: true,
        mode: 0o700,
      });
      await appendFile(
        this.filename,
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        { mode: 0o600 },
      );
    });
    this.queue = operation.catch((error) =>
      console.error(
        JSON.stringify({ event: "audit_error", message: String(error) }),
      ),
    );
    return operation;
  }

  async recent(): Promise<{
    records: Record<string, unknown>[];
    clipped: boolean;
  }> {
    await this.queue;
    let handle;
    try {
      handle = await open(this.filename, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { records: [], clipped: false };
      }
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > 0) {
        lines.shift();
      }
      const records: Record<string, unknown>[] = [];
      for (const line of lines.reverse()) {
        try {
          const value: unknown = JSON.parse(line);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            records.push(value as Record<string, unknown>);
          }
        } catch {
          /* Skip incomplete or malformed log lines. */
        }
      }
      // Pending counts are visible immediately without appending a new record
      // on every UI poll. The timer persists one summary per five-minute window.
      for (const failure of this.failures.values()) {
        if (failure.repeatCount) {
          const summary = this.summary(failure);
          const index = records.findIndex(
            (record) => String(record.at) < summary.at,
          );
          records.splice(index < 0 ? records.length : index, 0, summary);
        }
      }
      return { records, clipped: start > 0 };
    } finally {
      await handle.close();
    }
  }
}
