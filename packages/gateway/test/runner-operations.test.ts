import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RunnerOperations,
  validControl,
} from "../../../scripts/runner-operations.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const user = { id, runner: id, status: "active" };
const name = "dev-mcp-user-" + id;
const defaults = {
  network: true,
  memoryMiB: 0,
  cpus: 0,
  pids: 0,
  fileSizeMiB: 0,
  storageMiB: 0,
};
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runner-ops-"));
  temporary.push(directory);
  const info = {
    Config: { Labels: { "dev-mcp.user": id } },
    HostConfig: {},
    State: { Running: true, Status: "running" },
    NetworkSettings: { Networks: { [name]: {} } },
    Mounts: [],
  };
  const docker = vi.fn(async () => "");
  const provision = vi.fn(async () => {});
  const ops = new RunnerOperations(docker, provision, directory, "dev-mcp");
  vi.spyOn(ops, "owned").mockResolvedValue({ name, info });
  vi.spyOn(ops, "inspect").mockResolvedValue(undefined);
  return { ops, docker, provision, info };
}
it("validates the privileged worker's input independently of the web form", () => {
  const request = { revision: id, action: "apply", limits: defaults };
  expect(validControl(request)).toBe(true);
  for (const limits of [
    { ...defaults, memoryMiB: "512;id" },
    { ...defaults, network: "false" },
    { ...defaults, storageMiB: 102401 },
    { ...defaults, cpus: -1 },
  ]) {
    expect(validControl({ ...request, limits })).toBe(false);
  }
  expect(validControl({ ...request, action: "exec" })).toBe(false);
});
it("applies live memory/CPU/PID and network limits without restarting jobs", async () => {
  const { ops, docker, provision } = await fixture();
  await ops.apply(
    user,
    {
      action: "apply",
      limits: {
        ...defaults,
        memoryMiB: 512,
        cpus: 0.5,
        pids: 64,
        network: false,
      },
    },
    "primary",
  );
  expect(docker).toHaveBeenCalledWith(
    "update",
    "--memory",
    "536870912",
    "--memory-swap",
    "536870912",
    "--cpus",
    "0.5",
    "--pids-limit",
    "64",
    name,
  );
  expect(docker).toHaveBeenCalledWith("network", "disconnect", name, name);
  expect(docker.mock.calls.some((args) => args[0] === "stop")).toBe(false);
  expect(provision).not.toHaveBeenCalled();
});
it("preserves original container and volumes if quota migration fails", async () => {
  const { ops, docker, provision } = await fixture();
  vi.spyOn(ops, "quota").mockRejectedValue(new Error("disk full"));
  await expect(
    ops.apply(
      user,
      { action: "apply", limits: { ...defaults, storageMiB: 1024 } },
      "primary",
    ),
  ).rejects.toThrow("disk full");
  expect(docker).toHaveBeenCalledWith("stop", "--time", "10", name);
  expect(
    docker.mock.calls.some((args) =>
      ["rm", "rename"].includes(String(args[0])),
    ),
  ).toBe(false);
  expect(provision).not.toHaveBeenCalled();
});
it("restores the original container name if replacement creation fails", async () => {
  const { ops, docker, provision } = await fixture();
  provision.mockRejectedValue(new Error("create failed"));
  await expect(
    ops.apply(
      user,
      { action: "apply", limits: { ...defaults, fileSizeMiB: 64 } },
      "primary",
    ),
  ).rejects.toThrow("create failed");
  expect(docker).toHaveBeenCalledWith("rename", name, name + "-previous");
  expect(docker).toHaveBeenCalledWith("rename", name + "-previous", name);
  expect(docker.mock.calls.flat()).not.toContain("--volumes");
});
it("does not restart stopped users when changing a file-size limit", async () => {
  const { ops, docker, provision, info } = await fixture();
  info.State = { Running: false, Status: "exited" };
  const limits = { ...defaults, fileSizeMiB: 64 };
  await ops.apply(user, { action: "apply", limits }, "primary");
  expect(provision).toHaveBeenCalledWith(user, limits, false, false);
  expect(docker.mock.calls.some((args) => args[0] === "start")).toBe(false);
});
it("rejects resource operations on a container labelled for another user", async () => {
  const { docker, provision, info } = await fixture();
  info.Config.Labels["dev-mcp.user"] = "another-user";
  const ops = new RunnerOperations(docker, provision, "unused", "dev-mcp");
  vi.spyOn(ops, "inspect").mockResolvedValue(info);
  await expect(ops.apply(user, { action: "stop" }, "primary")).rejects.toThrow(
    "소유권",
  );
  expect(docker).not.toHaveBeenCalled();
});
it("does not start disabled accounts or migrate the primary host workspace", async () => {
  const { ops, docker } = await fixture();
  await expect(
    ops.apply({ ...user, status: "disabled" }, { action: "start" }, "primary"),
  ).rejects.toThrow("승인");
  await expect(
    ops.apply(
      { ...user, runner: "primary" },
      { action: "apply", limits: { ...defaults, storageMiB: 1024 } },
      "primary",
    ),
  ).rejects.toThrow("호스트 공유");
  expect(docker).not.toHaveBeenCalled();
});
