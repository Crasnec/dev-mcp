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
  userRunnerSocketDir?: string;
  runnerStatusDir?: string;
  // Local-only onboarding listener; 0 disables it.
  onboardingPort?: number;
  // Apps are served at https://<name>.<previewDomain> by a separate listener.
  previewDomain?: string;
  previewPort?: number;
  google?: { clientId: string; clientSecret: string };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const port = Number(env.PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT is invalid");
  }
  const onboardingPort = Number(env.ONBOARDING_PORT ?? "3100");
  if (
    !Number.isSafeInteger(onboardingPort) ||
    onboardingPort < 0 ||
    onboardingPort > 65535 ||
    (onboardingPort !== 0 && onboardingPort === port)
  ) {
    throw new Error("ONBOARDING_PORT is invalid");
  }
  const previewPort = Number(env.PREVIEW_PORT ?? "3200");
  if (
    !Number.isSafeInteger(previewPort) ||
    previewPort < 0 ||
    previewPort > 65535 ||
    (previewPort !== 0 && [port, onboardingPort].includes(previewPort))
  ) {
    throw new Error("PREVIEW_PORT is invalid");
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
  const previewDomain = (env.PREVIEW_DOMAIN ?? "").trim().toLowerCase();
  if (previewDomain) {
    validatePreviewDomain(previewDomain, url.hostname);
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
    userRunnerSocketDir: path.resolve(
      env.USER_RUNNER_SOCKET_DIR ?? "/user-ipc",
    ),
    runnerStatusDir: path.resolve(env.RUNNER_STATUS_DIR ?? "/runner-status"),
    onboardingPort,
    previewPort,
    ...(previewDomain ? { previewDomain } : {}),
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

// App pages run arbitrary user code, so they must never share an origin, or a
// parent/child host, with the console.
export function validatePreviewDomain(domain: string, consoleHost: string) {
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(
      domain,
    ) ||
    domain.length > 200
  ) {
    throw new Error(
      "PREVIEW_DOMAIN must be a hostname such as apps.example.net",
    );
  }
  const host = consoleHost.toLowerCase();
  if (
    domain === host ||
    domain.endsWith("." + host) ||
    host.endsWith("." + domain)
  ) {
    throw new Error(
      "PREVIEW_DOMAIN must not be the console host or a parent or child of it",
    );
  }
}
