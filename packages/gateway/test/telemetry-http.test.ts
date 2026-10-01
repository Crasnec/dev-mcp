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
  let now = Date.parse("2026-10-01T12:00:00Z");
  const runnerStatusDir = path.join(dataDir, "status");
  await mkdir(path.join(runnerStatusDir, "telemetry"), { recursive: true });
  const scope = (cpu: number) => ({
    ts: now,
    state: "ok",
    values: { cpuUsedCores: cpu },
    metricObservedAt: { cpuUsedCores: now },
    coverage: { expected: 1, observed: 1, complete: true },
  });
  const writeCurrent = async (cpu = 12) =>
    writeFile(
      path.join(runnerStatusDir, "telemetry", "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        ts: now,
        scopes: {
          host: scope(cpu),
          "all-runners": scope(4),
          [owner.id]: scope(1),
          [other.id]: scope(3),
        },
      }),
    );
  await writeCurrent();
  const ipc = vi
    .spyOn(IpcClient.prototype, "call")
    .mockRejectedValue(new Error("Telemetry must not use runner IPC"));
  const telemetry = new RunnerTelemetryStore(runnerStatusDir, () => now);
  const read = vi.spyOn(telemetry, "read");
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      runnerStatusDir,
      runnerSocket: path.join(dataDir, "unused.sock"),
      adminPasswordHash: passwordHash,
    },
    { users, telemetry },
  );
  const get = (
    url: string,
    token?: string,
    headers: Record<string, string> = {},
  ) =>
    inject(app, {
      method: "GET",
      url,
      headers: {
        ...headers,
        ...(token ? { cookie: "__Host-dev-mcp-session=" + token } : {}),
      },
    });
  return {
    users,
    admin,
    owner,
    other,
    adminSession,
    ownerSession,
    get,
    ipc,
    read,
    runnerStatusDir,
    writeCurrent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("telemetry authorization and HTTP responses", () => {
  it("renders own usage with range controls, charts and percentiles without enumerating other owners", async () => {
    const h = await fixture();
    const ts = Date.parse("2026-10-01T12:00:00Z");
    const folder = path.join(
      h.runnerStatusDir,
      "telemetry",
      "history",
      h.owner.id,
      "raw",
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "2026-10-01T12.jsonl"),
      JSON.stringify({
        ts,
        intervalMs: 5000,
        state: "ok",
        epoch: "own-runner",
        values: { cpuUsedCores: 2 },
        metricObservedAt: { cpuUsedCores: ts },
        deltas: { cpuSeconds: 10 },
        coverage: { expected: 1, observed: 1, complete: true },
      }) + "\n",
    );
    const list = vi.spyOn(h.users, "list");
    const getOwner = vi.spyOn(h.users, "get");
    const response = await h.get(
      "/account/usage?range=1h",
      h.ownerSession.token,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(h.read).toHaveBeenCalledExactlyOnceWith(h.owner.id, "1h");
    expect(response.payload).toContain('action="/account/usage"');
    expect(response.payload).toContain(
      'data-telemetry-url="/account/telemetry?range=1h"',
    );
    expect(response.payload).toContain('data-console-base="/account"');
    expect(response.payload).toContain("내 실행 환경");
    expect(response.payload).toContain("1 코어");
    expect(response.payload).toContain("≈ 2 코어");
    for (const metric of ["cpu", "memory", "disk", "disk-io", "network"]) {
      expect(response.payload).toContain(`data-telemetry-chart="${metric}"`);
    }
    for (const percentile of ["p50", "p95", "p99"]) {
      expect(response.payload).toContain(
        `data-telemetry-${percentile}="cpuUsedCores"`,
      );
    }
    for (const range of ["1h", "24h", "7d", "30d"]) {
      expect(response.payload).toContain(`<option value="${range}"`);
    }
    for (const privateValue of [
      h.other.id,
      h.other.username,
      'name="scope"',
      'name="owner"',
      "호스트 서버",
      "전체 실행 환경",
      "12 코어",
    ]) {
      expect(response.payload).not.toContain(privateValue);
    }
    expect(response.payload).toContain("/assets/telemetry.js");
    const full = await h.get(
      "/account/telemetry?range=1h&stream=1",
      h.ownerSession.token,
    );
    expect(full.json()).toMatchObject({
      scope: h.owner.id,
      reset: true,
      changes: {
        "current.values.cpuUsedCores": 1,
        "statistics.cpuUsedCores.p95": 2,
      },
    });
    const idle = await h.get(
      "/account/telemetry?range=1h&stream=1&since=" + full.json().revision,
      h.ownerSession.token,
    );
    expect(idle.statusCode).toBe(204);
    expect(idle.payload).toBe("");
    expect(list).not.toHaveBeenCalled();
    expect(getOwner).not.toHaveBeenCalled();
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("rejects account usage scope substitution and rechecks authentication before reading history", async () => {
    const h = await fixture();
    const anonymous = await h.get("/account/usage");
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe("/login");
    for (const query of [
      "scope=host",
      "scope=all-runners",
      "scope=" + h.other.id,
      "scope=" + h.owner.id,
      "owner=" + h.other.id,
      "owner=" + h.owner.id,
      "scope=host&scope=all-runners",
      "owner[]=foreign",
      "range=1y",
      "range=1h&range=24h",
    ]) {
      expect(
        (await h.get("/account/usage?" + query, h.ownerSession.token))
          .statusCode,
      ).toBe(400);
    }
    expect(h.read).not.toHaveBeenCalled();
    const adminOwn = await h.get(
      "/account/usage?range=30d",
      h.adminSession.token,
    );
    expect(adminOwn.statusCode).toBe(200);
    expect(h.read).toHaveBeenCalledExactlyOnceWith(h.admin.id, "30d");
    expect(adminOwn.payload).toContain('action="/account/usage"');
    expect(adminOwn.payload).not.toContain('name="scope"');
    expect(adminOwn.payload).not.toContain("호스트 서버");
    h.read.mockClear();
    await h.users.update(h.admin.id, h.owner.id, {
      status: "disabled",
      role: "user",
    });
    const suspended = await h.get("/account/usage", h.ownerSession.token);
    expect(suspended.statusCode).toBe(303);
    expect(suspended.headers.location).toBe("/login");
    expect(
      (await h.get("/account/telemetry?stream=1", h.ownerSession.token))
        .statusCode,
    ).toBe(401);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.ipc).not.toHaveBeenCalled();
  });

  it("serves a compact baseline, scalar-only updates, idle204 and a reset for changed filters", async () => {
    const h = await fixture();
    const route = "/admin/telemetry?scope=host&range=1h&stream=1";
    const first = await h.get(route, h.adminSession.token);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      streamVersion: 1,
      reset: true,
      changes: { "current.values.cpuUsedCores": 12 },
    });
    expect(first.json().series).toBeUndefined();
    const since = "&since=" + first.json().revision;
    const idle = await h.get(route + since, h.adminSession.token);
    expect(idle.statusCode).toBe(204);
    expect(idle.payload).toBe("");
    expect(idle.headers["cache-control"]).toBe("private, no-store");
    h.advance(5000);
    await h.writeCurrent(13);
    const update = await h.get(route + since, h.adminSession.token);
    expect(update.json()).toMatchObject({
      reset: false,
      base: first.json().revision,
      changes: { "current.values.cpuUsedCores": 13 },
    });
    expect(
      Object.keys(update.json().changes).filter((key) =>
        key.startsWith("point."),
      ),
    ).toHaveLength(0);
    expect(Buffer.byteLength(update.payload)).toBeLessThan(600);
    const reset = await h.get(
      "/admin/telemetry?scope=all-runners&stream=1" + since,
      h.adminSession.token,
    );
    expect(reset.json()).toMatchObject({ scope: "all-runners", reset: true });
    const complete = await h.get(
      "/admin/telemetry?scope=host",
      h.adminSession.token,
    );
    expect(complete.json().series).toHaveLength(720);
    expect(complete.json().streamVersion).toBeUndefined();
  });

  it("authenticates every revision request and rejects old automatic full-data browser polling", async () => {
    const h = await fixture();
    const full = await h.get("/admin/telemetry?stream=1", h.adminSession.token);
    const since = "&since=" + full.json().revision;
    expect((await h.get("/admin/telemetry?stream=1" + since)).statusCode).toBe(
      401,
    );
    expect(
      (await h.get("/admin/telemetry?stream=1" + since, h.ownerSession.token))
        .statusCode,
    ).toBe(403);
    const own = await h.get(
      "/account/telemetry?stream=1" + since,
      h.ownerSession.token,
    );
    expect(own.json()).toMatchObject({ scope: h.owner.id, reset: true });
    expect(own.payload).not.toContain(h.other.id);
    const legacy = await h.get("/admin/telemetry", h.adminSession.token, {
      "sec-fetch-dest": "empty",
    });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toEqual({ error: "refresh_required" });
    expect(Buffer.byteLength(legacy.payload)).toBeLessThan(100);
    expect(
      (
        await h.get("/admin/telemetry", h.adminSession.token, {
          "sec-fetch-dest": "document",
        })
      ).statusCode,
    ).toBe(200);
    await h.users.update(h.admin.id, h.owner.id, {
      status: "disabled",
      role: "user",
    });
    expect(
      (
        await h.get(
          "/account/telemetry?stream=1&since=" + own.json().revision,
          h.ownerSession.token,
        )
      ).statusCode,
    ).toBe(401);
    expect(h.ipc).not.toHaveBeenCalled();
  });
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
      "scope[]=host",
      "owner[scope]=" + h.other.id,
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
      "stream=2",
      "stream=1&stream=1",
      "stream=1&since=bad",
      "since=" + "x".repeat(24),
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
