import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "../src/json-store.ts";
import type { User, UserStore } from "../src/user-store.ts";

type Stored = User & { googleSub?: string };

// Production creates every account through Google sign-in with its own runner
// (runner === id). Fixtures write such records directly so tests can choose
// readable usernames.
async function insert(
  dataDir: string,
  username: string,
  role: User["role"],
  status: User["status"],
): Promise<User> {
  const id = randomUUID();
  const user: Stored = {
    id,
    username,
    role,
    status,
    runner: id,
    authVersion: 1,
    createdAt: Date.now(),
    email: username + "@example.test",
    googleSub: "google-" + id,
  };
  const store = new JsonStore<{
    users: Stored[];
    sessions: Record<string, unknown>;
  }>(path.join(dataDir, "users.json"), () => ({ users: [], sessions: {} }));
  await store.update((db) => {
    db.users.push(user);
  });
  const { googleSub: _, ...visible } = user;
  return { ...visible, googleLinked: true };
}

export function adminAccount(
  _users: UserStore,
  dataDir: string,
  username = "admin",
): Promise<User> {
  return insert(dataDir, username, "admin", "active");
}

export function pendingAccount(
  _users: UserStore,
  dataDir: string,
  username: string,
): Promise<User> {
  return insert(dataDir, username, "user", "pending");
}
