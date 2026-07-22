import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class JsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly initial: () => T,
  ) {}

  async read(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.filename, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.initial();
      }
      throw error;
    }
  }

  async update<R>(mutator: (value: T) => R | Promise<R>): Promise<R> {
    const operation = this.queue.then(async () => {
      const value = await this.read();
      const result = await mutator(value);
      await this.write(value);
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, this.filename);
  }
}
