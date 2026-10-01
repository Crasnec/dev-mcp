#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readdir, stat, statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  aggregateSamples,
  hostSample,
  parseCpu,
  parseDisk,
  parseMemory,
  parseNetwork,
  runnerSample,
  unavailable,
  number,
} from "./telemetry-metrics.mjs";
import { TelemetryStore, readBoundedJson } from "./telemetry-store.mjs";

const ID = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DU_COMMAND = [
  "/usr/bin/timeout",
  "-k",
  "2s",
  "15s",
  "/usr/bin/du",
  "-sx",
  "-B1",
  "/workspace",
  "/var/lib/dev-mcp",
];

export class DockerApi {
  constructor(socketPath = "/var/run/docker.sock") {
    this.socketPath = socketPath;
    this.version = "v1.45";
    this.requests = new Set();
  }
  async initialize() {
    const version = await this.request("GET", "/version");
    if (
      !/^1\.\d+$/.test(version.ApiVersion) ||
      Number(version.ApiVersion.split(".")[1]) < 45
    )
      throw new Error("Docker API 1.45 or newer is required");
    this.version = "v" + version.ApiVersion;
  }
  request(
    method,
    endpoint,
    body,
    { timeoutMs = 4000, maxBytes = 2 * 1024 * 1024, raw = false } = {},
  ) {
    const read =
      method === "GET" &&
      (/^\/(version|info)$/.test(endpoint) ||
        /^\/containers\/json\?/.test(endpoint) ||
        /^\/containers\/[a-f0-9]{64}\/(json|stats\?stream=false&one-shot=true)$/.test(
          endpoint,
        ) ||
        /^\/exec\/[a-f0-9]{64}\/json$/.test(endpoint));
    const exec =
      method === "POST" &&
      (/^\/containers\/[a-f0-9]{64}\/exec$/.test(endpoint) ||
        /^\/exec\/[a-f0-9]{64}\/start$/.test(endpoint));
    if (!read && !exec) {
      throw new Error("Docker operation is not allowed");
    }
    if (
      exec &&
      endpoint.endsWith("/exec") &&
      (JSON.stringify(body?.Cmd) !== JSON.stringify(DU_COMMAND) ||
        body?.Privileged !== false ||
        body?.Tty !== false ||
        body?.AttachStdin !== false ||
        body?.AttachStdout !== true ||
        body?.AttachStderr !== true ||
        Object.keys(body).some(
          (key) =>
            ![
              "Cmd",
              "Privileged",
              "Tty",
              "AttachStdin",
              "AttachStdout",
              "AttachStderr",
            ].includes(key),
        ))
    )
      throw new Error("Only the fixed storage measurement command is allowed");
    if (
      exec &&
      endpoint.endsWith("/start") &&
      (body?.Detach !== false ||
        body?.Tty !== false ||
        Object.keys(body).some((key) => !["Detach", "Tty"].includes(key)))
    ) {
      throw new Error("Only an attached storage measurement is allowed");
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0,
        complete = false;
      const request = http.request({
        socketPath: this.socketPath,
        path:
          endpoint === "/version" ? endpoint : "/" + this.version + endpoint,
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
      });
      this.requests.add(request);
      const timer = setTimeout(
        () =>
          request.destroy(
            Object.assign(new Error("Docker observation timed out"), {
              code: "TIMEOUT",
            }),
          ),
        timeoutMs,
      );
      const finish = (error, value) => {
        if (complete) {
          return;
        }
        complete = true;
        clearTimeout(timer);
        this.requests.delete(request);
        if (error) {
          reject(error);
        } else resolve(value);
      };
      request.on("error", (error) => finish(error));
      request.on("response", (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(
            Object.assign(new Error("Docker observation failed"), {
              status: response.statusCode,
            }),
          );
          response.destroy();
          request.destroy();
          return;
        }
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            request.destroy(new Error("Docker observation exceeded limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => finish(error));
        response.on("aborted", () =>
          finish(new Error("Docker observation aborted")),
        );
        response.on("end", () => {
          try {
            const buffer = Buffer.concat(chunks);
            finish(null, raw ? buffer : JSON.parse(buffer.toString("utf8")));
          } catch {
            finish(new Error("Invalid Docker observation"));
          }
        });
      });
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  abort() {
    for (const request of this.requests)
      request.destroy(new Error("Collector is stopping"));
  }
  list(filters) {
    return this.request(
      "GET",
      "/containers/json?all=1&filters=" +
        encodeURIComponent(JSON.stringify(filters)),
    );
  }
  inspect(id) {
    if (!ID.test(id)) {
      throw new Error("Invalid container ID");
    }
    return this.request("GET", `/containers/${id}/json`);
  }
  stats(id) {
    if (!ID.test(id)) {
      throw new Error("Invalid container ID");
    }
    return this.request(
      "GET",
      `/containers/${id}/stats?stream=false&one-shot=true`,
    );
  }
  async storage(id) {
    if (!ID.test(id)) {
      throw new Error("Invalid container ID");
    }
    const exec = await this.request("POST", `/containers/${id}/exec`, {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Privileged: false,
      Cmd: DU_COMMAND,
    });
    if (!ID.test(exec.Id)) {
      throw new Error("Invalid Docker exec ID");
    }
    const response = await this.request(
      "POST",
      `/exec/${exec.Id}/start`,
      { Detach: false, Tty: false },
      { timeoutMs: 20_000, maxBytes: 64 * 1024, raw: true },
    );
    const output = dockerOutput(response);
    const result = await this.request("GET", `/exec/${exec.Id}/json`);
    if (result.Running || result.ExitCode !== 0)
      throw Object.assign(new Error("Storage measurement was incomplete"), {
        code: [124, 137].includes(result.ExitCode)
          ? "TIMEOUT"
          : "STORAGE_READ_FAILED",
      });
    return parseStorage(output);
  }
}

export function dockerOutput(buffer) {
  const output = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length)
      throw new Error("Incomplete Docker output frame");
    const stream = buffer[offset],
      length = buffer.readUInt32BE(offset + 4);
    if (
      ![1, 2].includes(stream) ||
      buffer[offset + 1] ||
      buffer[offset + 2] ||
      buffer[offset + 3] ||
      offset + 8 + length > buffer.length
    )
      throw new Error("Invalid Docker output frame");
    if (stream === 1)
      output.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(output).toString("utf8");
}

export function parseStorage(output) {
  const values = {};
  for (const line of output.trim().split("\n")) {
    const match = /^(\d+)\s+(\/workspace|\/var\/lib\/dev-mcp)$/.exec(line);
    if (
      !match ||
      Object.hasOwn(values, match[2]) ||
      !Number.isSafeInteger(Number(match[1]))
    )
      throw new Error("Invalid storage measurement");
    values[match[2]] = Number(match[1]);
  }
  if (Object.keys(values).length !== 2)
    throw new Error("Incomplete storage measurement");
  return {
    workspace: values["/workspace"],
    runtime: values["/var/lib/dev-mcp"],
    used: values["/workspace"] + values["/var/lib/dev-mcp"],
  };
}

export function validAccount(user) {
  return (
    user &&
    typeof user.id === "string" &&
    UUID.test(user.id) &&
    (user.runner === "primary" || user.runner === user.id) &&
    ["active", "pending", "disabled"].includes(user.status)
  );
}
export function ownsContainer(user, info, project) {
  if (!validAccount(user) || !info || !ID.test(info.Id ?? "")) {
    return false;
  }
  const labels = info.Config?.Labels ?? {};
  return user.runner === "primary"
    ? labels["com.docker.compose.project"] === project &&
        labels["com.docker.compose.service"] === "runner" &&
        labels["com.docker.compose.oneoff"] === "False"
    : info.Name === "/dev-mcp-user-" + user.id &&
        labels["dev-mcp.user"] === user.id;
}

export function aggregateMember(user, hasContainer) {
  // Pending registrations do not yet own an environment. Active environments
  // remain expected when Docker is unavailable so missing data is never zero.
  return user.status === "active" || hasContainer;
}

async function boundedText(filename, max = 2 * 1024 * 1024) {
  // procfs reports size 0, so use a capped stream instead of stat size.
  const { createReadStream } = await import("node:fs");
  const stream = createReadStream(filename);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > max) {
        throw new Error("Host observation exceeds limit");
      }
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).toString("utf8");
}

