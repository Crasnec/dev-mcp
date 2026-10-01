import type { Express, Request, Response } from "express";
import type { GatewayConfig } from "./config.ts";
import type { User, UserStore } from "./user-store.ts";
import { browserSession } from "./browser-session.ts";
import { adminView, dateIso } from "./admin-view.ts";
import { errorPage, sendPage } from "./pages.ts";
import {
  RunnerTelemetryStore,
  TELEMETRY_RANGES,
  validTelemetryScope,
  type TelemetryRange,
  type TelemetryMetric,
} from "./telemetry-store.ts";

export function installTelemetryRoutes(
  app: Express,
  config: GatewayConfig,
  users: UserStore,
  telemetry: RunnerTelemetryStore,
): void {
  const browser = browserSession(config, users);

  const authenticate = async (
    req: Request,
    res: Response,
    admin: boolean,
    html = false,
  ) => {
    const session = await browser.current(req);
    if (!session) {
      if (html) {
        res.redirect(303, "/login");
      } else {
        res.status(401).json({ error: "authentication_required" });
      }
      return undefined;
    }
    if (admin && session.user.role !== "admin") {
      if (html) {
        sendPage(
          res,
          403,
          errorPage({
            status: 403,
            title: "관리자 전용 화면입니다",
            message: "내 계정 화면을 이용해 주세요.",
          }),
        );
      } else {
        res.status(403).json({ error: "admin_required" });
      }
      return undefined;
    }
    return session;
  };

  const resolveScope = async (
    scope: string,
  ): Promise<{ scope: string; label: string } | undefined> => {
    if (scope === "host") {
      return { scope, label: "호스트 서버" };
    }
    if (scope === "all-runners") {
      return { scope, label: "전체 실행 환경" };
    }
    if (!validTelemetryScope(scope)) {
      return undefined;
    }
    const owner = await users.get(scope);
    return owner && ownsRunner(owner)
      ? { scope, label: ownerLabel(owner) }
      : undefined;
  };

  app.get("/admin/telemetry", async (req, res) => {
    jsonHeaders(res);
    if (!(await authenticate(req, res, true))) {
      return;
    }
    const range = requestedRange(req);
    if (
      !range ||
      (req.query.scope !== undefined && typeof req.query.scope !== "string")
    ) {
      return res.status(400).json({ error: "invalid_telemetry_query" });
    }
    const selected = await resolveScope(
      typeof req.query.scope === "string" ? req.query.scope : "host",
    );
    if (!selected) {
      return res.status(404).json({ error: "scope_not_found" });
    }
    return res.json(await telemetry.read(selected.scope, range));
  });

  app.get("/account/telemetry", async (req, res) => {
    jsonHeaders(res);
    const session = await authenticate(req, res, false);
    if (!session) {
      return;
    }
    const range = requestedRange(req);
    if (
      !range ||
      req.query.scope !== undefined ||
      req.query.owner !== undefined
    ) {
      return res.status(400).json({ error: "invalid_telemetry_query" });
    }
    if (!ownsRunner(session.user)) {
      return res.status(404).json({ error: "scope_not_found" });
    }
    return res.json(await telemetry.read(session.user.id, range));
  });

  app.get("/admin/usage", async (req, res) => {
    const session = await authenticate(req, res, true, true);
    if (!session) {
      return;
    }
    const range = requestedRange(req);
    const scope =
      typeof req.query.scope === "string" ? req.query.scope : "host";
    const selected = await resolveScope(scope);
    if (!range || !selected) {
      return sendPage(
        res,
        400,
        errorPage({
          status: 400,
          title: "사용량 범위를 확인해 주세요",
          message: "사용할 실행 환경과 조회 기간을 선택해 주세요.",
        }),
      );
    }
    const data = await telemetry.read(scope, range);
    res.locals.admin = session;
    const owners = (await users.list()).filter(ownsRunner);
    const scopes = [
      { value: "host", label: "호스트 서버" },
      { value: "all-runners", label: "전체 실행 환경" },
      ...owners.map((owner) => ({ value: owner.id, label: ownerLabel(owner) })),
    ].map((entry) => ({ ...entry, selected: entry.value === scope }));
    const ranges = Object.entries(TELEMETRY_RANGES).map(([value, entry]) => ({
      value,
      label: entry.label,
      selected: value === range,
    }));
    return adminView(req, res, "usage", "admin/usage", {
      telemetryPage: true,
      telemetryUrl: "/admin/telemetry?" + new URLSearchParams({ scope, range }),
      scopes,
      ranges,
      scopeLabel: selected.label,
      rangeLabel: TELEMETRY_RANGES[range].label,
      telemetryNotice: {
        fresh: "",
        partial: "일부 측정값을 확인할 수 없습니다.",
        stale: "최근 측정이 중단되어 현재 사용량을 확인할 수 없습니다.",
        unavailable: "사용량이 수집되면 여기에 표시됩니다.",
      }[data.current.availability],
      telemetry: data,
      metrics: SSR_METRICS.map(([key, label]) => ({
        key,
        label,
        current: formatMetric(key, data.current.values[key]),
        average: formatMetric(key, data.statistics[key].average),
        max: formatMetric(key, data.statistics[key].max),
        p50: formatPercentile(key, data.statistics[key].p50),
        p95: formatPercentile(key, data.statistics[key].p95),
        p99: formatPercentile(key, data.statistics[key].p99),
        percentileTitle:
          data.statistics[key].percentileRelativeError === null
            ? "분포 기록이 없는 구간의 백분위는 표시되지 않습니다."
            : `근사 백분위 · 상대 오차 상한 ${decimal(data.statistics[key].percentileRelativeError * 100)}%`,
      })),
      totals: [
        {
          key: "cpuSeconds",
          label: "누적 CPU 시간",
          value: formatCpuTime(data.totals.cpuSeconds),
        },
        {
          key: "diskReadBytes",
          label: "디스크 읽기",
          value: formatBytes(data.totals.diskReadBytes),
        },
        {
          key: "diskWriteBytes",
          label: "디스크 쓰기",
          value: formatBytes(data.totals.diskWriteBytes),
        },
        {
          key: "networkRxBytes",
          label: "네트워크 수신",
          value: formatBytes(data.totals.networkRxBytes),
        },
        {
          key: "networkTxBytes",
          label: "네트워크 송신",
          value: formatBytes(data.totals.networkTxBytes),
        },
      ],
      observedAtLabel:
        data.current.observedAt === null
          ? "측정 기록 없음"
          : new Date(data.current.observedAt)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19) + " UTC",
      observedDateTime: dateIso(data.current.observedAt),
      coverageLabel:
        `선택 기간 중 ${durationLabel(data.history.observedMs)} 기록 · ${decimal(data.history.coverageRatio * 100)}%` +
        (data.history.truncated ? " · 일부 기록만 표시" : ""),
    });
  });
}

