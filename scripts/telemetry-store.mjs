import {
  mkdir,
  open,
  rename,
  rm,
  stat,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  METRICS,
  DELTAS,
  METRIC_MAX_AGE_MS,
  number,
  validScope,
} from "./telemetry-metrics.mjs";
import {
  distribution,
  addObservation,
  compactDistribution,
  encodeDistribution,
  decodeDistribution,
} from "./telemetry-distribution.mjs";

export const RETENTION_MS = {
  raw: 2 * 3600_000,
  minute: 48 * 3600_000,
  hour: 30 * 24 * 3600_000,
};
const RESOLUTION_MS = { minute: 60_000, hour: 3600_000 };
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function readBoundedJson(filename, maxBytes = MAX_FILE_BYTES) {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Telemetry input exceeds limit");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size)
      throw new Error("Telemetry input changed during read");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function atomicJson(
  filename,
  value,
  serialized = JSON.stringify(value),
) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  const temp = filename + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, serialized, { mode: 0o644 });
    await rename(temp, filename);
  } finally {
    await rm(temp, { force: true });
  }
}

export function bucket(ts, durationMs) {
  return {
    ts: Math.floor(ts / durationMs) * durationMs,
    durationMs,
    distributionLimit: durationMs <= 60_000 ? 24 : 256,
    metrics: Object.fromEntries(
      METRICS.map((name) => [
        name,
        {
          sum: 0,
          weightMs: 0,
          max: null,
          last: null,
          lastAt: null,
          count: 0,
          distribution: encodeDistribution(distribution()),
        },
      ]),
    ),
    deltas: Object.fromEntries(DELTAS.map((name) => [name, null])),
    deltaCoverageMs: Object.fromEntries(DELTAS.map((name) => [name, 0])),
    coverage: { expected: 0, observed: 0, complete: true, samples: 0 },
  };
}

export function addToBucket(target, sample, durationMs) {
  if (!durationMs || !sample.intervalMs) {
    return;
  }
  for (const name of METRICS) {
    const value = number(sample.values[name]);
    const observedAt = sample.metricObservedAt[name];
    if (
      value === null ||
      !Number.isFinite(observedAt) ||
      sample.ts - observedAt > METRIC_MAX_AGE_MS[name]
    )
      continue;
    const metric = target.metrics[name];
    const histogram =
      decodeDistribution(metric.distribution, metric.weightMs) ??
      distribution();
    const limit =
      Number.isInteger(target.distributionLimit) &&
      target.distributionLimit >= 4 &&
      target.distributionLimit <= 256
        ? target.distributionLimit
        : target.durationMs <= 60_000
          ? 24
          : 256;
    addObservation(histogram, value, durationMs, limit);
    metric.distribution = encodeDistribution(histogram);
    metric.sum += value * durationMs;
    metric.weightMs += durationMs;
    metric.max = metric.max === null ? value : Math.max(metric.max, value);
    metric.last = value;
    metric.lastAt = observedAt;
    metric.count += 1;
  }
  for (const name of DELTAS) {
    const value = number(sample.deltas[name]);
    if (value === null) {
      continue;
    }
    target.deltas[name] =
      (target.deltas[name] ?? 0) + (value * durationMs) / sample.intervalMs;
    target.deltaCoverageMs[name] += durationMs;
  }
  target.coverage.expected += sample.coverage.expected;
  target.coverage.observed += sample.coverage.observed;
  target.coverage.complete &&= sample.coverage.complete;
  target.coverage.samples += 1;
}

function validBucket(value, durationMs, now) {
  if (
    !value ||
    value.durationMs !== durationMs ||
    !Number.isSafeInteger(value.ts) ||
    value.ts > now ||
    now - value.ts > RETENTION_MS.hour ||
    value.ts % durationMs
  )
    return false;
  if (
    !value.metrics ||
    !value.deltas ||
    !value.deltaCoverageMs ||
    !value.coverage
  )
    return false;
  return (
    METRICS.every((name) => {
      const item = value.metrics[name];
      return (
        item &&
        number(item.sum) !== null &&
        number(item.weightMs) !== null &&
        item.weightMs <= durationMs &&
        number(item.count) !== null &&
        (item.max === null || number(item.max) !== null) &&
        (item.last === null || number(item.last) !== null)
      );
    }) &&
    DELTAS.every(
      (name) =>
        (value.deltas[name] === null || number(value.deltas[name]) !== null) &&
        number(value.deltaCoverageMs[name]) !== null &&
        value.deltaCoverageMs[name] <= durationMs,
    )
  );
}

