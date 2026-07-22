#!/usr/bin/env node
import { randomBytes, scrypt } from "node:crypto";
import { writeFileSync } from "node:fs";

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputPath) {
  console.error("--output requires a file path");
  process.exit(2);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error(
    "This command requires an interactive TTY; passwords are never accepted through arguments or pipes.",
  );
  process.exit(2);
}

async function readHidden(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (input) => {
      for (const character of input) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

try {
  const first = await readHidden("Administrator password: ");
  const second = await readHidden("Confirm password: ");
  if (first !== second) {
    throw new Error("Passwords do not match");
  }
  if (first.length < 14) {
    throw new Error("Use at least 14 characters");
  }
  const N = 16384,
    r = 8,
    p = 1;
  const salt = randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    scrypt(
      first,
      salt,
      32,
      { N, r, p, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
  const encoded = `scrypt:${N}:${r}:${p}:${salt.toString("base64url")}:${key.toString("base64url")}`;
  if (outputPath) {
    writeFileSync(outputPath, `${encoded}\n`, { mode: 0o600 });
    console.log("Administrator password hash generated.");
  } else {
    process.stdout.write(`${encoded}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
