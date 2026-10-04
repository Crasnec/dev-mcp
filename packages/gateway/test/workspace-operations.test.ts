import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { RunnerOperations } from "../../../scripts/runner-operations.mjs";
import {
  WorkspaceOperations,
  validWorkspaceControl,
} from "../../../scripts/workspace-operations.mjs";
import { SshRegistry } from "../../../scripts/ssh-registry.mjs";
import {
  parseSshPublicKey,
  sshLogin,
  workspaceContainer,
} from "../../../scripts/ssh-access.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const user = { id, runner: id, status: "active", authVersion: 1 };
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "workspace-ops-"));
  temporary.push(dir);
  return dir;
}
async function fixture() {
  const dir = await directory();
  const name = workspaceContainer(id);
  const info = {
    Config: {
      Labels: {
        "dev-mcp.user": id,
        "dev-mcp.role": "workspace",
        "dev-mcp.runtime": "split",
        "dev-mcp.workspace-source": "original",
      },
    },
    HostConfig: {},
    State: { Running: true, Status: "running" },
    NetworkSettings: { Networks: { ["dev-mcp-ssh-" + id]: {} } },
  };
  const docker = vi.fn(async () => "");
  const runners = new RunnerOperations(docker, vi.fn(), dir, "dev-mcp");
  vi.spyOn(runners, "inspect").mockResolvedValue(undefined);
  vi.spyOn(runners, "owned").mockResolvedValue({
    name: "dev-mcp-user-" + id,
    info,
  });
  const operations = new WorkspaceOperations(docker, runners, {}, "dev-mcp");
  vi.spyOn(operations, "owned").mockResolvedValue({ name, info });
  return { dir, name, info, docker, runners, operations };
}
const limits = {
  memoryMiB: 0,
  cpus: 0,
  pids: 0,
  fileSizeMiB: 0,
  network: false,
};
it("stops VS Code writes before storage copying and preserves already stopped workspaces", async () => {
  const f = await fixture();
  expect(
    await f.operations.beforeRunnerOperation(user, { action: "workspace" }),
  ).toBe(true);
  expect(f.docker).toHaveBeenCalledWith("stop", "--time", "10", f.name);
  f.docker.mockClear();
  f.info.State.Running = false;
  expect(
    await f.operations.beforeRunnerOperation(user, {
      action: "apply",
      limits: { ...limits, storageMiB: 1024 },
    }),
  ).toBe(false);
  expect(f.docker).not.toHaveBeenCalled();
  f.info.State.Running = true;
  expect(
    await f.operations.beforeRunnerOperation(user, {
      action: "apply",
      limits: { ...limits, memoryMiB: 512, storageMiB: 0 },
    }),
  ).toBe(false);
});
it("rolls back failed workspace replacement without deleting data volumes", async () => {
  const f = await fixture();
  vi.spyOn(f.operations, "template").mockResolvedValue({
    workspace: "mount",
    source: "new-source",
    limits,
  });
  vi.spyOn(f.operations, "create").mockRejectedValue(
    new Error("create failed"),
  );
  await expect(f.operations.sync(user)).rejects.toThrow("create failed");
  expect(f.docker).toHaveBeenCalledWith("rename", f.name, f.name + "-previous");
  expect(f.docker).toHaveBeenCalledWith("rename", f.name + "-previous", f.name);
  expect(f.docker).toHaveBeenCalledWith("start", f.name);
  expect(f.docker.mock.calls.flat()).not.toContain("--volumes");
});
it("never starts disabled accounts and rejects container and work-volume ownership mismatches", async () => {
  const f = await fixture();
  const request = {
    revision: randomUUID(),
    actorId: id,
    action: "start",
    requestedAt: Date.now(),
  };
  await expect(
    f.operations.apply({ ...user, status: "disabled" }, request),
  ).rejects.toThrow("승인");
  expect(f.docker).not.toHaveBeenCalled();
  await expect(
    f.operations.apply(user, { ...request, actorId: randomUUID() }),
  ).rejects.toThrow("Invalid workspace request");
  expect(f.docker).not.toHaveBeenCalled();
  vi.mocked(f.runners.owned).mockResolvedValue({
    name: "runner",
    info: {
      ...f.info,
      Mounts: [
        {
          Type: "volume",
          Name: "another-user-workspace",
          Destination: "/workspace",
        },
      ],
    },
  });
  await expect(f.operations.template(user)).rejects.toThrow("전용 작업 볼륨");
  vi.mocked(f.runners.inspect).mockResolvedValue({
    ...f.info,
    Config: {
      Labels: { "dev-mcp.user": "another-user", "dev-mcp.role": "workspace" },
    },
  });
  const operations = new WorkspaceOperations(
    f.docker,
    f.runners,
    {},
    "dev-mcp",
  );
  await expect(operations.owned(user)).rejects.toThrow("소유권");
  expect(validWorkspaceControl({ ...request, action: "exec" })).toBe(false);
  expect(validWorkspaceControl({ ...request, actorId: "../bad" })).toBe(false);
});
it("keeps the SSH management network when Internet access is blocked", async () => {
  const f = await fixture();
  f.info.Config.Labels["dev-mcp.workspace-source"] = "original";
  f.info.NetworkSettings.Networks["dev-mcp-user-" + id] = {};
  vi.spyOn(f.operations, "template").mockResolvedValue({
    workspace: "mount",
    source: "original",
    limits,
  });
  vi.spyOn(f.operations, "network").mockResolvedValue("dev-mcp-ssh-" + id);
  await f.operations.sync(user);
  expect(f.docker).toHaveBeenCalledWith(
    "network",
    "disconnect",
    "dev-mcp-user-" + id,
    f.name,
  );
  expect(f.docker).not.toHaveBeenCalledWith(
    "network",
    "disconnect",
    "dev-mcp-ssh-" + id,
    f.name,
  );
  expect(f.docker.mock.calls.some((call) => call[0] === "start")).toBe(false);
});
it("publishes only an owner's exact destination and clears revoked or deleted accounts", async () => {
  const dir = await directory();
  const registry = new SshRegistry(
    path.join(dir, "entry"),
    path.join(dir, "auth"),
  );
  await registry.init();
  await registry.prepare(user, process.getuid!(), process.getgid!());
  const bytes = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  const parsed = parseSshPublicKey(
    "ssh-ed25519 " +
      Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        bytes,
      ]).toString("base64"),
  );
  const entries = {
    [id]: {
      revision: randomUUID(),
      authVersion: 1,
      keys: [
        { id: randomUUID(), name: "laptop", ...parsed, createdAt: Date.now() },
      ],
    },
  };
  await registry.sync([user], { entries });
  const entryKey = path.join(dir, "entry/keys", sshLogin(id));
  expect(await readFile(entryKey, "utf8")).toContain(
    `restrict,port-forwarding,permitopen="${workspaceContainer(id)}:2222"`,
  );
  const auth = path.join(dir, "auth", id);
  expect(
    JSON.parse(await readFile(path.join(auth, "access.json"), "utf8")).enabled,
  ).toBe(true);
  await registry.sync([{ ...user, authVersion: 2 }], { entries });
  expect(await readFile(entryKey, "utf8")).toBe("");
  expect(await readFile(path.join(auth, "authorized_keys"), "utf8")).toBe("");
  expect(
    JSON.parse(await readFile(path.join(auth, "access.json"), "utf8")).enabled,
  ).toBe(false);
  await registry.sync([], { entries });
  expect(await readFile(path.join(dir, "entry/passwd"), "utf8")).not.toContain(
    sshLogin(id),
  );
  await expect(registry.sync(undefined, { entries })).rejects.toThrow();
});
