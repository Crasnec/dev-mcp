import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
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
  return {
    root,
    store,
    json,
    history,
    advance: (ms: number) => {
      now += ms;
    },
  };
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
  it("anchors compact series across polling jitter while preserving the exact rolling statistics and edge weights", async () => {
    const h = await fixture();
    await h.history("host", "raw", [
      sample(NOW - 3600000 + 2500, 2),
      sample(NOW - 5000, 3),
      sample(NOW, 4),
    ]);
    const first = await h.store.read("host", "1h", { stableBuckets: true });
    h.advance(1377);
    const stable = await h.store.read("host", "1h", { stableBuckets: true });
    const compatible = await h.store.read("host", "1h");
    expect(stable.statistics).toEqual(compatible.statistics);
    expect(stable.totals).toEqual(compatible.totals);
    expect(stable.history).toEqual(compatible.history);
    expect(stable.series).toHaveLength(721);
    expect(compatible.series).toHaveLength(720);
    expect(stable.series.every((point) => point.at % stable.stepMs === 0)).toBe(
      true,
    );
    const at = NOW - 10000;
    expect(stable.series.find((point) => point.at === at)).toEqual(
      first.series.find((point) => point.at === at),
    );
    expect(stable.statistics.cpuUsedCores.observedMs).toBe(11123);
  });
  it("returns elapsed weighted P50/P95/P99 from real samples across rollups and collector restarts", async () => {
    const h = await fixture();
    let writer = new CollectorStore(h.root);
    await writer.initialize(NOW - 100000);
    const observations = [
      [NOW - 80000, 0, 20000],
      [NOW - 60000, 0, 20000],
      [NOW - 50000, 0, 10000],
      [NOW - 30000, 1, 20000],
      [NOW - 10000, 1, 20000],
      [NOW - 5000, 1, 5000],
      [NOW - 1000, 8, 4000],
      [NOW, 16, 1000],
    ];
    for (const [index, [ts, cpu, duration]] of observations.entries()) {
      if (index === 3) {
        writer = new CollectorStore(h.root);
        await writer.initialize(NOW - 50000);
      }
      await writer.record(
        {
          host: collectorSample({
            ts,
            intervalMs: duration,
            values: { cpuUsedCores: cpu },
          }),
        },
        ts,
      );
    }
    for (const range of ["1h", "24h", "7d", "30d"] as TelemetryRange[]) {
      const result = await h.store.read("host", range);
      expect(result.statistics.cpuUsedCores).toMatchObject({
        p50: 0,
        p95: 1,
        p99: 8,
        observedMs: 100000,
        percentileObservedMs: 100000,
        percentileCoverageRatio: 1,
        percentileComplete: true,
      });
      expect(result.statistics.cpuUsedCores.average).toBeCloseTo(0.93);
      expect(
        result.statistics.cpuUsedCores.percentileRelativeError,
      ).toBeLessThan(0.011);
    }
    const last = (await h.store.read("host", "1h")).series.at(-1)!;
    expect(last.values.cpuUsedCores).toBeCloseTo(9.6);
    expect(last.p50.cpuUsedCores).toBe(8);
    expect(last.p95.cpuUsedCores).toBe(16);
    expect(last.p99.cpuUsedCores).toBe(16);
    expect(last.percentileCoverageRatio.cpuUsedCores).toBe(1);
  });

  it("leaves old or malformed rollup percentiles unavailable instead of treating their means as a distribution", async () => {
    const h = await fixture();
    const at = Math.floor(NOW / 60000) * 60000 - 60000;
    const old = rollup(at, 60000, 5, 60000, 50);
    await h.history("host", "minute", [old]);
    const result = await h.store.read("host", "24h");
    expect(result.statistics.cpuUsedCores).toMatchObject({
      average: 5,
      max: 50,
      p50: null,
      p95: null,
      p99: null,
      percentileObservedMs: 0,
      percentileCoverageRatio: 0,
      percentileComplete: false,
    });
    expect(
      result.series.every((point) => point.p99.cpuUsedCores === null),
    ).toBe(true);
    await h.history("host", "minute", [
      {
        ...old,
        metrics: {
          cpuUsedCores: {
            ...old.metrics.cpuUsedCores,
            distribution: [1, 0, "bad-input"],
          },
        },
      },
    ]);
    expect(
      (await h.store.read("host", "24h")).statistics.cpuUsedCores.p95,
    ).toBeNull();
  });

  it("marks distributions incomplete when new observations join a legacy pending bucket", async () => {
    const h = await fixture();
    const first = new CollectorStore(h.root);
    await first.initialize(NOW - 10000);
    await first.record(
      {
        host: collectorSample({
          ts: NOW - 5000,
          intervalMs: 5000,
          values: { cpuUsedCores: 1 },
        }),
      },
      NOW - 5000,
    );
    const checkpoint = JSON.parse(
      await readFile(path.join(h.root, "pending.json"), "utf8"),
    );
    for (const tier of ["minute", "hour"]) {
      for (const metric of Object.values(
        checkpoint.scopes.host[tier].metrics,
      ) as Array<Record<string, unknown>>)
        delete metric.distribution;
    }
    await h.json("pending.json", checkpoint);
    const resumed = new CollectorStore(h.root);
    await resumed.initialize(NOW - 5000);
    await resumed.record(
      {
        host: collectorSample({
          ts: NOW,
          intervalMs: 5000,
          values: { cpuUsedCores: 8 },
        }),
      },
      NOW,
    );
    for (const range of ["24h", "7d", "30d"] as TelemetryRange[]) {
      expect(
        (await h.store.read("host", range)).statistics.cpuUsedCores,
      ).toMatchObject({
        average: 4.5,
        p50: null,
        p95: null,
        p99: null,
        percentileObservedMs: 5000,
        percentileCoverageRatio: 0.5,
        percentileComplete: false,
      });
    }
    // Raw observations still contain the actual old values and remain usable.
    expect(
      (await h.store.read("host", "1h")).statistics.cpuUsedCores,
    ).toMatchObject({ p50: 1, p95: 8, p99: 8, percentileComplete: true });
  });
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
