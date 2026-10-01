import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RunnerTelemetryStore,
  type TelemetryRange,
} from "../src/telemetry-store.ts";
import { TelemetryStore as CollectorStore } from "../../../scripts/telemetry-store.mjs";
import { sample as collectorSample } from "../../../scripts/telemetry-metrics.mjs";

const NOW = Date.parse("2026-10-01T12:00:30Z");
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(now = NOW) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telemetry-store-"));
  temporary.push(directory);
  const root = path.join(directory, "telemetry");
  await mkdir(root);
  const store = new RunnerTelemetryStore(directory, () => now);
  const json = async (name: string, value: unknown) => {
    await writeFile(path.join(root, name), JSON.stringify(value));
  };
  const history = async (
    scope: string,
    tier: "raw" | "minute" | "hour",
    records: Array<Record<string, unknown>>,
    suffix = "",
  ) => {
    const folder = path.join(root, "history", scope, tier);
    await mkdir(folder, { recursive: true });
    const grouped = new Map<string, unknown[]>();
    for (const record of records) {
      const name =
        new Date(Number(record.ts))
          .toISOString()
          .slice(0, tier === "raw" ? 13 : 10) + ".jsonl";
      grouped.set(name, [...(grouped.get(name) ?? []), record]);
    }
    for (const [name, values] of grouped) {
      await writeFile(
        path.join(folder, name),
        values.map((value) => JSON.stringify(value)).join("\n") + "\n" + suffix,
      );
    }
  };
  return { root, store, json, history };
}
function sample(ts: number, cpu: number | null, intervalMs = 5000) {
  return {
    ts,
    intervalMs,
    state: "ok",
    epoch: "host-boot",
    values: {
      cpuUsedCores: cpu,
      cpuPercent: cpu === null ? null : cpu * 100,
      cpuCapacityCores: 8,
    },
    metricObservedAt: {
      cpuUsedCores: ts,
      cpuPercent: ts,
      cpuCapacityCores: ts,
    },
    deltas: { cpuSeconds: cpu === null ? null : (cpu * intervalMs) / 1000 },
    coverage: { expected: 1, observed: 1, complete: true },
  };
}
function rollup(
  ts: number,
  durationMs: number,
  cpu: number,
  weightMs = durationMs,
  maximum = cpu,
) {
  return {
    ts,
    durationMs,
    metrics: {
      cpuUsedCores: {
        sum: cpu * weightMs,
        weightMs,
        max: maximum,
        last: cpu,
        lastAt: ts + weightMs,
        count: weightMs / 5000,
      },
    },
    deltas: { cpuSeconds: (cpu * weightMs) / 1000 },
    deltaCoverageMs: { cpuSeconds: weightMs },
    coverage: {
      expected: 1,
      observed: 1,
      complete: true,
      samples: weightMs / 5000,
    },
  };
}