export class TelemetryStore {
  constructor(
    directory,
    {
      maxBytes = 512 * 1024 * 1024,
      maxFileBytes = MAX_FILE_BYTES,
      maxCheckpointBytes = MAX_FILE_BYTES,
      intervalMs = 5000,
    } = {},
  ) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxFileBytes = maxFileBytes;
    this.maxCheckpointBytes = maxCheckpointBytes;
    this.intervalMs = intervalMs;
    this.pending = {};
    this.lastPrunedAt = 0;
    this.historyLimited = false;
    this.truncatedBefore = null;
    this.lastTs = 0;
    this.startedAt = null;
  }

  async initialize(now = Date.now()) {
    await mkdir(this.directory, { recursive: true, mode: 0o755 });
    this.startedAt = now;
    try {
      const current = await readBoundedJson(
        path.join(this.directory, "current.json"),
      );
      if (current.schemaVersion === 1) {
        this.historyLimited = current.history?.limited === true;
        this.truncatedBefore = number(current.history?.truncatedBefore);
        if (
          number(current.history?.startedAt) !== null &&
          current.history.startedAt <= now
        )
          this.startedAt = current.history.startedAt;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.historyLimited = true;
      }
    }
    try {
      const checkpoint = await readBoundedJson(
        path.join(this.directory, "pending.json"),
      );
      if (checkpoint.schemaVersion === 1 && checkpoint.ts <= now) {
        this.lastTs = checkpoint.ts;
        for (const [scope, tiers] of Object.entries(checkpoint.scopes ?? {})) {
          if (!validScope(scope)) {
            continue;
          }
          const valid = {};
          for (const [tier, resolution] of Object.entries(RESOLUTION_MS)) {
            if (
              validBucket(tiers[tier], resolution, now) &&
              !(await this.hasFinalized(scope, tier, tiers[tier].ts, now))
            ) {
              valid[tier] = tiers[tier];
            }
          }
          this.pending[scope] = valid;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.historyLimited = true;
      }
    }
    await this.prune(now);
  }

  async hasFinalized(scope, tier, ts, now) {
    let handle;
    try {
      handle = await open(this.filename(scope, tier, ts), "r");
      const size = (await handle.stat()).size;
      if (size > this.maxFileBytes) {
        this.historyLimited = true;
        return false;
      }
      // Finalized buckets are appended in order. Inspect only a bounded tail,
      // including complete rows even when the last write was interrupted.
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (length < size) {
        lines.shift();
      }
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.ts >= ts && validBucket(value, RESOLUTION_MS[tier], now)) {
            // A crash between append and checkpoint can leave an older partial
            // checkpoint. Replaying it must never regress a finalized bucket.
            this.historyLimited = true;
            return true;
          }
        } catch {}
      }
      return false;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return false;
    } finally {
      await handle?.close();
    }
  }

  filename(scope, tier, ts) {
    if (
      !validScope(scope) ||
      !Object.hasOwn(RETENTION_MS, tier) ||
      !Number.isFinite(ts)
    )
      throw new Error("Invalid telemetry history key");
    const iso = new Date(ts).toISOString();
    const stamp = tier === "raw" ? iso.slice(0, 13) : iso.slice(0, 10);
    return path.join(this.directory, "history", scope, tier, stamp + ".jsonl");
  }

  async append(scope, tier, value) {
    const filename = this.filename(scope, tier, value.ts);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
    const line = JSON.stringify(value) + "\n";
    const handle = await open(filename, "a+", 0o644);
    try {
      const size = (await handle.stat()).size;
      if (size + Buffer.byteLength(line) > this.maxFileBytes) {
        this.historyLimited = true;
        this.truncatedBefore = Math.max(this.truncatedBefore ?? 0, value.ts);
        return;
      }
      // A crash can leave a partial final JSON line; separate it from this row.
      if (size) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 10) {
          await handle.write("\n");
        }
      }
      await handle.write(line);
    } finally {
      await handle.close();
    }
  }

  async record(scopes, ts = Date.now()) {
    // Wall-clock reversals must not add overlapping intervals to rollups.
    const clockReversed = ts <= this.lastTs;
    for (const [scope, original] of Object.entries(scopes)) {
      if (!validScope(scope) || original.ts !== ts)
        throw new Error("Invalid telemetry sample identity");
      const clippedMs = Math.min(
        original.intervalMs || 0,
        20_000,
        Math.max(0, ts - this.lastTs),
      );
      const entry = clockReversed
        ? {
            ...original,
            intervalMs: 0,
            deltas: Object.fromEntries(DELTAS.map((name) => [name, null])),
          }
        : clippedMs < original.intervalMs
          ? {
              ...original,
              intervalMs: clippedMs,
              deltas: Object.fromEntries(
                DELTAS.map((name) => [
                  name,
                  original.deltas[name] === null || !clippedMs
                    ? null
                    : (original.deltas[name] * clippedMs) / original.intervalMs,
                ]),
              ),
            }
          : original;
      await this.append(scope, "raw", entry);
      this.pending[scope] ??= {};
      for (const [tier, resolution] of Object.entries(RESOLUTION_MS)) {
        let current = this.pending[scope][tier];
        const start = entry.ts - Math.min(entry.intervalMs || 0, 20_000);
        let cursor = start;
        do {
          const bucketTs = Math.floor(cursor / resolution) * resolution;
          if (current && bucketTs < current.ts) {
            break;
          }
          if (!current || current.ts !== bucketTs) {
            if (current) {
              await this.append(scope, tier, current);
            }
            current = bucket(bucketTs, resolution);
            this.pending[scope][tier] = current;
          }
          const end = Math.min(entry.ts, bucketTs + resolution);
          addToBucket(current, entry, Math.max(0, end - cursor));
          cursor = end;
        } while (cursor < entry.ts);
      }
    }
    // Retain checkpoints for deleted owners only until their last bucket is sealed.
    for (const [scope, tiers] of Object.entries(this.pending)) {
      if (Object.hasOwn(scopes, scope)) {
        continue;
      }
      for (const [tier, current] of Object.entries(tiers))
        if (current.ts + current.durationMs <= ts) {
          await this.append(scope, tier, current);
          delete tiers[tier];
        }
      if (!Object.keys(tiers).length) {
        delete this.pending[scope];
      }
    }
    this.lastTs = Math.max(this.lastTs, ts);
    const checkpoint = {
      schemaVersion: 1,
      ts: this.lastTs,
      scopes: this.pending,
    };
    let serialized = JSON.stringify(checkpoint);
    while (Buffer.byteLength(serialized) > this.maxCheckpointBytes) {
      let compacted = false;
      for (const tiers of Object.values(this.pending)) {
        for (const current of Object.values(tiers)) {
          const limit =
            current.distributionLimit ??
            (current.durationMs <= 60_000 ? 24 : 256);
          if (limit <= 4) {
            continue;
          }
          current.distributionLimit = Math.max(4, Math.floor(limit / 2));
          compacted = true;
          for (const metric of Object.values(current.metrics)) {
            const histogram = decodeDistribution(
              metric.distribution,
              metric.weightMs,
            );
            if (!histogram) {
              continue;
            }
            compactDistribution(histogram, current.distributionLimit);
            metric.distribution = encodeDistribution(histogram);
          }
        }
      }
      if (!compacted) {
        throw new Error("Telemetry checkpoint exceeds limit");
      }
      serialized = JSON.stringify(checkpoint);
    }
    await atomicJson(
      path.join(this.directory, "pending.json"),
      checkpoint,
      serialized,
    );
    if (ts - this.lastPrunedAt >= 60_000) {
      await this.prune(ts);
    }
    await atomicJson(path.join(this.directory, "current.json"), {
      schemaVersion: 1,
      ts,
      sampleIntervalMs: this.intervalMs,
      metricMaxAgeMs: METRIC_MAX_AGE_MS,
      history: {
        retentionMs: RETENTION_MS,
        limited: this.historyLimited,
        truncatedBefore: this.truncatedBefore,
        startedAt: this.startedAt,
        maxBytes: this.maxBytes,
      },
      scopes,
    });
  }

  async prune(now) {
    const files = [];
    const root = path.join(this.directory, "history");
    let owners = [];
    try {
      owners = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    for (const owner of owners) {
      if (!owner.isDirectory() || !validScope(owner.name)) {
        continue;
      }
      for (const tier of Object.keys(RETENTION_MS)) {
        const directory = path.join(root, owner.name, tier);
        let names = [];
        try {
          names = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
        for (const name of names) {
          const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?\.jsonl$/.exec(
            name.name,
          );
          if (!name.isFile() || !match) {
            continue;
          }
          const stamp = Date.parse(
            match[1] + "T" + (match[2] ?? "00") + ":00:00.000Z",
          );
          const filename = path.join(directory, name.name);
          const end = stamp + (tier === "raw" ? 3600_000 : 24 * 3600_000);
          if (!Number.isFinite(stamp) || end <= now - RETENTION_MS[tier]) {
            await rm(filename);
            continue;
          }
          const info = await stat(filename);
          files.push({ filename, stamp, end, size: info.size });
        }
      }
    }
    let size = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.stamp - b.stamp)) {
      if (size <= this.maxBytes) {
        break;
      }
      await rm(file.filename);
      size -= file.size;
      this.historyLimited = true;
      this.truncatedBefore = Math.max(this.truncatedBefore ?? 0, file.end);
    }
    this.lastPrunedAt = now;
  }
}
