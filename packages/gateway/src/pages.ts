import type { Response } from "express";
import type { Scope } from "./config.ts";
import { renderView } from "./views.ts";

const scopeDetails: Record<Scope, { title: string; description: string }> = {
  "workspace:read": {
    title: "작업 공간 읽기",
    description: "등록된 프로젝트, 파일, 검색 결과와 Git 상태를 확인합니다.",
  },
  "workspace:write": {
    title: "작업 공간 변경",
    description: "파일 수정, 프로젝트 등록·삭제와 Git 커밋을 수행합니다.",
  },
  "command:run": {
    title: "명령 실행",
    description: "셸 명령과 백그라운드 프로세스를 실행합니다.",
  },
  "command:network": {
    title: "네트워크 사용",
    description: "저장소를 복제하거나 명령을 통해 외부 서비스와 통신합니다.",
  },
};

export function sendPage(
  res: Response,
  status: number,
  body: string,
  formActions: string[] = [],
): Response {
  const allowedForms =
    formActions.length > 0 ? formActions.join(" ") : "'none'";
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self'; script-src 'self'; form-action ${allowedForms}; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.setHeader("Cache-Control", "no-store");
  // Native same-origin POST forms need their Origin for CSRF validation.
  // no-referrer makes browsers submit Origin: null; cross-origin referrers
  // remain suppressed by same-origin. Non-form pages keep no-referrer.
  res.setHeader(
    "Referrer-Policy",
    formActions.length > 0 ? "same-origin" : "no-referrer",
  );
  return res.status(status).type("html").send(body);
}

export function landingPage(publicBaseUrl: string): string {
  return renderView("auth/landing", {
    title: "작업 공간 연결",
    endpoint: publicBaseUrl + "/mcp",
  });
}

export function authorizationPage(options: {
  transaction: string;
  clientName: string;
  scopes: Scope[];
  authorizationEndpoint: string;
  error?: string;
  username?: string;
  csrf?: string;
  signedInUsername?: string;
  googleEnabled?: boolean;
}): string {
  return renderView("auth/authorize", {
    ...options,
    title: "연결 승인",
    returnTo: "/oauth/consent?transaction=" + options.transaction,
    scopeItems: options.scopes.map((scope) => scopeDetails[scope]),
  });
}

export function errorPage(options: {
  status: number;
  title: string;
  message: string;
  code?: string;
}): string {
  return renderView("auth/error", {
    ...options,
    code: options.code ?? `HTTP ${options.status}`,
  });
}
