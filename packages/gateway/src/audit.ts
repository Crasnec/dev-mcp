import { mkdir, appendFile, open } from "node:fs/promises";
import path from "node:path";

export class AuditLogger {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filename: string;
  constructor(dataDir: string) {
    this.filename = path.join(dataDir, "audit.jsonl");
  }

  write(event: Record<string, unknown>): Promise<void> {
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
      return { records, clipped: start > 0 };
    } finally {
      await handle.close();
    }
  }
}
