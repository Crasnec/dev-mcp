export const METRICS = [
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
];
export const DELTAS = [
  "cpuSeconds",
  "diskReadBytes",
  "diskWriteBytes",
  "networkRxBytes",
  "networkTxBytes",
];
export const STORAGE_METRICS = new Set([
  "diskUsedBytes",
  "diskCapacityBytes",
  "diskPercent",
  "workspaceBytes",
  "runtimeBytes",
]);
export const METRIC_MAX_AGE_MS = Object.fromEntries(
  METRICS.map((name) => [name, STORAGE_METRICS.has(name) ? 900_000 : 20_000]),
);
export const STATES = new Set([
  "ok",
  "partial",
  "stopped",
  "missing",
  "error",
  "warming",
]);
export const validScope = (scope) =>
  scope === "host" ||
  scope === "all-runners" ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope);
export const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const percent = (used, capacity) =>
  number(used) !== null && number(capacity) > 0
    ? (used / capacity) * 100
    : null;

export function sample({
  ts,
  state = "ok",
  epoch = "",
  values = {},
  metricObservedAt = {},
  coverage = { expected: 1, observed: 1, complete: true },
  intervalMs = 0,
  deltas = {},
  details,
}) {
  const normalized = Object.fromEntries(
    METRICS.map((name) => [name, number(values[name])]),
  );
  normalized.cpuPercent =
    normalized.cpuUsedCores === null ? null : normalized.cpuUsedCores * 100;
  normalized.cpuCapacityPercent = percent(
    normalized.cpuUsedCores,
    normalized.cpuCapacityCores,
  );
  normalized.memoryPercent = percent(
    normalized.memoryUsedBytes,
    normalized.memoryCapacityBytes,
  );
  normalized.diskPercent = percent(
    normalized.diskUsedBytes,
    normalized.diskCapacityBytes,
  );
  const at = Object.fromEntries(
    METRICS.map((name) => [
      name,
      normalized[name] === null ? null : (metricObservedAt[name] ?? ts),
    ]),
  );
  at.diskPercent =
    normalized.diskPercent === null
      ? null
      : Math.min(at.diskUsedBytes, at.diskCapacityBytes);
  return {
    ts,
    state,
    epoch,
    values: normalized,
    metricObservedAt: at,
    coverage,
    intervalMs,
    deltas: Object.fromEntries(
      DELTAS.map((name) => [name, number(deltas[name])]),
    ),
    ...(details ? { details } : {}),
  };
}

export function unavailable(ts, state = "error", epoch = "") {
  return sample({
    ts,
    state,
    epoch,
    coverage: { expected: 1, observed: 0, complete: false },
  });
}

export function counterDelta(current, previous) {
  if (!current || !previous) {
    return null;
  }
  const keys = Object.keys(current);
  if (keys.length !== Object.keys(previous).length) {
    return null;
  }
  let delta = 0;
  for (const key of keys) {
    if (
      number(current[key]) === null ||
      number(previous[key]) === null ||
      current[key] < previous[key]
    )
      return null;
    delta += current[key] - previous[key];
  }
  return number(delta);
}

export function parseCpu(text) {
  const lines = text.trim().split("\n");
  const cpu = lines
    .find((line) => /^cpu\s/.test(line))
    ?.trim()
    .split(/\s+/)
    .slice(1, 9)
    .map(Number);
  const cores = lines.filter((line) => /^cpu\d+\s/.test(line)).length;
  if (
    !cpu ||
    cpu.length !== 8 ||
    !cores ||
    cpu.some((value) => number(value) === null)
  )
    throw new Error("Invalid host CPU counters");
  return {
    total: cpu.reduce((a, b) => a + b, 0),
    idle: cpu[3] + cpu[4],
    cores,
  };
}

export function parseMemory(text) {
  const values = Object.fromEntries(
    Array.from(text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm), (match) => [
      match[1],
      Number(match[2]) * 1024,
    ]),
  );
  if (
    !values.MemTotal ||
    number(values.MemAvailable) === null ||
    values.MemAvailable > values.MemTotal
  )
    throw new Error("Invalid host memory counters");
  return {
    used: values.MemTotal - values.MemAvailable,
    capacity: values.MemTotal,
  };
}

