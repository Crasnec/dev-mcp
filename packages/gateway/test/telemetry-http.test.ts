import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { hashPassword } from "../src/crypto.ts";
import { RunnerTelemetryStore } from "../src/telemetry-store.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { legacyUser } from "./legacy-user.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "telemetry-http-"));
  directories.push(dataDir);
  const secret = "telemetry-test-password";
  const passwordHash = await hashPassword(secret);
  const users = new UserStore(dataDir, passwordHash);
  const admin = (await users.list())[0]!;
  const pending = await legacyUser(users, dataDir, "telemetry-user", secret);
  const owner = await users.update(admin.id, pending.id, {
    status: "active",
    role: "user",
  });
  const otherPending = await legacyUser(users, dataDir, "another-user", secret);
  const other = await users.update(admin.id, otherPending.id, {
    status: "active",
    role: "user",
  });
  const adminSession = await users.createSession(admin);
  const ownerSession = await users.createSession(owner);
  const now = Date.parse("2026-10-01T12:00:00Z");
  const runnerStatusDir = path.join(dataDir, "status");
  await mkdir(path.join(runnerStatusDir, "telemetry"), { recursive: true });
  const scope = (cpu: number) => ({
    ts: now,
    state: "ok",
    values: { cpuUsedCores: cpu },
    metricObservedAt: { cpuUsedCores: now },
    coverage: { expected: 1, observed: 1, complete: true },
  });
  await writeFile(
    path.join(runnerStatusDir, "telemetry", "current.json"),
    JSON.stringify({
      schemaVersion: 1,
      ts: now,
      scopes: {
        host: scope(12),
        "all-runners": scope(4),
        [owner.id]: scope(1),
        [other.id]: scope(3),
      },
    }),
  );
  const ipc = vi
    .spyOn(IpcClient.prototype, "call")
    .mockRejectedValue(new Error("Telemetry must not use runner IPC"));
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      runnerStatusDir,
      runnerSocket: path.join(dataDir, "unused.sock"),
      adminPasswordHash: passwordHash,
    },
    { users, telemetry: new RunnerTelemetryStore(runnerStatusDir, () => now) },
  );
  const get = (url: string, token?: string) =>
    inject(app, {
      method: "GET",
      url,
      headers: token ? { cookie: "__Host-dev-mcp-session=" + token } : {},
    });
  return { users, admin, owner, other, adminSession, ownerSession, get, ipc };
}

describe("telemetry authorization and HTTP responses", () => {
  it("returns JSON401 without redirect and denies non-admin host and aggregate access", async () => {
    const h = await fixture();
    for (const route of ["/admin/telemetry", "/account/telemetry"]) {
      const response = await h.get(route);
      expect(response.statusCode).toBe(401);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["cache-control"]).toBe("private, no-store");
    }
    for (const scope of ["host", "all-runners", h.owner.id, h.other.id]) {
      expect(
        (await h.get("/admin/telemetry?scope=" + scope, h.ownerSession.token))
          .statusCode,
      ).toBe(403);
    }
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("binds account telemetry to its session owner and rejects scope substitution", async () => {
    const h = await fixture();
    const self = await h.get("/account/telemetry", h.ownerSession.token);
    expect(self.statusCode).toBe(200);
    expect(self.json().scope).toBe(h.owner.id);
    expect(self.json().current.values.cpuUsedCores).toBe(1);
    expect(self.payload).not.toContain(h.other.id);
    for (const query of [
      "scope=host",
      "scope=all-runners",
      "scope=" + h.other.id,
      "owner=" + h.other.id,
    ]) {
      expect(
        (await h.get("/account/telemetry?" + query, h.ownerSession.token))
          .statusCode,
      ).toBe(400);
    }
    await h.users.update(h.admin.id, h.owner.id, {
      status: "disabled",
      role: "user",
    });
    expect(
      (await h.get("/account/telemetry", h.ownerSession.token)).statusCode,
    ).toBe(401);
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("serves admin host, aggregate and known-owner scopes, returning unavailable for an unmeasured owner", async () => {
    const h = await fixture();
    for (const [scope, cpu] of [
      ["host", 12],
      ["all-runners", 4],
      [h.other.id, 3],
    ] as const) {
      const response = await h.get(
        "/admin/telemetry?scope=" + scope + "&range=30d",
        h.adminSession.token,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().current.values.cpuUsedCores).toBe(cpu);
      expect(response.json().series).toHaveLength(720);
    }
    const missing = await h.get(
      "/admin/telemetry?scope=" + h.admin.id,
      h.adminSession.token,
    );
    expect(missing.statusCode).toBe(200);
    expect(missing.json().current.availability).toBe("unavailable");
    expect(missing.json().current.values.cpuUsedCores).toBeNull();
    expect(
      (await h.get("/admin/telemetry", h.adminSession.token)).json().scope,
    ).toBe("host");
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("rejects unknown owners, path-like scopes, repeated arguments and unsupported ranges", async () => {
    const h = await fixture();
    for (const scope of [
      "00000000-0000-4000-8000-000000000009",
      "../current.json",
      "/host",
    ]) {
      expect(
        (
          await h.get(
            "/admin/telemetry?scope=" + encodeURIComponent(scope),
            h.adminSession.token,
          )
        ).statusCode,
      ).toBe(404);
    }
    for (const query of [
      "range=1y",
      "range=1h&range=24h",
      "scope=host&scope=all-runners",
    ]) {
      expect(
        (await h.get("/admin/telemetry?" + query, h.adminSession.token))
          .statusCode,
      ).toBe(400);
    }
  });

  it("renders an authorized SSR usage summary without runner IPC and retains sign-in behavior for the page", async () => {
    const h = await fixture();
    expect((await h.get("/admin/usage")).headers.location).toBe("/login");
    expect((await h.get("/admin/usage", h.ownerSession.token)).statusCode).toBe(
      403,
    );
    const response = await h.get(
      "/admin/usage?scope=host&range=24h",
      h.adminSession.token,
    );
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain(
      "/admin/telemetry?scope=host&amp;range=24h",
    );
    expect(response.payload).toContain("12 코어");
    expect(response.payload).toContain("0초 기록");
    expect(response.payload).toContain("/assets/telemetry.js");
    expect(h.ipc).not.toHaveBeenCalled();
  });
});
