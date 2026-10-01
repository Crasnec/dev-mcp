import path from "node:path";
import { open, stat } from "node:fs/promises";
import {
  distribution,
  distributionWeight,
  addObservation,
  mergeDistribution,
  decodeDistribution,
  percentile,
  relativeError,
  type Distribution,
} from "../../../scripts/telemetry-distribution.mjs";

export const TELEMETRY_METRICS = [
  "cpuUsedCores",
  "cpuCapacityCores",
  "cpuPercent",
  "cpuCapacityPercent",
  "memoryUsedBytes",
  "memoryCapacityBytes",
  "memoryPercent",
  "diskUsedBytes",
  "diskCapacityBytes",
  "diskPercent",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "networkRxBytesPerSecond",
  "networkTxBytesPerSecond",
  "workspaceBytes",
  "runtimeBytes",
] as const;
export const TELEMETRY_DELTAS = [
  "cpuSeconds",
  "diskReadBytes",
  "diskWriteBytes",
  "networkRxBytes",
  "networkTxBytes",
] as const;
export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];
type TelemetryDelta = (typeof TELEMETRY_DELTAS)[number];
type Values = Record<TelemetryMetric, number | null>;
type Coverage = { expected: number; observed: number; complete: boolean };
export const TELEMETRY_RANGES = {
  "1h": {
    durationMs: 3600_000,
    stepMs: 5000,
    tier: "raw",
    label: "최근 1시간",
  },
  "24h": {
    durationMs: 86400_000,
    stepMs: 120_000,
    tier: "minute",
    label: "최근 24시간",
  },
  "7d": {
    durationMs: 7 * 86400_000,
    stepMs: 3600_000,
    tier: "hour",
    label: "최근 7일",
  },
  "30d": {
    durationMs: 30 * 86400_000,
    stepMs: 3600_000,
    tier: "hour",
    label: "최근 30일",
  },
} as const;
export type TelemetryRange = keyof typeof TELEMETRY_RANGES;

export interface TelemetryResponse {
  schemaVersion: 1;
  scope: string;
  range: TelemetryRange;
  from: number;
  to: number;
  stepMs: number;
  current: {
    observedAt: number | null;
    state: string;
    availability: "fresh" | "partial" | "stale" | "unavailable";
    values: Values;
    metricObservedAt: Values;
    coverage: Coverage;
  };
  series: Array<{
    at: number;
    values: Values;
    maxValues: Values;
    p50: Values;
    p95: Values;
    p99: Values;
    percentileCoverageRatio: Values;
    percentileRelativeError: Values;
    coverage: Coverage;
  }>;
  statistics: Record<
    TelemetryMetric,
    {
      average: number | null;
      max: number | null;
      latest: number | null;
      observedMs: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
      percentileObservedMs: number;
      percentileCoverageRatio: number;
      percentileComplete: boolean;
      percentileRelativeError: number | null;
    }
  >;
  totals: Record<TelemetryDelta, number | null>;
  history: {
    startedAt: number | null;
    throughAt: number | null;
    requestedMs: number;
    observedMs: number;
    coverageRatio: number;
    truncated: boolean;
    collectionStartedAt: number | null;
    truncatedBefore: number | null;
  };
}

type MetricAccumulator = {
  sum: number;
  weightMs: number;
  max: number | null;
  last: number | null;
  lastAt: number;
  histogram: Distribution;
};
type NormalizedRow = {
  at: number;
  durationMs: number;
  metrics: Record<TelemetryMetric, MetricAccumulator>;
  deltas: Record<TelemetryDelta, number | null>;
  deltaCoverageMs: Record<TelemetryDelta, number>;
  coverage: Coverage;
};
type CachedFile = {
  stamp: string;
  bytes: number;
  value: unknown;
  limited?: boolean;
};
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const storageMetrics = new Set<string>([
  "diskUsedBytes",
  "diskCapacityBytes",
  "diskPercent",
  "workspaceBytes",
  "runtimeBytes",
]);

