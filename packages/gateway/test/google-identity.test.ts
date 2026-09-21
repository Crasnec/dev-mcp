import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GoogleLogin, verifyGoogleIdentity } from "../src/google-login.ts";
import { loadConfig } from "../src/config.ts";
import { pkceChallenge } from "../src/crypto.ts";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Google OIDC verification", () => {
  it("validates signatures, issuer, audience, nonce, expiry, authorized party and verified email", async () => {
    const pair = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const claims: JWTPayload = {
      iss: "https://accounts.google.com",
      aud: "client",
      sub: "subject",
      nonce: "nonce",
      email: "Alice@example.test",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const sign = (value: JWTPayload) =>
      new SignJWT(value)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .sign(pair.privateKey);
    expect(
      await verifyGoogleIdentity(await sign(claims), "client", "nonce", keys),
    ).toEqual({ sub: "subject", email: "alice@example.test" });
    for (const change of [
      { iss: "https://evil.test" },
      { aud: "another-client" },
      { nonce: "other-nonce" },
      { email_verified: false },
      { email_verified: "true" },
      { exp: 1 },
      { iat: 1 },
      { azp: "other-client" },
      { aud: ["client", "other-client"] },
      { sub: "" },
      { email: "not-an-email" },
    ]) {
      await expect(
        verifyGoogleIdentity(
          await sign({ ...claims, ...change }),
          "client",
          "nonce",
          keys,
        ),
      ).rejects.toThrow();
    }
    for (const missing of [
      "exp",
      "iat",
      "sub",
      "nonce",
      "email",
      "email_verified",
    ]) {
      const value = { ...claims };
      delete value[missing];
      await expect(
        verifyGoogleIdentity(await sign(value), "client", "nonce", keys),
      ).rejects.toThrow();
    }
    const wrong = await generateKeyPair("RS256");
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(wrong.privateKey);
    await expect(
      verifyGoogleIdentity(forged, "client", "nonce", keys),
    ).rejects.toThrow();
    await expect(
      verifyGoogleIdentity("not-a-token", "client", "nonce", keys),
    ).rejects.toThrow();
  });

  it("uses PKCE and a fixed callback, sends credentials only in the token POST, and sanitizes errors", async () => {
    const client = new GoogleLogin(
      { clientId: "client", clientSecret: "hidden-secret" },
      "https://dev.example.test/auth/google/callback",
    );
    const url = new URL(client.authorizationUrl("state", "nonce", "verifier"));
    expect(url.searchParams.get("code_challenge")).toBe(
      pkceChallenge("verifier"),
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://dev.example.test/auth/google/callback",
    );
    expect(url.toString()).not.toContain("hidden-secret");
    const fetcher = vi.fn(
      async () => new Response("secret provider details", { status: 400 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(client.exchange("code", "nonce", "verifier")).rejects.toThrow(
      "Google token exchange failed",
    );
    const [endpoint, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("https://oauth2.googleapis.com/token");
    expect(options.redirect).toBe("error");
    expect((options.body as URLSearchParams).get("client_secret")).toBe(
      "hidden-secret",
    );
    expect((options.body as URLSearchParams).get("code_verifier")).toBe(
      "verifier",
    );
    expect(options.method).toBe("POST");
  });

  it("loads trimmed file credentials without exposing values in configuration errors", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "mcp-google-config-"),
    );
    temporary.push(directory);
    const idFile = path.join(directory, "id.txt"),
      secretFile = path.join(directory, "secret.txt");
    await writeFile(idFile, "fake-client\n");
    await writeFile(secretFile, "fake-secret\n");
    const env = {
      PUBLIC_BASE_URL: "https://dev.example.test",
      ADMIN_PASSWORD_HASH: "fake",
      GOOGLE_CLIENT_ID_FILE: idFile,
      GOOGLE_CLIENT_SECRET_FILE: secretFile,
    };
    expect(loadConfig(env).google).toEqual({
      clientId: "fake-client",
      clientSecret: "fake-secret",
    });
    expect(() =>
      loadConfig({ ...env, GOOGLE_CLIENT_SECRET: "sensitive-value" }),
    ).toThrow("cannot be combined");
    await writeFile(secretFile, "sensitive invalid contents");
    expect(() => loadConfig(env)).toThrow(
      "GOOGLE_CLIENT_SECRET could not be loaded",
    );
  });
});
