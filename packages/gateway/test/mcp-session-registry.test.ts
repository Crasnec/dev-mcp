import { afterEach, expect, it, vi } from "vitest";
import { McpSessionRegistry } from "../src/mcp-session-registry.ts";

afterEach(() => vi.useRealTimers());
const session = (userId = "alice", actor = "client") => ({
  userId,
  actor,
  lastSeenAt: Date.now(),
});
function fixture() {
  vi.useFakeTimers();
  const close = vi.fn(async () => undefined);
  const registry = new McpSessionRegistry<ReturnType<typeof session>>(close, {
    idleMs: 1000,
    perClient: 2,
    perUser: 3,
  });
  const add = (id: string, userId = "alice", actor = "client") => {
    const release = registry.reserve(userId, actor);
    expect(release).toBeTruthy();
    const value = session(userId, actor);
    release!();
    registry.register(id, value);
    return value;
  };
  return { registry, close, add };
}

it("expires idle sessions, resets their idle period on activity and protects long requests", async () => {
  const { registry, close, add } = fixture();
  const idle = add("idle"),
    busy = add("busy");
  const finish = registry.begin(busy);
  await vi.advanceTimersByTimeAsync(900);
  registry.touch(idle);
  await vi.advanceTimersByTimeAsync(1000);
  expect(registry.sessions.has("idle")).toBe(false);
  expect(registry.sessions.has("busy")).toBe(true);
  expect(close).toHaveBeenCalledExactlyOnceWith(idle);
  finish();
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(registry.sessions.has("busy")).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(registry.sessions.size).toBe(0);
});

it("evicts only the least recently used inactive session of the limited client", async () => {
  const { registry, close, add } = fixture();
  const old = add("old");
  await vi.advanceTimersByTimeAsync(1);
  const newer = add("newer");
  add("other-user", "bob");
  add("other-client", "alice", "other");
  await vi.advanceTimersByTimeAsync(1);
  registry.touch(old);
  add("replacement");
  expect(close).toHaveBeenCalledExactlyOnceWith(newer);
  expect([...registry.sessions.keys()]).toEqual([
    "old",
    "other-user",
    "other-client",
    "replacement",
  ]);
});

it("bounds total sessions per user across clients and never evicts active requests", () => {
  const { registry, close, add } = fixture();
  const one = add("one"),
    two = add("two", "alice", "second"),
    three = add("three", "alice", "third");
  const finishes = [one, two, three].map((value) => registry.begin(value));
  expect(registry.reserve("alice", "fourth")).toBeUndefined();
  expect(close).not.toHaveBeenCalled();
  finishes[1]!();
  add("replacement", "alice", "fourth");
  expect(close).toHaveBeenCalledExactlyOnceWith(two);
  expect(registry.sessions.size).toBe(3);
});

it("counts concurrent initializations and releases failed initialization slots", () => {
  const { registry } = fixture();
  const first = registry.reserve("alice", "client"),
    second = registry.reserve("alice", "client");
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(registry.reserve("alice", "client")).toBeUndefined();
  first!();
  first!();
  expect(registry.reserve("alice", "client")).toBeTruthy();
  expect(registry.reserve("alice", "other")).toBeTruthy();
  expect(registry.reserve("alice", "third")).toBeUndefined();
  expect(registry.reserve("bob", "client")).toBeTruthy();
});

it("waits for all overlapping requests and clears timers when sessions close", async () => {
  const { registry, close, add } = fixture();
  const value = add("one");
  const a = registry.begin(value),
    b = registry.begin(value);
  a();
  await vi.advanceTimersByTimeAsync(2000);
  expect(registry.sessions.has("one")).toBe(true);
  b();
  registry.forget("one", value);
  b();
  await vi.advanceTimersByTimeAsync(2000);
  expect(close).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
