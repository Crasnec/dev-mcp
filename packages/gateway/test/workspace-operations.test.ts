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
async function fixture(unified = true) {
  const dir = await directory();
  const name = "dev-mcp-user-" + id;
  const info = {
    Config: {
      Labels: {
        "dev-mcp.user": id,
        ...(unified ? { "dev-mcp.runtime": "unified" } : {}),
      },
    },
    HostConfig: {},
    Mounts: [
      { Type: "volume", Name: name + "-workspace", Destination: "/workspace" },
    ],
    State: { Running: true, Status: "running" },
    NetworkSettings: { Networks: { ["dev-mcp-ssh-" + id]: {} } },
  };
  const docker = vi.fn(async () => "");
  const provision = vi.fn(async () => {});
  const runners = new RunnerOperations(docker, provision, dir, "dev-mcp");
  vi.spyOn(runners, "inspect").mockResolvedValue(undefined);
  vi.spyOn(runners, "owned").mockResolvedValue({ name, info });
  const operations = new WorkspaceOperations(docker, runners, {}, "dev-mcp");
  vi.spyOn(operations, "network").mockResolvedValue("dev-mcp-ssh-" + id);
  return { dir, name, info, docker, provision, runners, operations };
}
it("uses the account runner for SSH and preserves intentionally stopped containers", async () => {
  const f = await fixture();
  expect(await f.operations.owned(user)).toEqual({
    name: f.name,
    info: f.info,
  });
  expect(
    await f.operations.beforeRunnerOperation(user, { action: "workspace" }),
  ).toBe(false);
  f.info.State.Running = false;
  f.info.State.Status = "exited";
  await f.operations.sync(user);
  expect(f.docker).not.toHaveBeenCalled();
});
it("rolls back failed migration and keeps data volumes", async () => {
  const f = await fixture(false);
  f.provision.mockRejectedValue(new Error("create failed"));
  await expect(f.operations.sync(user)).rejects.toThrow("create failed");
  expect(f.docker).toHaveBeenCalledWith("rename", f.name, f.name + "-previous");
  expect(f.docker).toHaveBeenCalledWith("rename", f.name + "-previous", f.name);
  expect(f.docker).toHaveBeenCalledWith("start", f.name);
  expect(f.docker.mock.calls.flat()).not.toContain("--volumes");
});
it("never starts disabled accounts and rejects requests for another owner", async () => {
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
  await expect(
    f.operations.apply(user, { ...request, actorId: randomUUID() }),
  ).rejects.toThrow("Invalid workspace request");
  expect(f.docker).not.toHaveBeenCalled();
  expect(validWorkspaceControl({ ...request, action: "exec" })).toBe(false);
});
it("attaches SSH using the existing destination alias without enabling Internet access", async () => {
  const f = await fixture();
  f.info.NetworkSettings.Networks = {};
  await f.operations.sync(user);
  expect(f.docker).toHaveBeenCalledWith(
    "network",
    "connect",
    "--alias",
    workspaceContainer(id),
    "dev-mcp-ssh-" + id,
    f.name,
  );
  expect(f.docker.mock.calls.some((call) => call[0] === "start")).toBe(false);
});
it("rejects a legacy workspace belonging to another user before migration", async () => {
  const f = await fixture(false);
  vi.mocked(f.runners.inspect).mockResolvedValue({
    Config: {
      Labels: { "dev-mcp.user": randomUUID(), "dev-mcp.role": "workspace" },
    },
  });
  await expect(f.operations.sync(user)).rejects.toThrow("ownership mismatch");
  expect(f.provision).not.toHaveBeenCalled();
});
it("preserves an active owner's stopped state after migrating to a created replacement", async () => {
  const f = await fixture(false);
  f.info.State.Running = false;
  f.info.State.Status = "exited";
  f.provision.mockImplementationOnce(async () => {
    f.info.Config.Labels["dev-mcp.runtime"] = "unified";
    f.info.Config.Labels["dev-mcp.keep-stopped"] = "true";
    f.info.State.Status = "created";
  });
  await f.operations.sync(user);
  await f.operations.sync(user);
  expect(f.provision.mock.calls[0]?.[5]).toBe(true);
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
