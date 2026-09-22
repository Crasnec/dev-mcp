#!/usr/bin/env node
// Full migration test with uniquely named disposable volumes. No production data.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RunnerOperations } from "./runner-operations.mjs";
const execute = promisify(execFile);
const docker = async (...args) =>
  (
    await execute("docker", args, { timeout: 120000, maxBuffer: 1048576 })
  ).stdout.trim();
const id = randomUUID();
const name = "dev-mcp-user-" + id;
const project = "dev-mcp-test-" + id;
const user = { id, runner: id, status: "active" };
const image = JSON.parse(await docker("inspect", process.env.HOSTNAME))[0]
  .Image;
const workspace = name + "-workspace",
  data = name + "-data";
const pool = project + "-quota-pool",
  images = project + "-quota-images";
const create = async (_user, limits, quotaStorage = false) => {
  const args = [
    "create",
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
  ];
  if (quotaStorage) {
    args.push("--label", "dev-mcp.storage=quota");
  }
  for (const [source, target, subpath] of [
    [workspace, "/workspace", "workspace"],
    [data, "/var/lib/dev-mcp", "data"],
  ]) {
    args.push(
      "--mount",
      quotaStorage
        ? `type=volume,source=${pool},target=${target},volume-subpath=${id}/${subpath}`
        : `type=volume,source=${source},target=${target}`,
    );
  }
  args.push("--entrypoint", "node", image, "-e", "setInterval(()=>{},1000)");
  await docker(...args);
};
try {
  await docker("volume", "create", workspace);
  await docker("volume", "create", data);
  await docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,source=${workspace},target=/workspace`,
    "--mount",
    `type=volume,source=${data},target=/data`,
    "--entrypoint",
    "node",
    image,
    "-e",
    'const fs=require("node:fs");fs.writeFileSync("/workspace/project.txt","original project");fs.writeFileSync("/data/state.txt","original state");fs.chownSync("/workspace",1000,1000);fs.chownSync("/data",1000,1000);',
  );
  await create(user);
  await docker("start", name);
  const ops = new RunnerOperations(
    docker,
    create,
    "/tmp/storage-test-" + id,
    project,
  );
  const limits = {
    network: false,
    memoryMiB: 0,
    cpus: 0,
    pids: 0,
    fileSizeMiB: 0,
    storageMiB: 64,
  };
  await ops.apply(user, { action: "apply", limits }, "unused");
  const observation = await ops.observe(user, "unused");
  assert.equal(observation.storageMiB, 64);
  assert.equal(observation.state, "running");
  assert.equal(
    await docker(
      "exec",
      name,
      "node",
      "-e",
      'process.stdout.write(require("node:fs").readFileSync("/workspace/project.txt","utf8"))',
    ),
    "original project",
  );
  await docker(
    "exec",
    name,
    "node",
    "-e",
    `const fs=require("node:fs");
    fs.writeFileSync("/workspace/first.bin",Buffer.alloc(40*1048576));
    try {
      fs.writeFileSync("/var/lib/dev-mcp/second.bin",Buffer.alloc(40*1048576));
      process.exit(2);
    } catch (error) {
      if (!["ENOSPC","EDQUOT"].includes(error.code)) {
        throw error;
      }
    }`,
  );
  await ops.apply(
    user,
    { action: "apply", limits: { ...limits, storageMiB: 128 } },
    "unused",
  );
  await docker(
    "exec",
    name,
    "node",
    "-e",
    'require("node:fs").writeFileSync("/var/lib/dev-mcp/second.bin",Buffer.alloc(40*1048576))',
  );
  assert.equal((await ops.observe(user, "unused")).storageMiB, 128);
  const original = await docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,source=${workspace},target=/original,readonly`,
    "--entrypoint",
    "node",
    image,
    "-e",
    'process.stdout.write(require("node:fs").readFileSync("/original/project.txt","utf8"))',
  );
  assert.equal(original, "original project");
  console.log(
    "PASS Docker volume migration, subpath isolation, hard quota, resize and retained originals",
  );
} finally {
  for (const container of [name, name + "-previous"]) {
    const present = await docker(
      "ps",
      "-a",
      "--filter",
      "name=^/" + container + "$",
      "--format",
      "{{.ID}}",
    );
    if (present) {
      await docker("rm", "--force", container);
    }
  }
  const volumes = (await docker("volume", "ls", "--format", "{{.Name}}")).split(
    "\n",
  );
  for (const volume of [workspace, data, pool]) {
    if (volumes.includes(volume)) {
      await docker("volume", "rm", volume);
    }
  }
  if (volumes.includes(images)) {
    await docker(
      "run",
      "--rm",
      "--privileged",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${images},target=/images`,
      "--mount",
      "type=bind,source=/dev,target=/dev",
      "--entrypoint",
      "sh",
      image,
      "-c",
      'if [ -f /images/device ]; then losetup -d "$(cat /images/device)"; fi',
    );
    await docker("volume", "rm", images);
  }
}
