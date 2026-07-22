import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, expectedText] =
    encoded.split(":");
  if (
    algorithm !== "scrypt" ||
    !nText ||
    !rText ||
    !pText ||
    !saltText ||
    !expectedText
  ) {
    return false;
  }
  const N = Number(nText),
    r = Number(rText),
    p = Number(pText);
  if (N !== 16384 || r !== 8 || p !== 1) {
    return false;
  }
  const expected = Buffer.from(expectedText, "base64url");
  if (expected.length !== 32) {
    return false;
  }
  try {
    const actual = await new Promise<Buffer>((resolve, reject) => {
      nodeScrypt(
        password,
        Buffer.from(saltText, "base64url"),
        expected.length,
        { N, r, p, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
