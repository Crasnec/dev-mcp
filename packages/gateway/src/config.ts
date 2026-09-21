import path from "node:path";
import { readFileSync } from "node:fs";

export const ALL_SCOPES = [
  "workspace:read",
  "workspace:write",
  "command:run",
  "command:network",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export interface GatewayConfig {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  runnerSocket: string;
  userRunnerSocketDir?: string;
  adminPasswordHash: string;
  google?: { clientId: string; clientSecret: string };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const port = Number(env.PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT is invalid");
  }
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  if (!publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL is required");
  }
  const url = new URL(publicBaseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  ) {
    throw new Error(
      "PUBLIC_BASE_URL must use HTTPS (HTTP is allowed only for local tests)",
    );
  }
  if (!env.ADMIN_PASSWORD_HASH) {
    throw new Error("ADMIN_PASSWORD_HASH is required");
  }
  const clientId = credential(env, "GOOGLE_CLIENT_ID");
  const clientSecret = credential(env, "GOOGLE_CLIENT_SECRET");
  if (!!clientId !== !!clientSecret) {
    throw new Error("Google client ID and secret must both be configured");
  }
  return {
    port,
    publicBaseUrl,
    dataDir: path.resolve(env.GATEWAY_DATA_DIR ?? "/var/lib/dev-mcp"),
    runnerSocket: path.resolve(env.RUNNER_SOCKET ?? "/ipc/runner.sock"),
    userRunnerSocketDir: path.resolve(
      env.USER_RUNNER_SOCKET_DIR ?? "/user-ipc",
    ),
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
    ...(clientId && clientSecret ? { google: { clientId, clientSecret } } : {}),
  };
}

function credential(env: NodeJS.ProcessEnv, name: string): string {
  if (env[name] && env[name + "_FILE"]) {
    throw new Error(name + " and its _FILE setting cannot be combined");
  }
  try {
    const value = env[name + "_FILE"]
      ? readFileSync(env[name + "_FILE"]!, "utf8").trim()
      : (env[name] ?? "").trim();
    if (
      (env[name + "_FILE"] && !value) ||
      value.length > 4096 ||
      /\s/.test(value)
    ) {
      throw new Error("Invalid credential");
    }
    return value;
  } catch {
    // Never include file contents or underlying errors in logs.
    throw new Error(
      name + " could not be loaded; check the credential configuration",
    );
  }
}
