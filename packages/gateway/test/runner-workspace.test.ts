import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RunnerOperations,
  validControl,
  validWorkspaceRoot,
  workspaceNames,
} from "../../../scripts/runner-operations.mjs";

const id = "00000000-0000-4000-8000-000000000001";
const user = {
  id,
  runner: id,
  status: "active",
  email: "Mina.Kim@example.test",
};
const name = "dev-mcp-user-" + id;
const root = "/srv/dev-mcp/workspaces";
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

type Answers = {
  probe?: string;
  mkdir?: (name: string) => string;
  verify?: string;
  volumes?: string;
  primary?: string | null;
  fail?: (args: string[]) => boolean;
};
const primaryWorkspace = "/home/me/workspace";
async function fixture(
  answers: Answers = {},
  workspaceRoot: string | null = root,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runner-workspace-"));
  temporary.push(directory);
  const installationFile = path.join(directory, "installation.json");
  await writeFile(installationFile, JSON.stringify({ workspaceRoot }));
  const info = {
    Config: { Labels: { "dev-mcp.user": id } as Record<string, string> },
    HostConfig: {},
    State: { Running: true, Status: "running" },
    NetworkSettings: { Networks: { [name]: {} } },
    Mounts: [
      {
        Type: "volume",
        Name: name + "-workspace",
        Destination: "/workspace",
      },
    ] as Record<string, string>[],
  };
  const docker = vi.fn(async (...args: string[]) => {
    if (answers.fail?.(args)) {
      throw new Error("docker failed");
    }
    if (args[0] === "inspect" && args[1] === "--format") {
      return "sha256:runner-image";
    }
    if (args[0] === "inspect") {
      const source =
        answers.primary === undefined ? primaryWorkspace : answers.primary;
      return JSON.stringify([
        {
          Mounts: source
            ? [{ Type: "bind", Source: source, Destination: "/workspace" }]
            : [],
        },
      ]);
    }
    if (args[0] === "volume" && args[1] === "ls") {
      return answers.volumes ?? "";
    }
    if (args[0] === "run" && args.includes("-e")) {
      const index = args.indexOf("-e");
      const [operation, target] = [args[index + 2], args[index + 3]];
      return operation === "probe"
        ? (answers.probe ?? "ok")
        : operation === "mkdir"
          ? (answers.mkdir?.(target!) ?? "created")
          : operation === "verify"
            ? (answers.verify ?? "ok")
            : "removed";
    }
    return "";
  });
  const provision = vi.fn(async () => {});
  const ops = new RunnerOperations(
    docker,
    provision,
    directory,
    "dev-mcp",
    installationFile,
  );
  vi.spyOn(ops, "owned").mockResolvedValue({ name, info });
  vi.spyOn(ops, "inspect").mockResolvedValue(undefined);
  const registry = async () =>
    JSON.parse(
      await readFile(path.join(directory, "workspace-dirs.json"), "utf8"),
    );
  const helperCalls = (operation: string) =>
    docker.mock.calls.filter(
      (args) => args[0] === "run" && args[args.indexOf("-e") + 2] === operation,
    );
  return { ops, docker, provision, info, directory, registry, helperCalls };
}
const hostInfo = (info: { Mounts: Record<string, string>[] }, dir: string) => {
  info.Mounts = [{ Type: "bind", Source: dir, Destination: "/workspace" }];
};

it("validates workspace roots, names and requests in the privileged worker", () => {
  for (const value of [root, "/home/user/workspace", "/a"]) {
    expect(validWorkspaceRoot(value)).toBe(true);
  }
  for (const value of [
    "",
    "/",
    "relative",
    "/a/",
    "/a//b",
    "/a/../b",
    "/a,b",
    "/a\nb",
    7,
  ]) {
    expect(validWorkspaceRoot(value)).toBe(false);
  }
  const revision = id;
  expect(
    validControl({
      revision,
      action: "workspace",
      workspace: { name: "mina" },
    }),
  ).toBe(true);
  for (const workspaceName of [
    "",
    "../etc",
    "Mina",
    ".hidden",
    "a/b",
    "a,b",
    "x".repeat(65),
  ]) {
    expect(
      validControl({
        revision,
        action: "workspace",
        workspace: { name: workspaceName },
      }),
    ).toBe(false);
  }
  expect(validControl({ revision, action: "workspace" })).toBe(false);
});

it("derives readable, collision-tolerant directory names from the account email", () => {
  expect(workspaceNames(user).slice(0, 3)).toEqual([
    "mina.kim",
    "mina.kim-2",
    "mina.kim-3",
  ]);
  expect(workspaceNames({ id, email: "--Ünïcode+tag@example.test" })[0]).toBe(
    "n-code-tag",
  );
  expect(workspaceNames({ id })[0]).toBe("user-00000000");
  expect(workspaceNames({ id, email: "x".repeat(80) + "@a" })[0]).toHaveLength(
    32,
  );
});

