#!/usr/bin/env node
// Account-record half of scripts/migrate-primary-runner.sh. Runs inside the
// gateway image as the gateway user while the gateway is stopped, so the
// single-process JSON store has no concurrent writer.
import { constants } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const [operation, file, expectedId, workspace] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!["inspect", "apply"].includes(operation) || !file) {
  fail("Usage: migrate-primary-account.mjs inspect|apply <users.json> [id]");
}
const db = JSON.parse(await readFile(file, "utf8"));
if (!Array.isArray(db.users)) {
  fail("Invalid account database");
}
const legacy = db.users.filter((user) => user.runner === "primary");
if (operation === "inspect") {
  if (legacy.length === 0) {
    console.log(JSON.stringify({ none: true }));
    process.exit(0);
  }
  if (legacy.length !== 1) {
    fail("More than one account uses the primary runner; migrate manually.");
  }
  const [user] = legacy;
  if (user.status !== "active" || !user.googleSub) {
    fail(
      "The primary runner account must be an active Google-linked account; it could not sign in after migration.",
    );
  }
  // An installation root inside the old workspace would be rejected later.
  let root;
  try {
    root = JSON.parse(
      await readFile(new URL("installation.json", "file://" + file), "utf8"),
    ).workspaceRoot;
  } catch {
    // No onboarding state yet.
  }
  if (
    typeof root === "string" &&
    workspace &&
    (root === workspace || root.startsWith(workspace + "/"))
  ) {
    fail(
      `The workspace root ${root} lies inside the primary workspace ${workspace}.`,
    );
  }
  console.log(JSON.stringify({ id: user.id, role: user.role }));
  process.exit(0);
}
const user = legacy.length === 1 ? legacy[0] : undefined;
if (!user || user.id !== expectedId) {
  fail("The primary runner account changed since inspection.");
}
// Keep the first backup if an interrupted attempt is repeated.
await copyFile(
  file,
  file + ".pre-primary-migration",
  constants.COPYFILE_EXCL,
).catch((error) => {
  if (error.code !== "EEXIST") {
    throw error;
  }
});
user.runner = user.id;
delete user.passwordHash;
const temporary = `${file}.${randomUUID()}.tmp`;
await writeFile(temporary, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, file);
console.log(JSON.stringify({ id: user.id, migrated: true }));
