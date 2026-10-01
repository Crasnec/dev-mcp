import { describe, expect, it } from "vitest";
import {
  TelemetryStream,
  CHART_METRICS,
  POINT_FIELDS,
} from "../src/telemetry-stream.ts";
import {
  TELEMETRY_METRICS,
  type TelemetryMetric,
  type TelemetryResponse,
} from "../src/telemetry-store.ts";

const START = Date.parse("2026-10-01T12:00:00Z");
function values(n: number) {
  return Object.fromEntries(
    TELEMETRY_METRICS.map((metric, index) => [metric, n + index]),
  ) as Record<TelemetryMetric, number>;
}
function data(): TelemetryResponse {
  return {
    schemaVersion: 1,
    scope: "host",
    range: "1h",
    from: START,
    to: START + 3600000,
    stepMs: 5000,
    current: {
      observedAt: START + 3600000,
      state: "ok",
      availability: "fresh",
      values: values(3),
      metricObservedAt: values(START),
      coverage: { expected: 1, observed: 1, complete: true },
    },
    statistics: Object.fromEntries(
      TELEMETRY_METRICS.map((metric) => [
        metric,
        {
          average: 2,
          max: 4,
          latest: 3,
          observedMs: 3600000,
          p50: 2,
          p95: 3,
          p99: 4,
          percentileObservedMs: 3600000,
          percentileCoverageRatio: 1,
          percentileComplete: true,
          percentileRelativeError: 0.01,
        },
      ]),
    ) as TelemetryResponse["statistics"],
    totals: {
      cpuSeconds: 7200,
      diskReadBytes: 100000,
      diskWriteBytes: 200000,
      networkRxBytes: 300000,
      networkTxBytes: 400000,
    },
    history: {
      startedAt: START,
      throughAt: START + 3600000,
      requestedMs: 3600000,
      observedMs: 3600000,
      coverageRatio: 1,
      truncated: false,
      collectionStartedAt: START,
      truncatedBefore: null,
    },
    series: Array.from({ length: 720 }, (_, index) => ({
      at: START + index * 5000,
      values: values(index + 0.1),
      maxValues: values(index + 0.5),
      p50: values(index + 0.2),
      p95: values(index + 0.3),
      p99: values(index + 0.4),
      percentileCoverageRatio: values(1),
      percentileRelativeError: values(0.01),
      coverage: { expected: 1, observed: 1, complete: true },
    })),
  };
}

describe("compact telemetry revisions", () => {
  it("projects seven chart metrics, keeps only consumed scalars, and emits 204 semantics for unchanged content", () => {
    const feed = new TelemetryStream();
    const source = data();
    source.from += 1000;
    source.to += 1000;
    const first = feed.respond("admin", source)!;
    expect(first.reset).toBe(true);
    expect(first.base).toBeNull();
    expect(first.changes[`point.${START}`]).toHaveLength(
      CHART_METRICS.length * POINT_FIELDS.length,
    );
    expect(first.changes["current.values.cpuCapacityCores"]).toBe(
      source.current.values.cpuCapacityCores,
    );
    expect(first.changes["current.values.cpuCapacityPercent"]).toBe(
      source.current.values.cpuCapacityPercent,
    );
    expect(first.changes["current.values.workspaceBytes"]).toBeUndefined();
    expect(
      first.changes["statistics.cpuCapacityCores.average"],
    ).toBeUndefined();
    expect(first.changes["history.collectionStartedAt"]).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("percentileCoverageRatio");
    expect(feed.respond("admin", source, first.revision)).toBeUndefined();
    source.from += 1;
    source.to += 1;
    expect(feed.respond("admin", source, first.revision)).toBeUndefined();
  });

  it("advances an empty chart axis at bucket boundaries with an envelope-only update", () => {
    const feed = new TelemetryStream();
    const source = data();
    source.series = [];
    source.from += 1000;
    source.to += 1000;
    const first = feed.respond("admin", source)!;
    source.from += 4001;
    source.to += 4001;
    const next = feed.respond("admin", source, first.revision)!;
    expect(next.reset).toBe(false);
    expect(next.base).toBe(first.revision);
    expect(next.changes).toEqual({});
    expect(next.removed).toEqual([]);
    expect(next.to).toBe(source.to);
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(350);
    source.from += 100;
    source.to += 100;
    expect(feed.respond("admin", source, next.revision)).toBeUndefined();
  });

  it("sends one new point and expired point key rather than repeating the rolling history", () => {
    const feed = new TelemetryStream();
    const source = data();
    const first = feed.respond("admin", source)!;
    const next = structuredClone(source);
    next.from += 5000;
    next.to += 5000;
    next.current.observedAt! += 5000;
    next.current.values.cpuUsedCores = 5;
    next.statistics.cpuUsedCores.average = 2.5;
    next.totals.cpuSeconds! += 25;
    const point = structuredClone(next.series.at(-1)!);
    point.at += 5000;
    next.series = [...next.series.slice(1), point];
    const patch = feed.respond("admin", next, first.revision)!;
    expect(patch.reset).toBe(false);
    expect(patch.base).toBe(first.revision);
    expect(
      Object.keys(patch.changes).filter((key) => key.startsWith("point.")),
    ).toEqual([`point.${point.at}`]);
    expect(patch.removed).toEqual([`point.${START}`]);
    expect(patch.changes["current.values.cpuUsedCores"]).toBe(5);
    expect(patch.changes["current.values.cpuCapacityCores"]).toBeUndefined();
    const completeBytes = Buffer.byteLength(JSON.stringify(source));
    const initialBytes = Buffer.byteLength(JSON.stringify(first));
    const updateBytes = Buffer.byteLength(JSON.stringify(patch));
    expect(initialBytes).toBeLessThan(completeBytes * 0.25);
    expect(updateBytes).toBeLessThan(completeBytes * 0.005);
    expect(updateBytes).toBeLessThan(2000);
  });

  it("resynchronizes on expired, evicted, unknown, other-viewer or changed-scope bases", () => {
    let now = 0;
    const feed = new TelemetryStream({
      ttlMs: 10,
      maxEntries: 2,
      now: () => now,
    });
    const source = data();
    const first = feed.respond("a", source)!;
    expect(feed.respond("b", source, first.revision)?.reset).toBe(true);
    const scoped = { ...source, scope: "all-runners" };
    expect(feed.respond("a", scoped, first.revision)?.reset).toBe(true);
    expect(feed.respond("a", source, first.revision)?.reset).toBe(true);
    const fresh = feed.respond("a", source)!;
    now = 11;
    expect(feed.respond("a", source, fresh.revision)?.reset).toBe(true);
    expect(
      feed.respond("a", { ...source, range: "24h" }, fresh.revision)?.reset,
    ).toBe(true);
    const tooSmall = new TelemetryStream({ maxBytes: 10 });
    const uncached = tooSmall.respond("a", source)!;
    expect(tooSmall.respond("a", source, uncached.revision)?.reset).toBe(true);
  });
});
