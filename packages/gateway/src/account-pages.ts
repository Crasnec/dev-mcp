import { renderView } from "./views.ts";
import type { User } from "./user-store.ts";

export function credentialsPage(
  kind: "login" | "signup",
  csrf: string,
  error = "",
  settings?: { registrationOpen: boolean; registrationMessage: string },
  googleEnabled = false,
): string {
  const signup = kind === "signup";
  return renderView("auth/credentials", {
    title: signup ? "회원가입" : "로그인",
    signup,
    csrf,
    error,
    action: "/" + kind,
    autocomplete: signup ? "new-password" : "current-password",
    alternateHref: signup ? "/login" : "/signup",
    closed: signup && settings?.registrationOpen === false,
    registrationMessage: signup ? settings?.registrationMessage : "",
    googleEnabled,
  });
}

export function pendingPage(): string {
  return renderView("auth/pending", { title: "승인 대기" });
}

export interface ProjectSummary {
  id: string;
  name: string;
  relativePath: string;
}
export interface RunnerSummary {
  ready: boolean;
  projects: ProjectSummary[];
}

export function accountPage(
  user: User,
  csrf: string,
  summary: RunnerSummary,
  endpoint: string,
  error = "",
  googleEnabled = false,
): string {
  return renderView("auth/account", {
    title: "내 계정",
    wide: true,
    user,
    isAdmin: user.role === "admin",
    csrf,
    summary,
    endpoint,
    error,
    googleEnabled,
    displayName: user.email ?? user.username,
  });
}