function ownsRunner(user: User): boolean {
  return (
    validTelemetryScope(user.id) &&
    user.id !== "host" &&
    user.id !== "all-runners" &&
    (user.runner === "primary" || user.runner === user.id)
  );
}

const SSR_METRICS: Array<[TelemetryMetric, string]> = [
  ["cpuUsedCores", "CPU 사용"],
  ["memoryUsedBytes", "메모리 사용"],
  ["diskUsedBytes", "저장공간 사용"],
  ["networkRxBytesPerSecond", "네트워크 수신"],
  ["networkTxBytesPerSecond", "네트워크 송신"],
  ["diskReadBytesPerSecond", "디스크 읽기"],
  ["diskWriteBytesPerSecond", "디스크 쓰기"],
];
function decimal(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}
function formatCpuTime(value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (value >= 3600) {
    return decimal(value / 3600) + " 코어·시간";
  }
  if (value >= 60) {
    return decimal(value / 60) + " 코어·분";
  }
  return decimal(value) + " 코어·초";
}
function durationLabel(milliseconds: number): string {
  let remaining = Math.floor(milliseconds / 1000);
  const parts: string[] = [];
  for (const [unit, seconds] of [
    ["일", 86400],
    ["시간", 3600],
    ["분", 60],
    ["초", 1],
  ] as const) {
    const count = Math.floor(remaining / seconds);
    if (count > 0) {
      parts.push(count + unit);
      remaining %= seconds;
    }
    if (parts.length === 2) {
      break;
    }
  }
  return parts.join(" ") || "0초";
}
function formatBytes(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return decimal(value) + " " + units[index];
}
function formatMetric(key: TelemetryMetric, value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (key === "cpuUsedCores") {
    return decimal(value) + " 코어";
  }
  return formatBytes(value) + (key.endsWith("PerSecond") ? "/s" : "");
}
function formatPercentile(key: TelemetryMetric, value: number | null): string {
  return value === null ? "—" : "≈ " + formatMetric(key, value);
}
function ownerLabel(user: User): string {
  return (user.email ?? user.username) + " 실행 환경";
}
function requestedRange(req: Request): TelemetryRange | undefined {
  const range = req.query.range ?? "1h";
  return typeof range === "string" && Object.hasOwn(TELEMETRY_RANGES, range)
    ? (range as TelemetryRange)
    : undefined;
}
function jsonHeaders(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.vary("Cookie");
}