const optional = async (operation) => {
  try {
    return await operation();
  } catch {
    return null;
  }
};

export async function hostObservation(procRoot, sysRoot, fsRoot) {
  const [cpu, memory, epoch, interfaces, devices, filesystem] =
    await Promise.all([
      optional(async () =>
        parseCpu(await boundedText(path.join(procRoot, "stat"))),
      ),
      optional(async () =>
        parseMemory(await boundedText(path.join(procRoot, "meminfo"))),
      ),
      optional(async () =>
        (
          await boundedText(
            path.join(procRoot, "sys/kernel/random/boot_id"),
            128,
          )
        ).trim(),
      ),
      optional(async () => {
        const names = await readdir(path.join(sysRoot, "class/net"));
        const eligible = await Promise.all(
          names
            .filter((name) => /^[A-Za-z0-9_.:-]+$/.test(name) && name !== "lo")
            .map(
              async (name) =>
                await optional(async () => {
                  await stat(path.join(sysRoot, "class/net", name, "device"));
                  return name;
                }),
            ),
        );
        return eligible.filter(Boolean).sort();
      }),
      optional(async () => {
        const names = await readdir(path.join(sysRoot, "block"));
        const eligible = await Promise.all(
          names
            .filter(
              (name) =>
                /^[A-Za-z0-9_.!-]+$/.test(name) &&
                !/^(loop|ram|zram|dm-|md)/.test(name),
            )
            .map(
              async (name) =>
                await optional(async () => {
                  await stat(path.join(sysRoot, "block", name, "device"));
                  if (
                    (await readdir(path.join(sysRoot, "block", name, "slaves")))
                      .length
                  )
                    return null;
                  return name;
                }),
            ),
        );
        return eligible.filter(Boolean).sort();
      }),
      optional(async () => {
        const info = await statfs(fsRoot);
        return {
          capacity: info.blocks * info.bsize,
          used: (info.blocks - info.bfree) * info.bsize,
        };
      }),
    ]);
  const [network, disk] = await Promise.all([
    interfaces?.length
      ? optional(async () =>
          parseNetwork(
            await boundedText(path.join(procRoot, "1/net/dev")),
            interfaces,
          ),
        )
      : null,
    devices?.length
      ? optional(async () =>
          parseDisk(
            await boundedText(path.join(procRoot, "diskstats")),
            devices,
          ),
        )
      : null,
  ]);
  return {
    cpu,
    memory,
    epoch: epoch || "unknown-host-boot",
    network,
    disk,
    filesystem,
    interfaces: interfaces ?? [],
    devices: devices ?? [],
  };
}

