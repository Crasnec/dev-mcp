import { randomUUID } from "node:crypto";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "./protocol.ts";
import { fail, ok } from "./protocol.ts";

interface Continuation {
  v: 1;
  kind: "output";
  id: string;
  offset: number;
}

export class OutputStore {
  private readonly directory: string;
  constructor(
    dataDir: string,
    private readonly defaultBytes: number,
  ) {
    this.directory = path.join(dataDir, "output");
  }

  async save(
    content: Buffer,
  ): Promise<{ preview: string; truncated: boolean; continuation?: string }> {
    const preview = content.subarray(0, this.defaultBytes).toString("utf8");
    if (content.length <= this.defaultBytes) {
      return { preview, truncated: false };
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    await writeFile(path.join(this.directory, `${id}.log`), content, {
      mode: 0o600,
    });
    return {
      preview,
      truncated: true,
      continuation: encode({
        v: 1,
        kind: "output",
        id,
        offset: this.defaultBytes,
      }),
    };
  }

  async allocate(): Promise<{ id: string; filename: string }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    return { id, filename: path.join(this.directory, `${id}.log`) };
  }

  async finalize(
    id: string,
  ): Promise<{ preview: string; truncated: boolean; continuation?: string }> {
    const filename = path.join(this.directory, `${id}.log`);
    const size = (await stat(filename)).size;
    const handle = await open(filename, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size, this.defaultBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const truncated = size > bytesRead;
      return {
        preview: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated,
        ...(truncated
          ? {
              continuation: encode({
                v: 1,
                kind: "output",
                id,
                offset: bytesRead,
              }),
            }
          : {}),
      };
    } finally {
      await handle.close();
    }
  }

  async read(token: string, maxBytes = this.defaultBytes): Promise<ToolResult> {
    let parsed: Continuation;
    try {
      parsed = decode(token);
    } catch {
      return fail("INVALID_CONTINUATION", "Continuation token is invalid");
    }
    if (
      parsed.v !== 1 ||
      parsed.kind !== "output" ||
      !/^[0-9a-f-]{36}$/.test(parsed.id) ||
      parsed.offset < 0
    ) {
      return fail("INVALID_CONTINUATION", "Continuation token is invalid");
    }
    const filename = path.join(this.directory, `${parsed.id}.log`);
    try {
      const size = (await stat(filename)).size;
      const end = Math.min(
        size,
        parsed.offset + Math.min(Math.max(maxBytes, 1), this.defaultBytes),
      );
      const handle = await open(filename, "r");
      const content = Buffer.alloc(Math.max(0, end - parsed.offset));
      const { bytesRead } = await handle.read(
        content,
        0,
        content.length,
        parsed.offset,
      );
      await handle.close();
      const truncated = end < size;
      return ok(
        {
          output: content.subarray(0, bytesRead).toString("utf8"),
          offset: parsed.offset,
          nextOffset: parsed.offset + bytesRead,
        },
        {
          truncated,
          ...(truncated
            ? { continuation: encode({ ...parsed, offset: end }) }
            : {}),
        },
      );
    } catch (error) {
      return fail(
        "OUTPUT_NOT_FOUND",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function encode(value: Continuation): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value: string): Continuation {
  return JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as Continuation;
}
