import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const temporary: string[] = [];
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const charlie = "00000000-0000-4000-8000-000000000003";
const account = (id: string, status = "active", runner = id) => ({
  id,
  status,
  runner,
});

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(users: unknown[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-provisioner-"));
  temporary.push(directory);
  const usersFile = path.join(directory, "users.json");
  const stateFile = path.join(directory, "state.json");
  await writeFile(usersFile, JSON.stringify({ users }));
  await writeFile(stateFile, JSON.stringify({ containers: {}, calls: [] }));
  // Exercise the actual reconciliation process AND shell helper against a fake
  // Docker daemon, including durable state across retries and service restarts.
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"));
state.calls.push(args);
let output = "", code = 0;
const name = args.at(-1);
if (args[0] === "ps") {
  if (args.includes("-a")) {
    output = Object.entries(state.containers).map(([key, value]) => key + " " + value).join("\\n");
  } else {
    output = args.some(arg => arg.endsWith("service=gateway")) ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb";
  }
} else if (args[0] === "container") {
  code = state.containers[name] ? 0 : 1;
} else if (args[0] === "inspect") {
  output = args[2].includes("Mounts") ? "/host/user-ipc" : args[2].includes("Image") ? "sha256:runner-image" : state.containers[name];
} else if (args[0] === "network" && args[1] === "inspect") {
  code = 1;
} else if (args[0] === "run" && args.includes("--detach")) {
  const container = args[args.indexOf("--name") + 1];
  if (state.failNext) {
    delete state.failNext;
    code = 1;
  } else {
    state.containers[container] = "running";
  }
} else if (args[0] === "start") {
  state.containers[name] = "running";
}
fs.writeFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify(state));
console.log(output);
process.exit(code);
`,
    { mode: 0o755 },
  );
  return {
    usersFile,
    stateFile,
    state: async () => JSON.parse(await readFile(stateFile, "utf8")),
    run: () =>
      execute(
        process.execPath,
        ["scripts/reconcile-user-runners.mjs", "--once"],
        {
          env: {
            ...process.env,
            PATH: directory + path.delimiter + process.env.PATH,
            PROVISIONER_USERS_FILE: usersFile,
            FAKE_DOCKER_STATE: stateFile,
          },
        },
      ),
  };
}

it("creates only approved dedicated runners with isolated mounts and no published ports", async () => {
  const fixtureData = await fixture([
    account(alice),
    account(bob, "pending"),
    account(charlie, "disabled"),
    account("00000000-0000-4000-8000-000000000004", "active", "primary"),
    account("../../bad;touch /tmp/injected"),
    account("00000000-0000-4000-8000-000000000005", "active", alice),
  ]);
  const result = await fixtureData.run();
  expect(result.stdout).toContain("user_runner_provisioned");
  const state = await fixtureData.state();
  expect(state.containers).toEqual({ ["dev-mcp-user-" + alice]: "running" });
  const creation = state.calls.find((args: string[]) =>
    args.includes("--detach"),
  );
  expect(creation).toEqual(
    expect.arrayContaining([
      "--read-only",
      "no-new-privileges:true",
      `type=volume,source=dev-mcp-user-${alice}-workspace,target=/workspace`,
      `type=volume,source=dev-mcp-user-${alice}-data,target=/var/lib/dev-mcp`,
      `type=bind,source=/host/user-ipc/${alice},target=/ipc`,
      `type=bind,source=/host/user-ipc/${alice}.key,target=/run/dev-mcp-ipc-key,readonly`,
      "sha256:runner-image",
    ]),
  );
  expect(creation).not.toContain("--publish");
  expect(creation).not.toContain("-p");
  expect(creation.join(" ")).not.toContain("docker.sock");
  expect(creation[creation.indexOf("--network") + 1]).toBe(
    "dev-mcp-user-" + alice,
  );

  await writeFile(
    fixtureData.usersFile,
    JSON.stringify({ users: [account(alice), account(bob)] }),
  );
  await fixtureData.run();
  const approved = await fixtureData.state();
  expect(Object.keys(approved.containers)).toHaveLength(2);
  expect(
    approved.calls.filter((args: string[]) => args.includes("--detach")),
  ).toHaveLength(2);
});

it("retries failed creation on the next pass and continues with other users", async () => {
  const f = await fixture([account(alice), account(bob)]);
  await writeFile(
    f.stateFile,
    JSON.stringify({ ...(await f.state()), failNext: true }),
  );
  await expect(f.run()).rejects.toMatchObject({ code: 1 });
  expect((await f.state()).containers).toEqual({
    ["dev-mcp-user-" + bob]: "running",
  });
  await f.run();
  expect(Object.keys((await f.state()).containers)).toHaveLength(2);
});

it("preserves running and intentionally stopped containers, but recovers an incomplete start", async () => {
  const f = await fixture([account(alice), account(bob), account(charlie)]);
  await writeFile(
    f.stateFile,
    JSON.stringify({
      calls: [],
      containers: {
        ["dev-mcp-user-" + alice]: "running",
        ["dev-mcp-user-" + bob]: "exited",
        ["dev-mcp-user-" + charlie]: "created",
      },
    }),
  );
  await f.run();
  const state = await f.state();
  expect(state.containers["dev-mcp-user-" + bob]).toBe("exited");
  expect(state.containers["dev-mcp-user-" + charlie]).toBe("running");
  expect(
    state.calls.filter((args: string[]) => args.includes("--detach")),
  ).toHaveLength(0);
});

it("fails closed on unreadable account state without logging its contents", async () => {
  const f = await fixture([]);
  await writeFile(f.usersFile, "PRIVATE_SENTINEL invalid json");
  await expect(f.run()).rejects.toMatchObject({
    code: 1,
    stdout: '{"event":"runner_reconciliation_failed"}\n',
  });
  expect((await f.state()).calls).toHaveLength(0);
});
