import { mkdir, appendFile } from "node:fs/promises";
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
}