export function validTelemetryScope(scope: string): boolean {
  return scope === "host" || scope === "all-runners" || UUID.test(scope);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function timestamp(value: unknown, now: number): number | null {
  const result = number(value);
  return result !== null && result > 0 && result <= now + 60_000
    ? result
    : null;
}
function values(): Values {
  return Object.fromEntries(
    TELEMETRY_METRICS.map((metric) => [metric, null]),
  ) as Values;
}
function accumulators(): Record<TelemetryMetric, MetricAccumulator> {
  return Object.fromEntries(
    TELEMETRY_METRICS.map((metric) => [
      metric,
      {
        sum: 0,
        weightMs: 0,
        max: null,
        last: null,
        lastAt: 0,
        histogram: distribution(),
      },
    ]),
  ) as Record<TelemetryMetric, MetricAccumulator>;
}
function coverage(value: unknown): Coverage {
  const data = object(value);
  const expected = number(data.expected);
  const observed = number(data.observed);
  if (
    expected === null ||
    observed === null ||
    !Number.isSafeInteger(expected) ||
    !Number.isSafeInteger(observed) ||
    observed > expected
  ) {
    return { expected: 0, observed: 0, complete: false };
  }
  return {
    expected,
    observed,
    complete: data.complete === true && expected === observed,
  };
}
function maxAge(
  metric: TelemetryMetric,
  configured: Record<string, unknown>,
): number {
  const requested = number(configured[metric]);
  return requested !== null && requested >= 5000 && requested <= 86400_000
    ? requested
    : storageMetrics.has(metric)
      ? 900_000
      : 20_000;
}

/** Reads collector-owned files only. No polling process, Docker or runner IPC. */
export class RunnerTelemetryStore {
  private readonly directory: string;
  private readonly cache = new Map<string, CachedFile>();
  private readonly pendingReads = new Map<
    string,
    Promise<CachedFile | undefined>
  >();
  private cacheBytes = 0;
  private lastSnapshot: Record<string, unknown> | undefined;

  constructor(
    statusDirectory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = path.join(statusDirectory, "telemetry");
  }

  async read(
    scope: string,
    range: TelemetryRange = "1h",
  ): Promise<TelemetryResponse> {
    if (
      !validTelemetryScope(scope) ||
      !Object.hasOwn(TELEMETRY_RANGES, range)
    ) {
      throw new Error("Invalid telemetry query");
    }
    const now = this.now();
    const config = TELEMETRY_RANGES[range];
    const from = now - config.durationMs;
    const snapshotFile = await this.file("current.json", false);
    let snapshot = object(snapshotFile?.value);
    let fallback = false;
    if (
      snapshot.schemaVersion === 1 &&
      timestamp(snapshot.ts, now) !== null &&
      Object.keys(object(snapshot.scopes)).length
    ) {
      this.lastSnapshot = snapshot;
    } else {
      snapshot = this.lastSnapshot ?? {};
      fallback = !!this.lastSnapshot;
    }
    const metricAges = object(snapshot.metricMaxAgeMs);
    const current = this.current(
      object(object(snapshot.scopes)[scope]),
      metricAges,
      now,
      fallback,
    );
    const count = Math.min(720, Math.ceil(config.durationMs / config.stepMs));
    const buckets = Array.from({ length: count }, (_, index) => ({
      at: from + index * config.stepMs,
      metrics: accumulators(),
      coverage: { expected: 0, observed: 0, complete: false },
      hasRows: false,
      coveredMs: 0,
    }));
    const totalMetrics = accumulators();
    const totals = Object.fromEntries(
      TELEMETRY_DELTAS.map((key) => [key, null]),
    ) as Record<TelemetryDelta, number | null>;
    const rows = new Map<number, NormalizedRow>();
    let bytes = 0;
    const collectorHistory = object(snapshot.history);
    const collectorTruncatedBefore = timestamp(
      collectorHistory.truncatedBefore,
      now,
    );
    let truncated =
      collectorHistory.limited === true &&
      (collectorTruncatedBefore === null || collectorTruncatedBefore > from);
    let historyStarted: number | null = null;
    let historyThrough: number | null = null;
    let historyObservedMs = 0;
    const shardMs = config.tier === "raw" ? 3600_000 : 86400_000;
    const sourceStep =
      config.tier === "raw"
        ? 5000
        : config.tier === "minute"
          ? 60_000
          : 3600_000;
    const start = Math.floor((from - sourceStep) / shardMs) * shardMs;
    for (
      let shard = Math.floor(now / shardMs) * shardMs;
      shard >= start;
      shard -= shardMs
    ) {
      const name = new Date(shard)
        .toISOString()
        .slice(0, config.tier === "raw" ? 13 : 10);
      const file = await this.file(
        path.join("history", scope, config.tier, name + ".jsonl"),
        true,
      );
      bytes += file?.bytes ?? 0;
      truncated ||= file?.limited === true;
      if (bytes > MAX_QUERY_BYTES) {
        truncated = true;
        break;
      }
      if (Array.isArray(file?.value)) {
        for (const line of file.value) {
          const row = normalize(line, config.tier, now, metricAges);
          if (row && row.at + row.durationMs > from && row.at < now) {
            rows.set(row.at, row);
          }
        }
      }
    }
    if (config.tier !== "raw") {
      const pending = object((await this.file("pending.json", false))?.value);
      if (pending.schemaVersion === 1) {
        const row = normalize(
          object(object(pending.scopes)[scope])[config.tier],
          config.tier,
          now,
          metricAges,
        );
        const checkpointAt = timestamp(pending.ts, now);
        if (row && checkpointAt !== null) {
          // Pending sums already contain only elapsed samples. A full bucket
          // duration here would prorate those samples a second time.
          row.durationMs = Math.max(
            0,
            Math.min(row.durationMs, checkpointAt - row.at),
          );
        }
        if (
          row &&
          row.durationMs > 0 &&
          checkpointAt !== null &&
          !rows.has(row.at) &&
          row.at < now &&
          row.at + row.durationMs > from
        ) {
          rows.set(row.at, row);
        }
      }
    }
    for (const row of Array.from(rows.values()).sort((a, b) => a.at - b.at)) {
      const begin = Math.max(from, row.at);
      const end = Math.min(now, row.at + row.durationMs);
      if (end <= begin) {
        continue;
      }
      const fraction = (end - begin) / row.durationMs;
      const observed = Math.min(
        row.durationMs,
        Math.max(
          ...TELEMETRY_METRICS.map((metric) => row.metrics[metric].weightMs),
        ),
      );
      if (observed > 0) {
        historyStarted =
          historyStarted === null ? begin : Math.min(historyStarted, begin);
        historyThrough =
          historyThrough === null ? end : Math.max(historyThrough, end);
        historyObservedMs += observed * fraction;
      }
      addMetrics(totalMetrics, row.metrics, fraction);
      for (const key of TELEMETRY_DELTAS) {
        if (row.deltas[key] !== null && row.deltaCoverageMs[key] > 0) {
          totals[key] = (totals[key] ?? 0) + row.deltas[key] * fraction;
        }
      }
      const first = Math.max(0, Math.floor((begin - from) / config.stepMs));
      const last = Math.min(
        count - 1,
        Math.floor((end - from - 1) / config.stepMs),
      );
      for (let index = first; index <= last; index += 1) {
        const bucket = buckets[index]!;
        const overlap = Math.max(
          0,
          Math.min(end, bucket.at + config.stepMs) - Math.max(begin, bucket.at),
        );
        addMetrics(bucket.metrics, row.metrics, overlap / row.durationMs);
        bucket.coverage = {
          expected: Math.max(bucket.coverage.expected, row.coverage.expected),
          observed: bucket.hasRows
            ? Math.min(bucket.coverage.observed, row.coverage.observed)
            : row.coverage.observed,
          complete:
            (!bucket.hasRows || bucket.coverage.complete) &&
            row.coverage.complete,
        };
        bucket.hasRows = true;
        bucket.coveredMs += overlap;
      }
    }
    return {
      schemaVersion: 1,
      scope,
      range,
      from,
      to: now,
      stepMs: config.stepMs,
      current,
      series: buckets.map((bucket) => {
        const summaries = Object.fromEntries(
          TELEMETRY_METRICS.map((metric) => [
            metric,
            percentileSummary(bucket.metrics[metric]),
          ]),
        ) as Record<TelemetryMetric, ReturnType<typeof percentileSummary>>;
        const percentiles = Object.fromEntries(
          [
            "p50",
            "p95",
            "p99",
            "percentileCoverageRatio",
            "percentileRelativeError",
          ].map((key) => [
            key,
            Object.fromEntries(
              TELEMETRY_METRICS.map((metric) => [
                metric,
                summaries[metric][
                  key as
                    | "p50"
                    | "p95"
                    | "p99"
                    | "percentileCoverageRatio"
                    | "percentileRelativeError"
                ],
              ]),
            ),
          ]),
        ) as Pick<
          TelemetryResponse["series"][number],
          | "p50"
          | "p95"
          | "p99"
          | "percentileCoverageRatio"
          | "percentileRelativeError"
        >;
        return {
          at: bucket.at,
          ...percentiles,
          values: Object.fromEntries(
            TELEMETRY_METRICS.map((metric) => [
              metric,
              average(bucket.metrics[metric]),
            ]),
          ) as Values,
          maxValues: Object.fromEntries(
            TELEMETRY_METRICS.map((metric) => [
              metric,
              bucket.metrics[metric].max,
            ]),
          ) as Values,
          coverage: {
            ...bucket.coverage,
            complete:
              bucket.coverage.complete && bucket.coveredMs >= config.stepMs,
          },
        };
      }),
      statistics: Object.fromEntries(
        TELEMETRY_METRICS.map((metric) => [
          metric,
          {
            average: average(totalMetrics[metric]),
            max: totalMetrics[metric].max,
            latest: current.values[metric] ?? totalMetrics[metric].last,
            observedMs: totalMetrics[metric].weightMs,
            ...percentileSummary(totalMetrics[metric]),
          },
        ]),
      ) as TelemetryResponse["statistics"],
      totals,
      history: {
        startedAt: historyStarted,
        throughAt: historyThrough,
        requestedMs: config.durationMs,
        observedMs: Math.min(config.durationMs, historyObservedMs),
        coverageRatio: Math.min(1, historyObservedMs / config.durationMs),
        truncated,
        collectionStartedAt: timestamp(collectorHistory.startedAt, now),
        truncatedBefore: collectorTruncatedBefore,
      },
    };
  }

  private current(
    sample: Record<string, unknown>,
    metricAges: Record<string, unknown>,
    now: number,
    fallback: boolean,
  ): TelemetryResponse["current"] {
    const observedAt = timestamp(sample.ts, now);
    const state =
      typeof sample.state === "string" ? sample.state.slice(0, 32) : "missing";
    const currentValues = values();
    const metricObservedAt = values();
    const sourceValues = object(sample.values);
    const sourceTimes = object(sample.metricObservedAt);
    const stale =
      observedAt !== null && (fallback || now - observedAt > 20_000);
    let expiredMetric = false;
    for (const metric of TELEMETRY_METRICS) {
      const at = Object.hasOwn(sourceTimes, metric)
        ? timestamp(sourceTimes[metric], now)
        : observedAt;
      metricObservedAt[metric] = at;
      if (
        observedAt !== null &&
        !stale &&
        at !== null &&
        at <= observedAt &&
        now - at <= maxAge(metric, metricAges)
      ) {
        currentValues[metric] = number(sourceValues[metric]);
      } else if (number(sourceValues[metric]) !== null) {
        expiredMetric = true;
      }
    }
    const available = Object.values(currentValues).some(
      (value) => value !== null,
    );
    const resultCoverage = coverage(sample.coverage);
    return {
      observedAt,
      state,
      availability: stale
        ? "stale"
        : !available
          ? "unavailable"
          : resultCoverage.complete &&
              !expiredMetric &&
              (state === "ok" || state === "stopped")
            ? "fresh"
            : "partial",
      values: currentValues,
      metricObservedAt,
      coverage: resultCoverage,
    };
  }

  private async file(
    relative: string,
    lines: boolean,
  ): Promise<CachedFile | undefined> {
    const filename = path.join(this.directory, relative);
    const pending = this.pendingReads.get(filename);
    if (pending) {
      return pending;
    }
    const reading = this.readFile(filename, lines);
    this.pendingReads.set(filename, reading);
    try {
      return await reading;
    } finally {
      this.pendingReads.delete(filename);
    }
  }

  private async readFile(
    filename: string,
    lines: boolean,
  ): Promise<CachedFile | undefined> {
    try {
      const info = await stat(filename);
      if (!info.isFile()) {
        return undefined;
      }
      if (info.size > MAX_FILE_BYTES) {
        return {
          stamp: "oversized",
          bytes: 0,
          value: undefined,
          limited: true,
        };
      }
      const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${info.size}`;
      const previous = this.cache.get(filename);
      if (previous?.stamp === stamp) {
        this.cache.delete(filename);
        this.cache.set(filename, previous);
        return previous;
      }
      const handle = await open(filename, "r");
      let source: string;
      try {
        const buffer = Buffer.alloc(info.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        source = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      const parsed: unknown[] = [];
      if (lines) {
        const completeLines = source
          .slice(0, source.lastIndexOf("\n") + 1)
          .split("\n");
        for (const line of completeLines.slice(0, 20_000)) {
          if (!line || line.length > MAX_LINE_BYTES) {
            continue;
          }
          try {
            parsed.push(JSON.parse(line));
          } catch {
            // A corrupt or interrupted sample is a gap, never a zero.
          }
        }
      }
      const entry = {
        stamp,
        bytes: info.size,
        value: lines ? parsed : JSON.parse(source),
      };
      if (previous) {
        this.cacheBytes -= previous.bytes;
        this.cache.delete(filename);
      }
      this.cache.set(filename, entry);
      this.cacheBytes += entry.bytes;
      while (this.cacheBytes > MAX_CACHE_BYTES || this.cache.size > 96) {
        const oldest = this.cache.entries().next().value;
        if (!oldest) {
          break;
        }
        this.cacheBytes -= oldest[1].bytes;
        this.cache.delete(oldest[0]);
      }
      return entry;
    } catch {
      return undefined;
    }
  }
}

function normalize(
  value: unknown,
  tier: "raw" | "minute" | "hour",
  now: number,
  metricAges: Record<string, unknown>,
): NormalizedRow | undefined {
  const data = object(value);
  const ts = timestamp(data.ts, now);
  const durationMs = number(tier === "raw" ? data.intervalMs : data.durationMs);
  const maximum =
    tier === "raw" ? 20_000 : tier === "minute" ? 60_000 : 3600_000;
  if (
    ts === null ||
    durationMs === null ||
    durationMs <= 0 ||
    durationMs > maximum
  ) {
    return undefined;
  }
  const metrics = accumulators();
  const sourceValues = object(data.values);
  const sourceTimes = object(data.metricObservedAt);
  const sourceMetrics = object(data.metrics);
  for (const metric of TELEMETRY_METRICS) {
    if (tier === "raw") {
      const numeric = number(sourceValues[metric]);
      const at = Object.hasOwn(sourceTimes, metric)
        ? timestamp(sourceTimes[metric], now)
        : ts;
      if (
        numeric !== null &&
        at !== null &&
        ts - at <= maxAge(metric, metricAges) &&
        at <= ts &&
        Number.isFinite(numeric * durationMs)
      ) {
        const histogram = distribution();
        addObservation(histogram, numeric, durationMs);
        metrics[metric] = {
          sum: numeric * durationMs,
          weightMs: durationMs,
          max: numeric,
          last: numeric,
          lastAt: ts,
          histogram,
        };
      }
    } else {
      const source = object(sourceMetrics[metric]);
      const sum = number(source.sum);
      const weightMs = number(source.weightMs);
      const maximumValue = number(source.max);
      if (
        sum !== null &&
        weightMs !== null &&
        weightMs > 0 &&
        weightMs <= durationMs &&
        maximumValue !== null
      ) {
        metrics[metric] = {
          sum,
          weightMs,
          max: maximumValue,
          last: number(source.last),
          lastAt: timestamp(source.lastAt, now) ?? ts,
          histogram:
            decodeDistribution(source.distribution, weightMs) ?? distribution(),
        };
      }
    }
  }
  const sourceDeltas = object(data.deltas);
  const sourceDeltaCoverage = object(data.deltaCoverageMs);
  return {
    at: tier === "raw" ? ts - durationMs : ts,
    durationMs,
    metrics,
    deltas: Object.fromEntries(
      TELEMETRY_DELTAS.map((key) => [key, number(sourceDeltas[key])]),
    ) as NormalizedRow["deltas"],
    deltaCoverageMs: Object.fromEntries(
      TELEMETRY_DELTAS.map((key) => [
        key,
        tier === "raw"
          ? durationMs
          : Math.min(durationMs, number(sourceDeltaCoverage[key]) ?? 0),
      ]),
    ) as NormalizedRow["deltaCoverageMs"],
    coverage: coverage(data.coverage),
  };
}

function average(metric: MetricAccumulator): number | null {
  return metric.weightMs > 0 ? metric.sum / metric.weightMs : null;
}
function percentileSummary(metric: MetricAccumulator) {
  const observedMs = distributionWeight(metric.histogram);
  const ratio =
    metric.weightMs > 0 ? Math.min(1, observedMs / metric.weightMs) : 0;
  const complete =
    metric.weightMs > 0 &&
    Math.abs(observedMs - metric.weightMs) <=
      Math.max(1e-6, metric.weightMs * 1e-9);
  return {
    p50: complete ? percentile(metric.histogram, 0.5, metric.max) : null,
    p95: complete ? percentile(metric.histogram, 0.95, metric.max) : null,
    p99: complete ? percentile(metric.histogram, 0.99, metric.max) : null,
    percentileObservedMs: observedMs,
    percentileCoverageRatio: ratio,
    percentileComplete: complete,
    percentileRelativeError: complete ? relativeError(metric.histogram) : null,
  };
}
function addMetrics(
  target: Record<TelemetryMetric, MetricAccumulator>,
  source: Record<TelemetryMetric, MetricAccumulator>,
  fraction: number,
): void {
  for (const metric of TELEMETRY_METRICS) {
    const incoming = source[metric];
    if (!incoming.weightMs) {
      continue;
    }
    const current = target[metric];
    current.sum += incoming.sum * fraction;
    current.weightMs += incoming.weightMs * fraction;
    mergeDistribution(current.histogram, incoming.histogram, fraction);
    current.max = Math.max(current.max ?? 0, incoming.max ?? 0);
    if (incoming.lastAt >= current.lastAt) {
      current.lastAt = incoming.lastAt;
      current.last = incoming.last;
    }
  }
}