it("creates new runners in an exclusive host directory under a verified root", async () => {
  const { ops, provision, registry, helperCalls, docker } = await fixture({
    mkdir: (target) => (target === "mina.kim" ? "exists" : "created"),
  });
  await ops.create(user, undefined, "primary-id");
  const dir = root + "/mina.kim-2";
  expect(provision).toHaveBeenCalledWith(user, undefined, false, false, dir);
  expect(await registry()).toEqual({
    users: { [id]: { root, name: "mina.kim-2" } },
  });
  expect(helperCalls("verify")).toHaveLength(1);
  // Helpers run unprivileged from the runner image with only the root mounted.
  const helper = helperCalls("mkdir")[0]!;
  expect(helper).toEqual(
    expect.arrayContaining([
      "--rm",
      "--read-only",
      "ALL",
      "no-new-privileges:true",
      `type=bind,source=${root},target=/workspace-root`,
      "sha256:runner-image",
    ]),
  );
  expect(helper).not.toContain("--privileged");
  expect(helper).not.toContain("--user");
  expect(docker).toHaveBeenCalledWith("start", name);
});

it("keeps an existing workspace volume instead of hiding its data", async () => {
  const { ops, provision, helperCalls } = await fixture({
    volumes: name + "-workspace",
  });
  await ops.create(user, undefined, "primary-id");
  expect(provision).toHaveBeenCalledWith(
    user,
    undefined,
    false,
    false,
    undefined,
  );
  expect(helperCalls("mkdir")).toHaveLength(0);
});

it("does not fall back to volumes while a configured root is unusable", async () => {
  const { ops, provision } = await fixture({ probe: "not_writable" });
  await expect(ops.create(user, undefined, "primary-id")).rejects.toThrow(
    "작업 공간 루트",
  );
  expect(provision).not.toHaveBeenCalled();
});

it("keeps volume behaviour when no root is configured", async () => {
  const { ops, provision, helperCalls } = await fixture({}, null);
  await ops.create(user, undefined, "primary-id");
  expect(provision).toHaveBeenCalledWith(
    user,
    undefined,
    false,
    false,
    undefined,
  );
  expect(helperCalls("probe")).toHaveLength(0);
});

it("keeps host directories across recreation and rejects storage quotas", async () => {
  const { ops, provision, info, helperCalls } = await fixture();
  const dir = root + "/mina";
  await ops.recordWorkspace(user, { root, name: "mina" });
  hostInfo(info, dir);
  const limits = {
    network: true,
    memoryMiB: 0,
    cpus: 0,
    pids: 0,
    fileSizeMiB: 64,
    storageMiB: 0,
  };
  await ops.apply(user, { action: "apply", limits }, "primary-id");
  expect(provision).toHaveBeenCalledWith(user, limits, false, false, dir);
  expect(helperCalls("verify")).toHaveLength(1);
  await expect(
    ops.apply(
      user,
      { action: "apply", limits: { ...limits, storageMiB: 1024 } },
      "primary-id",
    ),
  ).rejects.toThrow("저장공간 상한");
});

it("refuses to start a host workspace that is no longer a plain owned directory", async () => {
  const { ops, docker, info } = await fixture({ verify: "invalid" });
  await ops.recordWorkspace(user, { root, name: "mina" });
  hostInfo(info, root + "/mina");
  await expect(
    ops.apply(user, { action: "restart" }, "primary-id"),
  ).rejects.toThrow("실제 디렉터리");
  expect(docker.mock.calls.some((args) => args[0] === "restart")).toBe(false);
  hostInfo(info, "/elsewhere");
  await expect(
    ops.apply(user, { action: "start" }, "primary-id"),
  ).rejects.toThrow("일치하지");
});

