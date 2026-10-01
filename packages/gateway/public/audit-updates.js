(() => {
  const page = document.querySelector("main[data-live-audit]");
  const body = page?.querySelector("tbody[data-audit-rows]");
  if (!body) {
    return;
  }

  const rows = new Map();
  const feeds = new Set();
  const cards = new WeakSet();
  let timer;
  let closed = false;
  let unauthorized = false;

  function selectedWithin(element) {
    const selection = window.getSelection();
    return (
      selection &&
      !selection.isCollapsed &&
      (element.contains(selection.anchorNode) ||
        element.contains(selection.focusNode))
    );
  }

  function protectedWithin(element) {
    return element.contains(document.activeElement) || selectedWithin(element);
  }

  function preserveReading(update) {
    const anchor = Array.from(body.children).find((row) => {
      const rect = row.getBoundingClientRect();
      return !row.hidden && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    const top = anchor?.getBoundingClientRect().top;
    const left = window.scrollX;
    const scrollTop = window.scrollY;
    const scroller = body.closest(".table-scroll");
    const horizontal = scroller?.scrollLeft;
    const focused = document.activeElement;
    update();
    if (scroller) {
      scroller.scrollLeft = horizontal;
    }
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
    // Account for native scroll anchoring, which may already have compensated
    // for inserted rows before this layout measurement.
    const nextTop = anchor?.isConnected
      ? anchor.getBoundingClientRect().top
      : undefined;
    const targetTop =
      nextTop === undefined ? scrollTop : window.scrollY + nextTop - top;
    if (window.scrollX !== left || window.scrollY !== targetTop) {
      window.scrollTo({ left, top: targetTop, behavior: "instant" });
    }
  }

  function element(tag, className, text, attributes = {}) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = String(text ?? "");
    }
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, String(value));
    }
    return node;
  }

  function link(className, text, href, attributes = {}) {
    const node = element("a", className, text, attributes);
    const url = new URL(href || "/admin/audit", window.location.href);
    if (
      url.origin === new URL(window.location.href).origin &&
      url.pathname.startsWith("/admin/")
    ) {
      node.setAttribute("href", url.pathname + url.search + url.hash);
    }
    return node;
  }

  function localTime(label, datetime) {
    return element("time", "", label, {
      datetime: datetime || "",
      "data-local-time": "",
    });
  }

  function signature(value) {
    return JSON.stringify(value);
  }

  function applyDelta(feed, result) {
    if (result !== null) {
      if (
        result.schemaVersion !== 1 ||
        result.kind !== (feed.kind === "list" ? "audit" : "audit-detail") ||
        typeof result.revision !== "string" ||
        typeof result.reset !== "boolean" ||
        !result.changes ||
        typeof result.changes !== "object" ||
        !Array.isArray(result.removed)
      ) {
        throw new Error("Invalid audit response");
      }
      const snapshot = result.reset ? {} : { ...feed.snapshot };
      for (const key of result.removed) {
        delete snapshot[key];
      }
      Object.assign(snapshot, result.changes);
      feed.apply(snapshot);
      feed.snapshot = snapshot;
      feed.revision = result.revision;
    } else if (feed.snapshot) {
      // A selected or focused field may have deferred its last DOM update.
      feed.apply(feed.snapshot);
    }
  }

  function schedule(delay = 0) {
    clearTimeout(timer);
    if (!closed && !unauthorized && !document.hidden) {
      timer = setTimeout(pump, delay);
    }
  }

  function createFeed(options) {
    const feed = {
      due: Date.now(),
      failures: 0,
      inFlight: false,
      stopped: false,
      interval: 2000,
      ...options,
    };
    feeds.add(feed);
    return feed;
  }

  async function refresh(feed) {
    feed.inFlight = true;
    const controller = new AbortController();
    feed.controller = controller;
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      feed.kind === "list" ? 45_000 : 20_000,
    );
    try {
      const url = feed.url();
      if (feed.revision) {
        url.searchParams.set("since", feed.revision);
      }
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        unauthorized = true;
        for (const pending of feeds) {
          pending.controller?.abort();
        }
        feed.error?.("로그인 또는 접근 권한을 확인해 주세요.");
        return;
      }
      if (response.status === 404) {
        feed.stopped = true;
        feed.error?.("이 기록을 더 이상 확인할 수 없습니다.");
        return;
      }
      if (!response.ok) {
        throw new Error("Audit update failed");
      }
      const result = response.status === 204 ? null : await response.json();
      if (
        !controller.signal.aborted &&
        !closed &&
        !unauthorized &&
        !document.hidden &&
        feed.active()
      ) {
        if (feed.kind === "log") {
          if (result !== null) {
            feed.apply(result);
          }
        } else {
          applyDelta(feed, result);
        }
      }
      feed.failures = 0;
    } catch {
      if (!controller.signal.aborted || timedOut) {
        feed.failures += 1;
      }
      if (
        (!controller.signal.aborted || timedOut) &&
        !closed &&
        !document.hidden &&
        feed.active()
      ) {
        feed.error?.(
          "상세 정보를 불러오지 못했습니다. 잠시 후 다시 시도합니다.",
        );
      }
    } finally {
      clearTimeout(timeout);
      feed.controller = undefined;
      feed.inFlight = false;
      feed.due =
        Date.now() +
        (feed.failures
          ? Math.min(2000 * 2 ** feed.failures, 30_000)
          : feed.interval);
      feed.done?.();
      schedule();
    }
  }

  function pump() {
    if (closed || unauthorized || document.hidden) {
      return;
    }
    for (const feed of feeds) {
      if (feed.owner && !feed.owner.isConnected && !feed.inFlight) {
        feeds.delete(feed);
      }
    }
    const active = Array.from(feeds).filter(
      (feed) => !feed.stopped && feed.active(),
    );
    let slots =
      3 -
      Array.from(feeds).filter((feed) => feed.kind !== "list" && feed.inFlight)
        .length;
    const pending = active
      .filter((feed) => !feed.inFlight)
      .sort((a, b) => a.due - b.due);
    for (const feed of pending) {
      if (feed.due > Date.now()) {
        continue;
      }
      if (feed.kind !== "list") {
        if (slots <= 0) {
          continue;
        }
        slots -= 1;
      }
      void refresh(feed);
    }
    const waiting = pending.filter(
      (feed) => !feed.inFlight && (feed.kind === "list" || slots > 0),
    );
    if (waiting.length) {
      schedule(
        Math.max(0, Math.min(...waiting.map((feed) => feed.due)) - Date.now()),
      );
    }
  }

  function registerLogs(row) {
    for (const card of row.content.querySelectorAll("[data-audit-process]")) {
      const log = card.querySelector("pre[data-audit-log]");
      if (cards.has(card) || !log || !card.dataset.liveUrl) {
        continue;
      }
      cards.add(card);
      log.scrollTop = log.scrollHeight;
      let status = card.dataset.running === "true" ? "running" : undefined;
      const feed = createFeed({
        kind: "log",
        row,
        owner: card,
        stopped:
          card.dataset.running === "false" && card.dataset.more !== "true",
        active: () =>
          row.detail.isConnected && !row.detail.hidden && card.isConnected,
        url: () => {
          const url = new URL(card.dataset.liveUrl, window.location.href);
          if (log.dataset.cursor) {
            url.searchParams.set("cursor", log.dataset.cursor);
          }
          if (status) {
            url.searchParams.set("status", status);
          }
          return url;
        },
        apply: (result) => {
          if (
            typeof result.output !== "string" ||
            typeof result.cursor !== "string" ||
            typeof result.more !== "boolean" ||
            typeof result.process?.status !== "string" ||
            typeof result.process?.statusLabel !== "string"
          ) {
            throw new Error("Invalid log response");
          }
          const top = log.scrollTop;
          const left = log.scrollLeft;
          const follow = log.scrollHeight - log.clientHeight - top <= 24;
          preserveReading(() => {
            for (const message of card.querySelectorAll("[data-log-error]")) {
              message.remove();
            }
            if (result.output) {
              log.append(document.createTextNode(result.output));
            }
            if (log.textContent) {
              for (const empty of card.querySelectorAll("[data-log-empty]")) {
                empty.remove();
              }
            } else if (!card.querySelector("[data-log-empty]")) {
              const empty = document.createElement("p");
              empty.dataset.logEmpty = "";
              empty.className = "audit-log-empty";
              empty.textContent = "아직 기록된 로그가 없습니다.";
              card.insertBefore(empty, log);
            }
            if (!result.more) {
              for (const truncated of card.querySelectorAll(
                "[data-log-truncated]",
              )) {
                truncated.remove();
              }
            }
            log.scrollTop = follow ? log.scrollHeight : top;
            log.scrollLeft = left;
            for (const badge of card.querySelectorAll(
              "[data-process-status]",
            )) {
              badge.textContent = result.process.statusLabel;
              badge.className = "badge " + result.process.status;
            }
          });
          status = result.process.status;
          // Logs can finish while an older metadata request is still in flight.
          // Keep their authoritative status when that metadata later arrives.
          card.auditLogStatus = result.process;
          log.dataset.cursor = result.cursor;
          card.dataset.running = String(result.process.status === "running");
          card.dataset.more = String(result.more);
          feed.stopped = result.process.status !== "running" && !result.more;
          feed.interval = result.more ? 100 : 2000;
        },
      });
    }
  }

  function processHeader(process) {
    const header = element("header", "", undefined, {
      "data-audit-process-header": "",
    });
    const identity = element("div", "audit-process-identity");
    const facts = element("div", "audit-process-facts");
    facts.append(
      element("span", "badge " + process.status, process.statusLabel, {
        "data-process-status": "",
      }),
      element("span", "", "PID " + process.pid),
    );
    const started = element("span");
    started.append(
      localTime(process.startedLabel, process.startedDateTime),
      document.createTextNode(" 시작"),
    );
    facts.append(started);
    identity.append(
      facts,
      element("strong", "audit-process-command", process.command),
      element("code", "audit-process-id", process.id),
    );
    header.append(
      identity,
      link("audit-text-link", "프로세스 상세 →", process.href),
    );
    return header;
  }

  function processCard(process) {
    const card = element("article", "audit-process-card", undefined, {
      "data-audit-process": process.id,
      "data-live-url": process.liveUrl,
      "data-running": process.runningText,
      "data-more": "true",
    });
    card.append(
      processHeader(process),
      element("p", "audit-log-empty", "아직 기록된 로그가 없습니다.", {
        "data-log-empty": "",
      }),
      element("pre", "log-output", "", {
        "data-audit-log": "",
        "data-cursor": "",
        tabindex: "0",
        "aria-label": "프로세스 " + process.id + " 실행 로그",
      }),
    );
    card.auditMetadata = signature(process);
    return card;
  }

  function processMeta(meta) {
    const root = element("div", "", undefined, {
      "data-audit-process-meta": "",
    });
    const heading = element("div", "audit-process-heading");
    const title = element("div");
    title.append(element("h3", "", "연관 프로세스·작동 로그"));
    if (meta.ownerLabel) {
      title.append(element("p", "", meta.ownerLabel + "님의 실행 환경"));
    }
    heading.append(title);
    if (meta.processListHref) {
      heading.append(
        link("audit-text-link", "프로세스 관리 →", meta.processListHref),
      );
    }
    root.append(heading);
    if (meta.message) {
      root.append(element("p", "audit-message", meta.message));
    }
    return root;
  }

  function detailFragment(record, meta, hasProcesses) {
    const root = element("div", "audit-detail-panel", undefined, {
      "data-audit-fragment": "",
      role: "region",
      "aria-label": record.event + " 상세",
    });
    if (record.reason) {
      const reason = element("section", "audit-reason-section");
      reason.append(
        element("h3", "", "작업 이유"),
        element("p", "", record.reason),
      );
      root.append(reason);
    }
    const section = element("section", "audit-process-section");
    section.append(
      processMeta(meta),
      element("div", "audit-process-list", undefined, {
        "data-audit-processes": "",
      }),
    );
    root.append(section);
    if (record.command || meta.command) {
      const command = element(
        "details",
        "audit-command-section audit-request-command",
      );
      if (!hasProcesses) {
        command.setAttribute("open", "");
      }
      command.append(
        element("summary", "", "요청한 명령"),
        element(
          "pre",
          "command-block audit-command",
          record.command || meta.command,
        ),
      );
      root.append(command);
    }
    const raw = element("details", "audit-raw");
    raw.append(
      element("summary", "", "원본 기록"),
      element("pre", "audit-json", record.details),
    );
    root.append(raw);
    return root;
  }

  function mergeDetail(row, snapshot) {
    if (!snapshot.record || !snapshot.meta || !Array.isArray(snapshot.order)) {
      throw new Error("Invalid audit detail");
    }
    preserveReading(() => {
      if (!row.loaded) {
        row.content.replaceChildren(
          detailFragment(
            snapshot.record,
            snapshot.meta,
            snapshot.order.length > 0,
          ),
        );
        row.loaded = true;
        row.metaSignature = signature(snapshot.meta);
      }
      const currentMeta = row.content.querySelector(
        "[data-audit-process-meta]",
      );
      const metaSignature = signature(snapshot.meta);
      if (
        currentMeta &&
        row.metaSignature !== metaSignature &&
        !protectedWithin(currentMeta)
      ) {
        currentMeta.replaceChildren(...processMeta(snapshot.meta).children);
        row.metaSignature = metaSignature;
      }
      const list = row.content.querySelector("[data-audit-processes]");
      const known = new Map(
        Array.from(
          row.content.querySelectorAll("[data-audit-process]"),
          (card) => [card.dataset.auditProcess, card],
        ),
      );
      if (list) {
        for (const id of snapshot.order) {
          const process = snapshot["process:" + id];
          if (!process) {
            continue;
          }
          const card = known.get(id);
          if (!card) {
            list.append(processCard(process));
          } else {
            const header = card.querySelector("[data-audit-process-header]");
            const nextSignature = signature(process);
            if (
              header &&
              card.auditMetadata !== nextSignature &&
              !protectedWithin(header)
            ) {
              header.replaceChildren(
                ...processHeader({ ...process, ...card.auditLogStatus })
                  .children,
              );
              card.auditMetadata = nextSignature;
            }
          }
        }
      }
      registerLogs(row);
    });
  }

  function registerRow(summary, detail) {
    const toggle = summary.querySelector("[data-audit-toggle]");
    const content = detail?.querySelector("[data-audit-detail-content]");
    if (!toggle || !content) {
      return undefined;
    }
    const row = {
      summary,
      detail,
      toggle,
      content,
      loaded: !!content.querySelector("[data-audit-fragment]"),
    };
    rows.set(summary.dataset.auditId, row);
    row.feed = createFeed({
      kind: "detail",
      row,
      owner: detail,
      interval: 5000,
      due: row.loaded ? Date.now() + 5000 : Date.now(),
      active: () => detail.isConnected && !detail.hidden,
      url: () => {
        content.setAttribute("aria-busy", "true");
        const url = new URL(toggle.dataset.detailUrl, window.location.href);
        return url;
      },
      apply: (snapshot) => mergeDetail(row, snapshot),
      error: (message) => {
        if (!row.loaded && !detail.hidden) {
          let error = content.querySelector("[data-audit-load-error]");
          if (!error) {
            error = document.createElement("p");
            error.dataset.auditLoadError = "";
            error.className = "audit-log-error";
            content.append(error);
          }
          error.textContent = message;
        }
      },
      done: () => content.removeAttribute("aria-busy"),
    });
    if (!detail.hidden) {
      registerLogs(row);
    }
    return row;
  }

  function updateSummary(row, record) {
    const value = signature(record);
    if (row.summarySignature === value || protectedWithin(row.summary)) {
      return;
    }
    const time = row.summary.querySelector(".audit-time");
    const event = row.summary.querySelector(".audit-event");
    const actor = row.summary.querySelector(".audit-actor");
    if (time) {
      time.replaceChildren(localTime(record.at, record.atDateTime));
    }
    if (event) {
      const heading = element("div", "audit-event-heading");
      heading.append(element("strong", "", record.event));
      if (record.tool) {
        heading.append(element("code", "audit-tool", record.tool));
      }
      event.replaceChildren(heading);
      if (record.reason) {
        event.append(element("p", "audit-reason", record.reason));
      }
    }
    if (actor) {
      actor.textContent = record.actor;
    }
    row.toggle.setAttribute(
      "href",
      link("", "", record.detailHref).getAttribute("href") || "/admin/audit",
    );
    row.summarySignature = value;
  }

  function createRow(record) {
    const id = record.id;
    const summary = element("tr", "audit-row", undefined, {
      id: "audit-row-" + id,
      "data-audit-id": id,
      role: "row",
    });
    for (const name of ["time", "event", "actor"]) {
      summary.append(
        element("td", "audit-" + name, undefined, { role: "cell" }),
      );
    }
    const action = element("td", "audit-action", undefined, { role: "cell" });
    action.append(
      link("button small audit-detail-toggle", "상세 보기", record.detailHref, {
        "data-audit-toggle": "",
        "data-detail-url": "/admin/audit/" + encodeURIComponent(id) + "/live",
        "aria-expanded": "false",
        "aria-controls": "audit-detail-" + id,
      }),
    );
    summary.append(action);
    const detail = element("tr", "audit-detail-row", undefined, {
      id: "audit-detail-" + id,
      "data-audit-detail-row": id,
      role: "row",
    });
    detail.hidden = true;
    const cell = element("td", "", undefined, {
      colspan: "4",
      role: "cell",
      "aria-colspan": "4",
    });
    cell.append(
      element("div", "", undefined, { "data-audit-detail-content": "" }),
    );
    detail.append(cell);
    return registerRow(summary, detail);
  }

  function renderPagination(value) {
    const root = element("nav", "pagination", undefined, {
      "aria-label": "페이지 이동",
    });
    root.append(
      element(
        "span",
        "pagination-summary",
        "총 " +
          value.total +
          "개 · " +
          value.page +
          " / " +
          value.pages +
          " 페이지",
      ),
    );
    const links = element("div", "pagination-links");
    function step(href, label, aria) {
      return href
        ? link("button pagination-step", label, href, { "aria-label": aria })
        : element("span", "button pagination-step disabled", label, {
            "aria-disabled": "true",
          });
    }
    links.append(step(value.previous, "← 이전", "이전 페이지"));
    for (const item of value.pageItems || []) {
      if (item.gap) {
        links.append(
          element("span", "pagination-gap", "…", { "aria-hidden": "true" }),
        );
      } else if (item.isPage) {
        links.append(
          item.current
            ? element("span", "button pagination-page active", item.label, {
                "aria-current": "page",
              })
            : link("button pagination-page", item.label, item.href, {
                "aria-label": item.label + "페이지로 이동",
              }),
        );
      }
    }
    links.append(step(value.next, "다음 →", "다음 페이지"));
    root.append(links);
    return root;
  }

  function reconcile(snapshot) {
    if (!Array.isArray(snapshot.order)) {
      throw new Error("Invalid audit list");
    }
    preserveReading(() => {
      const order = [];
      for (const id of snapshot.order) {
        const record = snapshot["row:" + id];
        if (!record) {
          continue;
        }
        const row = rows.get(id) || createRow(record);
        if (row) {
          updateSummary(row, record);
          order.push(row);
        }
      }
      for (const [id, row] of rows) {
        if (order.includes(row)) {
          continue;
        }
        if (
          !row.detail.hidden ||
          protectedWithin(row.summary) ||
          protectedWithin(row.detail)
        ) {
          order.push(row);
        } else {
          row.summary.remove();
          row.detail.remove();
          rows.delete(id);
        }
      }
      for (const child of Array.from(body.children)) {
        if (!child.matches("[data-audit-id], [data-audit-detail-row]")) {
          child.remove();
        }
      }
      let before = body.firstElementChild;
      for (const row of order) {
        for (const node of [row.summary, row.detail]) {
          if (node === before) {
            before = before.nextElementSibling;
          } else {
            body.insertBefore(node, before);
          }
        }
      }
      if (!order.length) {
        const empty = element("tr", "", undefined, { role: "row" });
        empty.append(
          element("td", "empty-state", "조건에 맞는 기록이 없습니다.", {
            colspan: "4",
            role: "cell",
            "aria-colspan": "4",
          }),
        );
        body.replaceChildren(empty);
      }
      for (const [selector, value, render] of [
        [
          "[data-audit-pagination]",
          snapshot.pagination,
          (value) => (value ? renderPagination(value) : undefined),
        ],
        [
          "[data-audit-clipped]",
          snapshot.clipped,
          (value) =>
            value
              ? element(
                  "p",
                  "audit-clipped",
                  "최근 1 MiB의 기록을 표시합니다. 이전 기록은 서버의 보관 로그에서 확인할 수 있습니다.",
                )
              : undefined,
        ],
      ]) {
        const current = page.querySelector(selector);
        const nextSignature = signature(value);
        if (
          current &&
          current.auditSignature !== nextSignature &&
          !protectedWithin(current)
        ) {
          const next = render(value);
          current.replaceChildren(...(next ? [next] : []));
          current.auditSignature = nextSignature;
        }
      }
    });
  }

  const initialDetails = new Map(
    Array.from(body.querySelectorAll("[data-audit-detail-row]"), (detail) => [
      detail.dataset.auditDetailRow,
      detail,
    ]),
  );
  for (const summary of body.querySelectorAll("[data-audit-id]")) {
    registerRow(summary, initialDetails.get(summary.dataset.auditId));
  }
  createFeed({
    kind: "list",
    due: Date.now() + 2000,
    active: () => true,
    url: () => {
      const url = new URL(window.location.href);
      url.pathname = "/admin/audit/live";
      url.searchParams.delete("detail");
      url.hash = "";
      return url;
    },
    apply: reconcile,
  });

  page.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-audit-toggle]");
    if (
      !toggle ||
      !page.contains(toggle) ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const row = rows.get(toggle.closest("[data-audit-id]")?.dataset.auditId);
    if (!row) {
      return;
    }
    event.preventDefault();
    const open = row.detail.hidden;
    row.detail.hidden = !open;
    row.toggle.setAttribute("aria-expanded", String(open));
    row.toggle.textContent = open ? "닫기" : "상세 보기";
    row.summary.classList.toggle("expanded", open);
    if (open) {
      row.feed.due = Date.now();
      registerLogs(row);
      schedule();
    } else {
      for (const feed of feeds) {
        if (feed.row === row) {
          feed.controller?.abort();
        }
      }
    }
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.hidden) {
      for (const feed of feeds) {
        feed.controller?.abort();
      }
    } else {
      for (const feed of feeds) {
        feed.due = Date.now();
      }
      schedule();
    }
  });
  window.addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(timer);
    for (const feed of feeds) {
      feed.controller?.abort();
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      closed = false;
      schedule();
    }
  });
  schedule();
})();
