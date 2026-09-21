import { readFileSync } from "node:fs";
import type { Request, Response } from "express";
import { renderView } from "./views.ts";
import { sendPage } from "./pages.ts";
import type { User } from "./user-store.ts";

interface NavItem {
  key: string;
  href: string;
  label: string;
  mark: string;
  description: string;
}
export type AdminSession = { user: User; csrf: string };

export function adminView(
  req: Request,
  res: Response,
  section: string,
  template: string,
  data: Record<string, unknown> = {},
  status = 200,
): Response {
  const navigation = JSON.parse(
    readFileSync(
      new URL("../views/admin/navigation.json", import.meta.url),
      "utf8",
    ),
  ) as NavItem[];
  const current =
    navigation.find((item) => item.key === section) ?? navigation[0]!;
  const session = res.locals.admin as AdminSession;
  return sendPage(
    res,
    status,
    renderView(
      template,
      {
        title: current.label,
        description: current.description,
        sectionHref: current.href,
        csrf: session.csrf,
        actor: {
          ...session.user,
          username: session.user.email ?? session.user.username,
        },
        navigation: navigation.map((item) => ({
          ...item,
          active: item.key === section,
        })),
        notice:
          req.query.saved === "1" ? "변경 사항을 저장했습니다." : undefined,
        ...data,
      },
      "layouts/admin",
    ),
    ["'self'"],
  );
}

export function dateLabel(value: number | string | undefined): string {
  if (value === undefined) {
    return "기록 없음";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "기록 없음"
    : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function query(req: Request, key: string): string {
  return typeof req.query[key] === "string" ? req.query[key].slice(0, 200) : "";
}

export function pageOf<T>(items: T[], req: Request, pageKey = "page") {
  const pages = Math.max(1, Math.ceil(items.length / 25));
  const raw = Number(query(req, pageKey));
  const page = Math.max(
    1,
    Math.min(pages, Number.isSafeInteger(raw) ? raw : 1),
  );
  const link = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string" && key !== "saved") {
        params.set(key, value);
      }
    }
    params.set(pageKey, String(target));
    return req.baseUrl + req.path + "?" + params.toString();
  };
  return {
    rows: items.slice((page - 1) * 25, page * 25),
    pagination: {
      page,
      pages,
      total: items.length,
      previous: page > 1 ? link(page - 1) : undefined,
      next: page < pages ? link(page + 1) : undefined,
    },
  };
}

export const statusLabel = (status: string) =>
  ({
    pending: "승인 대기",
    active: "사용 중",
    disabled: "사용 중지",
    running: "실행 중",
    stopped: "종료됨",
    exited: "완료",
  })[status] ?? status;
export const userRow = (user: User) => ({
  ...user,
  username: user.email ?? user.username,
  statusLabel: statusLabel(user.status),
  roleLabel: user.role === "admin" ? "관리자" : "사용자",
  createdLabel: dateLabel(user.createdAt),
  href: "/admin/users/" + user.id,
});
