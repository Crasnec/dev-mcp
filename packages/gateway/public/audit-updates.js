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

  function parse(html, selector) {
    const element = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector(selector);
    if (!element) {
      throw new Error("Unexpected audit response");
    }
    return element;
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
    const timeout = setTimeout(
      () => controller.abort(),
      feed.kind === "list" ? 45_000 : 20_000,
    );
    try {
      const response = await fetch(feed.url(), {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: feed.kind === "log" ? "application/json" : "text/html",
        },
      });
      if (response.status === 401 || response.status === 403) {
        unauthorized = true;
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
      const result =
        feed.kind === "log" ? await response.json() : await response.text();
      if (!closed && !unauthorized && !document.hidden && feed.active()) {
        feed.apply(result);
      }
      feed.failures = 0;
    } catch {
      feed.failures += 1;
      if (!closed && !document.hidden && feed.active()) {
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
      const feed = createFeed({
        kind: "log",
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
          log.dataset.cursor = result.cursor;
          card.dataset.running = String(result.process.status === "running");
          card.dataset.more = String(result.more);
          feed.stopped = result.process.status !== "running" && !result.more;
          feed.interval = result.more ? 100 : 2000;
        },
      });
    }
  }

  function mergeDetail(row, html) {
    const next = parse(html, "[data-audit-fragment]");
    preserveReading(() => {
      if (!row.loaded) {
        row.content.replaceChildren(next);
        row.loaded = true;
      } else {
        const currentMeta = row.content.querySelector(
          "[data-audit-process-meta]",
        );
        const nextMeta = next.querySelector("[data-audit-process-meta]");
        if (
          currentMeta &&
          nextMeta &&
          !protectedWithin(currentMeta) &&
          currentMeta.innerHTML !== nextMeta.innerHTML
        ) {
          currentMeta.innerHTML = nextMeta.innerHTML;
        }
        const list = row.content.querySelector("[data-audit-processes]");
        const known = new Set(
          Array.from(
            row.content.querySelectorAll("[data-audit-process]"),
            (card) => card.dataset.auditProcess,
          ),
        );
        if (list) {
          for (const card of next.querySelectorAll("[data-audit-process]")) {
            if (!known.has(card.dataset.auditProcess)) {
              list.append(card);
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
      owner: detail,
      interval: 5000,
      due: row.loaded ? Date.now() + 5000 : Date.now(),
      active: () => detail.isConnected && !detail.hidden,
      url: () => {
        content.setAttribute("aria-busy", "true");
        const url = new URL(toggle.dataset.detailUrl, window.location.href);
        if (row.loaded) {
          url.searchParams.set("metadata", "1");
        }
        return url;
      },
      apply: (html) => mergeDetail(row, html),
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

  function reconcile(html) {
    const nextBody = parse(
      html,
      "main[data-live-audit] tbody[data-audit-rows]",
    );
    const nextDetails = new Map(
      Array.from(
        nextBody.querySelectorAll("[data-audit-detail-row]"),
        (detail) => [detail.dataset.auditDetailRow, detail],
      ),
    );
    const order = [];
    for (const summary of nextBody.querySelectorAll("[data-audit-id]")) {
      const id = summary.dataset.auditId;
      const row = rows.get(id) || registerRow(summary, nextDetails.get(id));
      if (row) {
        order.push(row);
      }
    }
    preserveReading(() => {
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
        body.replaceChildren(...nextBody.children);
      }
      const nextPage = nextBody.closest("main");
      for (const selector of [
        "[data-audit-pagination]",
        "[data-audit-clipped]",
      ]) {
        const current = page.querySelector(selector);
        const next = nextPage?.querySelector(selector);
        if (
          current &&
          next &&
          !protectedWithin(current) &&
          current.innerHTML !== next.innerHTML
        ) {
          current.innerHTML = next.innerHTML;
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
    }
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) {
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
