import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../public/telemetry.js", import.meta.url),
  "utf8",
);

class Element {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  listeners = new Map<string, (event?: any) => void>();
  textContent = "";
  className = "";
  id = "";
  hidden = false;
  clientWidth = 400;
  value = "";

  constructor(public name: string) {}

  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
    if (key.startsWith("data-")) {
      this.dataset[
        key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      ] = value;
    }
    if (key === "class") {
      this.className = value;
    }
  }

  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }

  matches(selector: string) {
    if (selector.startsWith("["))
      return this.attributes.has(selector.slice(1, -1));
    if (selector.startsWith("."))
      return this.className.split(" ").includes(selector.slice(1));
    return this.name === selector;
  }

  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  append(...children: Element[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: Element[]) {
    this.children = children;
  }

  addEventListener(type: string, callback: (event?: any) => void) {
    this.listeners.set(type, callback);
  }

  getBoundingClientRect() {
    return { left: 0, width: this.clientWidth };
  }

  fire(type: string, event: any = {}) {
    this.listeners.get(type)?.(event);
  }
}

const startAt = Date.parse("2026-10-01T00:00:00Z");
const metrics = {
  cpuUsedCores: 2.5,
  cpuCapacityCores: 8,
  cpuPercent: 250,
  cpuCapacityPercent: 31.25,
  memoryUsedBytes: 1024 ** 3,
  memoryCapacityBytes: 4 * 1024 ** 3,
  diskUsedBytes: 0,
  diskCapacityBytes: null,
  networkRxBytesPerSecond: 2048,
  networkTxBytesPerSecond: null,
};

function payload() {
  return {
    schemaVersion: 1,
    scope: "host",
    range: "1h",
    from: startAt,
    to: startAt + 30_000,
    stepMs: 10_000,
    current: {
      observedAt: startAt + 30_000,
      availability: "fresh",
      state: "running",
      values: { ...metrics },
      coverage: { expected: 1, observed: 1, complete: true },
    },
    series: [0, 1, 2, 3].map((i) => ({
      at: startAt + i * 10_000,
      values: { ...metrics, cpuUsedCores: i + 1 },
    })),
    statistics: {
      cpuUsedCores: {
        average: 1.25,
        max: 3.75,
        latest: 2.5,
        observedMs: 30_000,
      },
    },
    totals: {
      cpuSeconds: 3600,
      networkRxBytes: 1024 ** 2,
      networkTxBytes: null,
    },
    history: { observedMs: 1_800_000, coverageRatio: 0.5, truncated: false },
  };
}

