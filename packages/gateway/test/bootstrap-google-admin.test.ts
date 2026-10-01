import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapGoogleAdmin } from "../../../scripts/bootstrap-google-admin.mjs";
import { JsonStore } from "../src/json-store.ts";
import { UserStore, type User } from "../src/user-store.ts";
import { AuditLogger } from "../src/audit.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-bootstrap-"));
  temporary.push(directory);
  const users = new UserStore(directory);
  const { user } = await users.googleAccount(
    { sub: "verified-provider-subject", email: "chosen@example.test" },
    true,
  );
  // Raw records for states production code never creates any more.
  const store = new JsonStore<{
    users: Array<User & { googleSub?: string; passwordHash?: string }>;
    sessions: Record<string, unknown>;
  }>(path.join(directory, "users.json"), () => ({ users: [], sessions: {} }));
  const insert = async (record: Partial<User> & { googleSub?: string }) => {
    const id = record.id ?? crypto.randomUUID();
    await store.update((db) => {
      db.users.push({
        id,
        username: "raw-" + id,
        role: "user",
        status: "pending",
        runner: id,
        authVersion: 1,
        createdAt: Date.now(),
        ...record,
      });
    });
    return id;
  };
  return { users, user, insert, audit: new AuditLogger(directory) };
}

describe("first Google administrator bootstrap", () => {
  it("promotes the exact verified pending account once without any seeded account", async () => {
    const { users, user, audit } = await fixture();
    expect(await users.list()).toHaveLength(1);
    const promoted = await bootstrapGoogleAdmin({
      users,
      audit,
      userId: user.id,
      email: user.email,
    });
    expect(promoted).toMatchObject({
      id: user.id,
      email: user.email,
      googleLinked: true,
      role: "admin",
      status: "active",
      runner: user.id,
      authVersion: user.authVersion + 1,
    });
    expect((await audit.recent()).records).toEqual([
      expect.objectContaining({
        event: "bootstrap_google_admin",
        actor: "local_operator",
        userId: user.id,
      }),
    ]);
    const other = await users.googleAccount(
      { sub: "other-provider-subject", email: "other@example.test" },
      true,
    );
    await expect(
      bootstrapGoogleAdmin({
        users,
        audit,
        userId: other.user.id,
        email: other.user.email,
      }),
    ).rejects.toThrow("already exists");
    await expect(users.promoteFirstAdmin(other.user.id)).rejects.toThrow(
      "이미 활성 관리자",
    );
    expect((await users.get(other.user.id))?.status).toBe("pending");
  });

  it("rejects mismatched identities, unlinked records and non-pending targets", async () => {
    const { users, user, insert, audit } = await fixture();
    for (const [userId, email] of [
      ["../users", user.email],
      [user.id, "different@example.test"],
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", user.email],
    ]) {
      await expect(
        bootstrapGoogleAdmin({ users, audit, userId, email }),
      ).rejects.toThrow();
    }
    const unlinked = await insert({});
    const active = await insert({ status: "active", googleSub: "active-sub" });
    const shared = await insert({ runner: "primary", googleSub: "shared-sub" });
    for (const id of [unlinked, active, shared]) {
      await expect(users.promoteFirstAdmin(id)).rejects.toThrow(
        "승인 대기 중인 Google 계정만",
      );
      expect((await users.get(id))?.role).toBe("user");
    }
    expect(await users.get(user.id)).toEqual(user);
    expect((await audit.recent()).records).toHaveLength(0);
  });

  it("ignores a leftover legacy administrator and protects the last signed-in administrator", async () => {
    const { users, user, insert, audit } = await fixture();
    // An older installation's seeded account cannot sign in any more.
    const legacy = await insert({
      role: "admin",
      status: "active",
      runner: "primary",
    });
    const promoted = await bootstrapGoogleAdmin({
      users,
      audit,
      userId: user.id,
      email: user.email,
    });
    expect((await users.get(legacy))?.googleLinked).toBe(false);
    for (const changes of [
      { role: "user", status: "active" },
      { role: "admin", status: "disabled" },
    ] as const) {
      await expect(
        users.update(promoted.id, promoted.id, changes),
      ).rejects.toThrow("마지막 관리자");
      expect(await users.get(promoted.id)).toEqual(promoted);
    }
    const { user: second } = await users.googleAccount(
      { sub: "second-admin-subject", email: "second@example.test" },
      true,
    );
    await users.update(promoted.id, second.id, {
      role: "admin",
      status: "active",
    });
    expect(
      await users.update(promoted.id, promoted.id, {
        role: "user",
        status: "active",
      }),
    ).toMatchObject({ role: "user", status: "active" });
    await expect(
      users.update(second.id, second.id, { role: "admin", status: "disabled" }),
    ).rejects.toThrow("마지막 관리자");
  });
});