async function mapLimit(values, limit, operation) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await operation(values[index]);
      }
    }),
  );
  return output;
}

export class Collector {
  constructor({
    docker,
    store,
    project = "dev-mcp",
    usersFile = "/gateway-data/users.json",
    statusDirectory = "/runner-status",
    procRoot = "/host-proc",
    sysRoot = "/host-sys",
    fsRoot = "/hostfs",
    maxRunners = 256,
    readHost = hostObservation,
  }) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
      throw new Error("Invalid Compose project");
    Object.assign(this, {
      docker,
      store,
      project,
      usersFile,
      statusDirectory,
      procRoot,
      sysRoot,
      fsRoot,
      maxRunners,
      readHost,
    });
    this.previous = new Map();
    this.storage = new Map();
    this.storageDue = new Map();
    this.storageErrors = new Map();
    this.epochs = new Map();
    this.storageInFlight = false;
    this.stopping = false;
  }
  async collect() {
    const frameDeadline = Date.now() + 12_000;
    const [db, status, containers] = await Promise.all([
      optional(() => readBoundedJson(this.usersFile, 4 * 1024 * 1024)),
      optional(() =>
        readBoundedJson(path.join(this.statusDirectory, "status.json")),
      ),
      optional(async () => {
        const [primary, dedicated] = await Promise.all([
          this.docker.list({
            label: [
              `com.docker.compose.project=${this.project}`,
              "com.docker.compose.service=runner",
              "com.docker.compose.oneoff=False",
            ],
          }),
          this.docker.list({ label: ["dev-mcp.user"] }),
        ]);
        if (!Array.isArray(primary) || !Array.isArray(dedicated))
          throw new Error("Invalid Docker container list");
        return { primary, dedicated };
      }),
    ]);
    const databaseReady = Array.isArray(db?.users);
    const accounts = databaseReady ? db.users.filter(validAccount) : [];
    const unique = [
      ...new Map(accounts.map((user) => [user.id, user])).values(),
    ];
    const candidates = (user) =>
      user.runner === "primary"
        ? (containers?.primary ?? [])
        : (containers?.dedicated ?? []).filter((entry) =>
            entry.Names?.includes("/dev-mcp-user-" + user.id),
          );
    const included = unique.filter((user) =>
      aggregateMember(user, candidates(user).length > 0),
    );
    const includedIds = new Set(included.map((user) => user.id));
    const selected = [...unique]
      .sort(
        (a, b) => Number(includedIds.has(b.id)) - Number(includedIds.has(a.id)),
      )
      .slice(0, this.maxRunners);
    const observations = await mapLimit(selected, 4, async (user) => {
      try {
        // Bound a frame even when a large installation has failing runners.
        if (!containers || Date.now() >= frameDeadline || this.stopping)
          return { user, error: true };
        const matches = candidates(user);
        if (!matches.length) {
          return { user, missing: true };
        }
        if (matches.length !== 1 || !ID.test(matches[0].Id ?? ""))
          throw new Error("Ambiguous runner identity");
        const info = await this.docker.inspect(matches[0].Id);
        if (!ownsContainer(user, info, this.project))
          throw new Error("Runner identity mismatch");
        let stats = null;
        if (info.State.Running) {
          stats = await optional(() => this.docker.stats(info.Id));
          if (stats?.id && stats.id !== info.Id)
            throw new Error("Runner statistics identity mismatch");
          // Restart between inspect and stats must not produce a cross-generation delta.
          const after = await this.docker.inspect(info.Id);
          if (
            !ownsContainer(user, after, this.project) ||
            after.State.StartedAt !== info.State.StartedAt ||
            after.State.Running !== info.State.Running
          )
            return { user, warming: true };
        }
        return { user, info, stats };
      } catch {
        return { user, error: true };
      }
    });
    // Timestamp host counters immediately after their read, not after a
    // potentially variable Docker sweep that would skew byte-rate intervals.
    const host = await this.readHost(this.procRoot, this.sysRoot, this.fsRoot);
    const ts = Date.now();
    const hostResult = hostSample({ ...host, ts }, this.previous.get("host"));
    this.previous.set("host", hostResult.counters);
    const scopes = { host: hostResult.sample };
    for (const observation of observations) {
      const { user, info, stats } = observation;
      if (!info) {
        scopes[user.id] = unavailable(
          ts,
          observation.missing
            ? "missing"
            : observation.warming
              ? "warming"
              : "error",
        );
        this.previous.delete(user.id);
        this.epochs.delete(user.id);
        continue;
      }
      const epoch = info.Id + ":" + info.State.StartedAt;
      if (this.epochs.get(user.id) !== epoch) {
        this.storage.delete(user.id);
        this.storageDue.delete(user.id);
        this.storageErrors.delete(user.id);
      }
      this.epochs.set(user.id, epoch);
      const cached = this.storage.get(user.id);
      const quota = status?.entries?.[user.id];
      const freshQuota =
        info.Config?.Labels?.["dev-mcp.storage"] === "quota" &&
        number(quota?.storageUsedMiB) !== null &&
        number(quota?.observedAt) !== null &&
        quota.observedAt <= ts &&
        quota.observedAt >= Date.parse(info.State.StartedAt) &&
        ts - quota.observedAt <= 20_000;
      const storage =
        cached && cached.epoch === epoch && ts - cached.observedAt <= 900_000
          ? {
              ...cached,
              capacity:
                freshQuota && number(quota.storageMiB) > 0
                  ? quota.storageMiB * 1048576
                  : null,
            }
          : freshQuota
            ? {
                used: quota.storageUsedMiB * 1048576,
                capacity:
                  number(quota.storageMiB) > 0
                    ? quota.storageMiB * 1048576
                    : null,
                observedAt: quota.observedAt,
                source: "quota",
              }
            : undefined;
      const result = runnerSample(
        {
          ts,
          info,
          stats,
          hostCores: host.cpu?.cores,
          hostMemory: host.memory?.capacity,
          storage,
        },
        this.previous.get(user.id),
      );
      result.sample.details.storageState = storage
        ? this.storageErrors.has(user.id)
          ? "stale"
          : "ok"
        : this.storageErrors.has(user.id)
          ? "unavailable"
          : "warming";
      result.sample.details.storageError =
        this.storageErrors.get(user.id) ?? null;
      scopes[user.id] = result.sample;
      this.previous.set(user.id, result.counters);
    }
    scopes["all-runners"] = aggregateSamples(
      ts,
      observations
        .filter((entry) => includedIds.has(entry.user.id))
        .map((entry) => scopes[entry.user.id]),
      scopes.host,
      databaseReady ? included.length : 1,
    );
    if (!databaseReady) {
      scopes["all-runners"].state = "error";
      scopes["all-runners"].details.accountsUnavailable = true;
    }
    if (included.length > selected.length)
      scopes["all-runners"].details.omittedRunners =
        included.length - selected.length;
    for (const key of this.previous.keys())
      if (key !== "host" && !unique.some((user) => user.id === key))
        this.previous.delete(key);
    for (const map of [
      this.storage,
      this.storageDue,
      this.storageErrors,
      this.epochs,
    ])
      for (const key of map.keys())
        if (!unique.some((user) => user.id === key)) {
          map.delete(key);
        }
    await this.store.record(scopes, ts);
    this.scheduleStorage(observations, ts);
    return scopes;
  }
  scheduleStorage(observations, now) {
    if (this.storageInFlight || this.stopping) {
      return;
    }
    const candidate = observations
      .filter(
        (entry) =>
          entry.info?.State.Running &&
          (this.storageDue.get(entry.user.id) ?? 0) <= now,
      )
      .sort(
        (a, b) =>
          (this.storageDue.get(a.user.id) ?? 0) -
          (this.storageDue.get(b.user.id) ?? 0),
      )[0];
    if (!candidate) {
      return;
    }
    const { user, info } = candidate;
    const epoch = info.Id + ":" + info.State.StartedAt;
    this.storageInFlight = true;
    this.storageDue.set(user.id, now + 300_000);
    void this.docker
      .storage(info.Id)
      .then(async (value) => {
        if (this.stopping || this.epochs.get(user.id) !== epoch) {
          return;
        }
        const after = await this.docker.inspect(info.Id);
        if (
          !this.stopping &&
          this.epochs.get(user.id) === epoch &&
          ownsContainer(user, after, this.project) &&
          after.Id + ":" + after.State.StartedAt === epoch
        ) {
          this.storage.set(user.id, {
            ...value,
            epoch,
            observedAt: Date.now(),
            source: "du",
          });
          this.storageErrors.delete(user.id);
        }
      })
      .catch((error) => {
        if (this.stopping || this.epochs.get(user.id) !== epoch) {
          return;
        }
        this.storageErrors.set(
          user.id,
          error.code === "TIMEOUT"
            ? "measurement_timeout"
            : "measurement_unavailable_or_inaccessible",
        );
      })
      .finally(() => {
        this.storageInFlight = false;
      });
  }
  stop() {
    this.stopping = true;
    this.docker.abort();
  }
}

