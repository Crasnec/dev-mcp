import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { RunnerConfig } from "../src/config.ts";
import { ProcessService } from "../src/process-service.ts";
import { ProjectService } from "../src/project-service.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

interface LogPage {
  output: string;
  offset: number;
  nextOffset: number;
  cursor: string;
}

async function fixture(output = "", maxOutputBytes = 64 * 1024) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-process-logs-"));
  temporary.push(dataDir);
  const config: RunnerConfig = {
    workspaceRoot: dataDir,
    dataDir,
    socketPath: path.join(dataDir, "runner.sock"),
    maxConcurrentCommands: 2,
    maxConcurrentProcesses: 2,
    defaultCommandTimeoutMs: 0,
    maxOutputBytes,
  };
  const processStat = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const id = "test-process";
  const logFile = path.join(dataDir, "output.log");
  const record = {
    id,
    projectId: "test-project",
    command: "fixture",
    cwd: ".",
    networkIntent: "none",
    pid: process.pid,
    procStart: processStat
      .slice(processStat.lastIndexOf(")") + 2)
      .split(" ")[19],
    startedAt: new Date().toISOString(),
    status: "running",
    logFile,
  };
  const saveRecord = () =>
    writeFile(
      path.join(dataDir, "processes.json"),
      JSON.stringify({ processes: [record] }),
    );
  await saveRecord();
  await writeFile(logFile, output);
  const service = new ProcessService(config, new ProjectService(config));
  return {
    id,
    service,
    append: (value: string | Buffer) => appendFile(logFile, value),
    finish: async () => {
      record.status = "exited";
      await saveRecord();
    },
    read: async (cursor?: string, maxBytes?: number) => {
      const result = await service.logs(id, cursor, maxBytes);
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ cursor: expect.any(String) });
      return { ...result, data: result.data as LogPage };
    },
  };
}

describe("incremental process logs", () => {
  it("returns reusable cursors for empty logs and reads appended output after EOF", async () => {
    const logs = await fixture();
    const empty = await logs.read();
    expect(empty.data).toMatchObject({ output: "", offset: 0, nextOffset: 0 });
    expect(empty.truncated).toBe(false);
    expect(empty.continuation).toBeUndefined();

    await logs.append("ready\n");
    const first = await logs.read(empty.data.cursor);
    expect(first.data).toMatchObject({
      output: "ready\n",
      offset: 0,
      nextOffset: 6,
    });
    expect(first.truncated).toBe(false);
    expect(first.continuation).toBeUndefined();
    const idle = await logs.read(first.data.cursor);
    expect(idle.data).toEqual({ ...first.data, output: "", offset: 6 });

    await logs.append("complete\n");
    const appended = await logs.read(idle.data.cursor);
    expect(appended.data).toMatchObject({
      output: "complete\n",
      offset: 6,
      nextOffset: 15,
    });
    expect(appended.truncated).toBe(false);
    expect(appended.continuation).toBeUndefined();
  });

  it("keeps byte limits, legacy cursors, and continuation pagination compatible", async () => {
    const logs = await fixture("abcdefghij", 4);
    const first = await logs.read(undefined, 100);
    expect(first.data).toMatchObject({
      output: "abcd",
      offset: 0,
      nextOffset: 4,
    });
    expect(first.truncated).toBe(true);
    expect(first.continuation).toBe(first.data.cursor);
    const second = await logs.read(first.continuation);
    expect(second.data).toMatchObject({
      output: "efgh",
      offset: 4,
      nextOffset: 8,
    });
    expect(second.truncated).toBe(true);
    expect(second.continuation).toBe(second.data.cursor);
    const last = await logs.read(second.continuation);
    expect(last.data).toMatchObject({
      output: "ij",
      offset: 8,
      nextOffset: 10,
    });
    expect(last.truncated).toBe(false);
    expect(last.continuation).toBeUndefined();

    const legacy = Buffer.from(
      JSON.stringify({ v: 1, kind: "process-log", id: logs.id, offset: 4 }),
    ).toString("base64url");
    expect((await logs.read(legacy)).data).toEqual(second.data);
  });

  it.each([1, 2, 3])(
    "preserves UTF-8 while paginating with maxBytes=%i",
    async (maxBytes) => {
      const output = "시작 · café 🦊 \uFEFF 끝\n";
      const logs = await fixture(output);
      await logs.finish();
      let cursor: string | undefined;
      let combined = "";
      for (let page = 0; page < Buffer.byteLength(output); page += 1) {
        const result = await logs.read(cursor, maxBytes);
        combined += result.data.output;
        expect(result.data.nextOffset - result.data.offset).toBeLessThanOrEqual(
          maxBytes,
        );
        cursor = result.data.cursor;
        if (!result.truncated) {
          expect(result.continuation).toBeUndefined();
          expect(result.data.nextOffset).toBe(Buffer.byteLength(output));
          break;
        }
        expect(result.continuation).toBe(cursor);
      }
      expect(combined).toBe(output);
      expect((await logs.read(cursor, maxBytes)).data.output).toBe("");
    },
  );

  it("buffers split UTF-8 writes at live EOF until the character is complete", async () => {
    const logs = await fixture();
    let cursor = (await logs.read()).data.cursor;
    for (const character of ["한", "🦊"]) {
      const bytes = Buffer.from(character);
      for (let index = 0; index < bytes.length; index += 1) {
        await logs.append(bytes.subarray(index, index + 1));
        const result = await logs.read(cursor, 1);
        expect(result.data.output).toBe(
          index === bytes.length - 1 ? character : "",
        );
        expect(result.truncated).toBe(false);
        expect(result.continuation).toBeUndefined();
        cursor = result.data.cursor;
        const idle = await logs.read(cursor, 1);
        expect(idle.data.output).toBe("");
        expect(idle.data.cursor).toBe(cursor);
      }
    }
    await logs.append("\n");
    expect((await logs.read(cursor)).data.output).toBe("\n");
  });

  it("flushes an unfinished UTF-8 character once at terminal EOF", async () => {
    const logs = await fixture();
    await logs.append(Buffer.from([0xf0, 0x9f]));
    const running = await logs.read();
    expect(running.data.output).toBe("");
    await logs.finish();
    const final = await logs.read(running.data.cursor);
    expect(final.data.output).toBe("�");
    expect(final.truncated).toBe(false);
    expect(final.continuation).toBeUndefined();
    expect((await logs.read(final.data.cursor)).data.output).toBe("");
  });

  it("rejects unbounded, malformed, or non-UTF-8 pending cursor bytes", async () => {
    const logs = await fixture("hello");
    for (const pending of [
      42,
      "",
      "A".repeat(1000),
      "!!!!",
      Buffer.from("a").toString("base64url"),
      Buffer.from([0x80]).toString("base64url"),
      Buffer.from([0xe0, 0x80]).toString("base64url"),
      Buffer.from([0xf0, 0x9f, 0xa6, 0x8a]).toString("base64url"),
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({
          v: 1,
          kind: "process-log",
          id: logs.id,
          offset: 5,
          pending,
        }),
      ).toString("base64url");
      expect((await logs.service.logs(logs.id, cursor)).error?.code).toBe(
        "PROCESS_LOG_FAILED",
      );
    }
  });
});
