import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { splitRuntime } from "../../../scripts/split-runtime.mjs";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(running = true) {
  const statusDir = await mkdtemp(path.join(os.tmpdir(), "runtime-split-"));
  temporary.push(statusDir);
  const user = {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    email: "developer@example.test",
    status: "active",
  };
  const name = "dev-mcp-user-developer";
  const info = {
    Config: {
      Labels: { "dev-mcp.user": user.id, "dev-mcp.runtime": "unified" },
    },
    State: { Running: running },
    Mounts: [],
  };
  const image = "sha256:" + "a".repeat(64);
  const docker = vi.fn(async (...args) => (args[0] === "commit" ? image : ""));
  const runners = {
    statusDir,
    owned: vi.fn(async () => ({ name, info })),
    inspect: vi.fn(async () => undefined),
    helperImage: vi.fn(async () => image),
    limits: vi.fn(() => ({ network: true })),
    provision: vi.fn(async () => {}),
    waitReady: vi.fn(async () => {}),
  };
  const workspaces = {
    runners,
    docker,
    template: vi.fn(async () => ({
      workspace: "type=volume,source=work,target=/workspace",
      home: "home",
      gitAuth: "git-auth",
    })),
    prepareStorage: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
  };
  return { statusDir, user, name, info, image, docker, runners, workspaces };
}

it("keeps the developer snapshot out of MCP provisioning and waits for both replacements before retiring the old container", async () => {
  const f = await fixture();
  await splitRuntime(f.workspaces, f.user);
  expect(f.runners.provision).toHaveBeenCalledWith(
    f.user,
    { network: true },
    false,
    false,
    "",
    false,
  );
  expect(f.workspaces.create).toHaveBeenCalledWith(
    f.user,
    expect.any(Object),
    false,
    f.image,
  );
  expect(f.runners.waitReady).toHaveBeenCalledWith(f.name);
  expect(f.docker).toHaveBeenCalledWith("rm", f.name + "-before-split");
  expect(f.docker.mock.calls.flat()).not.toContain("--volumes");
  const journal = JSON.parse(
    await readFile(path.join(f.statusDir, "runtime-splits.json"), "utf8"),
  );
  expect(journal.users[f.user.id].phase).toBe("ready");
});

it.each(["active", "disabled"])(
  "preserves stopped containers for a %s account",
  async (status) => {
    const f = await fixture(false);
    f.user.status = status;
    await splitRuntime(f.workspaces, f.user);
    expect(f.docker.mock.calls.some((call) => call[0] === "start")).toBe(false);
    expect(f.runners.provision.mock.calls[0][5]).toBe(true);
  },
);

it("restores the original container on a failed split and waits for a fresh operation before retrying", async () => {
  const f = await fixture();
  f.workspaces.create.mockRejectedValue(
    new Error("development startup failed"),
  );
  await expect(splitRuntime(f.workspaces, f.user)).rejects.toThrow(
    "development startup failed",
  );
  expect(f.docker).toHaveBeenCalledWith(
    "rename",
    f.name + "-before-split",
    f.name,
  );
  expect(f.docker).toHaveBeenCalledWith("start", f.name);
  expect(f.docker.mock.calls.flat()).not.toContain("--volumes");
  f.docker.mockClear();
  await expect(splitRuntime(f.workspaces, f.user)).rejects.toThrow("보존");
  expect(f.docker).not.toHaveBeenCalled();
});
