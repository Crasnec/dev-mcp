import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuditLogger } from "../src/audit.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const failure = {
  event: "mcp_error",
  userId: "alice",
  clientId: "client",
  stage: "session",
  errorCode: "MCP_SESSION_ID_REQUIRED",
  requestMethod: "unknown",
  httpStatus: 400,
};
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-audit-"));
  temporary.push(dir);
  return {
    audit: new AuditLogger(dir),
    lines: async () =>
      (await readFile(path.join(dir, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

it("persists the first failure and one counted summary per window while UI polls retain pending counts", async () => {
  const { audit, lines } = await fixture();
  vi.useFakeTimers();
  await audit.write(failure);
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all(Array.from({ length: 50 }, () => audit.write(failure)));
  expect(await lines()).toHaveLength(1);
  const summary = (await audit.recent()).records.find(
    (record) => record.aggregated,
  );
  expect(summary).toMatchObject({
    ...failure,
    repeatCount: 50,
    firstSeenAt: expect.any(String),
    lastSeenAt: expect.any(String),
  });
  await audit.recent();
  expect(await lines()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await audit.recent();
  expect(await lines()).toHaveLength(2);
  expect((await lines())[1]).toMatchObject({ repeatCount: 50 });
  await audit.write(failure);
  expect(await lines()).toHaveLength(3);
});

it("keeps different principals and diagnostics separate and always writes individual tool calls", async () => {
  const { audit, lines } = await fixture();
  for (const changes of [
    {},
    { userId: "bob" },
    { clientId: "other" },
    { errorCode: "MCP_SESSION_NOT_FOUND" },
    { requestMethod: "tools/call" },
    { sessionId: "different" },
  ]) {
    await audit.write({ ...failure, ...changes });
  }
  await audit.write({ event: "tool_call", userId: "alice", ok: false });
  await audit.write({ event: "tool_call", userId: "alice", ok: false });
  expect(await lines()).toHaveLength(8);
});

it("persists outstanding repeat counts on graceful shutdown", async () => {
  const { audit, lines } = await fixture();
  vi.useFakeTimers();
  await audit.write(failure);
  await audit.write(failure);
  await audit.flush();
  expect(await lines()).toHaveLength(2);
  expect((await lines())[1]).toMatchObject({
    aggregated: true,
    repeatCount: 1,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds aggregation memory and persists suppressed counts before evicting a bucket", async () => {
  const { audit, lines } = await fixture();
  vi.useFakeTimers();
  await audit.write(failure);
  await audit.write(failure);
  for (let index = 0; index < 1000; index += 1)
    await audit.write({ ...failure, clientId: String(index) });
  await audit.recent();
  expect(vi.getTimerCount()).toBe(1000);
  expect((await lines()).find((record) => record.aggregated)).toMatchObject({
    repeatCount: 1,
    clientId: "client",
  });
});
