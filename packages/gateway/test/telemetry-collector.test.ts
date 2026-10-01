import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateSamples,
  counterDelta,
  hostSample,
  parseCpu,
  parseDisk,
  parseMemory,
  parseNetwork,
  runnerSample,
  sample,
  unavailable,
} from "../../../scripts/telemetry-metrics.mjs";
import {
  TelemetryStore,
  readBoundedJson,
  RETENTION_MS,
} from "../../../scripts/telemetry-store.mjs";
import {
  Collector,
  DockerApi,
  aggregateMember,
  dockerOutput,
  ownsContainer,
  parseStorage,
} from "../../../scripts/collect-runner-telemetry.mjs";

// These tests use in-memory Docker responses only. They never spawn Docker or
// connect to a socket, and are safe to run independently of provisioner tests.
const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SECOND = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ID = "a".repeat(64);
const NOW = Date.parse("2026-10-01T12:00:00Z");
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "telemetry-collector-"));
  temporary.push(dir);
  return dir;
}
const user = (id = OWNER, status = "active") => ({ id, runner: id, status });
const info = (started = "2026-10-01T00:00:00Z", running = true) => ({
  Id: ID,
  Name: "/dev-mcp-user-" + OWNER,
  Config: { Labels: { "dev-mcp.user": OWNER } },
  State: {
    StartedAt: started,
    Running: running,
    Status: running ? "running" : "exited",
  },
  HostConfig: { NanoCpus: 4e9, Memory: 1024 },
});
const stats = (step = 0) => ({
  id: ID,
  cpu_stats: {
    cpu_usage: { total_usage: 1e9 + step * 10e9 },
    system_cpu_usage: 20e9 + step * 40e9,
    online_cpus: 8,
  },
  memory_stats: { usage: 800, stats: { inactive_file: 300 } },
  networks: { eth0: { rx_bytes: 100 + step * 500, tx_bytes: 20 + step * 50 } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { major: 8, minor: 0, op: "read", value: 1000 + step * 10000 },
      { major: 8, minor: 0, op: "write", value: 2000 + step * 5000 },
    ],
  },
});
const runnerInput = (ts = NOW, step = 0, container = info()) => ({
  ts,
  info: container,
  stats: stats(step),
  hostCores: 8,
  hostMemory: 8192,
});
const hostInput = (ts = NOW, step = 0) => ({
  ts,
  epoch: "boot-a",
  cpu: { total: 1000 + step * 800, idle: 500 + step * 400, cores: 8 },
  memory: { used: 4096, capacity: 8192 },
  network: { rx: { eth0: 100 + step * 500 }, tx: { eth0: 50 + step * 50 } },
  disk: {
    read: { "8:0": 500 + step * 1000 },
    write: { "8:0": 20 + step * 500 },
  },
  filesystem: { used: 200, capacity: 1000 },
});
const entry = (ts: number, cpu = 2, intervalMs = 5000) =>
  sample({
    ts,
    intervalMs,
    values: { cpuUsedCores: cpu, cpuCapacityCores: 8 },
    deltas: { cpuSeconds: (cpu * intervalMs) / 1000, networkRxBytes: 500 },
  });

