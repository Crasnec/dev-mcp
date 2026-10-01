import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const adminId = "00000000-0000-4000-8000-0000000000aa";
const userId = "00000000-0000-4000-8000-0000000000bb";
const legacyAdmin = {
  id: adminId,
  username: "admin",
  role: "admin",
  status: "active",
  runner: "primary",
  authVersion: 3,
  createdAt: 1,
  googleSub: "google-admin",
  email: "admin@example.test",
  passwordHash: "scrypt:legacy",
};
const dedicated = {
  id: userId,
  username: "google-" + userId,
  role: "user",
  status: "active",
  runner: userId,
  authVersion: 1,
  createdAt: 2,
  googleSub: "google-user",
  email: "user@example.test",
};

async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-migrate-"));
  temporary.push(dir);
  return dir;
}

describe("primary runner account migration", () => {
  const account = (...args: string[]) =>
    execute(process.execPath, ["scripts/migrate-primary-account.mjs", ...args]);

  it("moves exactly one Google-linked primary account to its own runner and keeps a backup", async () => {
    const dir = await directory();
    const file = path.join(dir, "users.json");
    const original = JSON.stringify({
      users: [legacyAdmin, dedicated],
      sessions: { kept: { userId: adminId } },
    });
    await writeFile(file, original);
    const inspected = await account("inspect", file, "", "/home/me/workspace");
    expect(JSON.parse(inspected.stdout)).toEqual({
      id: adminId,
      role: "admin",
    });
    await expect(account("apply", file, userId)).rejects.toThrow();
    await account("apply", file, adminId);
    const db = JSON.parse(await readFile(file, "utf8"));
    expect(db.users[0]).toEqual({
      ...legacyAdmin,
      runner: adminId,
      passwordHash: undefined,
    });
    expect(db.users[0]).not.toHaveProperty("passwordHash");
    // Credential versions and sessions stay valid: MCP clients need no reconnect.
    expect(db.users[0].authVersion).toBe(3);
    expect(db.sessions).toEqual({ kept: { userId: adminId } });
    expect(db.users[1]).toEqual(dedicated);
    expect(await readFile(file + ".pre-primary-migration", "utf8")).toBe(
      original,
    );
    expect(JSON.parse((await account("inspect", file)).stdout)).toEqual({
      none: true,
    });
  });

  it("refuses ambiguous, unlinked or overlapping primary accounts", async () => {
    const dir = await directory();
    const file = path.join(dir, "users.json");
    for (const users of [
      [legacyAdmin, { ...legacyAdmin, id: userId, googleSub: "other" }],
      [{ ...legacyAdmin, googleSub: undefined }],
      [{ ...legacyAdmin, status: "disabled" }],
    ]) {
      await writeFile(file, JSON.stringify({ users, sessions: {} }));
      await expect(account("inspect", file)).rejects.toThrow();
    }
    await writeFile(
      file,
      JSON.stringify({ users: [legacyAdmin], sessions: {} }),
    );
    await writeFile(
      path.join(dir, "installation.json"),
      JSON.stringify({ workspaceRoot: "/home/me/workspace/users" }),
    );
    await expect(
      account("inspect", file, "", "/home/me/workspace"),
    ).rejects.toThrow();
    expect(
      JSON.parse((await account("inspect", file, "", "/srv/other")).stdout),
    ).toEqual({ id: adminId, role: "admin" });
  });

  async function host(state: Record<string, unknown> = {}) {
    const dir = await directory();
    const stateFile = path.join(dir, "state.json");
    await writeFile(
      stateFile,
      JSON.stringify({ calls: [], running: [], existing: [], ...state }),
    );
    // A fake Docker host: Compose containers, their mounts, images, and the
    // helper containers the script runs.
    await writeFile(
      path.join(dir, "docker"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"));
state.calls.push(args);
let output = "", code = 0;
const service = (args.find((arg) => arg.startsWith("label=com.docker.compose.service=")) ?? "").split("=").at(-1);
const ids = { runner: "aaaaaaaaaaaa", gateway: "bbbbbbbbbbbb", provisioner: "cccccccccccc" };
if (args[0] === "ps") {
  output = ids[service] ?? "";
} else if (args[0] === "inspect" && args[1] === "--format") {
  const format = args[2];
  const target = args[3];
  output = format.includes("State.Running")
    ? String(state.running.includes(target))
    : format.includes("/workspace")
      ? "/home/me/workspace"
      : format.includes("/var/lib/dev-mcp")
        ? (target === ids.runner ? "dev-mcp_runner-data" : "dev-mcp_gateway-data")
        : format.includes("/runner-status")
          ? "dev-mcp_runner-status"
          : "";
} else if (args[0] === "image" && args[1] === "inspect") {
  output = "sha256:" + "e".repeat(64);
} else if ((args[0] === "container" || args[0] === "volume") && args[1] === "inspect") {
  code = state.existing.includes(args[2]) ? 0 : 1;
} else if (args[0] === "run") {
  if (args.includes("migrate-primary-account.mjs") || args.includes("scripts/migrate-primary-account.mjs")) {
    output = args.includes("inspect") ? JSON.stringify({ id: "${adminId}", role: "admin" }) : "{}";
  } else if (args.includes("-e") && args.some((arg) => arg.includes("statSync(\\"/workspace\\")"))) {
    output = state.owner ?? "ok";
  }
}
fs.writeFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify(state));
if (output) {
  console.log(output);
}
process.exit(code);
`,
      { mode: 0o755 },
    );
    return {
      state: async () => JSON.parse(await readFile(stateFile, "utf8")),
      run: (...args: string[]) =>
        execute("bash", ["scripts/migrate-primary-runner.sh", ...args], {
          env: {
            ...process.env,
            // A real docker CLI must never reach a host daemon from tests.
            DOCKER_HOST: "unix://" + path.join(dir, "no-docker.sock"),
            PATH: dir + path.delimiter + process.env.PATH,
            FAKE_DOCKER_STATE: stateFile,
          },
        }),
    };
  }
  // Docker calls that change state: lifecycle commands, new volumes, and
  // helper containers with a writable mount.
  const writable = (args: string[]) =>
    args.some(
      (arg, index) =>
        args[index - 1] === "--mount" && !arg.endsWith(",readonly"),
    );
  const mutations = (calls: string[][]) =>
    calls.filter(
      (args) =>
        ["stop", "rm", "start"].includes(args[0]!) ||
        (args[0] === "volume" && args[1] === "create") ||
        (args[0] === "run" && writable(args)),
    );

  it("only inspects in a dry run and migrates with --apply", async () => {
    const fake = await host({ running: ["aaaaaaaaaaaa"] });
    const dry = await fake.run();
    expect(dry.stdout).toContain("Dry run only");
    expect(dry.stdout).toContain(adminId);
    expect(dry.stdout).toContain("/home/me/workspace");
    expect(mutations((await fake.state()).calls)).toEqual([]);
    const applied = await fake.run("--apply");
    expect(applied.stdout).toContain("Migrated.");
    const calls = (await fake.state()).calls as string[][];
    const steps = mutations(calls).map((args) =>
      args[0] === "run"
        ? args.find((arg) => arg.includes("target=/data"))
          ? "accounts"
          : args.find((arg) => arg.includes("target=/status"))
            ? "registry"
            : "copy"
        : args.slice(0, 2).join(" "),
    );
    expect(steps).toEqual([
      "stop aaaaaaaaaaaa",
      "volume create",
      "copy",
      "registry",
      "accounts",
    ]);
    const copy = calls.find((args) => args.includes("cp"))!;
    expect(copy).toEqual(
      expect.arrayContaining([
        "type=volume,source=dev-mcp_runner-data,target=/source,readonly",
        `type=volume,source=dev-mcp-user-${adminId}-data,target=/var/lib/dev-mcp`,
        "-a",
      ]),
    );
    const registry = calls.find((args) =>
      args.some((arg) => arg.includes("target=/status")),
    )!;
    expect(registry.slice(-2)).toEqual([adminId, "/home/me/workspace"]);
    // Nothing is deleted: the old container and data volume stay for rollback.
    expect(calls.some((args) => args[0] === "rm" || args.includes("rm"))).toBe(
      false,
    );
  });

  it("stops before any change when services run, targets exist or ownership differs", async () => {
    for (const [state, message] of [
      [{ running: ["bbbbbbbbbbbb"] }, "Stop gateway and provisioner"],
      [{ existing: [`dev-mcp-user-${adminId}-data`] }, "already exists"],
      [{ owner: "invalid" }, "must be owned by the runner user"],
    ] as const) {
      const fake = await host(state);
      await expect(fake.run("--apply")).rejects.toThrow(message);
      expect(mutations((await fake.state()).calls)).toEqual([]);
    }
  });
});
