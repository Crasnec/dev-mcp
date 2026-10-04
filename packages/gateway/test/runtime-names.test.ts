import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunnerOperations } from "../../../scripts/runner-operations.mjs";
import {
  runtimeContainer,
  runtimeName,
  ownsRuntime,
} from "../../../scripts/runtime-names.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const user = { id, runner: id, status: "active", email: "Mina.Kim@gmail.com" };
const legacy = "dev-mcp-user-" + id;
const target = "dev-mcp-user-mina.kim";
const image = "sha256:" + "a".repeat(64);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "runtime-names-"));
  temporary.push(dir);
  const info = {
    Name: "/" + legacy,
    Config: { Labels: { "dev-mcp.user": id, "dev-mcp.runtime": "unified" } },
    HostConfig: { Memory: 512 * 1048576, NanoCpus: 500000000 },
    State: { Running: true, Status: "running" },
    NetworkSettings: { Networks: { [legacy]: {} } },
    Mounts: [
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
  };
  const containers = new Map<string, typeof info>([[legacy, info]]);
  const volumes = new Map<string, { Labels: Record<string, string> }>();
  const docker = vi.fn(async (...args: string[]) => {
    if (args[0] === "volume" && args[1] === "ls") {
      return [...volumes.keys()].join("\n");
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return JSON.stringify([volumes.get(args.at(-1)!)!]);
    }
    if (args[0] === "volume" && args[1] === "create") {
      const labels = Object.fromEntries(
        args.flatMap((arg, index) =>
          arg === "--label" ? [args[index + 1]!.split("=")] : [],
        ),
      );
      volumes.set(args.at(-1)!, { Labels: labels });
    }
    if (args[0] === "rename") {
      const current = containers.get(args[1]!)!;
      containers.delete(args[1]!);
      containers.set(args[2]!, { ...current, Name: "/" + args[2] });
    }
    if (args[0] === "rm") {
      containers.delete(args.at(-1)!);
    }
    if (args[0] === "commit") {
      return image;
    }
    return "";
  });
  const provision = vi.fn(async () => {
    containers.set(target, { ...info, Name: "/" + target });
  });
  const ops = new RunnerOperations(docker, provision, dir, "dev-mcp");
  vi.spyOn(ops, "inspect").mockImplementation(async (name) =>
    containers.get(name),
  );
  vi.spyOn(ops, "helperImage").mockResolvedValue(image);
  return { ops, docker, provision, info, containers, volumes };
}

it("uses the Google local part without numbered suffixes and keeps authorization IDs separate", () => {
  expect(runtimeName(user)).toBe("mina.kim");
  expect(runtimeContainer(user)).toBe(target);
  expect(runtimeContainer({ id })).toBe(legacy);
  expect(runtimeName({ id, email: "../../Bad+Tag@gmail.com" })).toBe("bad-tag");
  expect(() => runtimeName({ id: "../escape" })).toThrow();
  const named = {
    Name: "/" + target,
    Config: { Labels: { "dev-mcp.user": id, "dev-mcp.name": "mina.kim" } },
  };
  expect(ownsRuntime(user, named)).toBe(true);
  expect(
    ownsRuntime(user, { ...named, Name: "/" + target + "-previous" }),
  ).toBe(false);
  expect(
    ownsRuntime({ ...user, id: "00000000-0000-4000-8000-000000000002" }, named),
  ).toBe(false);
});

