import { createHash, randomBytes } from "node:crypto";
import {
  TELEMETRY_DELTAS,
  type TelemetryMetric,
  type TelemetryResponse,
} from "./telemetry-store.ts";

export const CHART_METRICS = [
  "cpuUsedCores",
  "memoryUsedBytes",
  "diskUsedBytes",
  "networkRxBytesPerSecond",
  "networkTxBytesPerSecond",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
] as const;
export const POINT_FIELDS = [
  "values",
  "maxValues",
  "p50",
  "p95",
  "p99",
  "percentileRelativeError",
] as const;
export const CURRENT_METRICS: readonly TelemetryMetric[] = [
  ...CHART_METRICS,
  "cpuCapacityCores",
  "cpuPercent",
  "cpuCapacityPercent",
  "memoryCapacityBytes",
  "memoryPercent",
  "diskCapacityBytes",
  "diskPercent",
];
const STATISTICS = [
  "average",
  "max",
  "p50",
  "p95",
  "p99",
  "percentileRelativeError",
] as const;
type Snapshot = {
  revision: string;
  key: string;
  fingerprint: string;
  fields: Map<string, string>;
  bytes: number;
  touched: number;
};
export type TelemetryPatch = {
  schemaVersion: 1;
  streamVersion: 1;
  kind: "telemetry";
  revision: string;
  base: string | null;
  reset: boolean;
  scope: string;
  range: string;
  from: number;
  to: number;
  stepMs: number;
  changes: Record<string, unknown>;
  removed: string[];
};

function project(data: TelemetryResponse): Map<string, string> {
  const result = new Map<string, string>();
  const put = (key: string, value: unknown) =>
    result.set(key, JSON.stringify(value ?? null));
  for (const key of ["observedAt", "state", "availability"] as const)
    put(`current.${key}`, data.current[key]);
  for (const metric of CURRENT_METRICS)
    put(`current.values.${metric}`, data.current.values[metric]);
  for (const metric of CHART_METRICS) {
    for (const key of STATISTICS)
      put(`statistics.${metric}.${key}`, data.statistics[metric]?.[key]);
  }
  for (const key of TELEMETRY_DELTAS) put(`totals.${key}`, data.totals[key]);
  for (const key of ["observedMs", "coverageRatio", "truncated"] as const)
    put(`history.${key}`, data.history[key]);
  for (const point of data.series) {
    const packed = POINT_FIELDS.flatMap((field) =>
      CHART_METRICS.map((metric) => point[field]?.[metric] ?? null),
    );
    // Empty slots are reconstructed locally, including interior gaps.
    if (packed.some((value) => value !== null)) {
      put(`point.${point.at}`, packed);
    }
  }
  return result;
}

/** Authenticated, viewer-scoped delta bases. Stores serialized field values only. */
export class TelemetryStream {
  private readonly entries = new Map<string, Snapshot>();
  private readonly latest = new Map<string, string>();
  private bytes = 0;
  constructor(
    private readonly options: {
      maxBytes?: number;
      maxEntries?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  respond(
    viewer: string,
    data: TelemetryResponse,
    since?: string,
  ): TelemetryPatch | undefined {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 300_000;
    for (const [revision, entry] of this.entries) {
      if (now - entry.touched > ttl) {
        this.remove(revision);
      }
    }
    const key = JSON.stringify([viewer, data.scope, data.range]);
    const candidate = since ? this.entries.get(since) : undefined;
    const previous = candidate?.key === key ? candidate : undefined;
    const fields = project(data);
    const serialized = JSON.stringify([...fields]);
    const grid = [
      Math.floor(data.from / data.stepMs),
      Math.ceil(data.to / data.stepMs),
      data.stepMs,
    ];
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(grid))
      .update(serialized)
      .digest("base64url");
    if (previous?.fingerprint === fingerprint) {
      previous.touched = now;
      this.touch(previous);
      return undefined;
    }
    let current = this.entries.get(this.latest.get(key) ?? "");
    if (!current || current.fingerprint !== fingerprint) {
      current = {
        revision: randomBytes(18).toString("base64url"),
        key,
        fingerprint,
        fields,
        bytes: Buffer.byteLength(serialized),
        touched: now,
      };
      this.entries.set(current.revision, current);
      this.latest.set(key, current.revision);
      this.bytes += current.bytes;
      const sameKey = [...this.entries.values()].filter(
        (entry) => entry.key === key,
      );
      for (const entry of sameKey.slice(0, Math.max(0, sameKey.length - 3)))
        this.remove(entry.revision);
      while (
        this.bytes > (this.options.maxBytes ?? 8 * 1024 * 1024) ||
        this.entries.size > (this.options.maxEntries ?? 96)
      ) {
        const oldest = this.entries.keys().next().value;
        if (!oldest) {
          break;
        }
        this.remove(oldest);
      }
    } else {
      current.touched = now;
      this.touch(current);
    }
    const changes: Record<string, unknown> = Object.create(null);
    for (const [field, value] of current.fields) {
      if (!previous || previous.fields.get(field) !== value) {
        changes[field] = JSON.parse(value);
      }
    }
    const removed = previous
      ? [...previous.fields.keys()].filter(
          (field) => !current.fields.has(field),
        )
      : [];
    return {
      schemaVersion: 1,
      streamVersion: 1,
      kind: "telemetry",
      revision: current.revision,
      base: previous?.revision ?? null,
      reset: !previous,
      scope: data.scope,
      range: data.range,
      from: data.from,
      to: data.to,
      stepMs: data.stepMs,
      changes,
      removed,
    };
  }

  private touch(entry: Snapshot) {
    this.entries.delete(entry.revision);
    this.entries.set(entry.revision, entry);
  }
  private remove(revision: string) {
    const entry = this.entries.get(revision);
    if (!entry) {
      return;
    }
    this.bytes -= entry.bytes;
    this.entries.delete(revision);
    if (this.latest.get(entry.key) === revision) {
      this.latest.delete(entry.key);
    }
  }
}