export function parseNetwork(text, interfaces) {
  const rx = {},
    tx = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match || !interfaces.includes(match[1])) {
      continue;
    }
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (
      fields.length < 16 ||
      number(fields[0]) === null ||
      number(fields[8]) === null
    )
      throw new Error("Invalid host network counters");
    rx[match[1]] = fields[0];
    tx[match[1]] = fields[8];
  }
  return Object.keys(rx).length === interfaces.length && interfaces.length
    ? { rx, tx }
    : null;
}

export function parseDisk(text, devices) {
  const read = {},
    write = {};
  for (const line of text.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!devices.includes(fields[2])) {
      continue;
    }
    const r = Number(fields[5]),
      w = Number(fields[9]);
    if (number(r) === null || number(w) === null)
      throw new Error("Invalid host disk counters");
    read[fields[0] + ":" + fields[1]] = r * 512;
    write[fields[0] + ":" + fields[1]] = w * 512;
  }
  return Object.keys(read).length === devices.length && devices.length
    ? { read, write }
    : null;
}

function interval(previous, epoch, ts) {
  const elapsed = previous && previous.epoch === epoch ? ts - previous.ts : 0;
  return elapsed > 0 && elapsed <= 20_000 ? elapsed : 0;
}

export function hostSample(
  {
    ts,
    epoch,
    cpu,
    memory,
    network,
    disk,
    filesystem,
    interfaces = [],
    devices = [],
  },
  previous,
) {
  const elapsed = interval(previous, epoch, ts);
  const cpuDelta =
    elapsed && cpu && previous.cpu && cpu.cores === previous.cpu.cores
      ? counterDelta(
          { total: cpu.total, idle: cpu.idle },
          { total: previous.cpu.total, idle: previous.cpu.idle },
        )
      : null;
  const totalDelta = cpu && previous?.cpu ? cpu.total - previous.cpu.total : 0;
  const idleDelta = cpu && previous?.cpu ? cpu.idle - previous.cpu.idle : 0;
  const cores =
    cpuDelta !== null && totalDelta > 0 && idleDelta <= totalDelta
      ? ((totalDelta - idleDelta) / totalDelta) * cpu.cores
      : null;
  const deltas = {
    cpuSeconds: cores === null ? null : (cores * elapsed) / 1000,
    networkRxBytes: elapsed
      ? counterDelta(network?.rx, previous.network?.rx)
      : null,
    networkTxBytes: elapsed
      ? counterDelta(network?.tx, previous.network?.tx)
      : null,
    diskReadBytes: elapsed
      ? counterDelta(disk?.read, previous.disk?.read)
      : null,
    diskWriteBytes: elapsed
      ? counterDelta(disk?.write, previous.disk?.write)
      : null,
  };
  const values = {
    cpuUsedCores: cores,
    cpuCapacityCores: cpu?.cores,
    memoryUsedBytes: memory?.used,
    memoryCapacityBytes: memory?.capacity,
    diskUsedBytes: filesystem?.used,
    diskCapacityBytes: filesystem?.capacity,
  };
  for (const [delta, metric] of ratePairs)
    values[metric] =
      deltas[delta] === null || !elapsed
        ? null
        : (deltas[delta] / elapsed) * 1000;
  const observed = [cpu, memory, network, disk, filesystem].filter(
    Boolean,
  ).length;
  return {
    sample: sample({
      ts,
      epoch,
      state: observed < 5 ? "partial" : elapsed ? "ok" : "warming",
      values,
      intervalMs: elapsed,
      deltas,
      coverage: { expected: 5, observed, complete: observed === 5 },
      details: {
        networkInterfaces: interfaces,
        blockDevices: devices,
        diskFilesystem: "/",
        networkScope: "physical interfaces",
        diskScope: "root filesystem",
      },
    }),
    counters: { ts, epoch, cpu, network, disk },
  };
}

