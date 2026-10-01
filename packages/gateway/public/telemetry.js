(() => {
  const page = document.querySelector("[data-telemetry]");
  if (!page?.dataset.telemetryUrl) return;

  const ns = "http://www.w3.org/2000/svg";
  const interval = 5000;
  const maxPoints = 720;
  const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
  const definitions = {
    cpu: {
      label: "CPU 사용량",
      metrics: ["cpuUsedCores"],
      labels: ["사용 중"],
      capacity: "cpuCapacityCores",
    },
    memory: {
      label: "메모리 사용량",
      metrics: ["memoryUsedBytes"],
      labels: ["사용 중"],
      capacity: "memoryCapacityBytes",
    },
    disk: {
      label: "디스크 사용량",
      metrics: ["diskUsedBytes"],
      labels: ["사용 중"],
      capacity: "diskCapacityBytes",
    },
    network: {
      label: "네트워크 전송량",
      metrics: ["networkRxBytesPerSecond", "networkTxBytesPerSecond"],
      labels: ["수신", "송신"],
    },
    "disk-io": {
      label: "디스크 입출력",
      metrics: ["diskReadBytesPerSecond", "diskWriteBytesPerSecond"],
      labels: ["읽기", "쓰기"],
    },
  };
  const finite = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const timestamp = (value) => {
    const result = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(result) && Math.abs(result) <= 8.64e15
      ? result
      : null;
  };

  function bytes(value) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${number.format(value)} ${units[unit]}`;
  }

  function duration(milliseconds) {
    let seconds = Math.floor(milliseconds / 1000);
    const parts = [];
    for (const [size, label] of [
      [86400, "일"],
      [3600, "시간"],
      [60, "분"],
      [1, "초"],
    ]) {
      const value = Math.floor(seconds / size);
      if (value) parts.push(`${number.format(value)}${label}`);
      seconds %= size;
      if (parts.length === 2) break;
    }
    return parts.join(" ") || "0초";
  }

  function format(metric, value) {
    value = finite(value);
    if (value === null) return "—";
    if (metric === "cpuSeconds") {
      if (value >= 3600) return `${number.format(value / 3600)} 코어·시간`;
      if (value >= 60) return `${number.format(value / 60)} 코어·분`;
      return `${number.format(value)} 코어·초`;
    }
    if (metric.endsWith("BytesPerSecond")) return `${bytes(value)}/s`;
    if (metric.endsWith("Bytes")) return bytes(value);
    if (metric.endsWith("Percent")) return `${number.format(value)}%`;
    if (metric.endsWith("Cores")) return `${number.format(value)} 코어`;
    return number.format(value);
  }

  function dateLabel(at, full = false, longRange = false) {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "UTC",
      ...(full || longRange ? { month: "numeric", day: "numeric" } : {}),
      ...(full || !longRange
        ? { hour: "2-digit", minute: "2-digit", hour12: false }
        : {}),
      ...(full ? { second: "2-digit" } : {}),
    }).format(new Date(at));
  }

  function element(name, attributes = {}, text) {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) {
      node.setAttribute(key, String(value));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function chart(container, index) {
    const definition = definitions[container.dataset.telemetryChart];
    if (!definition) return null;
    const tooltip = document.createElement("div");
    tooltip.className = "telemetry-chart-tooltip";
    tooltip.id = `telemetry-tooltip-${index}`;
    tooltip.hidden = true;
    tooltip.setAttribute("role", "status");
    tooltip.setAttribute("aria-live", "off");
    const svg = element("svg", {
      class: "telemetry-chart-svg",
      viewBox: "0 0 640 220",
      role: "img",
      tabindex: "0",
      "aria-label": `${definition.label} 추이. 좌우 방향키로 측정값을 탐색합니다.`,
      "aria-describedby": tooltip.id,
    });
    const drawing = element("g", { "aria-hidden": "true" });
    const overlay = element("g", {
      "aria-hidden": "true",
      visibility: "hidden",
    });
    const cursor = element("line", {
      class: "telemetry-cursor",
      y1: 14,
      y2: 172,
    });
    overlay.append(cursor);
    const dots = definition.metrics.map((_, seriesIndex) => {
      const dot = element("circle", {
        class: `telemetry-point telemetry-series--${seriesIndex ? "secondary" : "primary"}`,
        r: 4,
      });
      overlay.append(dot);
      return dot;
    });
    svg.append(drawing, overlay);
    const empty = document.createElement("p");
    empty.className = "telemetry-chart-empty";
    empty.textContent = "이 기간에 수집된 측정값이 없습니다.";
    empty.hidden = true;
    container.append(svg, tooltip, empty);
    if (definition.metrics.length > 1) {
      const legend = document.createElement("div");
      legend.className = "telemetry-chart-legend";
      for (const [seriesIndex, label] of definition.labels.entries()) {
        const item = document.createElement("span");
        item.className = `telemetry-legend-item telemetry-series--${seriesIndex ? "secondary" : "primary"}`;
        item.textContent = label;
        legend.append(item);
      }
      container.append(legend);
    }

    let points = [];
    let width = 640;
    let lastResult;
    let from = 0;
    let to = 1;
    let upper = 1;
    let selectedAt = null;
    let hovering = false;
    const measureWidth = () =>
      Math.max(
        240,
        svg.getBoundingClientRect().width || container.clientWidth || 640,
      );
    const x = (at) =>
      80 + Math.max(0, Math.min(1, (at - from) / (to - from))) * (width - 96);
    const y = (value) => 172 - (value / upper) * 158;
    const nearest = (at) => {
      let best = 0;
      for (let i = 1; i < points.length; i += 1) {
        if (Math.abs(points[i].at - at) < Math.abs(points[best].at - at))
          best = i;
      }
      return best;
    };
    function select(at) {
      if (!points.length || at === null) {
        selectedAt = null;
        tooltip.hidden = true;
        overlay.setAttribute("visibility", "hidden");
        return;
      }
      const point = points[nearest(at)];
      selectedAt = point.at;
      tooltip.textContent = `${dateLabel(point.at, true)} · ${definition.metrics
        .map((metric, i) => {
          const value = finite(point.values?.[metric]);
          const peak = finite(point.maxValues?.[metric]);
          const rolledUp = lastResult?.range !== "1h";
          return `${definition.labels[i]} ${rolledUp ? "평균 " : ""}${format(metric, value)}${rolledUp && peak !== null ? ` · 최대 ${format(metric, peak)}` : ""}`;
        })
        .join(" · ")}`;
      tooltip.hidden = false;
      overlay.setAttribute("visibility", "visible");
      cursor.setAttribute("x1", String(x(point.at)));
      cursor.setAttribute("x2", String(x(point.at)));
      definition.metrics.forEach((metric, i) => {
        const value = finite(point.values?.[metric]);
        dots[i].setAttribute(
          "visibility",
          value === null ? "hidden" : "visible",
        );
        if (value !== null) {
          dots[i].setAttribute("cx", String(x(point.at)));
          dots[i].setAttribute("cy", String(y(value)));
        }
      });
    }
    svg.addEventListener("pointermove", (event) => {
      hovering = true;
      tooltip.setAttribute("aria-live", "off");
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width) return;
      const matrix = svg.getScreenCTM?.();
      const relative =
        matrix && typeof DOMPoint !== "undefined"
          ? new DOMPoint(event.clientX, event.clientY).matrixTransform(
              matrix.inverse(),
            ).x
          : ((event.clientX - bounds.left) / bounds.width) * width;
      select(
        from +
          Math.max(0, Math.min(1, (relative - 80) / (width - 96))) *
            (to - from),
      );
    });
    svg.addEventListener("pointerleave", () => {
      hovering = false;
      if (document.activeElement !== svg) select(null);
    });
    svg.addEventListener("focus", () => {
      tooltip.setAttribute("aria-live", "polite");
      select(selectedAt ?? points.at(-1)?.at ?? null);
    });
    svg.addEventListener("blur", () => {
      if (!hovering) select(null);
    });
    svg.addEventListener("keydown", (event) => {
      if (
        !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      tooltip.setAttribute("aria-live", "polite");
      if (event.key === "Escape") return select(null);
      if (!points.length) return;
      let selected =
        selectedAt === null ? points.length - 1 : nearest(selectedAt);
      if (event.key === "ArrowLeft") selected = Math.max(0, selected - 1);
      if (event.key === "ArrowRight")
        selected = Math.min(points.length - 1, selected + 1);
      if (event.key === "Home") selected = 0;
      if (event.key === "End") selected = points.length - 1;
      select(points[selected].at);
    });

    function render(result) {
      lastResult = result;
      width = measureWidth();
      svg.setAttribute("viewBox", `0 0 ${width} 220`);
      const valid = result.series
        .map((point) => ({ ...point, at: timestamp(point?.at) }))
        .filter((point) => point.at !== null)
        .sort((a, b) => a.at - b.at);
      // The API is bounded too; retain both ends if a future server sends more.
      let previousIndex = -1;
      const selectedIndices =
        valid.length <= maxPoints
          ? valid.map((_, i) => i)
          : Array.from({ length: maxPoints }, (_, i) =>
              Math.floor((i * (valid.length - 1)) / (maxPoints - 1)),
            );
      points = selectedIndices.map((index) => {
        const breaks = definition.metrics.filter((metric) => {
          for (let i = previousIndex + 1; i <= index; i += 1) {
            if (
              finite(valid[i].values?.[metric]) === null ||
              (i > 0 &&
                finite(result.stepMs) &&
                valid[i].at - valid[i - 1].at > result.stepMs * 1.8)
            )
              return true;
          }
          return false;
        });
        previousIndex = index;
        return { ...valid[index], breaks };
      });
      from = timestamp(result.from) ?? points[0]?.at ?? 0;
      to = timestamp(result.to) ?? points.at(-1)?.at ?? from + 1;
      if (to <= from) to = from + 1;
      const observed = points.flatMap((point) =>
        [
          ...definition.metrics,
          ...(definition.capacity ? [definition.capacity] : []),
        ]
          .map((metric) => finite(point.values?.[metric]))
          .filter((value) => value !== null),
      );
      if (definition.capacity) {
        const capacity = finite(result.current.values?.[definition.capacity]);
        if (capacity !== null) observed.push(capacity);
      }
      const maximum = Math.max(1, ...observed);
      upper =
        definition.capacity || maximum > Number.MAX_VALUE / 1.1
          ? maximum
          : maximum * 1.1;
      const nodes = [];
      for (let i = 0; i <= 3; i += 1) {
        const value = (upper * i) / 3;
        nodes.push(
          element("line", {
            class: "telemetry-grid-line",
            x1: 80,
            x2: width - 16,
            y1: y(value),
            y2: y(value),
          }),
        );
        nodes.push(
          element(
            "text",
            {
              class: "telemetry-axis-label",
              x: 72,
              y: y(value) + 4,
              "text-anchor": "end",
            },
            format(definition.metrics[0], value),
          ),
        );
      }
      for (let i = 0; i <= 2; i += 1) {
        const at = from + ((to - from) * i) / 2;
        nodes.push(
          element(
            "text",
            {
              class: "telemetry-axis-label",
              x: x(at),
              y: 202,
              "text-anchor": i === 0 ? "start" : i === 2 ? "end" : "middle",
            },
            dateLabel(at, false, to - from > 2 * 86400000),
          ),
        );
      }
      let hasValues = false;
      definition.metrics.forEach((metric, seriesIndex) => {
        let path = "";
        let previousAt = null;
        for (const [pointIndex, point] of points.entries()) {
          const value = finite(point.values?.[metric]);
          if (value === null) {
            previousAt = null;
            continue;
          }
          hasValues = true;
          const gap = previousAt === null || point.breaks.includes(metric);
          const next = points[pointIndex + 1];
          const isolated =
            gap &&
            (!next ||
              finite(next.values?.[metric]) === null ||
              next.breaks.includes(metric));
          if (isolated) {
            nodes.push(
              element("circle", {
                class: `telemetry-point telemetry-series--${seriesIndex ? "secondary" : "primary"}`,
                cx: x(point.at),
                cy: y(value),
                r: 2.5,
              }),
            );
          }
          path += `${gap ? "M" : "L"}${x(point.at).toFixed(2)},${y(value).toFixed(2)} `;
          previousAt = point.at;
        }
        nodes.push(
          element("path", {
            class: `telemetry-chart-line telemetry-series--${seriesIndex ? "secondary" : "primary"}`,
            d: path.trim(),
            fill: "none",
            "vector-effect": "non-scaling-stroke",
          }),
        );
      });
      drawing.replaceChildren(...nodes);
      empty.hidden = hasValues;
      select(selectedAt);
    }
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        if (lastResult && measureWidth() !== width) render(lastResult);
      });
      observer.observe(container);
    } else {
      window.addEventListener("resize", () => {
        if (lastResult) render(lastResult);
      });
    }
    return render;
  }

  const charts = Array.from(
    page.querySelectorAll("[data-telemetry-chart]"),
    chart,
  ).filter(Boolean);
  const notice = page.querySelector("[data-telemetry-notice]");
  const observedAt = page.querySelector("[data-telemetry-observed-at]");
  const coverage = page.querySelector("[data-telemetry-coverage]");
  const bindings = [
    ["value", (result, metric) => result.current.values?.[metric]],
    ["average", (result, metric) => result.statistics?.[metric]?.average],
    ["max", (result, metric) => result.statistics?.[metric]?.max],
    ["total", (result, metric) => result.totals?.[metric]],
  ].flatMap(([kind, read]) =>
    Array.from(page.querySelectorAll(`[data-telemetry-${kind}]`), (node) => ({
      node,
      metric: node.getAttribute(`data-telemetry-${kind}`),
      read,
    })),
  );

  function availability(state, message) {
    page.dataset.telemetryAvailability = state;
    if (notice) {
      notice.textContent = message;
      notice.hidden = !message;
    }
  }

  function update(result) {
    if (
      result?.schemaVersion !== 1 ||
      !result.current ||
      !Array.isArray(result.series)
    ) {
      throw new Error("Invalid telemetry response");
    }
    const left = window.scrollX;
    const top = window.scrollY;
    for (const binding of bindings) {
      const next = format(binding.metric, binding.read(result, binding.metric));
      if (binding.node.textContent !== next) binding.node.textContent = next;
    }
    const at = timestamp(result.current.observedAt);
    if (observedAt)
      observedAt.textContent =
        at === null
          ? "측정 기록 없음"
          : new Date(at).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    if (coverage) {
      const observed = finite(result.history?.observedMs);
      const ratio = finite(result.history?.coverageRatio);
      coverage.textContent =
        observed === null
          ? "기록 범위를 확인할 수 없습니다."
          : `선택 기간 중 ${duration(observed)} 기록${ratio === null ? "" : ` · ${number.format(Math.min(1, ratio) * 100)}%`}${result.history?.truncated ? " · 일부 기록만 표시" : ""}`;
    }
    for (const render of charts) render(result);
    const state = ["fresh", "partial", "stale", "unavailable"].includes(
      result.current.availability,
    )
      ? result.current.availability
      : "unavailable";
    availability(
      state,
      {
        fresh: "",
        partial: "일부 측정값을 사용할 수 없습니다.",
        stale: "최근 측정값이 지연되고 있습니다.",
        unavailable: "측정 데이터를 아직 사용할 수 없습니다.",
      }[state] ?? "측정 데이터를 아직 사용할 수 없습니다.",
    );
    if (window.scrollX !== left || window.scrollY !== top) {
      window.scrollTo({ left, top, behavior: "instant" });
    }
  }

  let timer;
  let controller;
  let inFlight = false;
  let closed = false;
  let stopped = false;
  let failures = 0;
  let resumeRequested = false;

  function schedule(delay) {
    clearTimeout(timer);
    if (!closed && !stopped && !document.hidden)
      timer = setTimeout(refresh, delay);
  }

  async function refresh() {
    if (closed || stopped || document.hidden || inFlight) return;
    inFlight = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL(page.dataset.telemetryUrl, window.location.href);
      if (url.origin !== new URL(window.location.href).origin)
        throw new Error("Invalid telemetry URL");
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (closed || document.hidden || controller.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) {
        stopped = true;
        availability(
          "unavailable",
          response.status === 404
            ? "이 실행 환경의 사용량을 조회할 수 없습니다."
            : "사용량을 조회하려면 다시 로그인해야 합니다.",
        );
        return;
      }
      if (!response.ok) throw new Error("Telemetry request failed");
      const result = await response.json();
      if (closed || document.hidden || controller.signal.aborted) return;
      update(result);
      failures = 0;
    } catch {
      if (!closed && !document.hidden && !resumeRequested) {
        failures += 1;
        availability(
          "unavailable",
          "사용량 데이터를 불러오지 못했습니다. 잠시 후 다시 시도합니다.",
        );
      }
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      inFlight = false;
      const delay = resumeRequested
        ? 0
        : failures
          ? Math.min(interval * 2 ** failures, 60000)
          : interval;
      resumeRequested = false;
      schedule(delay);
    }
  }

  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.hidden) {
      controller?.abort();
    } else if (inFlight) {
      resumeRequested = true;
    } else {
      void refresh();
    }
  });
  window.addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(timer);
    controller?.abort();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      closed = false;
      if (inFlight) resumeRequested = true;
      else void refresh();
    }
  });
  schedule(0);
})();