describe("read-only telemetry history", () => {
  it("reads the actual collector's current, raw and open rollup files consistently", async () => {
    const h = await fixture();
    const writer = new CollectorStore(h.root);
    await writer.initialize(NOW - 10_000);
    for (const [ts, cpu] of [
      [NOW - 5000, 1],
      [NOW, 2],
    ]) {
      await writer.record(
        {
          host: collectorSample({
            ts,
            intervalMs: 5000,
            values: { cpuUsedCores: cpu, cpuCapacityCores: 8 },
            deltas: { cpuSeconds: cpu * 5 },
          }),
        },
        ts,
      );
    }
    for (const range of ["1h", "24h", "7d", "30d"] as TelemetryRange[]) {
      const data = await h.store.read("host", range);
      expect(data.current.values.cpuPercent).toBe(200);
      expect(data.current.values.cpuCapacityPercent).toBe(25);
      expect(data.statistics.cpuUsedCores.average).toBe(1.5);
      expect(data.statistics.cpuUsedCores.max).toBe(2);
      expect(data.statistics.cpuUsedCores.observedMs).toBe(10_000);
      expect(data.totals.cpuSeconds).toBe(15);
      expect(data.history.collectionStartedAt).toBe(NOW - 10_000);
    }
  });
  it("uses elapsed time for averages, sampled maxima and CPU totals, preserving gaps", async () => {
    const h = await fixture();
    await h.json("current.json", {
      schemaVersion: 1,
      ts: NOW,
      scopes: { host: sample(NOW, 4) },
    });
    await h.history("host", "raw", [
      sample(NOW - 15_000, 1),
      sample(NOW - 5000, 3, 10_000),
    ]);
    const result = await h.store.read("host");
    expect(result.current.availability).toBe("fresh");
    expect(result.current.values.cpuPercent).toBe(400);
    expect(result.statistics.cpuUsedCores.average).toBeCloseTo(7 / 3);
    expect(result.statistics.cpuUsedCores.max).toBe(3);
    expect(result.statistics.cpuUsedCores.observedMs).toBe(15_000);
    expect(result.totals.cpuSeconds).toBe(35);
    expect(result.totals.networkRxBytes).toBeNull();
    expect(result.series).toHaveLength(720);
    expect(result.series.at(-1)?.values.cpuUsedCores).toBeNull();
    expect(result.series.at(-1)?.coverage.complete).toBe(false);
    expect(result.history.observedMs).toBe(15_000);
    expect(result.history.coverageRatio).toBeCloseTo(15 / 3600);
  });

  it("includes elapsed pending minute and hour totals without prorating twice", async () => {
    const h = await fixture();
    const minute = Math.floor(NOW / 60_000) * 60_000;
    const hour = Math.floor(NOW / 3600_000) * 3600_000;
    await h.json("pending.json", {
      schemaVersion: 1,
      ts: NOW,
      scopes: {
        host: {
          minute: rollup(minute, 60_000, 6, 20_000, 7),
          hour: rollup(hour, 3600_000, 6, 20_000, 7),
        },
      },
    });
    for (const range of ["24h", "7d", "30d"] as TelemetryRange[]) {
      const result = await h.store.read("host", range);
      expect(result.statistics.cpuUsedCores.average).toBe(6);
      expect(result.statistics.cpuUsedCores.max).toBe(7);
      expect(result.statistics.cpuUsedCores.observedMs).toBe(20_000);
      expect(result.totals.cpuSeconds).toBe(120);
      expect(result.series.length).toBeLessThanOrEqual(720);
    }
  });

  it("deduplicates finalized buckets and prefers them to an overlapping checkpoint", async () => {
    const h = await fixture();
    const ts = Math.floor(NOW / 60_000) * 60_000 - 60_000;
    await h.history("all-runners", "minute", [
      rollup(ts, 60_000, 2, 60_000, 4),
      rollup(ts, 60_000, 3, 60_000, 5),
    ]);
    await h.json("pending.json", {
      schemaVersion: 1,
      ts: NOW,
      scopes: { "all-runners": { minute: rollup(ts, 60_000, 8) } },
    });
    const result = await h.store.read("all-runners", "24h");
    expect(result.statistics.cpuUsedCores.average).toBe(3);
    expect(result.statistics.cpuUsedCores.max).toBe(5);
    expect(result.totals.cpuSeconds).toBe(180);
  });

  it("applies separate storage freshness and marks the last good snapshot stale after corruption", async () => {
    const h = await fixture();
    const source = sample(NOW, 2);
    await h.json("current.json", {
      schemaVersion: 1,
      ts: NOW,
      scopes: {
        host: {
          ...source,
          values: {
            ...source.values,
            diskUsedBytes: 1234,
            networkRxBytesPerSecond: 25,
          },
          metricObservedAt: {
            ...source.metricObservedAt,
            diskUsedBytes: NOW - 600_000,
            networkRxBytesPerSecond: NOW - 25_000,
          },
        },
      },
    });
    const current = (await h.store.read("host")).current;
    expect(current.values.diskUsedBytes).toBe(1234);
    expect(current.values.networkRxBytesPerSecond).toBeNull();
    expect(current.availability).toBe("partial");
    await writeFile(path.join(h.root, "current.json"), "{interrupted");
    const fallback = (await h.store.read("host")).current;
    expect(fallback.observedAt).toBe(NOW);
    expect(fallback.availability).toBe("stale");
    expect(
      Object.values(fallback.values).every((value) => value === null),
    ).toBe(true);
  });

  it("treats unavailable, malformed and incomplete samples as gaps, while keeping measured zero", async () => {
    const h = await fixture();
    await h.history(
      "host",
      "raw",
      [
        sample(NOW - 15_000, 0),
        sample(NOW - 10_000, -1),
        sample(NOW - 5000, null),
      ],
      JSON.stringify(sample(NOW, 999)),
    );
    const result = await h.store.read("host");
    expect(result.current.availability).toBe("unavailable");
    expect(result.statistics.cpuUsedCores.average).toBe(0);
    expect(result.statistics.cpuUsedCores.max).toBe(0);
    expect(result.statistics.cpuUsedCores.observedMs).toBe(5000);
    expect(result.totals.cpuSeconds).toBe(0);
  });

  it("rejects traversal and overlong gaps and bounds oversized history files", async () => {
    const h = await fixture();
    await expect(h.store.read("../../other")).rejects.toThrow(
      "Invalid telemetry query",
    );
    await h.history("host", "raw", [
      sample(NOW, 10, 60_000),
      sample(NOW - 5000, 2, 0),
    ]);
    expect((await h.store.read("host")).totals.cpuSeconds).toBeNull();
    const filename = path.join(
      h.root,
      "history",
      "host",
      "raw",
      new Date(NOW).toISOString().slice(0, 13) + ".jsonl",
    );
    await truncate(filename, 9 * 1024 * 1024);
    const bounded = await h.store.read("host");
    expect(bounded.statistics.cpuUsedCores.average).toBeNull();
    expect(bounded.history.truncated).toBe(true);
    expect(bounded.series.length).toBeLessThanOrEqual(720);
  });

  it("keeps scopes isolated and uses the measured aggregate peak rather than summing runner peaks", async () => {
    const h = await fixture();
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    const at = NOW - 3600_000;
    await h.history(a, "hour", [rollup(at, 3600_000, 1, 3600_000, 4)]);
    await h.history(b, "hour", [rollup(at, 3600_000, 1, 3600_000, 4)]);
    await h.history("all-runners", "hour", [
      rollup(at, 3600_000, 2, 3600_000, 5),
    ]);
    expect(
      (await h.store.read("all-runners", "7d")).statistics.cpuUsedCores.max,
    ).toBe(5);
    expect((await h.store.read(a, "7d")).statistics.cpuUsedCores.max).toBe(4);
    expect(
      (await h.store.read("host", "7d")).statistics.cpuUsedCores.max,
    ).toBeNull();
  });
});