const ratePairs = [
  ["networkRxBytes", "networkRxBytesPerSecond"],
  ["networkTxBytes", "networkTxBytesPerSecond"],
  ["diskReadBytes", "diskReadBytesPerSecond"],
  ["diskWriteBytes", "diskWriteBytesPerSecond"],
];

export function runnerCounters(stats) {
  const rx = {},
    tx = {},
    read = {},
    write = {};
  for (const [name, net] of Object.entries(stats.networks ?? {})) {
    rx[name] = number(net.rx_bytes);
    tx[name] = number(net.tx_bytes);
  }
  const entries = stats.blkio_stats?.io_service_bytes_recursive;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = entry.major + ":" + entry.minor;
    if (/^read$/i.test(entry.op)) {
      read[key] = number(entry.value);
    }
    if (/^write$/i.test(entry.op)) {
      write[key] = number(entry.value);
    }
  }
  return {
    cpu: number(stats.cpu_stats?.cpu_usage?.total_usage),
    system: number(stats.cpu_stats?.system_cpu_usage),
    online:
      number(stats.cpu_stats?.online_cpus) ||
      stats.cpu_stats?.cpu_usage?.percpu_usage?.length ||
      null,
    network: stats.networks ? { rx, tx } : null,
    disk: Array.isArray(entries) ? { read, write } : null,
  };
}

function cpuCapacity(info, hostCores) {
  const host = info.HostConfig ?? {};
  const bounds = [number(hostCores)];
  if (number(host.NanoCpus) > 0) {
    bounds.push(host.NanoCpus / 1e9);
  } else if (number(host.CpuQuota) > 0 && number(host.CpuPeriod) > 0)
    bounds.push(host.CpuQuota / host.CpuPeriod);
  if (
    typeof host.CpusetCpus === "string" &&
    /^(\d+(-\d+)?)(,\d+(-\d+)?)*$/.test(host.CpusetCpus)
  ) {
    const count = host.CpusetCpus.split(",").reduce((sum, range) => {
      const [lo, hi = lo] = range.split("-").map(Number);
      return sum + Math.max(0, hi - lo + 1);
    }, 0);
    if (count > 0) {
      bounds.push(count);
    }
  }
  const valid = bounds.filter((value) => value > 0);
  return valid.length ? Math.min(...valid) : null;
}

export function runnerSample(
  { ts, info, stats, hostCores, hostMemory, storage },
  previous,
) {
  const epoch = info.Id + ":" + info.State.StartedAt;
  const stopped = !info.State.Running;
  const counters = stats
    ? runnerCounters(stats)
    : { cpu: null, system: null, network: null, disk: null };
  const elapsed = interval(previous, epoch, ts);
  const cpu = elapsed
    ? counterDelta({ cpu: counters.cpu }, { cpu: previous.cpu })
    : null;
  const system = elapsed
    ? counterDelta({ system: counters.system }, { system: previous.system })
    : null;
  const cores = stopped
    ? 0
    : cpu !== null && system > 0 && counters.online
      ? (cpu / system) * counters.online
      : null;
  const memory = stats?.memory_stats;
  const cache =
    number(memory?.stats?.total_inactive_file) ??
    number(memory?.stats?.inactive_file) ??
    0;
  const usage = number(memory?.usage);
  const values = {
    cpuUsedCores: cores,
    cpuCapacityCores: cpuCapacity(info, hostCores),
    memoryUsedBytes: stopped
      ? 0
      : usage === null
        ? null
        : Math.max(0, usage - Math.min(cache, usage)),
    memoryCapacityBytes:
      number(info.HostConfig?.Memory) > 0
        ? info.HostConfig.Memory
        : number(hostMemory),
  };
  const deltas = { cpuSeconds: cpu === null ? null : cpu / 1e9 };
  for (const [delta, metric] of ratePairs) {
    const kind = delta.startsWith("network") ? "network" : "disk";
    const key = {
      networkRxBytes: "rx",
      networkTxBytes: "tx",
      diskReadBytes: "read",
      diskWriteBytes: "write",
    }[delta];
    const next = counters[kind]?.[key];
    deltas[delta] = elapsed ? counterDelta(next, previous[kind]?.[key]) : null;
    values[metric] = stopped
      ? 0
      : deltas[delta] === null || !elapsed
        ? null
        : (deltas[delta] / elapsed) * 1000;
  }
  const metricObservedAt = {};
  if (
    storage &&
    number(storage.observedAt) !== null &&
    storage.observedAt <= ts &&
    ts - storage.observedAt <= 900_000
  ) {
    Object.assign(values, {
      diskUsedBytes: number(storage.used),
      diskCapacityBytes: number(storage.capacity),
      workspaceBytes: number(storage.workspace),
      runtimeBytes: number(storage.runtime),
    });
    for (const name of STORAGE_METRICS)
      metricObservedAt[name] = storage.observedAt;
  }
  const state = stopped
    ? "stopped"
    : !stats
      ? "error"
      : !elapsed
        ? "warming"
        : Object.entries(values).some(
              ([name, value]) =>
                !STORAGE_METRICS.has(name) && number(value) === null,
            )
          ? "partial"
          : "ok";
  return {
    sample: sample({
      ts,
      state,
      epoch,
      values,
      metricObservedAt,
      intervalMs: elapsed,
      deltas,
      coverage: {
        expected: 1,
        observed: stopped || stats ? 1 : 0,
        complete: stopped || !!stats,
      },
      details: {
        containerId: info.Id,
        containerState: info.State.Status,
        diskScope: "workspace and runtime data",
        diskSource: storage?.source ?? null,
      },
    }),
    counters: { ...counters, ts, epoch },
  };
}

