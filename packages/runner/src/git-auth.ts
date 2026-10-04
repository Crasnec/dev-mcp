import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunnerConfig } from "./config.ts";

// gh may migrate its configuration when reading an older hosts.yml. Give it
// a private writable copy; the development export remains read-only to MCP.
export class GitAuthSync {
  private previous?: Buffer;
  constructor(private readonly config: RunnerConfig) {}
  async refresh(): Promise<void> {
    if (!this.config.gitAuthDir) {
      return;
    }
    const source = await readFile(
      path.join(this.config.gitAuthDir, "gh", "hosts.yml"),
    ).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return Buffer.alloc(0);
    });
    const directory = path.join(
      this.config.userHome ?? this.config.dataDir,
      ".config",
      "gh",
    );
    const filename = path.join(directory, "hosts.yml");
    if (
      this.previous?.equals(source) &&
      (await readFile(filename).then(
        () => true,
        () => false,
      ))
    ) {
      return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = filename + "." + randomUUID();
    await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
    this.previous = source;
  }
}