function harness() {
  const page = new Element("main");
  page.setAttribute("data-telemetry", "");
  page.setAttribute(
    "data-telemetry-url",
    "/admin/telemetry?scope=host&range=1h",
  );
  const notice = new Element("p");
  notice.setAttribute("data-telemetry-notice", "");
  notice.textContent = "수집 대기 중";
  const observedAt = new Element("span");
  observedAt.setAttribute("data-telemetry-observed-at", "");
  const coverage = new Element("span");
  coverage.setAttribute("data-telemetry-coverage", "");
  const input = new Element("input");
  input.value = "user is editing this";
  page.append(notice, observedAt, coverage, input);
  const controls = new Element("div");
  controls.setAttribute("data-telemetry-stat-controls", "");
  controls.hidden = true;
  const statisticButtons = Object.fromEntries(
    ["average", "p50", "p95", "p99"].map((statistic) => {
      const button = new Element("button");
      button.setAttribute("data-telemetry-stat", statistic);
      controls.append(button);
      return [statistic, button];
    }),
  );
  const percentileNotice = new Element("p");
  percentileNotice.setAttribute("data-telemetry-percentile-notice", "");
  page.append(controls, percentileNotice);
  const bound = (kind: string, metric: string) => {
    const node = new Element("span");
    node.setAttribute(`data-telemetry-${kind}`, metric);
    node.textContent = "SSR value";
    page.append(node);
    return node;
  };
  const values = Object.fromEntries(
    Object.keys(metrics).map((metric) => [metric, bound("value", metric)]),
  );
  const average = bound("average", "cpuUsedCores");
  const max = bound("max", "cpuUsedCores");
  const percentiles = Object.fromEntries(
    ["p50", "p95", "p99"].map((key) => [key, bound(key, "cpuUsedCores")]),
  );
  const totals = Object.fromEntries(
    ["cpuSeconds", "networkRxBytes", "networkTxBytes"].map((metric) => [
      metric,
      bound("total", metric),
    ]),
  );
  const charts = Object.fromEntries(
    ["cpu", "memory", "disk", "network", "disk-io"].map((kind) => {
      const node = new Element("div");
      node.setAttribute("data-telemetry-chart", kind);
      page.append(node);
      return [kind, node];
    }),
  );
  const documentEvents = new Map<string, () => void>();
  const windowEvents = new Map<string, ((event?: any) => void)[]>();
  const document = {
    hidden: false,
    activeElement: input as Element | null,
    querySelector: () => page,
    createElement: (name: string) => new Element(name),
    createElementNS: (_namespace: string, name: string) => new Element(name),
    addEventListener: (type: string, callback: () => void) =>
      documentEvents.set(type, callback),
  };
  const window = {
    location: { href: "https://dev.example/admin/usage?scope=host&range=1h" },
    scrollX: 0,
    scrollY: 420,
    scrollTo: vi.fn(),
    addEventListener: (type: string, callback: (event?: any) => void) =>
      windowEvents.set(type, [...(windowEvents.get(type) ?? []), callback]),
  };
  const fetch = vi.fn();
  const respond = (body = payload(), status = 200) => {
    fetch.mockResolvedValueOnce({
      ok: status === 200,
      status,
      json: async () => body,
    });
  };
  return {
    page,
    notice,
    observedAt,
    coverage,
    controls,
    statisticButtons,
    percentileNotice,
    percentiles,
    input,
    values,
    average,
    max,
    totals,
    charts,
    document,
    window,
    fetch,
    respond,
    start: () =>
      runInNewContext(source, {
        document,
        window,
        fetch,
        URL,
        AbortController,
        Intl,
        setTimeout,
        clearTimeout,
      }),
    visibility: (hidden: boolean) => {
      document.hidden = hidden;
      documentEvents.get("visibilitychange")?.();
    },
    event: (type: string, event?: any) =>
      windowEvents.get(type)?.forEach((callback) => callback(event)),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("telemetry page", () => {
  it("shows real cores, normalized percentages, byte units, averages, peaks and observed totals without turning missing values into zero", async () => {
    const h = harness();
    h.respond();
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(String(h.fetch.mock.calls[0][0])).toBe(
      "https://dev.example/admin/telemetry?scope=host&range=1h",
    );
    expect(h.fetch.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    expect(h.values.cpuUsedCores.textContent).toBe("2.5 코어");
    expect(h.values.cpuPercent.textContent).toBe("250%");
    expect(h.values.cpuCapacityPercent.textContent).toBe("31.25%");
    expect(h.values.memoryUsedBytes.textContent).toBe("1 GiB");
    expect(h.values.diskUsedBytes.textContent).toBe("0 B");
    expect(h.values.diskCapacityBytes.textContent).toBe("—");
    expect(h.values.networkRxBytesPerSecond.textContent).toBe("2 KiB/s");
    expect(h.values.networkTxBytesPerSecond.textContent).toBe("—");
    expect(h.average.textContent).toBe("1.25 코어");
    expect(h.max.textContent).toBe("3.75 코어");
    expect(h.totals.cpuSeconds.textContent).toBe("1 코어·시간");
    expect(h.totals.networkRxBytes.textContent).toBe("1 MiB");
    expect(h.totals.networkTxBytes.textContent).toBe("—");
    expect(h.notice.hidden).toBe(true);
    expect(h.observedAt.textContent).not.toBe("—");
    expect(h.observedAt.textContent).toBe(
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(startAt + 30_000)),
    );
    expect(h.observedAt.getAttribute("datetime")).toBe(
      "2026-10-01T00:00:30.000Z",
    );
    expect(h.coverage.textContent).toBe("선택 기간 중 30분 기록 · 50%");
    expect(h.input.value).toBe("user is editing this");
    expect(h.document.activeElement).toBe(h.input);
    expect(h.window.scrollTo).not.toHaveBeenCalled();
  });

  it("breaks chart lines across missing metrics and missing intervals, while retaining real zero samples", async () => {
    const h = harness();
    const data = payload();
    data.series[1].values.cpuUsedCores = null as unknown as number;
    data.series[2].values.cpuUsedCores = 0;
    data.series[3].at += 30_000;
    data.to += 30_000;
    h.respond(data);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const path = h.charts.cpu.querySelector("path")!.getAttribute("d")!;
    expect(path.match(/M/g)).toHaveLength(3);
    expect(path).not.toContain("L");
    expect(path).not.toMatch(/NaN|Infinity/);
    expect(h.charts.cpu.querySelector(".telemetry-chart-empty")!.hidden).toBe(
      true,
    );
    expect(
      h.charts["disk-io"].querySelector(".telemetry-chart-empty")!.hidden,
    ).toBe(false);
    expect(
      h.charts.network
        .querySelectorAll(".telemetry-legend-item")
        .map((node) => node.textContent),
    ).toEqual(["수신 · 평균", "송신 · 평균"]);
  });

  it("supports keyboard and pointer inspection without replacing focus or the selected historic sample during refresh", async () => {
    const h = harness();
    const first = payload();
    first.series[1].values.cpuUsedCores = null as unknown as number;
    h.respond(first);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const svg = h.charts.cpu.querySelector("svg")!;
    const tooltip = h.charts.cpu.querySelector(".telemetry-chart-tooltip")!;
    expect(svg.getAttribute("tabindex")).toBe("0");
    expect(svg.getAttribute("viewBox")).toBe("0 0 400 220");
    h.document.activeElement = svg;
    svg.fire("focus");
    expect(tooltip.textContent).toContain("4 코어");
    const preventDefault = vi.fn();
    svg.fire("keydown", { key: "Home", preventDefault });
    svg.fire("keydown", { key: "ArrowRight", preventDefault });
    expect(tooltip.textContent).toContain("사용 중 평균 —");
    expect(preventDefault).toHaveBeenCalledTimes(2);
    const second = payload();
    second.series[1].values.cpuUsedCores = 1.75;
    second.series.push({
      at: startAt + 40_000,
      values: { ...metrics, cpuUsedCores: 6 },
    });
    second.to += 10_000;
    h.respond(second);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.charts.cpu.querySelector("svg")).toBe(svg);
    expect(h.document.activeElement).toBe(svg);
    expect(tooltip.textContent).toContain("1.75 코어");
    svg.fire("keydown", { key: "Escape", preventDefault });
    expect(tooltip.hidden).toBe(true);
    svg.fire("pointermove", { clientX: 384 });
    expect(tooltip.textContent).toContain("6 코어");
    expect(tooltip.hidden).toBe(false);
  });

  it("bounds SVG work to 720 samples and updates the viewBox when the container changes width", async () => {
    const h = harness();
    const data = payload();
    data.series = Array.from({ length: 2000 }, (_, i) => ({
      at: startAt + i * 10_000,
      values: { ...metrics },
    }));
    data.to = data.series.at(-1)!.at;
    h.respond(data);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const path = h.charts.cpu.querySelector("path")!.getAttribute("d")!;
    expect(path.match(/[ML]/g)).toHaveLength(720);
    h.charts.cpu.clientWidth = 272;
    h.charts.cpu.querySelector("svg")!.clientWidth = 272;
    h.event("resize");
    expect(h.charts.cpu.querySelector("svg")!.getAttribute("viewBox")).toBe(
      "0 0 272 220",
    );
  });

  it("selects measured percentile series, keeps two network lines, and exposes approximation without fabricating legacy percentiles", async () => {
    const h = harness();
    const original = payload();
    const data = {
      ...original,
      statistics: {
        cpuUsedCores: {
          ...original.statistics.cpuUsedCores,
          p50: 1.2,
          p95: 3.2,
          p99: 3.6,
          percentileRelativeError: 0.04,
        },
      },
      series: original.series.map((point, i) => ({
        ...point,
        p50: { ...metrics, cpuUsedCores: 1 },
        p95: { ...metrics, cpuUsedCores: i === 1 ? null : 3 },
        p99: { ...metrics, cpuUsedCores: 4 },
        percentileRelativeError: { cpuUsedCores: 0.04 },
      })),
    };
    h.respond(data);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controls.hidden).toBe(false);
    expect(h.percentiles.p95.textContent).toBe("≈ 3.2 코어");
    expect(h.percentiles.p95.getAttribute("title")).toContain("4%");
    h.document.activeElement = h.statisticButtons.p95;
    h.statisticButtons.p95.fire("click");
    expect(h.statisticButtons.p95.getAttribute("aria-pressed")).toBe("true");
    expect(h.statisticButtons.average.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(h.document.activeElement).toBe(h.statisticButtons.p95);
    expect(h.charts.network.querySelectorAll("path")).toHaveLength(2);
    const path = h.charts.cpu.querySelector("path")!.getAttribute("d")!;
    expect(path.match(/M/g)).toHaveLength(2);
    const svg = h.charts.cpu.querySelector("svg")!;
    svg.fire("focus");
    const tooltip = h.charts.cpu.querySelector(".telemetry-chart-tooltip")!;
    expect(tooltip.textContent).toContain("P95 ≈ 3 코어");
    expect(tooltip.textContent).toContain("상대 오차 ≤ 4%");
    h.respond();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.statisticButtons.p95.getAttribute("aria-pressed")).toBe("true");
    expect(h.percentiles.p95.textContent).toBe("—");
    expect(h.charts.cpu.querySelector("path")!.getAttribute("d")).toBe("");
    expect(h.percentileNotice.hidden).toBe(false);
    h.statisticButtons.average.fire("click");
    expect(h.percentileNotice.hidden).toBe(true);
    expect(h.charts.cpu.querySelector("path")!.getAttribute("d")).not.toBe("");
  });

  it("waits for each response and pauses with an abort while hidden, then resumes immediately", async () => {
    const h = harness();
    let reject!: (reason: Error) => void;
    h.fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    h.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const signal = h.fetch.mock.calls[0][1].signal;
    h.visibility(true);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.respond();
    h.visibility(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.notice.hidden).toBe(true);
    h.visibility(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("backs off transient failures, recovers unavailable state, and stops after an authorization failure", async () => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    h.respond();
    h.respond(payload(), 403);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.page.dataset.telemetryAvailability).toBe("unavailable");
    expect(h.notice.textContent).toContain("불러오지 못했습니다");
    expect(h.values.cpuUsedCores.textContent).toBe("SSR value");
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.page.dataset.telemetryAvailability).toBe("fresh");
    expect(h.notice.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.notice.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    h.visibility(true);
    h.visibility(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed responses without overwriting valid content and makes stale measurements explicit", async () => {
    const h = harness();
    h.respond();
    h.respond({ ...payload(), schemaVersion: 2 });
    const stale = payload();
    stale.current.availability = "stale";
    stale.current.values.cpuUsedCores = null as unknown as number;
    h.respond(stale);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.values.cpuUsedCores.textContent).toBe("2.5 코어");
    expect(h.page.dataset.telemetryAvailability).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.values.cpuUsedCores.textContent).toBe("—");
    expect(h.page.dataset.telemetryAvailability).toBe("stale");
    expect(h.notice.textContent).toContain("지연");
  });

  it("times out a stalled fetch, retries with backoff and stops on page exit", async () => {
    const h = harness();
    h.fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    h.respond();
    h.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(h.page.dataset.telemetryAvailability).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.event("pagehide");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.respond();
    h.event("pageshow", { persisted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not render an aborted response after a quick hide and show", async () => {
    const h = harness();
    let complete!: (value: unknown) => void;
    h.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    h.respond();
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.visibility(true);
    h.visibility(false);
    const obsolete = payload();
    obsolete.current.values.cpuUsedCores = 99;
    complete(obsolete);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.values.cpuUsedCores.textContent).toBe("2.5 코어");
  });
});