export function aggregateSamples(ts, entries, host, expected = entries.length) {
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const id = entry.details?.containerId;
    if (id && seen.has(id)) {
      return false;
    }
    if (id) {
      seen.add(id);
    }
    return true;
  });
  expected = Math.max(0, expected - (entries.length - unique.length));
  const values = {};
  const times = {};
  for (const metric of METRICS) {
    const all = unique.map((entry) => number(entry.values[metric]));
    values[metric] =
      unique.length && all.every((value) => value !== null)
        ? all.reduce((a, b) => a + b, 0)
        : expected === 0
          ? 0
          : null;
    times[metric] =
      values[metric] === null
        ? null
        : unique.length
          ? Math.min(
              ...unique.map((entry) => entry.metricObservedAt[metric] ?? ts),
            )
          : ts;
  }
  values.cpuCapacityCores = host.values.cpuCapacityCores;
  values.memoryCapacityBytes = host.values.memoryCapacityBytes;
  times.cpuCapacityCores = host.metricObservedAt.cpuCapacityCores;
  times.memoryCapacityBytes = host.metricObservedAt.memoryCapacityBytes;
  values.diskCapacityBytes = null;
  const observed = unique.filter((entry) => entry.coverage.observed > 0).length;
  const complete = observed === expected;
  const deltas = {};
  for (const name of DELTAS) {
    const all = unique.map((entry) => number(entry.deltas[name]));
    deltas[name] =
      complete && all.length && all.every((value) => value !== null)
        ? all.reduce((a, b) => a + b, 0)
        : complete && expected === 0
          ? 0
          : null;
  }
  if (!complete)
    for (const metric of METRICS)
      if (
        !metric.endsWith("CapacityCores") &&
        !metric.endsWith("CapacityBytes")
      )
        values[metric] = null;
  return sample({
    ts,
    state: complete
      ? unique.some((entry) => entry.state === "warming")
        ? "warming"
        : unique.some(
              (entry) => entry.state === "partial" || entry.state === "error",
            )
          ? "partial"
          : "ok"
      : "partial",
    epoch: "aggregate",
    values,
    metricObservedAt: times,
    intervalMs: unique.length
      ? Math.min(...unique.map((entry) => entry.intervalMs))
      : host.intervalMs,
    deltas,
    coverage: { expected, observed, complete },
    details: {
      diskScope: "sum of runner storage",
      deduplicatedRunners: entries.length - unique.length,
    },
  });
}