describe("telemetry observations", () => {
  it("parses host counters without guest, bridge, partition, or available-memory double counting", () => {
    expect(
      parseCpu("cpu 100 0 50 200 30 10 10 0 99 99\ncpu0 1\ncpu1 1\n"),
    ).toEqual({ total: 400, idle: 230, cores: 2 });
    expect(
      parseMemory("MemTotal: 1000 kB\nMemAvailable: 250 kB\nMemFree: 100 kB\n"),
    ).toEqual({ used: 750 * 1024, capacity: 1000 * 1024 });
    expect(
      parseNetwork(
        "eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\nbr0: 900 0 0 0 0 0 0 0 900 0 0 0 0 0 0 0",
        ["eth0"],
      ),
    ).toEqual({ rx: { eth0: 100 }, tx: { eth0: 200 } });
    expect(
      parseDisk(
        "8 0 sda 1 0 20 0 1 0 30 0 0 0 0\n8 1 sda1 1 0 20 0 1 0 30 0 0 0 0",
        ["sda"],
      ),
    ).toEqual({ read: { "8:0": 20 * 512 }, write: { "8:0": 30 * 512 } });
  });

  it("computes multicore CPU, working set, byte rates and separately observed disk gauges", () => {
    const first = runnerSample(runnerInput());
    expect(first.sample.values.cpuUsedCores).toBeNull();
    expect(first.sample.intervalMs).toBe(0);
    const second = runnerSample(
      {
        ...runnerInput(NOW + 5000, 1),
        storage: {
          observedAt: NOW - 200000,
          used: 200,
          capacity: 1000,
          workspace: 150,
          runtime: 50,
          source: "du",
        },
      },
      first.counters,
    ).sample;
    expect(second.values).toMatchObject({
      cpuUsedCores: 2,
      cpuPercent: 200,
      cpuCapacityPercent: 50,
      memoryUsedBytes: 500,
      networkRxBytesPerSecond: 100,
      diskReadBytesPerSecond: 2000,
      diskPercent: 20,
    });
    expect(second.deltas).toMatchObject({
      cpuSeconds: 10,
      networkRxBytes: 500,
      diskReadBytes: 10000,
    });
    expect(second.metricObservedAt.workspaceBytes).toBe(NOW - 200000);
    expect(second.metricObservedAt.diskPercent).toBe(NOW - 200000);
  });

  it("computes host utilization and does not confuse capacity percent with core percent", () => {
    const first = hostSample(hostInput());
    const next = hostSample(hostInput(NOW + 5000, 1), first.counters).sample;
    expect(next.values).toMatchObject({
      cpuUsedCores: 4,
      cpuPercent: 400,
      cpuCapacityPercent: 50,
      memoryPercent: 50,
      diskPercent: 20,
    });
    expect(next.deltas.cpuSeconds).toBe(20);
  });

  it("invalidates reset interfaces independently of aggregate increases and never bridges restarts or long gaps", () => {
    expect(counterDelta({ a: 1, b: 1000 }, { a: 10, b: 20 })).toBeNull();
    expect(counterDelta({ replacement: 20 }, { old: 10 })).toBeNull();
    const previous = runnerSample(runnerInput()).counters;
    for (const input of [
      runnerInput(NOW + 30000, 1),
      runnerInput(NOW + 5000, 1, info("new-epoch")),
    ]) {
      const result = runnerSample(input, previous).sample;
      expect(result.intervalMs).toBe(0);
      expect(result.values.cpuUsedCores).toBeNull();
      expect(result.deltas.networkRxBytes).toBeNull();
    }
    const changed = runnerInput(NOW + 5000, 1);
    changed.stats.networks.eth0.rx_bytes = 1;
    expect(
      runnerSample(changed, previous).sample.values.networkRxBytesPerSecond,
    ).toBeNull();
  });

  it("uses explicit zero for an inspected stopped runner and leaves missing observations unknown", () => {
    const stopped = runnerSample({
      ...runnerInput(),
      info: info("same", false),
      stats: null,
    }).sample;
    expect(stopped.state).toBe("stopped");
    expect(stopped.values.cpuUsedCores).toBe(0);
    expect(stopped.values.memoryUsedBytes).toBe(0);
    expect(stopped.values.networkRxBytesPerSecond).toBe(0);
    expect(stopped.values.diskUsedBytes).toBeNull();
    expect(unavailable(NOW).values.cpuUsedCores).toBeNull();
  });

  it("deduplicates aliases and capacities, and computes the synchronized aggregate before rollup", () => {
    const a = runnerSample(runnerInput()).sample;
    a.values.cpuUsedCores = 2;
    const b = structuredClone(a);
    b.details.containerId = "b".repeat(64);
    b.values.cpuUsedCores = 3;
    const total = aggregateSamples(
      NOW,
      [a, a, b],
      hostSample(hostInput()).sample,
      3,
    );
    expect(total.coverage).toEqual({
      expected: 2,
      observed: 2,
      complete: true,
    });
    expect(total.values.cpuUsedCores).toBe(5);
    expect(total.values.cpuCapacityCores).toBe(8);
    expect(total.values.memoryCapacityBytes).toBe(8192);
    expect(total.values.diskCapacityBytes).toBeNull();
    expect(
      aggregateSamples(
        NOW,
        [a, unavailable(NOW)],
        hostSample(hostInput()).sample,
      ).values.cpuUsedCores,
    ).toBeNull();
  });

  it("expects missing active environments but excludes registrations without an environment", () => {
    expect(aggregateMember(user(OWNER, "pending"), false)).toBe(false);
    expect(aggregateMember(user(OWNER, "disabled"), false)).toBe(false);
    expect(aggregateMember(user(OWNER, "active"), false)).toBe(true);
    expect(aggregateMember(user(OWNER, "disabled"), true)).toBe(true);
    expect(aggregateMember(user(OWNER, "pending"), true)).toBe(true);
  });

  it("preserves partial aggregate state and records known-zero empty runner intervals", () => {
    const host = hostSample(
      hostInput(NOW + 5000, 1),
      hostSample(hostInput()).counters,
    ).sample;
    const partial = sample({
      ts: NOW + 5000,
      state: "partial",
      intervalMs: 5000,
    });
    expect(aggregateSamples(NOW + 5000, [partial], host).state).toBe("partial");
    const empty = aggregateSamples(NOW + 5000, [], host);
    expect(empty.intervalMs).toBe(5000);
    expect(empty.values.cpuUsedCores).toBe(0);
    expect(empty.deltas.networkRxBytes).toBe(0);
  });
});

