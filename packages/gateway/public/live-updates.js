(() => {
  const page = document.querySelector("main[data-live-page]");
  if (!page) {
    return;
  }

  const processPage = page.matches("[data-live-process]")
    ? page
    : page.querySelector("[data-live-process]");
  const log = processPage?.querySelector("pre[data-live-log]");
  let cursor = log?.dataset.cursor || "";
  let more = processPage?.dataset.liveMore === "true";
  let finished = processPage
    ? processPage.dataset.liveRunning === "false" && !more
    : false;
  let closed = false;
  let inFlight = false;
  let controller;
  let timer;
  let failures = 0;

  if (log) {
    log.scrollTop = log.scrollHeight;
  }

  function keepWindowPosition(update) {
    const left = window.scrollX;
    const top = window.scrollY;
    update();
    if (window.scrollX !== left || window.scrollY !== top) {
      window.scrollTo({ left, top, behavior: "instant" });
    }
  }

  function updateRegions(html) {
    const nextPage = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector("main[data-live-page]");
    if (!nextPage) {
      throw new Error("The response is not a live page");
    }
    const nextRegions = new Map(
      Array.from(nextPage.querySelectorAll("[data-live-region]"), (region) => [
        region.dataset.liveRegion,
        region,
      ]),
    );
    const selection = window.getSelection();
    keepWindowPosition(() => {
      for (const region of page.querySelectorAll("[data-live-region]")) {
        const next = nextRegions.get(region.dataset.liveRegion);
        if (
          !next ||
          next.innerHTML === region.innerHTML ||
          region.contains(document.activeElement) ||
          region.matches("form, input, select, textarea, [contenteditable]") ||
          region.querySelector(
            "form, input, select, textarea, [contenteditable]",
          ) ||
          (selection &&
            !selection.isCollapsed &&
            (region.contains(selection.anchorNode) ||
              region.contains(selection.focusNode)))
        ) {
          continue;
        }
        const scrollPositions = [region, ...region.querySelectorAll("*")].map(
          (element) => ({ top: element.scrollTop, left: element.scrollLeft }),
        );
        region.innerHTML = next.innerHTML;
        [region, ...region.querySelectorAll("*")].forEach((element, index) => {
          const position = scrollPositions[index];
          if (position) {
            element.scrollTop = position.top;
            element.scrollLeft = position.left;
          }
        });
      }
    });
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
    ) {
      throw new Error("Invalid process update");
    }
    const running = result.process.status === "running";
    const follow = log.scrollHeight - log.clientHeight - log.scrollTop <= 24;
    const top = log.scrollTop;
    const left = log.scrollLeft;
    keepWindowPosition(() => {
      for (const fallback of processPage.querySelectorAll(
        "[data-log-error], [data-live-next]",
      )) {
        fallback.remove();
      }
      if (result.output) {
        log.append(document.createTextNode(result.output));
      }
      log.scrollTop = follow ? log.scrollHeight : top;
      log.scrollLeft = left;
      for (const badge of processPage.querySelectorAll(
        "[data-process-status]",
      )) {
        badge.textContent = result.process.statusLabel;
        badge.className = "badge " + result.process.status;
      }
      if (!running) {
        for (const stop of processPage.querySelectorAll(
          "[data-process-stop]",
        )) {
          stop.remove();
        }
      }
    });
    cursor = result.cursor;
    more = result.more;
    log.dataset.cursor = cursor;
    processPage.dataset.liveRunning = String(running);
    processPage.dataset.liveMore = String(more);
    finished = !running && !more;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!closed && !finished && !document.hidden) {
      timer = setTimeout(refresh, delay);
    }
  }

  async function refresh() {
    if (closed || finished || document.hidden || inFlight) {
      return;
    }
    inFlight = true;
    controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      processPage ? 20_000 : 45_000,
    );
    try {
      const url = new URL(
        processPage ? processPage.dataset.liveProcess : window.location.href,
        window.location.href,
      );
      if (processPage && cursor) {
        url.searchParams.set("cursor", cursor);
      }
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
        headers: { Accept: processPage ? "application/json" : "text/html" },
      });
      if ([401, 403, 404].includes(response.status)) {
        finished = true;
        return;
      }
      if (!response.ok) {
        throw new Error("Live update failed");
      }
      const result = processPage
        ? await response.json()
        : await response.text();
      if (closed || document.hidden) {
        return;
      }
      if (processPage) {
        updateProcess(result);
      } else {
        updateRegions(result);
      }
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      clearTimeout(timeout);
      controller = undefined;
      inFlight = false;
      schedule(
        failures ? Math.min(2000 * 2 ** failures, 30_000) : more ? 100 : 2000,
      );
    }
  }

  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) {
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
      void refresh();
    }
  });
  schedule(more ? 0 : 2000);
})();
