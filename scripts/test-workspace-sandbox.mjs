#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const image = process.env.WORKSPACE_IMAGE ?? "dev-mcp-workspace:latest";
const profile = fileURLToPath(
  new URL("../docker/workspace-seccomp.json", import.meta.url),
);
const base = ["run", "--rm", "--network", "none"];
const secured = [
  ...base,
  "--security-opt",
  "seccomp=" + profile,
  "--security-opt",
  "apparmor=dev-mcp-workspace",
  "--security-opt",
  "systempaths=unconfined",
];
const run = (args) => execute("docker", args, { timeout: 30000 });

// Fresh containers only, with no host/account volumes and no model calls.
await assert.rejects(
  run([
    ...base,
    "--entrypoint",
    "bwrap",
    image,
    "--unshare-user",
    "--ro-bind",
    "/",
    "/",
    "true",
  ]),
);
const isolated = await run([
  ...secured,
  "--entrypoint",
  "bash",
  image,
  "-c",
  "set -eu; mkdir -p /workspace/check; printf keep > /workspace/outside.txt; bwrap --unshare-user --unshare-pid --unshare-net --ro-bind / / --bind /workspace/check /workspace/check --chdir /workspace/check --proc /proc --dev /dev --tmpfs /tmp -- bash -c 'set -eu; printf sandbox-check > sample.txt; cat sample.txt; if printf bad > /workspace/outside.txt; then exit 9; fi'; test \"$(cat /workspace/outside.txt)\" = keep",
]);
assert.equal(isolated.stdout, "sandbox-check");
await assert.rejects(
  run([
    ...secured,
    "--user",
    "0:0",
    "--entrypoint",
    "bash",
    image,
    "-c",
    "mkdir -p /tmp/mount-check; mount -t tmpfs tmpfs /tmp/mount-check",
  ]),
);
await run([
  ...secured,
  "--user",
  "0:0",
  "--entrypoint",
  "node",
  image,
  "-e",
  'const fs=require("node:fs");for(const [p,flags] of [["/proc/kcore","r"],["/proc/keys","r"],["/proc/sysrq-trigger","w"]]){let blocked=false;try{fs.closeSync(fs.openSync(p,flags))}catch{blocked=true}blocked || process.exit(1)}',
]);
console.log(
  "PASS nested workspace sandbox writes, outside-workspace denial, parent mount denial and protected proc paths",
);
