import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AuthStore } from "../src/auth-store.ts";
import { pkceChallenge } from "../src/crypto.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("OAuth token lifecycle", () => {
  it("enforces PKCE, one-time codes, refresh rotation, scope narrowing, and revoke", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "mcp-auth-"));
    temporary.push(data);
    const store = new AuthStore(data);
    const client = await store.registerClient("test", [
      "https://chat.example/callback",
    ]);
    const verifier = "v".repeat(64);
    const transaction = await store.createPending({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      scopes: ["workspace:read", "workspace:write"],
      codeChallenge: pkceChallenge(verifier),
      expiresAt: Date.now() + 60_000,
    });
    const pending = await store.consumePending(transaction);
    expect(pending).toBeTruthy();
    const code = await store.createCode(pending!);
    expect(
      await store.exchangeCode({
        code,
        clientId: client.clientId,
        redirectUri: client.redirectUris[0]!,
        verifier: "x".repeat(64),
      }),
    ).toBeUndefined();
    const exchanged = await store.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      verifier,
    });
    expect(exchanged?.scopes).toContain("workspace:write");
    expect(
      await store.exchangeCode({
        code,
        clientId: client.clientId,
        redirectUri: client.redirectUris[0]!,
        verifier,
      }),
    ).toBeUndefined();

    const tokens = await store.issueTokens(client.clientId, exchanged!.scopes);
    expect((await store.access(tokens.accessToken))?.clientId).toBe(
      client.clientId,
    );
    const refreshed = await store.refresh({
      refreshToken: tokens.refreshToken,
      clientId: client.clientId,
      requestedScopes: ["workspace:read"],
    });
    expect(refreshed?.scopes).toEqual(["workspace:read"]);
    expect(
      await store.refresh({
        refreshToken: tokens.refreshToken,
        clientId: client.clientId,
      }),
    ).toBeUndefined();
    await store.revoke(refreshed!.accessToken);
    expect(await store.access(refreshed!.accessToken)).toBeUndefined();
  });

  it("deduplicates concurrent refreshes and tolerates a short retry window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const data = await mkdtemp(path.join(os.tmpdir(), "mcp-auth-refresh-"));
    temporary.push(data);
    const store = new AuthStore(data);
    const client = await store.registerClient("refresh-race", [
      "https://chat.example/callback",
    ]);
    const tokens = await store.issueTokens(client.clientId, [
      "workspace:read",
      "workspace:write",
    ]);
    const input = {
      refreshToken: tokens.refreshToken,
      clientId: client.clientId,
      requestedScopes: ["workspace:read"] as const,
    };

    const [first, second] = await Promise.all([
      store.refresh(input),
      store.refresh(input),
    ]);
    expect(first).toBeTruthy();
    expect(second).toEqual(first);

    const retry = await store.refresh(input);
    expect(retry).toEqual(first);

    vi.advanceTimersByTime(5_001);
    expect(await store.refresh(input)).toBeUndefined();

    const rotatedAgain = await store.refresh({
      refreshToken: first!.refreshToken,
      clientId: client.clientId,
      requestedScopes: ["workspace:read"],
    });
    expect(rotatedAgain).toBeTruthy();
  });

  it("expires authorization codes, access tokens, and refresh tokens at their configured TTLs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const data = await mkdtemp(path.join(os.tmpdir(), "mcp-auth-expiry-"));
    temporary.push(data);
    const store = new AuthStore(data);
    const client = await store.registerClient("expiry", [
      "https://chat.example/callback",
    ]);
    const verifier = "e".repeat(64);
    const code = await store.createCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      scopes: ["workspace:read"],
      codeChallenge: pkceChallenge(verifier),
      expiresAt: Date.now() + 60_000,
    });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(
      await store.exchangeCode({
        code,
        clientId: client.clientId,
        redirectUri: client.redirectUris[0]!,
        verifier,
      }),
    ).toBeUndefined();

    const tokens = await store.issueTokens(client.clientId, ["workspace:read"]);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(await store.access(tokens.accessToken)).toBeUndefined();
    vi.advanceTimersByTime(30 * 24 * 60 * 60_000);
    expect(
      await store.refresh({
        refreshToken: tokens.refreshToken,
        clientId: client.clientId,
      }),
    ).toBeUndefined();
  });
});
