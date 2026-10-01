import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json-store.ts";
import type { GoogleIdentity } from "./google-login.ts";
import { randomToken, tokenHash } from "./crypto.ts";

export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "pending" | "active" | "disabled";
  runner: string;
  authVersion: number;
  createdAt: number;
  googleLinked?: boolean;
  email?: string;
}
// Every account is created by Google sign-in and owns a dedicated runner
// (runner === id). Records from older versions may still carry a legacy
// passwordHash or runner "primary" until scripts/migrate-primary-runner.sh runs.
interface StoredUser extends User {
  googleSub?: string;
  passwordHash?: string;
}
export interface Principal {
  userId: string;
  authVersion: number;
}
interface Session extends Principal {
  createdAt?: number;
  expiresAt: number;
  csrf: string;
}
interface Database {
  users: StoredUser[];
  sessions: Record<string, Session>;
}

export class UserStore {
  private readonly store: JsonStore<Database>;

  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "users.json"), () => ({
      users: [],
      sessions: {},
    }));
  }

  async list(): Promise<User[]> {
    return (await this.store.read()).users.map(publicUser);
  }

  async get(id: string): Promise<User | undefined> {
    return (await this.list()).find((user) => user.id === id);
  }

  async valid(principal: Principal): Promise<User | undefined> {
    const user = await this.get(principal.userId);
    return user?.status === "active" &&
      user.authVersion === principal.authVersion
      ? user
      : undefined;
  }

  async googleAccount(
    identity: GoogleIdentity,
    registrationOpen: boolean,
  ): Promise<{ user: User; created: boolean }> {
    return this.store.update((db) => {
      const existing = db.users.find((user) => user.googleSub === identity.sub);
      if (existing) {
        existing.email = identity.email;
        return { user: publicUser(existing), created: false };
      }
      if (!registrationOpen) {
        throw new Error("현재 신규 가입을 받지 않습니다.");
      }
      const id = randomUUID();
      const user: StoredUser = {
        id,
        username: "google-" + id,
        role: "user",
        status: "pending",
        runner: id,
        authVersion: 1,
        createdAt: Date.now(),
        googleSub: identity.sub,
        email: identity.email,
      };
      db.users.push(user);
      return { user: publicUser(user), created: true };
    });
  }

  // Local installer onboarding (or the offline CLI fallback) approves the first
  // administrator; there is no seeded account to act as the approver.
  async promoteFirstAdmin(id: string): Promise<User> {
    return this.store.update((db) => {
      if (db.users.some(signInAdmin)) {
        throw new Error("이미 활성 관리자가 있습니다.");
      }
      const user = db.users.find((entry) => entry.id === id);
      if (
        !user?.googleSub ||
        user.status !== "pending" ||
        user.role !== "user" ||
        user.runner !== user.id
      ) {
        throw new Error(
          "승인 대기 중인 Google 계정만 첫 관리자로 정할 수 있습니다.",
        );
      }
      user.role = "admin";
      user.status = "active";
      user.authVersion += 1;
      revokeSessions(db, id);
      return publicUser(user);
    });
  }

  async update(
    actorId: string,
    id: string,
    changes: {
      role: User["role"];
      status: User["status"];
    },
  ): Promise<User> {
    return this.store.update((db) => {
      requireAdmin(db, actorId);
      const user = db.users.find((entry) => entry.id === id);
      if (!user) {
        throw new Error("사용자를 찾을 수 없습니다.");
      }
      // Only administrators who can sign in count; a leftover legacy account
      // without a Google identity cannot recover access.
      if (
        signInAdmin(user) &&
        (changes.role !== "admin" || changes.status !== "active") &&
        db.users.filter(signInAdmin).length === 1
      ) {
        throw new Error(
          "마지막 관리자는 비활성화하거나 일반 사용자로 변경할 수 없습니다.",
        );
      }
      Object.assign(user, changes);
      user.authVersion += 1;
      revokeSessions(db, id);
      return publicUser(user);
    });
  }

  async revokeAccess(actorId: string, id: string): Promise<void> {
    await this.store.update((db) => {
      requireAdmin(db, actorId);
      const user = db.users.find((entry) => entry.id === id);
      if (!user) {
        throw new Error("사용자를 찾을 수 없습니다.");
      }
      user.authVersion += 1;
      revokeSessions(db, id);
    });
  }

  async createSession(user: User): Promise<{ token: string; csrf: string }> {
    const token = randomToken();
    const csrf = randomToken();
    await this.store.update((db) => {
      const current = db.users.find((entry) => entry.id === user.id);
      if (
        !current ||
        current.status !== "active" ||
        current.authVersion !== user.authVersion
      ) {
        throw new Error("계정 상태가 변경되었습니다. 다시 로그인해 주세요.");
      }
      for (const [key, session] of Object.entries(db.sessions)) {
        if (session.expiresAt <= Date.now()) {
          delete db.sessions[key];
        }
      }
      db.sessions[tokenHash(token)] = {
        createdAt: Date.now(),
        userId: user.id,
        authVersion: user.authVersion,
        csrf,
        expiresAt: Date.now() + 8 * 60 * 60_000,
      };
    });
    return { token, csrf };
  }

  async session(
    token: string,
  ): Promise<{ user: User; csrf: string } | undefined> {
    const db = await this.store.read();
    const session = db.sessions[tokenHash(token)];
    if (!session || session.expiresAt <= Date.now()) {
      return undefined;
    }
    const user = db.users.find((entry) => entry.id === session.userId);
    if (
      !user ||
      user.status !== "active" ||
      user.authVersion !== session.authVersion
    ) {
      return undefined;
    }
    return { user: publicUser(user), csrf: session.csrf };
  }

  async logout(token: string): Promise<void> {
    await this.store.update((db) => {
      delete db.sessions[tokenHash(token)];
    });
  }

  async browserSessions(): Promise<
    Array<{ id: string; userId: string; createdAt?: number; expiresAt: number }>
  > {
    const db = await this.store.read();
    return Object.entries(db.sessions).flatMap(([key, session]) => {
      const user = db.users.find((entry) => entry.id === session.userId);
      if (
        session.expiresAt <= Date.now() ||
        user?.status !== "active" ||
        user.authVersion !== session.authVersion
      ) {
        return [];
      }
      return [
        {
          id: tokenHash(key),
          userId: user.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        },
      ];
    });
  }

  async revokeBrowserSession(actorId: string, id: string): Promise<void> {
    await this.store.update((db) => {
      requireAdmin(db, actorId);
      const key = Object.keys(db.sessions).find((key) => tokenHash(key) === id);
      if (!key) {
        throw new Error("이미 종료되었거나 존재하지 않는 세션입니다.");
      }
      delete db.sessions[key];
    });
  }
}

function publicUser(user: StoredUser): User {
  const { passwordHash: _, googleSub, ...safe } = user;
  return { ...safe, googleLinked: !!googleSub };
}

function signInAdmin(user: StoredUser): boolean {
  return user.role === "admin" && user.status === "active" && !!user.googleSub;
}

function requireAdmin(db: Database, actorId: string): void {
  if (
    !db.users.some(
      (user) =>
        user.id === actorId &&
        user.role === "admin" &&
        user.status === "active",
    )
  ) {
    throw new Error("관리자 권한이 필요합니다.");
  }
}

function revokeSessions(db: Database, id: string): void {
  for (const [key, session] of Object.entries(db.sessions)) {
    if (session.userId === id) {
      delete db.sessions[key];
    }
  }
}