it("moves a volume workspace to a host directory and keeps the original volume", async () => {
  const { ops, docker, provision, registry } = await fixture();
  await ops.apply(
    user,
    { action: "workspace", workspace: { name: "mina" } },
    "primary-id",
  );
  const dir = root + "/mina";
  const sequence = docker.mock.calls
    .map((args) =>
      args[0] === "run"
        ? args.includes("cp")
          ? "copy"
          : "helper:" + args[args.indexOf("-e") + 2]
        : args[0],
    )
    .filter((step) => step !== "inspect");
  expect(sequence).toEqual([
    "helper:probe",
    "helper:mkdir",
    "stop",
    "copy",
    "helper:verify",
    "rename",
    "start",
    "rm",
  ]);
  const copy = docker.mock.calls.find((args) => args.includes("cp"))!;
  expect(copy).toEqual(
    expect.arrayContaining([
      `type=volume,source=${name}-workspace,target=/source,readonly`,
      `type=bind,source=${dir},target=/target`,
      "-a",
      "/source/.",
      "/target/",
    ]),
  );
  expect(provision).toHaveBeenCalledWith(
    user,
    expect.objectContaining({ storageMiB: 0, network: true }),
    false,
    false,
    dir,
  );
  expect(docker).toHaveBeenCalledWith("rm", name + "-previous");
  expect(docker.mock.calls.flat()).not.toContain("--volumes");
  expect(await registry()).toEqual({ users: { [id]: { root, name: "mina" } } });
});

it("restores the previous container and removes the new directory when a move fails", async () => {
  const { ops, docker, provision, directory, helperCalls } = await fixture();
  provision.mockRejectedValueOnce(new Error("create failed"));
  await expect(
    ops.apply(
      user,
      { action: "workspace", workspace: { name: "mina" } },
      "primary-id",
    ),
  ).rejects.toThrow("create failed");
  expect(docker).toHaveBeenCalledWith("rm", "--force", name);
  expect(docker).toHaveBeenCalledWith("rename", name + "-previous", name);
  expect(helperCalls("remove")).toHaveLength(1);
  expect(docker).toHaveBeenLastCalledWith("start", name);
  await expect(
    readFile(path.join(directory, "workspace-dirs.json"), "utf8"),
  ).rejects.toThrow();
});

it("rejects moves for the primary, quota and existing host workspaces and taken names", async () => {
  const request = { action: "workspace", workspace: { name: "mina" } };
  const { ops, info } = await fixture({ mkdir: () => "exists" });
  await expect(
    ops.apply({ ...user, runner: "primary" }, request, "primary-id"),
  ).rejects.toThrow("기본 환경");
  await expect(ops.apply(user, request, "primary-id")).rejects.toThrow(
    "다른 이름",
  );
  info.Config.Labels["dev-mcp.storage"] = "quota";
  await expect(ops.apply(user, request, "primary-id")).rejects.toThrow(
    "저장공간 상한",
  );
  delete info.Config.Labels["dev-mcp.storage"];
  hostInfo(info, root + "/mina");
  await expect(ops.apply(user, request, "primary-id")).rejects.toThrow(
    "이미 호스트",
  );
});

it("reports the workspace mode and host path in observations", async () => {
  const { ops, info } = await fixture();
  expect(await ops.observe(user, "primary-id")).toMatchObject({
    workspaceMode: "volume",
  });
  hostInfo(info, root + "/mina");
  expect(await ops.observe(user, "primary-id")).toMatchObject({
    workspaceMode: "host",
    workspaceHostPath: root + "/mina",
  });
});

it("keeps the primary runner's workspace out of every workspace root", async () => {
  const { ops, helperCalls } = await fixture();
  await ops.probeRoot("primary-id");
  // The primary workspace is mounted read-only only for the mount comparison.
  expect(helperCalls("probe")[0]).toEqual(
    expect.arrayContaining([
      `type=bind,source=${root},target=/workspace-root`,
      `type=bind,source=${primaryWorkspace},target=/primary-workspace,readonly`,
    ]),
  );
  const inside = await fixture({ probe: "inside_primary" });
  expect(await inside.ops.probeRoot("primary-id")).toMatchObject({
    state: "invalid",
    message: expect.stringContaining("기본 실행 환경의 작업 공간"),
  });
  await expect(
    inside.ops.create(user, undefined, "primary-id"),
  ).rejects.toThrow("작업 공간 루트");
  expect(inside.provision).not.toHaveBeenCalled();
  expect(inside.helperCalls("mkdir")).toHaveLength(0);
  const unclear = await fixture({ primary: "/home/me/a,b" });
  expect(await unclear.ops.probeRoot("primary-id")).toMatchObject({
    state: "invalid",
    message: expect.stringContaining("확인할 수 없어"),
  });
  expect(unclear.helperCalls("probe")).toHaveLength(0);
});

it("refuses to start a host workspace that has become visible to the primary runner", async () => {
  const { ops, docker, info } = await fixture({ verify: "inside_primary" });
  await ops.recordWorkspace(user, { root, name: "mina" });
  info.Mounts = [
    { Type: "bind", Source: root + "/mina", Destination: "/workspace" },
  ];
  await expect(
    ops.apply(user, { action: "start" }, "primary-id"),
  ).rejects.toThrow("기본 실행 환경의 작업 공간 안");
  expect(docker.mock.calls.some((args) => args[0] === "start")).toBe(false);
});
