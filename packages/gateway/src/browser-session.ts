import type { Request } from "express";
import type { GatewayConfig } from "./config.ts";
import type { UserStore } from "./user-store.ts";

export function browserSession(config: GatewayConfig, users: UserStore) {
  const secure = config.publicBaseUrl.startsWith("https:");
  const sessionCookie = secure ? "__Host-dev-mcp-session" : "dev-mcp-session";
  const formCookie = secure ? "__Host-dev-mcp-form" : "dev-mcp-form";
  const cookieOptions = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
  };
  return {
    sessionCookie,
    formCookie,
    cookieOptions,
    current: (req: Request) => users.session(cookie(req, sessionCookie)),
    validCsrf: (req: Request, expected: string) =>
      !!expected &&
      typeof req.body?.csrf === "string" &&
      req.body.csrf === expected &&
      (!req.headers.origin ||
        req.headers.origin === new URL(config.publicBaseUrl).origin),
  };
}
export function cookie(req: Request, name: string): string {
  const value = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="));
  return value?.slice(name.length + 1) ?? "";
}
export function field(req: Request, name: string): string {
  return typeof req.body?.[name] === "string" ? req.body[name] : "";
}
