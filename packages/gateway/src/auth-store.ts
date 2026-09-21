import path from "node:path";
import type { Scope } from "./config.ts";
import { JsonStore } from "./json-store.ts";
import { pkceChallenge, randomToken, tokenHash } from "./crypto.ts";
import type { Principal } from "./user-store.ts";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}
interface PendingAuthorization {
  browserBinding?: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  scopes: Scope[];
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
}
interface AuthorizationCode extends PendingAuthorization {
  used: boolean;
  principal: Principal;
}
interface AccessToken extends Principal {
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
  createdAt: number;
}
interface RefreshToken extends Principal {
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
  createdAt: number;
}
interface RefreshedTokens extends Principal {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: Scope[];
}
interface Database {
  clients: OAuthClient[];
  pending: Record<string, PendingAuthorization>;
  codes: Record<string, AuthorizationCode>;
  accessTokens: Record<string, AccessToken>;
  refreshTokens: Record<string, RefreshToken>;
}

export interface TokenInfo extends Principal {
  tokenHash: string;
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
}

const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const REFRESH_RETRY_GRACE_MS = 5_000;

export class AuthStore {
  private readonly store: JsonStore<Database>;
  private readonly refreshInFlight = new Map<
    string,
    Promise<RefreshedTokens | undefined>
  >();
  private readonly recentRefreshes = new Map<
    string,
    { value: RefreshedTokens; expiresAt: number }
  >();

  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "oauth.json"), () => ({
      clients: [],
      pending: {},
      codes: {},
      accessTokens: {},
      refreshTokens: {},
    }));
  }

  async registerClient(
    clientName: string,
    redirectUris: string[],
  ): Promise<OAuthClient> {
    const client: OAuthClient = {
      clientId: randomToken(24),
      clientName,
      redirectUris,
      createdAt: Date.now(),
    };
    await this.store.update((db) => {
      cleanup(db);
      db.clients.push(client);
    });
    return client;
  }

  async client(clientId: string): Promise<OAuthClient | undefined> {
    return (await this.store.read()).clients.find(
      (entry) => entry.clientId === clientId,
    );
  }

  async createPending(value: PendingAuthorization): Promise<string> {
    const transaction = randomToken();
    await this.store.update((db) => {
      cleanup(db);
      db.pending[tokenHash(transaction)] = value;
    });
    return transaction;
  }

  async consumePending(
    transaction: string,
  ): Promise<PendingAuthorization | undefined> {
    return this.store.update((db) => {
      cleanup(db);
      const key = tokenHash(transaction);
      const value = db.pending[key];
      delete db.pending[key];
      return value;
    });
  }

  async pendingAuthorization(
    transaction: string,
  ): Promise<PendingAuthorization | undefined> {
    const value = (await this.store.read()).pending[tokenHash(transaction)];
    return value && value.expiresAt > Date.now() ? value : undefined;
  }

  async createCode(
    pending: PendingAuthorization,
    principal: Principal,
  ): Promise<string> {
    const code = randomToken();
    await this.store.update((db) => {
      cleanup(db);
      db.codes[tokenHash(code)] = {
        ...pending,
        principal,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      };
    });
    return code;
  }

  async exchangeCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
  }): Promise<({ scopes: Scope[] } & Principal) | undefined> {
    return this.store.update((db) => {
      cleanup(db);
      const key = tokenHash(input.code);
      const code = db.codes[key];
      if (
        !code ||
        !code.principal ||
        code.used ||
        code.expiresAt <= Date.now() ||
        code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri
      ) {
        return undefined;
      }
      if (pkceChallenge(input.verifier) !== code.codeChallenge) {
        return undefined;
      }
      code.used = true;
      delete db.codes[key];
      return { scopes: code.scopes, ...code.principal };
    });
  }

  async issueTokens(
    clientId: string,
    scopes: Scope[],
    principal: Principal,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const accessToken = randomToken();
    const refreshToken = randomToken(48);
    const now = Date.now();
    await this.store.update((db) => {
      cleanup(db);
      db.accessTokens[tokenHash(accessToken)] = {
        ...principal,
        clientId,
        scopes,
        createdAt: now,
        expiresAt: now + ACCESS_TOKEN_TTL_MS,
      };
      db.refreshTokens[tokenHash(refreshToken)] = {
        ...principal,
        clientId,
        scopes,
        createdAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
      };
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_MS / 1_000,
    };
  }

  async refresh(input: {
    refreshToken: string;
    clientId: string;
    requestedScopes?: Scope[];
  }): Promise<RefreshedTokens | undefined> {
    const requestKey = refreshRequestKey(input);
    const cached = this.recentRefreshes.get(requestKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return (await this.access(cached.value.accessToken))
          ? cached.value
          : undefined;
      }
      this.recentRefreshes.delete(requestKey);
    }

    const existing = this.refreshInFlight.get(requestKey);
    if (existing) {
      return existing;
    }

    const operation = this.rotateRefresh(input);
    this.refreshInFlight.set(requestKey, operation);
    try {
      const refreshed = await operation;
      if (refreshed) {
        this.rememberRefresh(requestKey, refreshed);
      }
      return refreshed;
    } finally {
      if (this.refreshInFlight.get(requestKey) === operation) {
        this.refreshInFlight.delete(requestKey);
      }
    }
  }

  private rotateRefresh(input: {
    refreshToken: string;
    clientId: string;
    requestedScopes?: Scope[];
  }): Promise<RefreshedTokens | undefined> {
    return this.store.update((db) => {
      cleanup(db);
      const key = tokenHash(input.refreshToken);
      const token = db.refreshTokens[key];
      if (
        !token ||
        !token.userId ||
        !Number.isSafeInteger(token.authVersion) ||
        token.clientId !== input.clientId ||
        token.expiresAt <= Date.now()
      ) {
        return undefined;
      }
      if (
        input.requestedScopes &&
        input.requestedScopes.some((scope) => !token.scopes.includes(scope))
      ) {
        return undefined;
      }

      const scopes = input.requestedScopes ?? token.scopes;
      const accessToken = randomToken();
      const refreshToken = randomToken(48);
      const now = Date.now();

      delete db.refreshTokens[key];
      db.accessTokens[tokenHash(accessToken)] = {
        userId: token.userId,
        authVersion: token.authVersion,
        clientId: input.clientId,
        scopes,
        createdAt: now,
        expiresAt: now + ACCESS_TOKEN_TTL_MS,
      };
      db.refreshTokens[tokenHash(refreshToken)] = {
        userId: token.userId,
        authVersion: token.authVersion,
        clientId: input.clientId,
        scopes,
        createdAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
      };

      return {
        userId: token.userId,
        authVersion: token.authVersion,
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_MS / 1_000,
        scopes,
      };
    });
  }

  private rememberRefresh(requestKey: string, value: RefreshedTokens): void {
    const expiresAt = Date.now() + REFRESH_RETRY_GRACE_MS;
    this.recentRefreshes.set(requestKey, { value, expiresAt });
    const timer = setTimeout(() => {
      const current = this.recentRefreshes.get(requestKey);
      if (current?.expiresAt === expiresAt) {
        this.recentRefreshes.delete(requestKey);
      }
    }, REFRESH_RETRY_GRACE_MS);
    timer.unref();
  }

  async access(rawToken: string): Promise<TokenInfo | undefined> {
    const hash = tokenHash(rawToken);
    const db = await this.store.read();
    const token = db.accessTokens[hash];
    if (
      !token ||
      !db.clients.some((client) => client.clientId === token.clientId) ||
      !token.userId ||
      !Number.isSafeInteger(token.authVersion) ||
      token.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return {
      userId: token.userId,
      authVersion: token.authVersion,
      tokenHash: hash,
      clientId: token.clientId,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
    };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.store.update((db) => {
      const hash = tokenHash(rawToken);
      delete db.accessTokens[hash];
      delete db.refreshTokens[hash];
      cleanup(db);
    });
  }

  async clients(): Promise<OAuthClient[]> {
    return (await this.store.read()).clients;
  }

  async connectionSummary(principals: Principal[]): Promise<
    Array<{
      clientId: string;
      userId: string;
      accessCount: number;
      refreshCount: number;
    }>
  > {
    const db = await this.store.read();
    const versions = new Map(
      principals.map((principal) => [principal.userId, principal.authVersion]),
    );
    const groups = new Map<
      string,
      {
        clientId: string;
        userId: string;
        accessCount: number;
        refreshCount: number;
      }
    >();
    for (const [tokens, kind] of [
      [db.accessTokens, "accessCount"],
      [db.refreshTokens, "refreshCount"],
    ] as const) {
      for (const token of Object.values(tokens)) {
        if (
          token.expiresAt <= Date.now() ||
          !token.userId ||
          versions.get(token.userId) !== token.authVersion
        ) {
          continue;
        }
        const key = token.userId + ":" + token.clientId;
        const group = groups.get(key) ?? {
          clientId: token.clientId,
          userId: token.userId,
          accessCount: 0,
          refreshCount: 0,
        };
        group[kind] += 1;
        groups.set(key, group);
      }
    }
    return [...groups.values()];
  }

  async removeClient(clientId: string): Promise<void> {
    await this.store.update((db) => {
      if (!db.clients.some((client) => client.clientId === clientId)) {
        throw new Error("클라이언트를 찾을 수 없습니다.");
      }
      db.clients = db.clients.filter((client) => client.clientId !== clientId);
      for (const records of [
        db.pending,
        db.codes,
        db.accessTokens,
        db.refreshTokens,
      ]) {
        for (const [key, entry] of Object.entries(records)) {
          if (entry.clientId === clientId) {
            delete records[key];
          }
        }
      }
    });
    for (const [key, value] of this.recentRefreshes) {
      if (!(await this.access(value.value.accessToken))) {
        this.recentRefreshes.delete(key);
      }
    }
  }
}

function refreshRequestKey(input: {
  refreshToken: string;
  clientId: string;
  requestedScopes?: Scope[];
}): string {
  const scopes = input.requestedScopes
    ? [...new Set(input.requestedScopes)].sort().join(" ")
    : "*";
  return `${tokenHash(input.refreshToken)}:${input.clientId}:${scopes}`;
}

function cleanup(db: Database): void {
  const now = Date.now();
  for (const [key, value] of Object.entries(db.pending))
    if (value.expiresAt <= now) {
      delete db.pending[key];
    }
  for (const [key, value] of Object.entries(db.codes))
    if (value.expiresAt <= now || value.used) {
      delete db.codes[key];
    }
  for (const [key, value] of Object.entries(db.accessTokens))
    if (value.expiresAt <= now) {
      delete db.accessTokens[key];
    }
  for (const [key, value] of Object.entries(db.refreshTokens))
    if (value.expiresAt <= now) {
      delete db.refreshTokens[key];
    }
}
