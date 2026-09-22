#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const project = process.env.COMPOSE_PROJECT_NAME ?? "dev-mcp";
const usersFile =
  process.env.PROVISIONER_USERS_FILE ?? "/gateway-data/users.json";
const helper = fileURLToPath(new URL("./provision-user.sh", import.meta.url));
const interval = 5000;

// This privileged service has no HTTP listener or user-controlled command input.
// Read committed account records; only validated, active, dedicated identities
// can reach the fixed provisioning helper. Never print the account database.
async function approvedUsers() {
  let db;
  try {
    db = JSON.parse(await readFile(usersFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw new Error("Cannot read account database");
  }
  if (!Array.isArray(db.users)) {
    throw new Error("Invalid account database");
  }
  return db.users.filter(
    (user) =>
      user &&
      typeof user.id === "string" &&
      uuid.test(user.id) &&
      user.runner === user.id &&
      user.status === "active",
  );
}

async function docker(...args) {
  return (
    await execute("docker", args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}

async function serviceId(service) {
  const ids = await docker(
    "ps",
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
    throw new Error("Expected one running Compose service");
  }
  return ids;
}

function log(event, userId) {
  console.log(JSON.stringify({ event, ...(userId ? { userId } : {}) }));
}

async function reconcile() {
  const users = await approvedUsers();
  if (users.length === 0) {
    return true;
  }
  const gatewayId = await serviceId("gateway");
  const primaryId = await serviceId("runner");
  // Include stopped containers to respect an operator's explicit stop. A
  // container left in "created" by a failed start is retried by the helper.
  const existing = new Map(
    (await docker("ps", "-a", "--format", "{{.Names}} {{.State}}"))
      .split("\n")
      .map((line) => line.split(" ")),
  );
  let ok = true;
  for (const user of users) {
    const state = existing.get("dev-mcp-user-" + user.id);
    if (state && state !== "created") {
      continue;
    }
    try {
      // Recheck after earlier slow creations, so a withdrawn approval is skipped.
      if (!(await approvedUsers()).some((entry) => entry.id === user.id)) {
        continue;
      }
      await execute("bash", [helper, user.id], {
        env: {
          ...process.env,
          GATEWAY_CONTAINER_ID: gatewayId,
          PRIMARY_CONTAINER_ID: primaryId,
        },
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
      });
      log("user_runner_provisioned", user.id);
    } catch {
      // Do not serialize subprocess output, environment, or database contents.
      log("user_runner_provision_failed", user.id);
      ok = false;
    }
  }
  return ok;
}

const once = process.argv.includes("--once");
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
  // Await each pass: slow Docker operations never overlap another pass.
  await delay(interval);
} while (true);
