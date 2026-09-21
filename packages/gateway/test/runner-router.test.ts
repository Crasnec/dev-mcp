import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  unlink,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startIpcServer } from "../../runner/src/ipc-server.ts";
import type { RunnerRuntime } from "../../runner/src/runtime.ts";
import { RunnerRouter } from "../src/runner-router.ts";
import type { User } from "../src/user-store.ts";

const temporary: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function runner(socketPath: string, identity: string, secret?: string) {
  const runtime = {
    dispatch: async (request: { method: string; actor: string }) => ({
      ok: request.method !== "__authenticated_call",
      truncated: false,
      data: { runner: identity, method: request.method, actor: request.actor },
    }),
  } as unknown as RunnerRuntime;
  servers.push(await startIpcServer(socketPath, runtime, secret));
}

describe("dedicated user runner routing", () => {
  it("routes every tool to the authenticated user's socket, never falls back to the primary", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-router-"));
    temporary.push(dataDir);
    const aliceId = "00000000-0000-4000-8000-000000000001";
    const bobId = "00000000-0000-4000-8000-000000000002";
    await runner(path.join(dataDir, "primary.sock"), "primary");
    await writeFile(path.join(dataDir, aliceId + ".key"), "a".repeat(64));
    await writeFile(path.join(dataDir, bobId + ".key"), "b".repeat(64));
    await runner(
      path.join(dataDir, aliceId, "runner.sock"),
      "alice",
      "a".repeat(64),
    );
    await runner(
      path.join(dataDir, bobId, "runner.sock"),
      "bob",
      "b".repeat(64),
    );
    const router = new RunnerRouter({
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      adminPasswordHash: "unused",
      runnerSocket: path.join(dataDir, "primary.sock"),
      userRunnerSocketDir: dataDir,
    });
    const user = (id: string): User => ({
      id,
      runner: id,
      username: id,
      role: "user",
      status: "active",
      authVersion: 1,
      createdAt: Date.now(),
    });
    for (const method of [
      "project_list",
      "file_read",
      "image_read",
      "command_run",
      "command_output",
      "process_list",
      "process_logs",
      "process_stop",
      "git_read",
    ]) {
      for (const [id, identity] of [
        [aliceId, "alice"],
        [bobId, "bob"],
      ] as const) {
        const result = await router
          .forUser(user(id))
          .call(method, { project_id: "same-id" }, id);
        expect(result.data).toEqual({ runner: identity, method, actor: id });
      }
    }
    await unlink(path.join(dataDir, aliceId, "runner.sock"));
    await symlink(
      path.join(dataDir, bobId, "runner.sock"),
      path.join(dataDir, aliceId, "runner.sock"),
    );
    expect(
      (await router.forUser(user(aliceId)).call("project_list", {}, aliceId))
        .ok,
    ).toBe(false);
    await unlink(path.join(dataDir, aliceId, "runner.sock"));
    await symlink(
      path.join(dataDir, "primary.sock"),
      path.join(dataDir, aliceId, "runner.sock"),
    );
    expect(
      (await router.forUser(user(aliceId)).call("project_list", {}, aliceId))
        .ok,
    ).toBe(false);
    const missing = user("00000000-0000-4000-8000-000000000003");
    expect(
      (await router.forUser(missing).call("project_list", {}, missing.id)).error
        ?.code,
    ).toBe("RUNNER_UNAVAILABLE");
    expect(() => router.forUser({ ...user(aliceId), runner: bobId })).toThrow(
      "Invalid user runner identity",
    );
    expect(() => router.forUser(user("../../primary"))).toThrow(
      "Invalid user runner identity",
    );
  });
});
