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

export function managementShell(
  user: User,
  csrf: string,
  section: string,
): Record<string, unknown> {
  const allNavigation = JSON.parse(
    readFileSync(
      new URL("../views/admin/navigation.json", import.meta.url),
      "utf8",
    ),
  ) as NavItem[];
  const allowedNavigation =
    user.role === "admin"
      ? allNavigation
      : allNavigation.filter((item) => item.key === "account");
  const current = allowedNavigation.find((item) => item.key === section);
  if (!current) {
    throw new Error("사용할 수 없는 관리 화면입니다.");
  }
  const isAdmin = user.role === "admin";
  return {
    title: current.label,
    description: current.description,
    sectionHref: current.href,
    managementHref: isAdmin ? "/admin" : "/account",
    workspaceLabel: isAdmin ? "관리 워크스페이스" : "내 워크스페이스",
    isAdmin,
    csrf,
    actor: {
      username: user.email ?? user.username,
      roleLabel: isAdmin ? "서비스 관리자" : "일반 사용자",
    },
    navigation: allowedNavigation.map((item) => ({
      ...item,
      active: item.key === section,
    })),
  };
}

export function adminView(
  req: Request,
  res: Response,
  section: string,
  template: string,
  data: Record<string, unknown> = {},
  status = 200,
): Response {
  const session = res.locals.admin as AdminSession;
  return sendPage(
    res,
    status,
    renderView(
      template,
      {
        ...managementShell(session.user, session.csrf, section),
        refreshHref: currentPageHref(req),
        notice:
          req.query.saved === "1" ? "변경 사항을 저장했습니다." : undefined,
        ...data,
      },
      "layouts/admin",
    ),
    ["'self'"],
  );
}

function currentPageHref(req: Request): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string" && key !== "saved" && key !== "detail") {
      params.set(key, value);
    }
  }
  const suffix = params.toString();
  return req.baseUrl + req.path + (suffix ? "?" + suffix : "");
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
      if (typeof value === "string" && key !== "saved" && key !== "detail") {
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
      pageItems: paginationItems(page, pages, link),
    },
  };
}

function paginationItems(
  currentPage: number,
  totalPages: number,
  link: (page: number) => string,
) {
  const visiblePages = new Set<number>();
  if (totalPages <= 7) {
    for (let page = 1; page <= totalPages; page += 1) {
      visiblePages.add(page);
    }
  } else if (currentPage <= 4) {
    for (let page = 1; page <= 5; page += 1) {
      visiblePages.add(page);
    }
    visiblePages.add(totalPages);
  } else if (currentPage >= totalPages - 3) {
    visiblePages.add(1);
    for (let page = totalPages - 4; page <= totalPages; page += 1) {
      visiblePages.add(page);
    }
  } else {
    for (const page of [
      1,
      currentPage - 1,
      currentPage,
      currentPage + 1,
      totalPages,
    ]) {
      visiblePages.add(page);
    }
  }

  const items: Array<
    | { gap: true }
    | {
        isPage: true;
        label: string;
        href: string;
        current: boolean;
      }
  > = [];
  let previousPage = 0;
  for (const page of [...visiblePages].sort((left, right) => left - right)) {
    if (previousPage && page - previousPage > 1) {
      items.push({ gap: true });
    }
    items.push({
      isPage: true,
      label: String(page),
      href: link(page),
      current: page === currentPage,
    });
    previousPage = page;
  }
  return items;
}

type SortDirection = "asc" | "desc";
type SortValue = string | number | boolean | null | undefined;

export interface SortColumn<T> {
  key: string;
  label: string;
  value: (item: T) => SortValue;
  initialDirection?: SortDirection;
}

interface SortOptions {
  defaultKey?: string;
  defaultDirection?: SortDirection;
  sortKey?: string;
  directionKey?: string;
  pageKey?: string;
}

const sortCollator = new Intl.Collator("ko", {
  numeric: true,
  sensitivity: "base",
});

export function sortList<T>(
  items: T[],
  req: Request,
  columns: SortColumn<T>[],
  options: SortOptions = {},
) {
  if (columns.length === 0) {
    throw new Error("정렬 가능한 열이 필요합니다.");
  }
  const sortKey = options.sortKey ?? "sort";
  const directionKey = options.directionKey ?? "direction";
  const pageKey = options.pageKey ?? "page";
  const defaultColumn =
    columns.find((column) => column.key === options.defaultKey) ?? columns[0]!;
  const requestedColumn = columns.find(
    (column) => column.key === query(req, sortKey),
  );
  const column = requestedColumn ?? defaultColumn;
  const requestedDirection = query(req, directionKey);
  const direction: SortDirection =
    requestedColumn &&
    (requestedDirection === "asc" || requestedDirection === "desc")
      ? requestedDirection
      : (column.initialDirection ?? options.defaultDirection ?? "asc");

  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftValue = column.value(left.item);
      const rightValue = column.value(right.item);
      const leftMissing = leftValue === null || leftValue === undefined;
      const rightMissing = rightValue === null || rightValue === undefined;
      if (leftMissing || rightMissing) {
        return leftMissing === rightMissing
          ? left.index - right.index
          : leftMissing
            ? 1
            : -1;
      }
      const compared = compareSortValues(leftValue, rightValue);
      return (
        (direction === "asc" ? compared : -compared) || left.index - right.index
      );
    })
    .map(({ item }) => item);

  const headers = Object.fromEntries(
    columns.map((entry) => {
      const active = entry.key === column.key;
      const nextDirection: SortDirection = active
        ? direction === "asc"
          ? "desc"
          : "asc"
        : (entry.initialDirection ?? "asc");
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) {
        if (
          typeof value === "string" &&
          key !== "saved" &&
          key !== "detail" &&
          key !== sortKey &&
          key !== directionKey &&
          key !== pageKey
        ) {
          params.set(key, value);
        }
      }
      params.set(sortKey, entry.key);
      params.set(directionKey, nextDirection);
      return [
        entry.key,
        {
          label: entry.label,
          href: req.baseUrl + req.path + "?" + params.toString(),
          active,
          ascending: active && direction === "asc",
          descending: active && direction === "desc",
          ariaSort: direction === "asc" ? "ascending" : "descending",
          stateLabel: active
            ? direction === "asc"
              ? "오름차순 정렬됨"
              : "내림차순 정렬됨"
            : "정렬되지 않음",
          actionLabel:
            nextDirection === "asc" ? "오름차순으로 정렬" : "내림차순으로 정렬",
        },
      ];
    }),
  );

  return {
    items: sorted,
    headers,
    state: { key: column.key, direction, sortKey, directionKey },
  };
}

function compareSortValues(left: SortValue, right: SortValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return sortCollator.compare(String(left), String(right));
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