function envInteger(name, fallback, min, max) {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error("Invalid telemetry configuration");
  return value;
}

export async function main() {
  const statusDirectory = process.env.RUNNER_STATUS_DIR ?? "/runner-status";
  const intervalMs = envInteger("TELEMETRY_INTERVAL_MS", 5000, 1000, 10_000);
  const store = new TelemetryStore(path.join(statusDirectory, "telemetry"), {
    intervalMs,
    maxBytes: envInteger("TELEMETRY_MAX_HISTORY_MIB", 512, 16, 4096) * 1048576,
  });
  const docker = new DockerApi(
    process.env.TELEMETRY_DOCKER_SOCKET ?? "/var/run/docker.sock",
  );
  const collector = new Collector({
    docker,
    store,
    project: process.env.COMPOSE_PROJECT_NAME ?? "dev-mcp",
    usersFile: process.env.TELEMETRY_USERS_FILE ?? "/gateway-data/users.json",
    statusDirectory,
    procRoot: process.env.TELEMETRY_HOST_PROC ?? "/host-proc",
    sysRoot: process.env.TELEMETRY_HOST_SYS ?? "/host-sys",
    fsRoot: process.env.TELEMETRY_HOST_ROOT ?? "/hostfs",
    // Keep current + open-bucket snapshots below the shared 8 MiB read bound.
    maxRunners: envInteger("TELEMETRY_MAX_RUNNERS", 256, 1, 512),
  });
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    collector.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await store.initialize();
  try {
    await docker
      .initialize()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "telemetry_docker_unavailable" }),
        ),
      );
    do {
      const start = Date.now();
      try {
        await collector.collect();
      } catch {
        console.error(JSON.stringify({ event: "telemetry_collection_failed" }));
      }
      if (process.argv.includes("--once") || shutdown.signal.aborted) {
        break;
      }
      await delay(Math.max(250, intervalMs - (Date.now() - start)), undefined, {
        signal: shutdown.signal,
      }).catch(() => {});
    } while (!shutdown.signal.aborted);
  } finally {
    stop();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "telemetry_start_failed" }));
    process.exitCode = 1;
  });
}
