import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseSshPublicKey,
  sshKeysForUser,
  sshLogin,
} from "../../../scripts/ssh-access.mjs";
import { SshAccessStore } from "../src/ssh-access-store.ts";
import { UserStore } from "../src/user-store.ts";
import { loadConfig } from "../src/config.ts";
import { adminAccount } from "./accounts.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
function sshString(data: Buffer | string) {
  const bytes = Buffer.from(data);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return Buffer.concat([size, bytes]);
}
export function publicKey() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const bytes = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return (
    "ssh-ed25519 " +
    Buffer.concat([sshString("ssh-ed25519"), sshString(bytes)]).toString(
      "base64",
    )
  );
}
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-ssh-keys-"));
  directories.push(dir);
  const users = new UserStore(dir);
  const alice = await adminAccount(users, dir, "alice");
  const bob = await adminAccount(users, dir, "bob");
  return { dir, users, alice, bob, access: new SshAccessStore(dir) };
}

describe("SSH public keys", () => {
  it("normalizes public keys and refuses options, private keys, certificates and malformed blobs", () => {
    const key = publicKey();
    const parsed = parseSshPublicKey(key + " user@laptop\n");
    expect(parsed.publicKey).toBe(key);
    expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    for (const value of [
      'command="sh" ' + key,
      key + "\n" + publicKey(),
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "ssh-ed25519-cert-v01@openssh.com AAAA",
      "ssh-ed25519 AAAA",
      key.replace("ssh-ed25519", "ssh-rsa"),
      key + "\0",
    ]) {
      expect(() => parseSshPublicKey(value)).toThrow();
    }
    const invalidLength = Buffer.concat([
      sshString("ssh-ed25519"),
      sshString(Buffer.alloc(31)),
    ]);
    expect(() =>
      parseSshPublicKey("ssh-ed25519 " + invalidLength.toString("base64")),
    ).toThrow();
  });

  it("accepts RSA and ECDSA SSH wire keys and rejects small RSA moduli", () => {
    const positive = (value: string) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes[0]! & 0x80
        ? Buffer.concat([Buffer.from([0]), bytes])
        : bytes;
    };
    const rsa = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey.export({ format: "jwk" });
    const rsaKey =
      "ssh-rsa " +
      Buffer.concat([
        sshString("ssh-rsa"),
        sshString(positive(rsa.e!)),
        sshString(positive(rsa.n!)),
      ]).toString("base64");
    expect(parseSshPublicKey(rsaKey).publicKey).toBe(rsaKey);
    const small =
      "ssh-rsa " +
      Buffer.concat([
        sshString("ssh-rsa"),
        sshString(Buffer.from([3])),
        sshString(Buffer.alloc(128, 1)),
      ]).toString("base64");
    expect(() => parseSshPublicKey(small)).toThrow();
    const ec = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).publicKey.export({ format: "jwk" });
    const ecKey =
      "ecdsa-sha2-nistp256 " +
      Buffer.concat([
        sshString("ecdsa-sha2-nistp256"),
        sshString("nistp256"),
        sshString(
          Buffer.concat([
            Buffer.from([4]),
            Buffer.from(ec.x!, "base64url"),
            Buffer.from(ec.y!, "base64url"),
          ]),
        ),
      ]).toString("base64");
    expect(parseSshPublicKey(ecKey).publicKey).toBe(ecKey);
  });

  it("keeps concurrent public-key registrations isolated and limits each account", async () => {
    const { access, alice, bob, users, dir } = await fixture();
    const key = publicKey();
    const [first] = await Promise.all([
      access.add(alice, "Laptop", key),
      access.add(bob, "Desktop", publicKey()),
    ]);
    expect((await access.get(alice.id))?.keys).toHaveLength(1);
    expect((await access.get(bob.id))?.keys).toHaveLength(1);
    await expect(
      access.add(alice, "Duplicate", key + " comment"),
    ).rejects.toThrow("이미 등록");
    await access.remove(alice, first!.id);
    await access.add(alice, "New laptop", publicKey());
    expect((await access.get(alice.id))?.keys).toHaveLength(1);
    const charlie = await adminAccount(users, dir, "charlie");
    await access.add(charlie, "Third", publicKey());
    for (let i = 1; i < 10; i++)
      await access.add(alice, "Key " + i, publicKey());
    await expect(access.add(alice, "Too many", publicKey())).rejects.toThrow(
      "최대 10",
    );
  });

  it("refuses foreign key deletion and invalidates keys with the account's authentication version", async () => {
    const { access, alice, bob, users } = await fixture();
    const key = await access.add(alice, "Laptop", publicKey());
    await expect(access.remove(bob, key.id)).rejects.toThrow("내 계정");
    await users.revokeAccess(alice.id, alice.id);
    const current = (await users.get(alice.id))!;
    expect(sshKeysForUser(current, await access.get(alice.id))).toEqual([]);
    await access.add(current, "Replacement", publicKey());
    expect((await access.get(alice.id))?.keys.map((key) => key.name)).toEqual([
      "Replacement",
    ]);
    expect((await access.get(alice.id))?.keys).toHaveLength(1);
  });

  it("fails closed for malformed persisted public keys", async () => {
    const { access, alice, bob, dir } = await fixture();
    await access.add(alice, "Laptop", publicKey());
    const entry = (await access.get(alice.id))!;
    await writeFile(
      path.join(dir, "ssh-access.json"),
      JSON.stringify({
        entries: {
          [alice.id]: {
            ...entry,
            keys: [
              {
                ...entry.keys[0],
                publicKey: "command=sh " + entry.keys[0]!.publicKey,
              },
            ],
          },
        },
      }),
    );
    expect(await access.get(alice.id)).toBeUndefined();
  });
});

it("uses one shared unprivileged SSH port and keeps the feature opt-in", () => {
  const env = { PUBLIC_BASE_URL: "https://dev.example.test" };
  expect(loadConfig(env).ssh).toBeUndefined();
  expect(loadConfig({ ...env, WORKSPACE_SSH_ENABLED: "true" }).ssh).toEqual({
    host: "dev.example.test",
    port: 2222,
  });
  for (const port of ["22", "0", "65536", "2222;id", "2.2"])
    expect(() =>
      loadConfig({
        ...env,
        WORKSPACE_SSH_ENABLED: "true",
        WORKSPACE_SSH_PORT: port,
      }),
    ).toThrow();
  expect(() =>
    loadConfig({
      ...env,
      WORKSPACE_SSH_ENABLED: "true",
      WORKSPACE_SSH_HOST: "host\nProxyCommand sh",
    }),
  ).toThrow();
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  expect(sshLogin(first)).toMatch(/^u_[a-z2-7]{26}$/);
  expect(sshLogin(first)).not.toBe(sshLogin(second));
  expect(() => sshLogin("../../injected")).toThrow();
});
