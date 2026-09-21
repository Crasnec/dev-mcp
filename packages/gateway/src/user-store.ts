import path from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json-store.ts";
import type { GoogleIdentity } from "./google-login.ts";
import {
  hashPassword,
  randomToken,
  tokenHash,
  verifyPassword,
} from "./crypto.ts";

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
  passwordLogin?: boolean;
}
interface StoredUser extends User {
  passwordHash?: string;
  googleSub?: string;
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
  private ready: Promise<void> | undefined;

  constructor(
    dataDir: string,
    private readonly bootstrapPasswordHash: string,
  ) {
    this.store = new JsonStore(path.join(dataDir, "users.json"), () => ({
      users: [],
      sessions: {},
    }));
  }

  initialize(): Promise<void> {
    this.ready ??= this.store.update((db) => {
      if (db.users.length === 0) {
        db.users.push({
          id: randomUUID(),
          username: "admin",
          role: "admin",
          status: "active",
          runner: "primary",
          authVersion: 1,
          createdAt: Date.now(),
          passwordHash: this.bootstrapPasswordHash,
        });
      }
    });
    return this.ready;
  }

  async list(): Promise<User[]> {
    await this.initialize();
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
    await this.initialize();
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

  async linkGoogle(
    principal: Principal,
    identity: GoogleIdentity,
  ): Promise<User> {
    await this.initialize();
    return this.store.update((db) => {
      const user = db.users.find((entry) => entry.id === principal.userId);
      if (
        !user ||
        user.status !== "active" ||
        user.authVersion !== principal.authVersion
      ) {
        throw new Error("계정 상태가 변경되었습니다. 다시 로그인해 주세요.");
      }
      if (
        user.googleSub ||
        db.users.some((entry) => entry.googleSub === identity.sub)
      ) {
        throw new Error(
          "이미 연결된 Google 계정입니다. 기존 연결은 자동으로 변경하거나 병합하지 않습니다.",
        );
      }
      user.googleSub = identity.sub;
      user.email = identity.email;
      user.authVersion += 1;
      revokeSessions(db, user.id);
      return publicUser(user);
    });
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<User | undefined> {
    await this.initialize();
    const db = await this.store.read();
    const user = db.users.find(
      (entry) => entry.username === username.trim().toLowerCase(),
    );
    // Keep unknown-account password work comparable to a known-account failure.
    const verified = await verifyPassword(
      password,
      user?.passwordHash ?? this.bootstrapPasswordHash,
    );
    if (!user?.passwordHash || !verified || user.status !== "active") {
      return undefined;
    }
    return publicUser(user);
  }

  async update(
    actorId: string,
    id: string,
    changes: {
      role: User["role"];
      status: User["status"];
    },
  ): Promise<User> {
    await this.initialize();
    return this.store.update((db) => {
      requireAdmin(db, actorId);
      const user = db.users.find((entry) => entry.id === id);
      if (!user) {
        throw new Error("사용자를 찾을 수 없습니다.");
      }
      if (
        user.role === "admin" &&
        user.status === "active" &&
        (changes.role !== "admin" || changes.status !== "active") &&
        db.users.filter(
          (entry) => entry.role === "admin" && entry.status === "active",
        ).length === 1
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

  async changePassword(
    id: string,
    current: string,
    password: string,
  ): Promise<void> {
    const user = await this.get(id);
    if (!user || !(await this.authenticate(user.username, current))) {
      throw new Error("현재 비밀번호가 올바르지 않습니다.");
    }
    const passwordHash = await hashPassword(password);
    await this.store.update((db) => {
      const target = db.users.find((entry) => entry.id === id);
      if (
        !target ||
        target.authVersion !== user.authVersion ||
        target.status !== "active"
      ) {
        throw new Error("계정 상태가 변경되었습니다. 다시 로그인해 주세요.");
      }
      target.passwordHash = passwordHash;
      target.authVersion += 1;
      revokeSessions(db, id);
    });
  }

  async revokeAccess(actorId: string, id: string): Promise<void> {
    await this.initialize();
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
    await this.initialize();
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
    await this.initialize();
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
    await this.initialize();
    await this.store.update((db) => {
      delete db.sessions[tokenHash(token)];
    });
  }

  async browserSessions(): Promise<
    Array<{ id: string; userId: string; createdAt?: number; expiresAt: number }>
  > {
    await this.initialize();
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
    await this.initialize();
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
  return {
    ...safe,
    googleLinked: !!googleSub,
    passwordLogin: !!user.passwordHash,
  };
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
