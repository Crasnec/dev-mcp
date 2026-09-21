import { createHmac, timingSafeEqual } from "node:crypto";

export interface MediaClaims {
  v: 1;
  projectId: string;
  path: string;
  actor: string;
  userId: string;
  authVersion: number;
  expiresAt: number;
}

export const MEDIA_URL_TTL_MS = 10 * 60_000;

export function createMediaUrl(
  publicBaseUrl: string,
  secret: string,
  input: Omit<MediaClaims, "v" | "expiresAt">,
  now = Date.now(),
): { url: string; expiresAt: number } {
  const expiresAt = now + MEDIA_URL_TTL_MS;
  const claims: MediaClaims = { v: 1, ...input, expiresAt };
  const token = signClaims(secret, claims);
  return {
    url: `${publicBaseUrl}/media/${token}`,
    expiresAt,
  };
}

export function verifyMediaToken(
  secret: string,
  token: string,
  now = Date.now(),
): MediaClaims | undefined {
  const [encoded, encodedSignature] = token.split(".");
  if (!encoded || !encodedSignature) {
    return undefined;
  }
  const expected = signature(secret, encoded);
  const actual = Buffer.from(encodedSignature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<MediaClaims>;
    const expiresAt = claims.expiresAt;
    if (
      claims.v !== 1 ||
      typeof claims.projectId !== "string" ||
      typeof claims.path !== "string" ||
      typeof claims.actor !== "string" ||
      typeof claims.userId !== "string" ||
      !claims.userId ||
      !Number.isSafeInteger(claims.authVersion) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      claims.projectId.length === 0 ||
      claims.path.length === 0 ||
      claims.actor.length === 0 ||
      claims.path.includes("\0")
    ) {
      return undefined;
    }
    return {
      v: 1,
      projectId: claims.projectId,
      path: claims.path,
      actor: claims.actor,
      userId: claims.userId,
      authVersion: claims.authVersion!,
      expiresAt,
    };
  } catch {
    return undefined;
  }
}

function signClaims(secret: string, claims: MediaClaims): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

function signature(secret: string, encoded: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}
