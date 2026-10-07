import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

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
state.metadata ??= {};
state.networks ??= {};
state.entryNetworks ??= {};
state.volumes ??= {};
let output = "", code = 0;
const name = args.at(-1);
const values = option => args.flatMap((value, index) => value === option ? [args[index + 1]] : []);
const labels = () => Object.fromEntries(values("--label").map(value => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)]));
if (args[0] === "ps") {
  const filter = args.find(arg => arg.startsWith("name=^/"));
  if (filter) {
    output = Object.keys(state.containers).some(name => new RegExp(filter.slice(5)).test("/" + name)) ? "cccccccccccc" : "";
  } else if (args.some(arg => arg.startsWith("label=dev-mcp.user="))) {
    const owner = args.find(arg => arg.startsWith("label=dev-mcp.user=")).slice("label=dev-mcp.user=".length);
    output = Object.keys(state.containers).filter(name => state.metadata[name]?.labels?.["dev-mcp.user"] === owner).join("\\n");
  } else {
    output = args.some(arg => arg.endsWith("service=gateway")) ? "aaaaaaaaaaaa" : args.some(arg => arg.endsWith("service=ssh-entry")) ? "dddddddddddd" : "bbbbbbbbbbbb";
  }
} else if (args[0] === "container") {
  code = state.containers[name] ? 0 : 1;
} else if (args[0] === "inspect") {
  if (args.includes("--format")) {
    output = args[2].includes("Labels") ? state.metadata[name]?.labels?.["dev-mcp.user"] ?? name.replace("dev-mcp-user-", "") : args[2].includes("Mounts") ? "/host/user-ipc" : args[2].includes("Image") ? "sha256:" + "f".repeat(64) : state.containers[name];
  } else {
    const entry = name === "dddddddddddd";
    const primary = name === "bbbbbbbbbbbb";
    const metadata = state.metadata[name] ?? {};
    output = JSON.stringify([{
      Name: "/" + name,
      Image: "sha256:" + "f".repeat(64),
      Config: { Labels: entry ? {"com.docker.compose.project":"dev-mcp", "com.docker.compose.service":"ssh-entry"} : primary ? {"com.docker.compose.project":"dev-mcp", "com.docker.compose.service":"runner"} : metadata.labels ?? {"dev-mcp.user":name.replace("dev-mcp-user-", "")} },
      HostConfig: {},
      Mounts: metadata.mounts ?? [],
      NetworkSettings: {Networks: entry ? state.entryNetworks : metadata.networks ?? {}},
      State: {Status:entry || primary ? "running" : state.containers[name], Running:entry || primary || state.containers[name] === "running", Health: {Status: "healthy"}},
    }]);
  }
} else if (args[0] === "image" && args[1] === "inspect") {
  output = "sha256:" + "f".repeat(64);
} else if (args[0] === "volume" && args[1] === "create") {
  state.volumes[name] = {Labels: labels()};
} else if (args[0] === "volume" && args[1] === "inspect") {
  code = state.volumes[name] ? 0 : 1;
  output = args.includes("--format") ? state.volumes[name]?.Labels?.["dev-mcp.user"] ?? "" : JSON.stringify([state.volumes[name]]);
} else if (args[0] === "volume" && args[1] === "ls") {
  output = Object.keys(state.volumes).join("\\n");
} else if (args[0] === "network" && args[1] === "inspect") {
  if (state.networks[name]) {
    output = args.includes("--format") ? state.networks[name].Labels?.["dev-mcp.user"] : JSON.stringify([state.networks[name]]);
  } else {
    code = 1;
  }
} else if (args[0] === "network" && args[1] === "create") {
  state.networks[name] = {Labels: labels(), Internal: args.includes("--internal")};
} else if (args[0] === "network" && args[1] === "ls") {
  const filter = args.find(arg => arg.startsWith("name=^"));
  output = filter && state.networks[filter.slice(6, -1)] ? "eeeeeeeeeeee" : "";
} else if (args[0] === "network" && ["connect", "disconnect"].includes(args[1])) {
  const networks = name === "dddddddddddd" ? state.entryNetworks : state.metadata[name]?.networks;
  if (networks) {
    if (args[1] === "connect") {
      networks[args.at(-2)] = {};
    } else {
      delete networks[args[2]];
    }
  }
} else if ((args[0] === "run" && args.includes("--detach")) || args[0] === "create") {
  const container = args[args.indexOf("--name") + 1];
  if (state.failNext) {
    delete state.failNext;
    code = 1;
  } else {
    state.containers[container] = args[0] === "create" ? "created" : "running";
    state.metadata[container] = {
      labels: labels(), networks: {[values("--network")[0] ?? "none"]: {}},
      mounts: values("--mount").map(value => {
        const fields = Object.fromEntries(value.split(",").map(field => field.includes("=") ? [field.slice(0, field.indexOf("=")), field.slice(field.indexOf("=") + 1)] : [field, true]));
        return { Type: fields.type, Source: fields.source, Name: fields.type === "volume" ? fields.source : undefined, Destination: fields.target, RW: !fields.readonly };
      }),
    };
  }
} else if (args[0] === "run" && args.includes("-p")) {
  output = args.at(-1).includes("process.getuid() +") ? process.getuid() + ":" + process.getgid() : JSON.stringify({uid: process.getuid(), gid: process.getgid()});
} else if (args[0] === "run" && args.includes("-e")) {
  const operation = args[args.indexOf("-e") + 2];
  output = { probe: "ok", mkdir: "created", verify: "ok", remove: "removed" }[operation] ?? "";
} else if (args[0] === "start" || args[0] === "restart") {
  state.containers[name] = "running";
} else if (args[0] === "stop") {
  state.containers[name] = "exited";
} else if (args[0] === "commit") {
  output = "sha256:" + "f".repeat(64);
} else if (args[0] === "rename") {
  const source = args[1];
  state.containers[name] = state.containers[source];
  state.metadata[name] = state.metadata[source];
  delete state.containers[source];
  delete state.metadata[source];
} else if (args[0] === "rm") {
  delete state.containers[name];
  delete state.metadata[name];
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
    run: (extraEnv: NodeJS.ProcessEnv = {}) =>
      execute(
        process.execPath,
        ["scripts/reconcile-user-runners.mjs", "--once"],
        {
          env: {
            ...process.env,
            // If the fake cannot execute (for example from a noexec temporary
            // directory), a real docker CLI must never reach a host daemon.
            DOCKER_HOST: "unix://" + path.join(directory, "no-docker.sock"),
            DOCKER_CONTEXT: "default",
            PATH: directory + path.delimiter + process.env.PATH,
            PROVISIONER_USERS_FILE: usersFile,
            FAKE_DOCKER_STATE: stateFile,
            RUNNER_STATUS_DIR: path.join(directory, "status"),
            WORKSPACE_SSH_ENABLED: "false",
            COMPOSE_PROJECT_NAME: "dev-mcp",
            ...extraEnv,
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
  const creation = state.calls.find((args: string[]) => args[0] === "create");
  expect(creation).toEqual(
    expect.arrayContaining([
      "dev-mcp.runtime=split",
      `type=volume,source=dev-mcp-user-${alice}-workspace,target=/workspace`,
      `type=volume,source=dev-mcp-user-${alice}-data,target=/var/lib/dev-mcp`,
      `type=bind,source=/host/user-ipc/${alice},target=/ipc`,
      `type=bind,source=/host/user-ipc/${alice}.key,target=/run/dev-mcp-ipc-key,readonly`,
      "sha256:" + "f".repeat(64),
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
    approved.calls.filter((args: string[]) => args[0] === "create"),
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

it("creates email-named containers and volumes while retaining UUID IPC and authorization", async () => {
  const f = await fixture([{ ...account(alice), email: "mina.kim@gmail.com" }]);
  await f.run();
  const state = await f.state();
  const named = "dev-mcp-user-mina.kim";
  expect(state.containers).toEqual({ [named]: "running" });
  expect(state.metadata[named].labels).toMatchObject({
    "dev-mcp.user": alice,
    "dev-mcp.name": "mina.kim",
  });
  const creation = state.calls.find((args: string[]) => args[0] === "create");
  expect(creation).toEqual(
    expect.arrayContaining([
      `type=volume,source=${named}-workspace,target=/workspace`,
      `type=volume,source=${named}-data,target=/var/lib/dev-mcp`,
      `type=bind,source=/host/user-ipc/${alice},target=/ipc`,
    ]),
  );
  await f.run();
  expect(
    (await f.state()).calls.filter((args: string[]) => args[0] === "create"),
  ).toHaveLength(1);
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
    state.calls.filter((args: string[]) => args[0] === "create"),
  ).toHaveLength(0);
});

it("migrates a disabled email account with an existing stop request without starting it", async () => {
  const f = await fixture([
    { ...account(alice, "disabled"), email: "adjustedmin@gmail.com" },
  ]);
  const legacy = "dev-mcp-user-" + alice;
  await writeFile(
    f.stateFile,
    JSON.stringify({
      calls: [],
      containers: { [legacy]: "created" },
      metadata: {
        [legacy]: {
          labels: { "dev-mcp.user": alice, "dev-mcp.runtime": "unified" },
          networks: { [legacy]: {} },
          mounts: [
            {
              Type: "volume",
              Name: legacy + "-workspace",
              Destination: "/workspace",
            },
            {
              Type: "volume",
              Name: legacy + "-data",
              Destination: "/var/lib/dev-mcp",
            },
          ],
        },
      },
      volumes: {
        [legacy + "-workspace"]: { Labels: {} },
        [legacy + "-data"]: { Labels: {} },
      },
    }),
  );
  await writeFile(
    path.join(path.dirname(f.usersFile), "runner-controls.json"),
    JSON.stringify({ entries: { [alice]: { revision: bob, action: "stop" } } }),
  );
  await f.run();
  const state = await f.state();
  expect(Object.keys(state.containers)).toEqual(["dev-mcp-user-adjustedmin"]);
  expect(["created", "exited"]).toContain(
    state.containers["dev-mcp-user-adjustedmin"],
  );
  expect(
    state.metadata["dev-mcp-user-adjustedmin"].labels["dev-mcp.keep-stopped"],
  ).toBe("true");
  expect(state.calls.some((args: string[]) => args[0] === "start")).toBe(false);
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

it("applies a restart once and does not replay an ambiguous operation after a controller restart", async () => {
  const f = await fixture([account(alice)]);
  await f.run();
  const request = {
    revision: bob,
    action: "restart",
    actorId: charlie,
    requestedAt: Date.now(),
  };
  const controlsFile = path.join(
    path.dirname(f.stateFile),
    "runner-controls.json",
  );
  const statusFile = path.join(path.dirname(f.stateFile), "status/status.json");
  await writeFile(
    controlsFile,
    JSON.stringify({ entries: { [alice]: request } }),
  );
  await f.run();
  await f.run();
  expect(
    (await f.state()).calls.filter((args: string[]) => args[0] === "restart"),
  ).toHaveLength(1);
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  expect(status.entries[alice].phase).toBe("applied");
  status.entries[alice].phase = "applying";
  await writeFile(statusFile, JSON.stringify(status));
  await f.run();
  expect(
    (await f.state()).calls.filter((args: string[]) => args[0] === "restart"),
  ).toHaveLength(1);
  expect(
    JSON.parse(await readFile(statusFile, "utf8")).entries[alice].phase,
  ).toBe("failed");
}, 30000);

it("mounts approved users' workspaces from the onboarding root", async () => {
  const fixtureData = await fixture([
    { ...account(alice), email: "alice@example.test" },
  ]);
  const directory = path.dirname(fixtureData.usersFile);
  await writeFile(
    path.join(directory, "installation.json"),
    JSON.stringify({ workspaceRoot: "/srv/workspaces" }),
  );
  await fixtureData.run();
  const creation = (await fixtureData.state()).calls.find(
    (args: string[]) => args[0] === "create",
  );
  expect(creation).toEqual(
    expect.arrayContaining([
      "type=bind,source=/srv/workspaces/alice,target=/workspace",
      "dev-mcp.workspace=host",
      "type=volume,source=dev-mcp-user-alice-data,target=/var/lib/dev-mcp",
    ]),
  );
  expect(creation).not.toContain(
    "type=volume,source=dev-mcp-user-alice-workspace,target=/workspace",
  );
  const statusDir = path.join(directory, "status");
  expect(
    JSON.parse(
      await readFile(path.join(statusDir, "workspace-dirs.json"), "utf8"),
    ),
  ).toEqual({ users: { [alice]: { root: "/srv/workspaces", name: "alice" } } });
  const status = JSON.parse(
    await readFile(path.join(statusDir, "status.json"), "utf8"),
  );
  expect(status.installation.workspaceRoot).toMatchObject({
    path: "/srv/workspaces",
    state: "ready",
  });
});

it("separates MCP and SSH with private authentication, homes and networks and no public ports", async () => {
  const f = await fixture([
    { ...account(alice), authVersion: 1 },
    account(bob, "pending"),
  ]);
  const dir = path.dirname(f.usersFile);
  const env = {
    WORKSPACE_SSH_ENABLED: "true",
    WORKSPACE_APPARMOR_PROFILE: "dev-mcp-workspace",
    SSH_ENTRY_DATA_DIR: path.join(dir, "entry"),
    WORKSPACE_AUTH_DIR: path.join(dir, "auth"),
  };
  await f.run(env);
  const state = await f.state();
  expect(state.containers).toEqual({
    ["dev-mcp-user-" + alice]: "running",
    ["dev-mcp-workspace-" + alice]: "running",
  });
  const workspace = state.calls.find(
    (args: string[]) =>
      args.includes("dev-mcp.role=workspace") && args[0] === "create",
  );
  expect(workspace).toEqual(
    expect.arrayContaining([
      "type=volume,source=dev-mcp-user-" +
        alice +
        "-workspace,target=/workspace",
      "type=volume,source=dev-mcp-workspace-auth,target=/run/dev-mcp-ssh,volume-subpath=" +
        alice +
        ",readonly",
      "SSH_WORKSPACE=true",
      "apparmor=dev-mcp-workspace",
      "systempaths=unconfined",
      "type=volume,source=dev-mcp-user-" +
        alice +
        "-home,target=/workspace/.dev-mcp-home",
    ]),
  );
  expect(workspace.join(" ")).not.toMatch(/docker.sock|gateway-data/);
  expect(workspace).not.toContain("--publish");
  const runner = state.calls.find(
    (args: string[]) =>
      args[0] === "create" && args.includes("dev-mcp-user-" + alice),
  );
  expect(runner).not.toContain("SSH_WORKSPACE=true");
  expect(runner).toContain("--read-only");
  expect(runner).toContain("--cap-drop");
  expect(runner).toContain("no-new-privileges:true");
  expect(runner).not.toContain("apparmor=dev-mcp-workspace");
  expect(runner).not.toContain("systempaths=unconfined");
  expect(runner).not.toContain("--privileged");
  expect(workspace).not.toContain("--privileged");
  expect(runner).toContain(
    "/workspace/.dev-mcp-home:ro,nosuid,nodev,noexec,mode=000",
  );
  expect(state.metadata["dev-mcp-user-" + alice].networks).not.toHaveProperty(
    "dev-mcp-ssh-" + alice,
  );
  const status = JSON.parse(
    await readFile(path.join(dir, "status/status.json"), "utf8"),
  );
  expect(status.workspaces[alice].state).toBe("running");
});

it("applies personal workspace requests once, preserves stop across reconciliations and never replays an ambiguous restart", async () => {
  const f = await fixture([{ ...account(alice), authVersion: 1 }]);
  const dir = path.dirname(f.usersFile);
  const env = {
    WORKSPACE_SSH_ENABLED: "true",
    SSH_ENTRY_DATA_DIR: path.join(dir, "entry"),
    WORKSPACE_AUTH_DIR: path.join(dir, "auth"),
  };
  await f.run(env);
  const controlsFile = path.join(dir, "workspace-controls.json");
  const statusFile = path.join(dir, "status/status.json");
  const request = {
    revision: bob,
    action: "restart",
    actorId: alice,
    requestedAt: Date.now(),
  };
  await writeFile(
    controlsFile,
    JSON.stringify({ entries: { [alice]: request } }),
  );
  await f.run(env);
  await f.run(env);
  expect(
    (await f.state()).calls.filter(
      (args: string[]) =>
        args[0] === "restart" && args.at(-1) === "dev-mcp-workspace-" + alice,
    ),
  ).toHaveLength(1);
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  status.workspaces[alice].phase = "applying";
  await writeFile(statusFile, JSON.stringify(status));
  await expect(f.run(env)).rejects.toMatchObject({ code: 1 });
  expect(
    JSON.parse(await readFile(statusFile, "utf8")).workspaces[alice].phase,
  ).toBe("failed");
  expect(
    (await f.state()).calls.filter((args: string[]) => args[0] === "restart"),
  ).toHaveLength(1);
  await writeFile(
    controlsFile,
    JSON.stringify({
      entries: { [alice]: { ...request, revision: charlie, action: "stop" } },
    }),
  );
  await f.run(env);
  await f.run(env);
  const state = await f.state();
  expect(state.containers["dev-mcp-user-" + alice]).toBe("running");
  expect(state.containers["dev-mcp-workspace-" + alice]).toBe("exited");
}, 30000);

it("stops and starts both containers, recovers a missing development container and applies paired restarts once", async () => {
  const f = await fixture([{ ...account(alice), authVersion: 1 }]);
  const dir = path.dirname(f.usersFile);
  const env = {
    WORKSPACE_SSH_ENABLED: "true",
    SSH_ENTRY_DATA_DIR: path.join(dir, "entry"),
    WORKSPACE_AUTH_DIR: path.join(dir, "auth"),
  };
  const statusFile = path.join(dir, "status/status.json");
  const control = async (action: string) => {
    const request = {
      revision: randomUUID(),
      action,
      actorId: bob,
      requestedAt: Date.now(),
    };
    await writeFile(
      path.join(dir, "runner-controls.json"),
      JSON.stringify({ entries: { [alice]: request } }),
    );
    return request;
  };
  const mcp = "dev-mcp-user-" + alice,
    development = "dev-mcp-workspace-" + alice;
  await f.run(env);
  await control("stop");
  await f.run(env);
  await f.run(env);
  expect((await f.state()).containers).toEqual({
    [mcp]: "exited",
    [development]: "exited",
  });
  await control("start");
  await f.run(env);
  expect((await f.state()).containers).toEqual({
    [mcp]: "running",
    [development]: "running",
  });
  const state = await f.state();
  delete state.containers[development];
  delete state.metadata[development];
  await writeFile(f.stateFile, JSON.stringify(state));
  const request = await control("restart");
  await f.run(env);
  await f.run(env);
  expect((await f.state()).containers).toEqual({
    [mcp]: "running",
    [development]: "running",
  });
  let status = JSON.parse(await readFile(statusFile, "utf8"));
  expect(status.entries[alice]).toMatchObject({
    revision: request.revision,
    runtimePhase: "applied",
  });
  expect(status.workspaces[alice]).toMatchObject({
    revision: request.revision,
    phase: "applied",
  });
  const missingMcp = await f.state();
  delete missingMcp.containers[mcp];
  delete missingMcp.metadata[mcp];
  await writeFile(f.stateFile, JSON.stringify(missingMcp));
  const restart = await control("restart");
  await f.run(env);
  await f.run(env);
  expect((await f.state()).containers).toEqual({
    [mcp]: "running",
    [development]: "running",
  });
  expect(
    (await f.state()).calls.filter(
      (args: string[]) => args[0] === "restart" && args.at(-1) === development,
    ),
  ).toHaveLength(1);
  status = JSON.parse(await readFile(statusFile, "utf8"));
  status.workspaces[alice].phase = "applying";
  await writeFile(statusFile, JSON.stringify(status));
  await expect(f.run(env)).rejects.toMatchObject({ code: 1 });
  status = JSON.parse(await readFile(statusFile, "utf8"));
  expect(status.entries[alice]).toMatchObject({
    revision: restart.revision,
    runtimePhase: "failed",
  });
  expect(
    (await f.state()).calls.filter(
      (args: string[]) => args[0] === "restart" && args.at(-1) === development,
    ),
  ).toHaveLength(1);
}, 60000);

it("treats stopping an environment with both containers absent as already stopped", async () => {
  const f = await fixture([{ ...account(alice), authVersion: 1 }]);
  const dir = path.dirname(f.usersFile);
  await writeFile(
    path.join(dir, "runner-controls.json"),
    JSON.stringify({
      entries: {
        [alice]: {
          revision: randomUUID(),
          actorId: bob,
          action: "stop",
          requestedAt: Date.now(),
        },
      },
    }),
  );
  await f.run({
    WORKSPACE_SSH_ENABLED: "true",
    SSH_ENTRY_DATA_DIR: path.join(dir, "entry"),
    WORKSPACE_AUTH_DIR: path.join(dir, "auth"),
  });
  const status = JSON.parse(
    await readFile(path.join(dir, "status/status.json"), "utf8"),
  );
  expect(status.entries[alice]).toMatchObject({
    state: "missing",
    runtimePhase: "applied",
  });
  expect(status.workspaces[alice]).toMatchObject({
    state: "missing",
    phase: "applied",
  });
  expect((await f.state()).containers).toEqual({});
});

it("adopts completed MCP-only controls on upgrade without restarting a stopped development container", async () => {
  const f = await fixture([{ ...account(alice), authVersion: 1 }]);
  const dir = path.dirname(f.usersFile);
  const env = {
    WORKSPACE_SSH_ENABLED: "true",
    SSH_ENTRY_DATA_DIR: path.join(dir, "entry"),
    WORKSPACE_AUTH_DIR: path.join(dir, "auth"),
  };
  await f.run(env);
  const mcp = "dev-mcp-user-" + alice;
  const development = "dev-mcp-workspace-" + alice;
  const request = {
    revision: randomUUID(),
    action: "restart",
    actorId: bob,
    requestedAt: 100,
  };
  const controlsFile = path.join(dir, "runner-controls.json");
  const statusFile = path.join(dir, "status/status.json");
  await writeFile(
    controlsFile,
    JSON.stringify({ entries: { [alice]: request } }),
  );
  const previous = JSON.parse(await readFile(statusFile, "utf8"));
  previous.entries[alice] = {
    ...previous.entries[alice],
    revision: request.revision,
    phase: "applied",
  };
  delete previous.entries[alice].runtimePhase;
  await writeFile(statusFile, JSON.stringify(previous));
  const state = await f.state();
  state.containers[development] = "exited";
  state.calls = [];
  await writeFile(f.stateFile, JSON.stringify(state));
  await f.run(env);
  await f.run(env);
  const adopted = await f.state();
  expect(adopted.containers).toEqual({
    [mcp]: "running",
    [development]: "exited",
  });
  expect(
    adopted.calls.filter((args: string[]) => args[0] === "restart"),
  ).toEqual([]);
  expect(
    JSON.parse(await readFile(statusFile, "utf8")).workspaces[alice],
  ).toMatchObject({
    revision: request.revision,
    phase: "applied",
    legacyRunnerOnly: true,
  });
  const next = { ...request, revision: randomUUID(), requestedAt: 200 };
  await writeFile(controlsFile, JSON.stringify({ entries: { [alice]: next } }));
  await f.run(env);
  await f.run(env);
  const applied = await f.state();
  expect(applied.containers).toEqual({
    [mcp]: "running",
    [development]: "running",
  });
  expect(
    applied.calls.filter((args: string[]) => args[0] === "restart"),
  ).toEqual([["restart", mcp]]);
  expect(
    applied.calls.filter(
      (args: string[]) => args[0] === "start" && args.at(-1) === development,
    ),
  ).toHaveLength(1);
  expect(
    JSON.parse(await readFile(statusFile, "utf8")).workspaces[alice],
  ).toMatchObject({
    revision: next.revision,
    phase: "applied",
    legacyRunnerOnly: false,
  });
}, 30000);

it("keeps a newer personal stop, accepts a subsequent admin start and never replays superseded controls after a crash", async () => {
  const f = await fixture([{ ...account(alice), authVersion: 1 }]);
  const dir = path.dirname(f.usersFile);
  const env = {
    WORKSPACE_SSH_ENABLED: "true",
    SSH_ENTRY_DATA_DIR: path.join(dir, "entry"),
    WORKSPACE_AUTH_DIR: path.join(dir, "auth"),
  };
  await f.run(env);
  const global = {
    revision: randomUUID(),
    actorId: bob,
    action: "start",
    requestedAt: 100,
  };
  const personal = {
    revision: randomUUID(),
    actorId: alice,
    action: "stop",
    requestedAt: 200,
  };
  await writeFile(
    path.join(dir, "runner-controls.json"),
    JSON.stringify({ entries: { [alice]: global } }),
  );
  await writeFile(
    path.join(dir, "workspace-controls.json"),
    JSON.stringify({ entries: { [alice]: personal } }),
  );
  await f.run(env);
  await f.run(env);
  expect((await f.state()).containers["dev-mcp-workspace-" + alice]).toBe(
    "exited",
  );
  await writeFile(
    path.join(dir, "runner-controls.json"),
    JSON.stringify({
      entries: {
        [alice]: { ...global, revision: randomUUID(), requestedAt: 300 },
      },
    }),
  );
  await f.run(env);
  await f.run(env);
  expect((await f.state()).containers["dev-mcp-workspace-" + alice]).toBe(
    "running",
  );
  const interrupted = {
    ...global,
    revision: randomUUID(),
    action: "restart",
    requestedAt: 400,
  };
  await writeFile(
    path.join(dir, "runner-controls.json"),
    JSON.stringify({ entries: { [alice]: interrupted } }),
  );
  const statusFile = path.join(dir, "status/status.json");
  const status = JSON.parse(await readFile(statusFile, "utf8"));
  status.entries[alice].revision = interrupted.revision;
  status.entries[alice].phase = "applying";
  await writeFile(statusFile, JSON.stringify(status));
  await expect(f.run(env)).rejects.toMatchObject({ code: 1 });
  expect((await f.state()).containers["dev-mcp-workspace-" + alice]).toBe(
    "running",
  );
  expect(
    JSON.parse(await readFile(statusFile, "utf8")).workspaces[alice],
  ).toMatchObject({ revision: interrupted.revision, phase: "failed" });
}, 60000);
