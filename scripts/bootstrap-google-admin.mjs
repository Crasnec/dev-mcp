#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// First administrator for a new installation. The local onboarding calls this
// inside the running gateway; the CLI fallback below requires the gateway to be
// stopped because UserStore's update queue protects one process only.
export async function bootstrapGoogleAdmin({
  users,
  audit,
  userId,
  email,
  actor = "local_operator",
}) {
  if (
    typeof userId !== "string" ||
    !uuid.test(userId) ||
    typeof email !== "string" ||
    !email ||
    email.length > 320 ||
    /\s/.test(email)
  ) {
    throw new Error("Supply an exact pending user UUID and Google email.");
  }
  const accounts = await users.list();
  if (
    accounts.some(
      (user) =>
        user.role === "admin" && user.status === "active" && user.googleLinked,
    )
  ) {
    throw new Error("An active Google administrator already exists.");
  }
  const target = accounts.find((user) => user.id === userId);
  if (
    !target ||
    !target.googleLinked ||
    target.email !== email ||
    target.status !== "pending" ||
    target.role !== "user" ||
    target.runner !== target.id
  ) {
    throw new Error("The selected pending Google account does not match.");
  }
  const user = await users.promoteFirstAdmin(target.id);
  await audit.write({
    event: "bootstrap_google_admin",
    actor,
    userId: user.id,
  });
  return user;
}

async function main() {
  const [confirmation, userId, email, extra] = process.argv.slice(2);
  if (confirmation !== "--gateway-stopped" || !userId || !email || extra) {
    throw new Error(
      "Stop the gateway, then run: node scripts/bootstrap-google-admin.mjs --gateway-stopped <pending-user-UUID> <exact-Google-email>",
    );
  }
  const dataDir = path.resolve(
    process.env.GATEWAY_DATA_DIR ?? "/var/lib/dev-mcp",
  );
  // Never create a new database when the intended data volume is missing.
  const info = await stat(path.join(dataDir, "users.json"));
  if (!info.isFile() || info.size === 0) {
    throw new Error("The existing gateway account database is required.");
  }
  const [{ UserStore }, { AuditLogger }] = await Promise.all([
    import("../packages/gateway/dist/user-store.js"),
    import("../packages/gateway/dist/audit.js"),
  ]);
  const user = await bootstrapGoogleAdmin({
    users: new UserStore(dataDir),
    audit: new AuditLogger(dataDir),
    userId,
    email,
  });
  console.log("Google administrator enabled: " + user.id);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Bootstrap failed.");
    process.exitCode = 1;
  });
}
