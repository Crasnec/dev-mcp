import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bootstrapGoogleAdmin } from "../../../scripts/bootstrap-google-admin.mjs";
import { UserStore } from "../src/user-store.ts";
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
  const users = new UserStore(directory, "unused-bootstrap-hash");
  const admin = (await users.list())[0]!;
  const { user } = await users.googleAccount(
    { sub: "verified-provider-subject", email: "chosen@example.test" },
    true,
  );
  return { users, user, admin, audit: new AuditLogger(directory) };
}

describe("offline Google administrator bootstrap", () => {
  it("promotes the exact verified pending account once and preserves its identity and workspace", async () => {
    const { users, user, admin, audit } = await fixture();
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
      runner: user.runner,
      authVersion: user.authVersion + 1,
    });
    expect(await users.get(admin.id)).toEqual(admin);
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
    expect((await users.get(other.user.id))?.status).toBe("pending");
  });

  it("rejects mismatched identities, an unlinked account and nonpending targets without granting access", async () => {
    const { users, user, admin, audit } = await fixture();
    for (const [userId, email] of [
      ["../users", user.email],
      [user.id, "different@example.test"],
      [admin.id, user.email],
      ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", user.email],
    ]) {
      await expect(
        bootstrapGoogleAdmin({ users, audit, userId, email }),
      ).rejects.toThrow();
    }
    expect(await users.get(user.id)).toEqual(user);
    await users.update(admin.id, user.id, { role: "user", status: "active" });
    await expect(
      bootstrapGoogleAdmin({
        users,
        audit,
        userId: user.id,
        email: user.email,
      }),
    ).rejects.toThrow("does not match");
    expect((await audit.recent()).records).toHaveLength(0);
  });

  it("protects the last Google administrator even while an unlinked legacy administrator remains", async () => {
    const { users, user, admin, audit } = await fixture();
    const promoted = await bootstrapGoogleAdmin({
      users,
      audit,
      userId: user.id,
      email: user.email,
    });
    expect((await users.get(admin.id))?.googleLinked).toBe(false);
    for (const changes of [
      { role: "user", status: "active" },
      { role: "admin", status: "disabled" },
    ] as const) {
      await expect(
        users.update(promoted.id, promoted.id, changes),
      ).rejects.toThrow("마지막 Google 로그인 관리자");
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
    ).rejects.toThrow("마지막 Google 로그인 관리자");
  });
});
