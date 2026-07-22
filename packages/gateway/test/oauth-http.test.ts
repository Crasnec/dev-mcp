import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes, scrypt as nodeScrypt } from "node:crypto";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { pkceChallenge } from "../src/crypto.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      32,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
  return `scrypt:16384:8:1:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

describe("OAuth HTTP endpoints", () => {
  it("runs DCR + authorization code PKCE, rejects redirect mismatch, and revokes", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-oauth-http-"));
    temporary.push(dataDir);
    const password = "a-long-test-password";
    const app = createApp({
      port: 3000,
      publicBaseUrl: "http://127.0.0.1",
      dataDir,
      runnerSocket: path.join(dataDir, "missing.sock"),
      adminPasswordHash: await passwordHash(password),
    });
    const callback = "https://chat.example.test/oauth/callback";

    const invalid = await inject(app, {
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        redirect_uris: ["http://evil.example/callback"],
      }),
    });
    expect(invalid.statusCode).toBe(400);

    const registration = await inject(app, {
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.statusCode).toBe(201);
    const client = registration.json() as { client_id: string };
    const verifier = "p".repeat(64);
    const authorizeQuery = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: callback,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      scope: "workspace:read workspace:write",
      state: "state-123",
    };
    const page = await inject(app, {
      method: "GET",
      url: `/oauth/authorize?${new URLSearchParams(authorizeQuery).toString()}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain(
      "form-action http://127.0.0.1/oauth/authorize",
    );
    expect(page.payload).toContain('action="http://127.0.0.1/oauth/authorize"');
    const transaction = /name="transaction" value="([^"]+)"/.exec(
      page.payload,
    )?.[1];
    expect(transaction).toBeTruthy();

    const approved = await form(app, "/oauth/authorize", {
      transaction: transaction!,
      password,
      decision: "allow",
    });
    expect(approved.statusCode).toBe(302);
    const redirected = new URL(approved.headers.location as string);
    expect(redirected.origin + redirected.pathname).toBe(callback);
    expect(redirected.searchParams.get("state")).toBe("state-123");
    const code = redirected.searchParams.get("code")!;

    const mismatch = await form(app, "/oauth/token", {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: "https://chat.example.test/other",
      code_verifier: verifier,
    });
    expect(mismatch.statusCode).toBe(400);

    const token = await form(app, "/oauth/token", {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
    });
    expect(token.statusCode).toBe(200);
    const issued = token.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(issued.expires_in).toBe(900);
    expect(issued.scope).toContain("workspace:write");

    const challenge = await inject(app, { method: "GET", url: "/mcp" });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.headers["www-authenticate"]).toContain(
      "resource_metadata=",
    );
    const revoked = await form(app, "/oauth/revoke", {
      token: issued.access_token,
    });
    expect(revoked.statusCode).toBe(200);
  });
});

function form(
  app: ReturnType<typeof createApp>,
  url: string,
  values: Record<string, string>,
) {
  return inject(app, {
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(values).toString(),
  });
}