describe("collector ownership and storage isolation", () => {
  it("requires exact ownership and rejects arbitrary Docker mutations before opening a socket", () => {
    expect(ownsContainer(user(), info(), "dev-mcp")).toBe(true);
    expect(ownsContainer(user(SECOND), info(), "dev-mcp")).toBe(false);
    expect(
      ownsContainer(user(), { ...info(), Name: "/someone-else" }, "dev-mcp"),
    ).toBe(false);
    const primary = {
      ...info(),
      Config: {
        Labels: {
          "com.docker.compose.project": "dev-mcp",
          "com.docker.compose.service": "runner",
          "com.docker.compose.oneoff": "False",
        },
      },
    };
    expect(
      ownsContainer({ ...user(), runner: "primary" }, primary, "dev-mcp"),
    ).toBe(true);
    expect(
      ownsContainer({ ...user(), runner: "primary" }, primary, "other-project"),
    ).toBe(false);
    const api = new DockerApi("/socket-never-accessed");
    expect(() => api.request("DELETE", `/containers/${ID}`)).toThrow(
      "not allowed",
    );
    expect(() =>
      api.request("POST", `/containers/${ID}/exec`, {
        Cmd: ["sh", "-c", "anything"],
      }),
    ).toThrow("fixed storage");
  });

  it("requires complete successful storage output and validates Docker framing", () => {
    expect(parseStorage("100\t/workspace\n20\t/var/lib/dev-mcp\n")).toEqual({
      workspace: 100,
      runtime: 20,
      used: 120,
    });
    for (const text of [
      "100 /workspace",
      "100 /workspace\n20 /unknown",
      "100 /workspace\n20 /workspace",
      "-1 /workspace\n20 /var/lib/dev-mcp",
    ])
      expect(() => parseStorage(text)).toThrow();
    const frame = (stream: number, text: string) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(text), 4);
      return Buffer.concat([header, Buffer.from(text)]);
    };
    expect(
      dockerOutput(
        Buffer.concat([frame(1, "output"), frame(2, "private error")]),
      ),
    ).toBe("output");
    expect(() => dockerOutput(frame(1, "output").subarray(0, 10))).toThrow();
  });

  it("does not publish late storage scans after container recreation", async () => {
    let resolve!: (value: object) => void;
    const docker = {
      storage: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
      inspect: vi.fn(async () => info("replacement")),
    };
    const collector = new Collector({ docker, store: {} });
    const original = info();
    collector.epochs.set(OWNER, original.Id + ":" + original.State.StartedAt);
    collector.scheduleStorage([{ user: user(), info: original }], NOW);
    resolve({ used: 500, workspace: 400, runtime: 100 });
    await vi.waitFor(() => expect(collector.storageInFlight).toBe(false));
    expect(collector.storage.has(OWNER)).toBe(false);
    expect(docker.inspect).toHaveBeenCalledWith(ID);
  });

  it("reports scan failure without invented capacity or bytes", async () => {
    const docker = {
      storage: vi.fn(async () => {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" });
      }),
    };
    const collector = new Collector({ docker, store: {} });
    collector.epochs.set(OWNER, ID + ":" + info().State.StartedAt);
    collector.scheduleStorage([{ user: user(), info: info() }], NOW);
    await vi.waitFor(() => expect(collector.storageInFlight).toBe(false));
    expect(collector.storage.has(OWNER)).toBe(false);
    expect(collector.storageErrors.get(OWNER)).toBe("measurement_timeout");
  });

  it("keeps pending registrations out of the aggregate and clears storage from an old epoch", async () => {
    const dir = await directory();
    await writeFile(
      path.join(dir, "users.json"),
      JSON.stringify({ users: [user(), user(SECOND, "pending")] }),
    );
    const record = vi.fn(async () => {});
    const docker = {
      list: vi.fn(async (filters) =>
        filters.label[0] === "dev-mcp.user"
          ? [{ Id: ID, Names: [info().Name] }]
          : [],
      ),
      inspect: vi.fn(async () => info()),
      stats: vi.fn(async () => stats()),
    };
    const collector = new Collector({
      docker,
      store: { record },
      usersFile: path.join(dir, "users.json"),
      statusDirectory: dir,
      readHost: async () => hostInput(),
    });
    collector.storageInFlight = true;
    collector.epochs.set(OWNER, "old-generation");
    collector.storage.set(OWNER, {
      epoch: "old-generation",
      used: 999,
      observedAt: Date.now(),
    });
    const scopes = await collector.collect();
    expect(scopes["all-runners"].coverage).toEqual({
      expected: 1,
      observed: 1,
      complete: true,
    });
    expect(scopes[SECOND].state).toBe("missing");
    expect(scopes[OWNER].values.diskUsedBytes).toBeNull();
    expect(collector.storage.has(OWNER)).toBe(false);
    expect(record).toHaveBeenCalledOnce();
  });
});

