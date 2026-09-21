import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { GatewayConfig } from "./config.ts";
import { pkceChallenge } from "./crypto.ts";

export interface GoogleIdentity {
  sub: string;
  email: string;
}
export interface GoogleProvider {
  authorizationUrl(state: string, nonce: string, verifier: string): string;
  exchange(
    code: string,
    nonce: string,
    verifier: string,
  ): Promise<GoogleIdentity>;
}

const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 10_000 },
);

export async function verifyGoogleIdentity(
  token: string,
  clientId: string,
  nonce: string,
  keySet: JWTVerifyGetKey = keys,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(token, keySet, {
    algorithms: ["RS256"],
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
    requiredClaims: ["sub", "iat", "exp", "nonce", "email", "email_verified"],
    maxTokenAge: "10m",
  });
  if (
    payload.nonce !== nonce ||
    payload.email_verified !== true ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== clientId) ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 255 ||
    typeof payload.email !== "string" ||
    payload.email.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(payload.email)
  ) {
    throw new Error("Invalid Google identity");
  }
  return { sub: payload.sub, email: payload.email.toLowerCase() };
}

export class GoogleLogin implements GoogleProvider {
  constructor(
    private readonly credentials: NonNullable<GatewayConfig["google"]>,
    private readonly redirectUri: string,
  ) {}

  authorizationUrl(state: string, nonce: string, verifier: string): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  async exchange(
    code: string,
    nonce: string,
    verifier: string,
  ): Promise<GoogleIdentity> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    if (!response.ok) {
      throw new Error("Google token exchange failed");
    }
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== "string" || tokens.id_token.length > 32768) {
      throw new Error("Google ID token is missing");
    }
    // Access/refresh tokens are deliberately neither persisted nor logged.
    return verifyGoogleIdentity(
      tokens.id_token,
      this.credentials.clientId,
      nonce,
    );
  }
}
