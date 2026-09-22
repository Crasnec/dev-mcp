#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  RunnerOperations,
  OperationError,
  readJson,
  writeJson,
  validUser,
  validControl,
} from "./runner-operations.mjs";

const execute = promisify(execFile);
const project = process.env.COMPOSE_PROJECT_NAME ?? "dev-mcp";
const usersFile =
  process.env.PROVISIONER_USERS_FILE ?? "/gateway-data/users.json";
const controlsFile = path.join(path.dirname(usersFile), "runner-controls.json");
const statusDir = process.env.RUNNER_STATUS_DIR ?? "/runner-status";
const statusFile = path.join(statusDir, "status.json");
const helper = fileURLToPath(new URL("./provision-user.sh", import.meta.url));
const once = process.argv.includes("--once");
let gatewayId, primaryId;
const docker = async (...args) =>
  (
    await execute("docker", args, { timeout: 300_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
const log = (event, userId) =>
  console.log(JSON.stringify({ event, ...(userId ? { userId } : {}) }));

async function serviceId(service) {
  const ids = await docker(
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
    "--filter",
    "label=com.docker.compose.oneoff=False",
    "--format",
    "{{.ID}}",
  );
  if (!/^[a-f0-9]{12,64}$/.test(ids)) {
    throw new Error("Expected one Compose service");
  }
  return ids;
}
async function users() {
  const db = await readJson(usersFile, { users: [] });
  if (!Array.isArray(db.users)) {
    throw new Error("Invalid account database");
  }
  return db.users.filter(validUser);
}
const operations = new RunnerOperations(
  docker,
  async (user, limits, quotaStorage, start = true) => {
    await execute("bash", [helper, user.id], {
      env: {
        ...process.env,
        GATEWAY_CONTAINER_ID: gatewayId,
        PRIMARY_CONTAINER_ID: primaryId,
        RUNNER_MEMORY_MIB: String(limits?.memoryMiB ?? 0),
        RUNNER_CPUS: String(limits?.cpus ?? 0),
        RUNNER_PIDS: String(limits?.pids ?? 0),
        RUNNER_FILE_SIZE_MIB: String(limits?.fileSizeMiB ?? 0),
        RUNNER_NETWORK: String(limits?.network ?? true),
        RUNNER_QUOTA_STORAGE: String(quotaStorage ?? false),
        RUNNER_QUOTA_VOLUME: project + "-quota-pool",
        RUNNER_START: String(start),
      },
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
    });
  },
  statusDir,
  project,
);

async function reconcile() {
  const accounts = await users();
  if (!accounts.length) {
    return true;
  }
  gatewayId = await serviceId("gateway");
  primaryId = await serviceId("runner");
  const desired = await readJson(controlsFile, { entries: {} });
  const status = await readJson(statusFile, { entries: {} });
  let ok = true;
  for (const user of accounts) {
    let previous = status.entries[user.id] ?? {};
    const request = desired.entries[user.id];
    try {
      if (request && !validControl(request)) {
        throw new Error("Invalid runner request");
      }
      const current = (await users()).find((entry) => entry.id === user.id);
      if (!current) {
        continue;
      }
      if (request && previous.revision !== request.revision) {
        previous = {
          ...previous,
          revision: request.revision,
          phase: "applying",
          message: "운영 요청을 적용하고 있습니다.",
        };
        status.entries[user.id] = previous;
        await writeJson(statusFile, status);
        try {
          await operations.apply(current, request, primaryId);
          previous.phase = "applied";
          previous.message = "운영 요청을 적용했습니다.";
          log("runner_operation_applied", user.id);
        } catch (error) {
          previous.phase = "failed";
          previous.message =
            error instanceof OperationError
              ? error.message
              : "적용에 실패했습니다. 현재 상태와 설정값을 확인한 뒤 다시 요청해 주세요. 저장소 이전 중이었다면 원본 볼륨은 보존됩니다.";
          ok = false;
          log("runner_operation_failed", user.id);
        }
      } else if (request && previous.phase === "applying") {
        // A crash may have occurred after a restart was dispatched. Never replay
        // an ambiguous destructive operation automatically.
        previous.phase = "failed";
        previous.message =
          "관리 서비스가 작업 도중 재시작되었습니다. 실제 상태를 확인한 뒤 다시 요청해 주세요.";
      }
      const { info, name } = await operations.owned(current, primaryId);
      if (
        request?.action !== "stop" &&
        current.runner !== "primary" &&
        current.status === "active" &&
        (!info || (!request && info.State.Status === "created"))
      ) {
        // Legacy automatic creation, including retry on the next pass.
        const latest = (await users()).find((entry) => entry.id === user.id);
        if (latest?.status === "active") {
          await operations.create(current, request?.limits, primaryId);
          log("user_runner_provisioned", user.id);
        }
      }
      // A quota runner can fail to start after host reboot until its loop device
      // is restored. Recover only runners last observed running, never stopped.
      if (info?.Config.Labels?.["dev-mcp.storage"] === "quota") {
        await operations.storage();
        if (
          previous.state === "running" &&
          !info.State.Running &&
          /mount|loop/.test(info.State.Error ?? "") &&
          request?.action !== "stop" &&
          previous.phase !== "failed"
        ) {
          await docker("start", name);
        }
      }
      const observation = await operations.observe(current, primaryId);
      if (
        request?.action === "apply" &&
        previous.phase === "applied" &&
        Object.entries(request.limits).some(
          ([key, value]) => (observation[key] ?? 0) !== value,
        )
      ) {
        previous.phase = "failed";
        previous.message =
          "실제 적용값이 요청한 제한과 다릅니다. 현재 상태를 확인한 뒤 다시 요청해 주세요.";
        ok = false;
      }
      status.entries[user.id] = {
        ...previous,
        ...observation,
      };
    } catch {
      ok = false;
      status.entries[user.id] = {
        ...previous,
        state: "unknown",
        observedAt: Date.now(),
        message: "실행 환경 상태를 확인하지 못했습니다.",
      };
      log("user_runner_provision_failed", user.id);
    }
    await writeJson(statusFile, status);
  }
  return ok;
}

do {
  let ok = false;
  try {
    ok = await reconcile();
  } catch {
    log("runner_reconciliation_failed");
  }
  if (once) {
    process.exitCode = ok ? 0 : 1;
    break;
  }
  await delay(5000);
} while (true);