describe("bounded telemetry history", () => {
  it("splits intervals at bucket boundaries and keeps weighted totals exact", async () => {
    const store = new TelemetryStore(await directory());
    await store.initialize(NOW);
    await store.record({ host: entry(NOW + 59000, 2) }, NOW + 59000);
    await store.record({ host: entry(NOW + 64000, 4) }, NOW + 64000);
    const finalized = JSON.parse(
      (await readFile(store.filename("host", "minute", NOW), "utf8")).trim(),
    );
    expect(finalized.metrics.cpuUsedCores).toMatchObject({
      sum: 14000,
      weightMs: 6000,
      max: 4,
    });
    expect(finalized.deltas.cpuSeconds).toBe(14);
    expect(store.pending.host.minute.metrics.cpuUsedCores).toMatchObject({
      sum: 16000,
      weightMs: 4000,
    });
    expect(store.pending.host.hour.metrics.cpuUsedCores).toMatchObject({
      sum: 30000,
      weightMs: 10000,
    });
  });

  it("restores open buckets across restarts without overlapping represented time", async () => {
    const dir = await directory();
    const first = new TelemetryStore(dir);
    await first.initialize(NOW);
    await first.record({ host: entry(NOW + 5000, 2) }, NOW + 5000);
    const resumed = new TelemetryStore(dir);
    await resumed.initialize(NOW + 5000);
    await resumed.record({ host: entry(NOW + 8000, 4, 5000) }, NOW + 8000);
    expect(resumed.pending.host.minute.metrics.cpuUsedCores).toMatchObject({
      sum: 22000,
      weightMs: 8000,
    });
    expect(resumed.pending.host.minute.deltas.cpuSeconds).toBe(22);
    await resumed.record({ host: entry(NOW + 7000, 100, 5000) }, NOW + 7000);
    expect(resumed.pending.host.minute.metrics.cpuUsedCores.weightMs).toBe(
      8000,
    );
    const again = new TelemetryStore(dir);
    await again.initialize(NOW + 9000);
    expect(again.lastTs).toBe(NOW + 8000);
    await again.record({ host: entry(NOW + 13000, 1, 5000) }, NOW + 13000);
    expect(again.pending.host.minute.metrics.cpuUsedCores).toMatchObject({
      sum: 27000,
      weightMs: 13000,
    });
  });

  it("preserves collection gaps and stale disk measurements as missing weight", async () => {
    const store = new TelemetryStore(await directory());
    await store.initialize(NOW);
    await store.record({ host: entry(NOW + 5000) }, NOW + 5000);
    const next = sample({
      ts: NOW + 60000,
      intervalMs: 0,
      values: { cpuUsedCores: 2 },
    });
    await store.record({ host: next }, NOW + 60000);
    expect(store.pending.host.hour.metrics.cpuUsedCores.weightMs).toBe(5000);
    const stale = sample({
      ts: NOW + 65000,
      intervalMs: 5000,
      values: { diskUsedBytes: 10 },
      metricObservedAt: { diskUsedBytes: NOW - 900000 },
    });
    await store.record({ host: stale }, NOW + 65000);
    expect(store.pending.host.hour.metrics.diskUsedBytes.weightMs).toBe(0);
    expect(store.pending.host.hour.deltas.diskReadBytes).toBeNull();
  });

  it("does not replay an older pending bucket after a crash between finalized append and checkpoint", async () => {
    const dir = await directory();
    const first = new TelemetryStore(dir);
    await first.initialize(NOW);
    await first.record({ host: entry(NOW + 59000, 2) }, NOW + 59000);
    const oldCheckpoint = await readFile(path.join(dir, "pending.json"));
    await first.record({ host: entry(NOW + 64000, 4) }, NOW + 64000);
    // Simulate the finalized append surviving while the pending rename did not.
    await writeFile(path.join(dir, "pending.json"), oldCheckpoint);
    const resumed = new TelemetryStore(dir);
    await resumed.initialize(NOW + 69000);
    expect(resumed.pending.host.minute).toBeUndefined();
    expect(resumed.historyLimited).toBe(true);
    await resumed.record({ host: entry(NOW + 69000, 8, 0) }, NOW + 69000);
    await resumed.record({ host: entry(NOW + 74000, 8) }, NOW + 74000);
    const rows = (
      await readFile(resumed.filename("host", "minute", NOW), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].metrics.cpuUsedCores).toMatchObject({
      sum: 14000,
      weightMs: 6000,
    });
    expect(resumed.pending.host.minute.metrics.cpuUsedCores).toMatchObject({
      sum: 40000,
      weightMs: 5000,
    });
  });

  it("makes byte-limit loss explicit and retains loss/start metadata across restart", async () => {
    const dir = await directory();
    const first = new TelemetryStore(dir, { maxFileBytes: 20 });
    await first.initialize(NOW);
    await first.record({ host: entry(NOW + 5000) }, NOW + 5000);
    const resumed = new TelemetryStore(dir);
    await resumed.initialize(NOW + 10000);
    expect(resumed.historyLimited).toBe(true);
    expect(resumed.truncatedBefore).toBe(NOW + 5000);
    expect(resumed.startedAt).toBe(NOW);
    await resumed.record({ host: entry(NOW + 10000) }, NOW + 10000);
    const current = await readBoundedJson(path.join(dir, "current.json"));
    expect(current.history).toMatchObject({
      limited: true,
      startedAt: NOW,
      retentionMs: RETENTION_MS,
    });
    await expect(
      readBoundedJson(path.join(dir, "current.json"), 10),
    ).rejects.toThrow("limit");
  });

  it("prunes expired shards and caps total history without traversing arbitrary scopes", async () => {
    const store = new TelemetryStore(await directory(), { maxBytes: 100 });
    await store.initialize(NOW);
    await store.append("host", "raw", entry(NOW - 4 * 3600000));
    await store.append("host", "raw", entry(NOW));
    await store.prune(NOW);
    await expect(
      readFile(store.filename("host", "raw", NOW - 4 * 3600000)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(store.filename("host", "raw", NOW)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.historyLimited).toBe(true);
    expect(() => store.filename("../elsewhere", "raw", NOW)).toThrow();
  });

  it("separates a crash-truncated last line so new samples remain readable", async () => {
    const store = new TelemetryStore(await directory());
    await store.initialize(NOW);
    await store.append("host", "raw", entry(NOW));
    const filename = store.filename("host", "raw", NOW);
    await writeFile(filename, '{"partial":');
    await store.append("host", "raw", entry(NOW + 5000));
    const lines = (await readFile(filename, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).ts).toBe(NOW + 5000);
  });
});
