import { createHash } from "node:crypto";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_SSH_KEYS = 10;
export const WORKSPACE_SSH_PORT = 2222;

// A reversible UUID encoding gives NSS a short, unique account name. Neither
// a client-supplied hostname nor a truncated identifier selects an account.
export function sshLogin(id) {
  if (!uuid.test(id)) {
    throw new Error("Invalid SSH account");
  }
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0,
    value = 0,
    result = "u_";
  for (const byte of Buffer.from(id.replace(/-/g, ""), "hex")) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) {
    result += alphabet[(value << (5 - bits)) & 31];
  }
  return result;
}

export function workspaceContainer(id) {
  if (!uuid.test(id)) {
    throw new Error("Invalid workspace owner");
  }
  return "dev-mcp-workspace-" + id;
}

// Accept a single plain public key, never authorized_keys options, private
// keys or certificates. Inspect the SSH wire format before persisting it.
export function parseSshPublicKey(value) {
  const invalid = () => {
    throw new Error(
      "Ed25519, RSA (2048비트 이상), ECDSA 공개키 한 개를 입력해 주세요.",
    );
  };
  if (typeof value !== "string" || value.length > 8192) {
    invalid();
  }
  const text = value.trim();
  if (/[\0-\x1f\x7f]/.test(text)) {
    invalid();
  }
  const match =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: +[^\r\n]*)?$/.exec(
      text,
    );
  if (!match) {
    invalid();
  }
  const [_, type, encoded] = match;
  const blob = Buffer.from(encoded, "base64");
  if (
    blob.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    invalid();
  }
  let offset = 0;
  const field = () => {
    if (offset + 4 > blob.length) {
      invalid();
    }
    const length = blob.readUInt32BE(offset);
    offset += 4;
    if (length > blob.length - offset) {
      invalid();
    }
    const result = blob.subarray(offset, offset + length);
    offset += length;
    return result;
  };
  if (field().toString("utf8") !== type) {
    invalid();
  }
  if (type === "ssh-ed25519") {
    if (field().length !== 32) {
      invalid();
    }
  } else if (type === "ssh-rsa") {
    const exponent = field();
    const modulus = field();
    if (
      !exponent.length ||
      exponent.length > 8 ||
      exponent[0] & 0x80 ||
      !modulus.length ||
      modulus[0] & 0x80
    ) {
      invalid();
    }
    const positive = modulus[0] === 0 ? modulus.subarray(1) : modulus;
    const bits = positive.length * 8 - Math.clz32(positive[0] ?? 0) + 24;
    if (bits < 2048 || bits > 8192) {
      invalid();
    }
  } else {
    const curve = type.slice("ecdsa-sha2-".length);
    const point = field(); // curve name
    if (point.toString("utf8") !== curve) {
      invalid();
    }
    const publicPoint = field();
    const size = { nistp256: 65, nistp384: 97, nistp521: 133 }[curve];
    if (publicPoint.length !== size || publicPoint[0] !== 4) {
      invalid();
    }
  }
  if (offset !== blob.length) {
    invalid();
  }
  return {
    publicKey: type + " " + blob.toString("base64"),
    fingerprint:
      "SHA256:" +
      createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
  };
}

export function validSshAccess(entry) {
  if (
    !entry ||
    !uuid.test(entry.revision) ||
    !Number.isSafeInteger(entry.authVersion) ||
    entry.authVersion < 1 ||
    !Array.isArray(entry.keys) ||
    entry.keys.length > MAX_SSH_KEYS
  ) {
    return false;
  }
  const ids = new Set();
  const fingerprints = new Set();
  try {
    for (const key of entry.keys) {
      if (
        !key ||
        !uuid.test(key.id) ||
        typeof key.name !== "string" ||
        key.name.length > 80 ||
        /[\0-\x1f\x7f]/.test(key.name) ||
        !Number.isSafeInteger(key.createdAt) ||
        ids.has(key.id)
      ) {
        return false;
      }
      const parsed = parseSshPublicKey(key.publicKey);
      if (
        parsed.publicKey !== key.publicKey ||
        parsed.fingerprint !== key.fingerprint ||
        fingerprints.has(key.fingerprint)
      ) {
        return false;
      }
      ids.add(key.id);
      fingerprints.add(key.fingerprint);
    }
    return true;
  } catch {
    return false;
  }
}

export function sshKeysForUser(user, entry) {
  return user?.status === "active" &&
    user.runner === user.id &&
    validSshAccess(entry) &&
    entry.authVersion === user.authVersion
    ? entry.keys.map((key) => key.publicKey)
    : [];
}

// The page shows readiness only for an observed matching key set.
export function sshAccessRevision(user, entry) {
  return createHash("sha256")
    .update(JSON.stringify(sshKeysForUser(user, entry)))
    .digest("hex");
}
