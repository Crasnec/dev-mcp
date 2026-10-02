import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  readdir,
  chmod,
  chown,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import {
  sshKeysForUser,
  sshAccessRevision,
  sshLogin,
  workspaceContainer,
  parseSshPublicKey,
} from "./ssh-access.mjs";
import { validUser } from "./runner-operations.mjs";

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SSH_LEASE_MS = 30_000;
export async function atomicFile(filename, content, mode = 0o644) {
  const temporary = filename + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, { flag: "wx", mode });
  await rename(temporary, filename);
}
async function ownedDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    info.mode & 0o022
  ) {
    throw new Error("Invalid SSH registry directory");
  }
}
async function hostKey(
  directory,
  uid = process.getuid(),
  gid = process.getgid(),
) {
  const key = path.join(directory, "ssh_host_ed25519_key");
  let info;
  try {
    info = await lstat(key);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (!info) {
    await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
      timeout: 10_000,
    });
    await chmod(key, 0o600);
    if (uid !== process.getuid() || gid !== process.getgid()) {
      await chown(key, uid, gid);
    }
    info = await lstat(key);
  }
  if (
    !info.isFile() ||
    info.uid !== uid ||
    info.gid !== gid ||
    (info.mode & 0o777) !== 0o600
  ) {
    throw new Error("Invalid SSH host key ownership");
  }
  const publicInfo = await lstat(key + ".pub");
  if (
    !publicInfo.isFile() ||
    publicInfo.uid !== process.getuid() ||
    publicInfo.mode & 0o022
  ) {
    throw new Error("Invalid SSH host public key");
  }
  return parseSshPublicKey(await readFile(key + ".pub", "utf8")).fingerprint;
}

export class SshRegistry {
  constructor(entryDir, authDir) {
    this.entryDir = entryDir;
    this.authDir = authDir;
  }
  async init() {
    await ownedDirectory(this.entryDir);
    await ownedDirectory(this.authDir);
    await ownedDirectory(path.join(this.entryDir, "keys"));
    this.entryFingerprint = await hostKey(this.entryDir);
  }
  async prepare(user, uid, gid) {
    if (!validUser(user)) {
      throw new Error("Invalid workspace owner");
    }
    const directory = path.join(this.authDir, user.id);
    await ownedDirectory(directory);
    const fingerprint = await hostKey(directory, uid, gid);
    return { directory, fingerprint };
  }
  async sync(users, access) {
    if (
      !Array.isArray(users) ||
      !access ||
      typeof access.entries !== "object" ||
      !access.entries
    ) {
      throw new Error("Invalid SSH account state");
    }
    const accounts = new Map();
    for (const user of users) {
      if (validUser(user)) {
        if (accounts.has(user.id)) {
          throw new Error("Duplicate SSH account");
        }
        accounts.set(user.id, user);
      }
    }
    const passwd = [
      "root:*:0:0:root:/root:/bin/sh",
      "sshd:*:65534:65534:sshd:/var/empty:/bin/false",
    ];
    const currentLogins = new Set();
    for (const user of accounts.values()) {
      const keys = sshKeysForUser(user, access.entries[user.id]);
      const login = sshLogin(user.id);
      currentLogins.add(login);
      if (keys.length) {
        passwd.push(`${login}:*:1000:1000:workspace:/nonexistent:/bin/false`);
      }
      const options = `restrict,port-forwarding,permitopen="${workspaceContainer(user.id)}:2222"`;
      await atomicFile(
        path.join(this.entryDir, "keys", login),
        keys.map((key) => options + " " + key).join("\n") +
          (keys.length ? "\n" : ""),
      );
    }
    for (const login of await readdir(path.join(this.entryDir, "keys"))) {
      if (/^u_[a-z2-7]{26}$/.test(login) && !currentLogins.has(login)) {
        await atomicFile(path.join(this.entryDir, "keys", login), "");
      }
    }
    await atomicFile(
      path.join(this.entryDir, "passwd"),
      passwd.join("\n") + "\n",
    );
    // A manifest is renewed only after its authorized_keys was replaced.
    for (const id of await readdir(this.authDir)) {
      if (!uuid.test(id)) {
        continue;
      }
      const directory = path.join(this.authDir, id);
      await ownedDirectory(directory);
      const user = accounts.get(id);
      const keys = sshKeysForUser(user, access.entries[id]);
      await atomicFile(
        path.join(directory, "authorized_keys"),
        keys.join("\n") + (keys.length ? "\n" : ""),
      );
      await atomicFile(
        path.join(directory, "access.json"),
        JSON.stringify({
          enabled: keys.length > 0,
          revision: sshAccessRevision(user, access.entries[id]),
          expiresAt: Date.now() + SSH_LEASE_MS,
        }),
      );
    }
    await atomicFile(
      path.join(this.entryDir, "access.json"),
      JSON.stringify({
        enabled: true,
        revision: createHash("sha256")
          .update(this.entryFingerprint)
          .digest("hex"),
        expiresAt: Date.now() + SSH_LEASE_MS,
      }),
    );
  }
}
