import path from "node:path";
import type { Scope } from "./config.ts";
import { JsonStore } from "./json-store.ts";
import { pkceChallenge, randomToken, tokenHash } from "./crypto.ts";

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}
interface PendingAuthorization {
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
}
interface AccessToken {
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
  createdAt: number;
}
interface RefreshToken {
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
  createdAt: number;
}
interface Database {
  clients: OAuthClient[];
  pending: Record<string, PendingAuthorization>;
  codes: Record<string, AuthorizationCode>;
  accessTokens: Record<string, AccessToken>;
  refreshTokens: Record<string, RefreshToken>;
}

export interface TokenInfo {
  tokenHash: string;
  clientId: string;
  scopes: Scope[];
  expiresAt: number;
}

export class AuthStore {
  private readonly store: JsonStore<Database>;
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

  async createCode(pending: PendingAuthorization): Promise<string> {
    const code = randomToken();
    await this.store.update((db) => {
      cleanup(db);
      db.codes[tokenHash(code)] = {
        ...pending,
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
  }): Promise<{ scopes: Scope[] } | undefined> {
    return this.store.update((db) => {
      cleanup(db);
      const key = tokenHash(input.code);
      const code = db.codes[key];
      if (
        !code ||
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
      return { scopes: code.scopes };
    });
  }

  async issueTokens(
    clientId: string,
    scopes: Scope[],
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const accessToken = randomToken();
    const refreshToken = randomToken(48);
    const now = Date.now();
    await this.store.update((db) => {
      cleanup(db);
      db.accessTokens[tokenHash(accessToken)] = {
        clientId,
        scopes,
        createdAt: now,
        expiresAt: now + 15 * 60_000,
      };
      db.refreshTokens[tokenHash(refreshToken)] = {
        clientId,
        scopes,
        createdAt: now,
        expiresAt: now + 30 * 24 * 60 * 60_000,
      };
    });
    return { accessToken, refreshToken, expiresIn: 15 * 60 };
  }

  async refresh(input: {
    refreshToken: string;
    clientId: string;
    requestedScopes?: Scope[];
  }): Promise<
    | {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        scopes: Scope[];
      }
    | undefined
  > {
    let scopes: Scope[] | undefined;
    const valid = await this.store.update((db) => {
      cleanup(db);
      const key = tokenHash(input.refreshToken);
      const token = db.refreshTokens[key];
      if (
        !token ||
        token.clientId !== input.clientId ||
        token.expiresAt <= Date.now()
      ) {
        return false;
      }
      if (
        input.requestedScopes &&
        input.requestedScopes.some((scope) => !token.scopes.includes(scope))
      ) {
        return false;
      }
      scopes = input.requestedScopes ?? token.scopes;
      delete db.refreshTokens[key];
      return true;
    });
    if (!valid || !scopes) {
      return undefined;
    }
    const issued = await this.issueTokens(input.clientId, scopes);
    return { ...issued, scopes };
  }

  async access(rawToken: string): Promise<TokenInfo | undefined> {
    const hash = tokenHash(rawToken);
    const token = (await this.store.read()).accessTokens[hash];
    if (!token || token.expiresAt <= Date.now()) {
      return undefined;
    }
    return {
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
