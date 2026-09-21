import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "../src/json-store.ts";
import { hashPassword } from "../src/crypto.ts";
import type { User, UserStore } from "../src/user-store.ts";

// Migration fixture only: production has no password signup API.
export async function legacyUser(
  users: UserStore,
  dataDir: string,
  username: string,
  password: string,
): Promise<User> {
  await users.initialize();
  const id = randomUUID();
  const user: User = {
    id,
    username,
    role: "user",
    status: "pending",
    runner: id,
    authVersion: 1,
    createdAt: Date.now(),
  };
  const passwordHash = await hashPassword(password);
  const store = new JsonStore<{
    users: Array<User & { passwordHash?: string }>;
    sessions: Record<string, unknown>;
  }>(path.join(dataDir, "users.json"), () => ({ users: [], sessions: {} }));
  await store.update((db) => {
    db.users.push({ ...user, passwordHash });
  });
  return user;
}
