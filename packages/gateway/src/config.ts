import path from "node:path";

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
  adminPasswordHash: string;
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
  return {
    port,
    publicBaseUrl,
    dataDir: path.resolve(env.GATEWAY_DATA_DIR ?? "/var/lib/dev-mcp"),
    runnerSocket: path.resolve(env.RUNNER_SOCKET ?? "/ipc/runner.sock"),
    adminPasswordHash: env.ADMIN_PASSWORD_HASH,
  };
}
