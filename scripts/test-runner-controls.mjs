#!/usr/bin/env node
// Disposable Docker integration test. Uses unique names and mounts no service data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RunnerOperations } from "./runner-operations.mjs";
const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute("docker", args, { timeout: 30000 })).stdout.trim();
const id = randomUUID(),
  name = "dev-mcp-user-" + id;
const user = { id, runner: id, status: "active" };
const image = JSON.parse(await docker("inspect", process.env.HOSTNAME))[0]
  .Image;
let created = false,
  network = false;
try {
  await docker("network", "create", name);
  network = true;
  await docker(
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    "dev-mcp.user=" + id,
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--entrypoint",
    "node",
    image,
    "-e",
    "setInterval(()=>{},1000)",
  );
  created = true;
  const ops = new RunnerOperations(
    docker,
    async (_user, resource, quotaStorage) => {
      assert.equal(quotaStorage, false);
      const args = [
        "create",
        "--name",
        name,
        "--label",
        "dev-mcp.user=" + id,
        "--network",
        resource.network ? name : "none",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
      ];
      if (resource.memoryMiB) {
        args.push(
          "--memory",
          resource.memoryMiB + "m",
          "--memory-swap",
          resource.memoryMiB + "m",
        );
      }
      if (resource.cpus) {
        args.push("--cpus", String(resource.cpus));
      }
      if (resource.pids) {
        args.push("--pids-limit", String(resource.pids));
      }
      args.push(
        "--entrypoint",
        "node",
        image,
        "-e",
        "setInterval(()=>{},1000)",
      );
      await docker(...args);
    },
    "/tmp/control-test",
    "dev-mcp",
  );
  const limits = {
    network: true,
    memoryMiB: 128,
    cpus: 0.5,
    pids: 64,
    fileSizeMiB: 0,
    storageMiB: 0,
  };
  await ops.apply(user, { action: "apply", limits }, "unused");
  let observed = await ops.observe(user, "unused");
  assert.equal(observed.network, true);
  assert.equal(observed.memoryMiB, 128);
  assert.equal(observed.cpus, 0.5);
  assert.equal(observed.pids, 64);
  await ops.apply(
    user,
    { action: "apply", limits: { ...limits, network: false } },
    "unused",
  );
  observed = await ops.observe(user, "unused");
  assert.equal(observed.network, false);
  await ops.apply(user, { action: "stop" }, "unused");
  assert.equal((await ops.observe(user, "unused")).state, "exited");
  await ops.apply(user, { action: "start" }, "unused");
  assert.equal((await ops.observe(user, "unused")).state, "running");
  assert.equal((await ops.observe(user, "unused")).network, false);
  await ops.apply(user, { action: "restart" }, "unused");
  assert.equal((await ops.observe(user, "unused")).network, false);
  await ops.apply(
    user,
    {
      action: "apply",
      limits: { ...limits, network: true, memoryMiB: 0, cpus: 0, pids: 0 },
    },
    "unused",
  );
  observed = await ops.observe(user, "unused");
  assert.equal(observed.network, true);
  assert.equal(observed.memoryMiB, 0);
  assert.equal(observed.cpus, 0);
  assert.equal(observed.pids, 0);
  console.log(
    "PASS Docker lifecycle, live resource limits, network toggles and unlimited reset",
  );
} finally {
  if (created) {
    await docker("rm", "--force", name);
  }
  if (network) {
    await docker("network", "rm", name);
  }
}
