import { constants, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import { resolveExisting } from "./paths.ts";
import { errorMessage } from "./protocol.ts";

// Copy an explicitly selected project file into the execution's durable log.
// Shell redirections keep their normal meaning; stdout/stderr are still captured.
export class FileLogCapture {
  private offset = 0;
  private identity?: string;
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  warning?: string;

  constructor(
    private readonly root: string,
    private readonly filename: string,
    private readonly log: WriteStream,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.capture(), 100);
    this.timer.unref();
  }

  capture(final = false): Promise<void> {
    if (this.stopping && !final) {
      return this.queue;
    }
    this.queue = this.queue.then(async () => {
      try {
        const filename = await resolveExisting(this.root, this.filename);
        const handle = await open(
          filename,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await handle.stat();
          if (!info.isFile()) {
            throw new Error("The selected log source is not a regular file");
          }
          const identity = `${info.dev}:${info.ino}`;
          if (this.identity !== identity || info.size < this.offset) {
            this.offset = 0;
          }
          this.identity = identity;
          const end = final
            ? info.size
            : Math.min(info.size, this.offset + 256 * 1024);
          while (this.offset < end) {
            const buffer = Buffer.alloc(Math.min(64 * 1024, end - this.offset));
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              this.offset,
            );
            if (!bytesRead) {
              break;
            }
            this.offset += bytesRead;
            if (this.log.destroyed) {
              throw new Error("The execution log is no longer writable");
            }
            if (!this.log.write(buffer.subarray(0, bytesRead))) {
              await once(this.log, "drain");
            }
          }
          this.warning = undefined;
        } finally {
          await handle.close();
        }
      } catch (error) {
        this.warning =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "The selected log file has not been created."
            : `Could not capture the selected log file: ${errorMessage(error)}`;
      }
    });
    return this.queue;
  }

  async finish(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.capture(true);
  }
}