it("copies and verifies both volumes before replacing a running container, preserving its writable layer and limits", async () => {
  const f = await fixture();
  await f.ops.migrateNames(user);
  expect(f.docker).toHaveBeenCalledWith("stop", "--time", "10", legacy);
  expect(f.provision).toHaveBeenCalledWith(
    user,
    expect.objectContaining({ memoryMiB: 512, cpus: 0.5 }),
    false,
    false,
    undefined,
    false,
    image,
  );
  const copy = f.docker.mock.calls.filter((args) => args.includes("rsync"));
  expect(copy).toHaveLength(4);
  expect(copy[0]).toEqual(
    expect.arrayContaining([
      "0:0",
      "-aHAX",
      "--numeric-ids",
      `type=volume,source=${legacy}-workspace,target=/source,readonly`,
      `type=volume,source=${target}-workspace,target=/target`,
    ]),
  );
  expect(copy[1]).toContain("--dry-run");
  expect(f.docker).toHaveBeenCalledWith("commit", legacy);
  expect(f.docker).toHaveBeenCalledWith(
    "exec",
    target,
    "node",
    "-e",
    expect.any(String),
  );
  expect(f.docker).toHaveBeenLastCalledWith("rm", target + "-previous");
  expect(f.containers.has(legacy)).toBe(false);
  expect(f.containers.has(target)).toBe(true);
  expect(f.docker.mock.calls.flat()).not.toContain("--volumes");
});

it("does not start disabled or intentionally stopped accounts during naming migration", async () => {
  for (const status of ["active", "disabled"]) {
    const f = await fixture();
    f.info.State = { Running: false, Status: "exited" };
    await f.ops.migrateNames({ ...user, status });
    expect(f.provision.mock.calls[0]?.[5]).toBe(true);
    expect(f.docker.mock.calls.some((args) => args[0] === "start")).toBe(false);
  }
});

it("restores the previous container when startup verification fails", async () => {
  const f = await fixture();
  vi.spyOn(f.ops, "waitReady").mockRejectedValue(new Error("not ready"));
  await expect(f.ops.migrateNames(user)).rejects.toThrow("not ready");
  expect(f.containers.has(legacy)).toBe(true);
  expect(f.containers.has(target)).toBe(false);
  expect(f.docker).toHaveBeenLastCalledWith("start", legacy);
  expect(f.docker.mock.calls.flat()).not.toContain("--volumes");
});

it("keeps the completed destination authoritative after container deletion instead of recopying a stale original", async () => {
  const f = await fixture();
  await f.ops.migrateNames(user);
  f.containers.delete(target);
  f.volumes.set(legacy + "-workspace", { Labels: {} });
  f.volumes.set(legacy + "-data", { Labels: {} });
  f.docker.mockClear();
  await f.ops.migrateNames(user);
  expect(f.docker.mock.calls.some((args) => args.includes("rsync"))).toBe(
    false,
  );
});

it("leaves the original container in place when copying differs and safely retries with its own destination volumes", async () => {
  const f = await fixture();
  const actual = f.docker.getMockImplementation()!;
  f.docker.mockImplementation(async (...args) =>
    args.includes("--dry-run") ? "mismatch" : actual(...args),
  );
  await expect(f.ops.migrateNames(user)).rejects.toThrow("복사 검증");
  expect(f.provision).not.toHaveBeenCalled();
  expect(f.containers.has(legacy)).toBe(true);
  expect(f.docker).toHaveBeenLastCalledWith("start", legacy);
  f.docker.mockImplementation(actual);
  f.docker.mockClear();
  await expect(f.ops.migrateNames(user)).rejects.toThrow("새 운영 요청");
  await f.ops.migrateNames(user, { skipFailed: true });
  expect(f.docker.mock.calls.some((args) => args[0] === "stop")).toBe(false);
  await f.ops.migrateNames(user, { retry: true });
  expect(f.containers.has(target)).toBe(true);
});

it("rejects container and destination-volume collisions before stopping any jobs", async () => {
  const f = await fixture();
  f.containers.set(target, {
    ...f.info,
    Config: {
      Labels: { "dev-mcp.user": "someone-else", "dev-mcp.runtime": "unified" },
    },
  });
  await expect(f.ops.migrateNames(user)).rejects.toThrow("소유권");
  expect(f.docker).not.toHaveBeenCalled();
  f.containers.delete(target);
  f.volumes.set(target + "-workspace", {
    Labels: { "dev-mcp.user": "someone-else" },
  });
  await expect(f.ops.migrateNames(user)).rejects.toThrow("다른 계정");
  expect(f.docker.mock.calls.some((args) => args[0] === "stop")).toBe(false);
});
