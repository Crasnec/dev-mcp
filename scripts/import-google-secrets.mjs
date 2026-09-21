#!/usr/bin/env node
// Opaque file copy: never read, print, interpolate, or log credential contents.
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(process.argv[2] ?? path.join(root, "../plan-app"));
const destination = path.join(root, "data/google");
try {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (
    !(await lstat(destination)).isDirectory() ||
    (await lstat(destination)).isSymbolicLink()
  ) {
    throw new Error("Unsafe destination");
  }
  await chmod(destination, 0o700);
  for (const name of ["oauth-id.txt", "oauth-secret.txt"]) {
    const original = path.join(source, name);
    const info = await lstat(original);
    if (!info.isFile() || info.size < 1 || info.size > 4096) {
      throw new Error("Invalid credential file");
    }
    const target = path.join(destination, name);
    await copyFile(original, target, constants.COPYFILE_EXCL);
    // Compose local secrets bind files without remapping UID. The private 0700
    // host directory protects these files; only gateway mounts the individual files.
    await chmod(target, 0o444);
  }
  console.log(
    "Google credential files copied to the private data/google directory. Contents were not displayed.",
  );
} catch {
  console.error(
    "Credential import did not complete. Check source filenames and destination permissions; existing files are never overwritten. No credential contents were displayed.",
  );
  process.exitCode = 1;
}
