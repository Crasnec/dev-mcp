(() => {
  const page = document.querySelector("main[data-live-page]");
  if (!page) return;
  const processPage = page.matches("[data-live-process]")
    ? page
    : page.querySelector("[data-live-process]");
  const feed = page.querySelector("[data-live-feed]");
  if (!processPage && !feed) return;
  const log = processPage?.querySelector("pre[data-live-log]");
  const kind = feed?.dataset.liveFeed;
  let cursor = log?.dataset.cursor || "";
  let status = processPage?.dataset.liveRunning === "true" ? "running" : "";
  let more = processPage?.dataset.liveMore === "true";
  let finished = processPage
    ? processPage.dataset.liveRunning === "false" && !more
    : false;
  let closed = false;
  let inFlight = false;
  let controller;
  let timer;
  let failures = 0;
  let idle = false;
  let refreshOnVisible = false;
  let revision = "";
  let model = new Map();
  const rendered = new WeakMap();

  if (log) log.scrollTop = log.scrollHeight;

  function protectedRegion(region) {
    const selection = window.getSelection();
    return (
      region.contains(document.activeElement) ||
      region.matches("form, input, select, textarea, [contenteditable]") ||
      region.querySelector(
        "form, input, select, textarea, [contenteditable]",
      ) ||
      (selection &&
        !selection.isCollapsed &&
        (region.contains(selection.anchorNode) ||
          region.contains(selection.focusNode)))
    );
  }
  function keepWindowPosition(update) {
    const left = window.scrollX;
    const top = window.scrollY;
    update();
    if (window.scrollX !== left || window.scrollY !== top) {
      window.scrollTo({ left, top, behavior: "instant" });
    }
  }
  function text(node, value) {
    const next = value === null || value === undefined ? "" : String(value);
    if (node && node.textContent !== next) node.textContent = next;
  }
  function field(root, name) {
    return root.querySelector(`[data-live-field="${name}"]`);
  }
  function badge(node, label, value) {
    if (!node) return;
    text(node, label);
    const next = "badge " + (/^[a-z-]+$/.test(value) ? value : "pending");
    if (node.className !== next) node.className = next;
  }
  function href(node, value) {
    if (!node || typeof value !== "string") return;
    const url = new URL(value, window.location.href);
    if (
      url.origin !== new URL(window.location.href).origin ||
      !url.pathname.startsWith("/admin/")
    )
      return;
    if (node.getAttribute("href") !== value) node.setAttribute("href", value);
  }
  function time(node, datetime, label) {
    if (!node) return;
    const next = typeof datetime === "string" ? datetime : "";
    if (node.getAttribute("datetime") !== next) {
      node.setAttribute("datetime", next);
      text(node, label);
    }
    window.devMcpTime?.localize(node);
  }
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) text(node, content);
    return node;
  }
  function pagination(value) {
    const nav = element("nav", "pagination");
    nav.setAttribute("aria-label", "페이지 이동");
    nav.append(
      element(
        "span",
        "pagination-summary",
        `총 ${value.total}개 · ${value.page} / ${value.pages} 페이지`,
      ),
    );
    const links = element("div", "pagination-links");
    const step = (target, label, accessible) => {
      const node = element(
        target ? "a" : "span",
        "button pagination-step" + (target ? "" : " disabled"),
        label,
      );
      if (target) {
        href(node, target);
        node.setAttribute("aria-label", accessible);
      } else node.setAttribute("aria-disabled", "true");
      links.append(node);
    };
    step(value.previous, "← 이전", "이전 페이지");
    for (const item of value.pageItems || []) {
      if (item.gap) {
        const gap = element("span", "pagination-gap", "…");
        gap.setAttribute("aria-hidden", "true");
        links.append(gap);
      } else if (item.isPage) {
        const node = element(
          item.current ? "span" : "a",
          "button pagination-page" + (item.current ? " active" : ""),
          item.label,
        );
        if (item.current) node.setAttribute("aria-current", "page");
        else {
          href(node, item.href);
          node.setAttribute("aria-label", item.label + "페이지로 이동");
        }
        links.append(node);
      }
    }
    step(value.next, "다음 →", "다음 페이지");
    nav.append(links);
    return nav;
  }
  function updateRow(node, row) {
    const encoded = JSON.stringify(row);
    if (rendered.get(node) === encoded) return;
    if (kind === "runners") {
      text(field(node, "username"), row.username);
      badge(
        field(node, "connection"),
        row.ready ? "연결됨" : "응답 없음",
        row.ready ? "active" : "pending",
      );
      text(
        field(node, "projectCount"),
        row.ready ? `${row.projectCount}개` : "—",
      );
    } else {
      text(field(node, "command"), row.command);
      text(field(node, "pid"), row.pid ?? "—");
      time(field(node, "started"), row.startedDateTime, row.startedLabel);
    }
    badge(field(node, "status"), row.statusLabel, row.status);
    href(field(node, "href"), row.href);
    rendered.set(node, encoded);
  }
  function renderList(region) {
    const order = model.get("order");
    if (!Array.isArray(order)) return;
    const body = region.querySelector("[data-live-rows]");
    const template = page.querySelector("template[data-live-row-template]");
    if (!body || !template) return;
    const existing = new Map(
      Array.from(body.querySelectorAll("[data-live-row]"), (row) => [
        row.dataset.liveRow,
        row,
      ]),
    );
    const wanted = new Set(order);
    for (const [id, row] of existing) if (!wanted.has(id)) row.remove();
    for (const [index, id] of order.entries()) {
      const data = model.get("row:" + id);
      if (!data || data.id !== id) continue;
      let row = existing.get(id);
      if (!row) {
        row = template.content.firstElementChild.cloneNode(true);
        row.dataset.liveRow = id;
      }
      updateRow(row, data);
      if (body.children[index] !== row)
        body.insertBefore(row, body.children[index] || null);
    }
    const empty = body.querySelector("[data-live-empty]");
    if (order.length) empty?.remove();
    else if (!empty) {
      const row = element("tr");
      row.setAttribute("data-live-empty", "");
      const cell = element(
        "td",
        "empty-state",
        kind === "runners"
          ? "조건에 맞는 사용자가 없습니다."
          : "표시할 프로세스가 없습니다.",
      );
      cell.setAttribute("colspan", "5");
      row.append(cell);
      body.append(row);
    }
    const container = region.querySelector("[data-live-pagination]");
    const value = model.get("pagination");
    const encoded = JSON.stringify(value);
    if (container && rendered.get(container) !== encoded) {
      container.replaceChildren(...(value ? [pagination(value)] : []));
      rendered.set(container, encoded);
    }
    if (kind === "processes") {
      const unavailable = region.querySelector("[data-live-unavailable]");
      if (unavailable) unavailable.hidden = model.get("ready") === true;
      const owner = model.get("ownerId");
      if (typeof owner === "string")
        href(
          region.querySelector("[data-live-runner-link]"),
          "/admin/runners/" + encodeURIComponent(owner),
        );
    }
  }
  function renderRunner(region) {
    switch (region.dataset.liveRegion) {
      case "runner-connection": {
        const ready = model.get("ready");
        badge(
          field(region, "connection"),
          ready ? "연결됨" : "연결 대기",
          ready ? "active" : "pending",
        );
        break;
      }
      case "runner-operation": {
        const pending = field(region, "operationPending");
        const message = field(region, "operationMessage");
        if (pending) pending.hidden = !model.get("operationPending");
        if (message) {
          text(message, model.get("operationMessage"));
          message.hidden = !model.get("operationMessage");
        }
        break;
      }
      case "runner-state": {
        text(field(region, "containerState"), model.get("containerState"));
        time(
          field(region, "observed"),
          model.get("observedDateTime"),
          model.get("observedLabel"),
        );
        const missing = field(region, "observationMissing");
        if (missing) missing.hidden = model.get("observationFresh") === true;
        break;
      }
      case "runner-limits": {
        const observed = model.get("observed");
        const list = region.querySelector("[data-live-observed]");
        const empty = region.querySelector("[data-live-observed-empty]");
        if (list) list.hidden = !observed;
        if (empty) empty.hidden = !!observed;
        for (const node of region.querySelectorAll("[data-live-limit]")) {
          const key = node.dataset.liveLimit;
          text(
            node,
            !observed
              ? ""
              : key === "storage"
                ? `${observed.storageUsed} 사용 / ${observed.storage}`
                : observed[key],
          );
        }
        break;
      }
      case "runner-projects": {
        const projects = model.get("projects") || [];
        const list = region.querySelector("[data-live-projects]");
        const encoded = JSON.stringify(projects);
        if (list && rendered.get(list) !== encoded) {
          list.replaceChildren(
            ...projects.map((project) => {
              const item = element("li");
              item.append(
                element("strong", "", project.name),
                element("code", "", project.relativePath),
              );
              return item;
            }),
          );
          rendered.set(list, encoded);
        }
        const empty = region.querySelector("[data-live-projects-empty]");
        if (empty) {
          empty.hidden = projects.length > 0;
          text(
            empty,
            model.get("ready")
              ? "등록된 프로젝트가 없습니다."
              : "실행 환경에 연결한 뒤 확인할 수 있습니다.",
          );
        }
        break;
      }
    }
  }
  function reconcile() {
    if (!revision || closed || document.hidden) return;
    keepWindowPosition(() => {
      for (const region of page.querySelectorAll("[data-live-region]")) {
        if (protectedRegion(region)) continue;
        if (kind === "runner") renderRunner(region);
        else renderList(region);
      }
    });
  }
  function updateSnapshot(result) {
    if (
      !result ||
      result.schemaVersion !== 1 ||
      result.kind !== kind ||
      typeof result.revision !== "string" ||
      !result.revision ||
      typeof result.reset !== "boolean" ||
      !result.changes ||
      typeof result.changes !== "object" ||
      Array.isArray(result.changes) ||
      !Array.isArray(result.removed) ||
      !result.removed.every((key) => typeof key === "string") ||
      (!revision && !result.reset)
    ) {
      throw new Error("Invalid live snapshot");
    }
    const next = result.reset ? new Map() : new Map(model);
    for (const key of result.removed) next.delete(key);
    for (const [key, value] of Object.entries(result.changes))
      next.set(key, value);
    if (kind !== "runner") {
      const order = next.get("order");
      if (
        !Array.isArray(order) ||
        !order.every(
          (id) => typeof id === "string" && next.get("row:" + id)?.id === id,
        ) ||
        new Set(order).size !== order.length
      )
        throw new Error("Invalid live rows");
    }
    model = next;
    revision = result.revision;
    reconcile();
  }
  function updateProcess(result) {
    if (
      !log ||
      !result.process ||
      typeof result.process.status !== "string" ||
      typeof result.process.statusLabel !== "string" ||
      typeof result.output !== "string" ||
      typeof result.cursor !== "string" ||
      typeof result.more !== "boolean"
    )
      throw new Error("Invalid process update");
    const running = result.process.status === "running";
    const follow = log.scrollHeight - log.clientHeight - log.scrollTop <= 24;
    const top = log.scrollTop;
    const left = log.scrollLeft;
    keepWindowPosition(() => {
      for (const fallback of processPage.querySelectorAll(
        "[data-log-error], [data-live-next]",
      ))
        fallback.remove();
      if (result.output) log.append(document.createTextNode(result.output));
      log.scrollTop = follow ? log.scrollHeight : top;
      log.scrollLeft = left;
      for (const node of processPage.querySelectorAll("[data-process-status]"))
        badge(node, result.process.statusLabel, result.process.status);
      if (!running)
        for (const stop of processPage.querySelectorAll("[data-process-stop]"))
          stop.remove();
    });
    idle = !result.output && result.process.status === status;
    status = result.process.status;
    cursor = result.cursor;
    more = result.more;
    log.dataset.cursor = cursor;
    processPage.dataset.liveRunning = String(running);
    processPage.dataset.liveMore = String(more);
    finished = !running && !more;
  }
  function schedule(delay) {
    clearTimeout(timer);
    if (!closed && !finished && !document.hidden)
      timer = setTimeout(refresh, delay);
  }
  async function refresh() {
    if (closed || finished || document.hidden || inFlight) return;
    inFlight = true;
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(
      () => request.abort(),
      processPage ? 20_000 : 45_000,
    );
    try {
      const url = new URL(
        processPage ? processPage.dataset.liveProcess : feed.dataset.liveUrl,
        window.location.href,
      );
      if (processPage) {
        if (cursor) url.searchParams.set("cursor", cursor);
        if (status) url.searchParams.set("status", status);
      } else {
        url.search = new URL(window.location.href).search;
        if (feed.dataset.liveOwner && !url.searchParams.has("owner"))
          url.searchParams.set("owner", feed.dataset.liveOwner);
        if (revision) url.searchParams.set("since", revision);
      }
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: request.signal,
        headers: { Accept: "application/json" },
      });
      if ([401, 403, 404].includes(response.status)) {
        finished = true;
        return;
      }
      if (closed || document.hidden || request.signal.aborted) return;
      if (response.status === 204 || response.status === 304) {
        idle = true;
        reconcile();
      } else {
        if (!response.ok) throw new Error("Live update failed");
        const result = await response.json();
        if (closed || document.hidden || request.signal.aborted) return;
        idle = false;
        if (processPage) updateProcess(result);
        else updateSnapshot(result);
      }
      failures = 0;
    } catch {
      if (!closed && !document.hidden) failures += 1;
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      inFlight = false;
      const delay = refreshOnVisible
        ? 0
        : failures
          ? Math.min(3000 * 2 ** failures, 30_000)
          : more
            ? 100
            : idle
              ? 5000
              : 3000;
      refreshOnVisible = false;
      schedule(delay);
    }
  }
  document.addEventListener("focusout", () => {
    setTimeout(reconcile, 0);
  });
  document.addEventListener("selectionchange", reconcile);
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.hidden) controller?.abort();
    else {
      reconcile();
      refreshOnVisible = inFlight;
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
      refreshOnVisible = inFlight;
      void refresh();
    }
  });
  schedule(more ? 0 : 3000);
})();
