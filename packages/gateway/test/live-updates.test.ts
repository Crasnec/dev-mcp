import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../public/live-updates.js", import.meta.url),
  "utf8",
);

// Keep the harness limited to browser APIs used by the script. Timers and fetch
// remain under test control so visibility, slow responses and EOF can be tested.
class Element {
  dataset: Record<string, string> = {};
  selectors = new Set<string>();
  children: Element[] = [];
  textContent = "";
  className = "";
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 1000;
  clientHeight = 100;
  removed = false;
  replacements = 0;
  private html = "";

  constructor(selector: string, dataset: Record<string, string> = {}) {
    this.selectors.add(selector);
    this.dataset = dataset;
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.replacements += 1;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    for (const child of this.querySelectorAll("*")) {
      child.scrollTop = 0;
      child.scrollLeft = 0;
    }
  }

  matches(selector: string) {
    return selector.split(", ").some((part) => this.selectors.has(part));
  }

  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => {
      if (child.removed) {
        return [];
      }
      return [
        ...(selector === "*" || child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ];
    });
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(element: Element | null) {
    return this === element || this.querySelectorAll("*").includes(element!);
  }

  append(node: { textContent: string }) {
    this.textContent += node.textContent;
    this.scrollHeight += node.textContent.length;
  }

  remove() {
    this.removed = true;
  }
}

function harness(detail = true) {
  const events = new Map<string, (event?: { persisted: boolean }) => void>();
  const page = new Element("main[data-live-page]");
  const log = new Element("pre[data-live-log]", { cursor: "initial-cursor" });
  const badge = new Element("[data-process-status]");
  const stop = new Element("[data-process-stop]");
  const nextPage = new Element("main[data-live-page]");
  if (detail) {
    page.selectors.add("[data-live-process]");
    page.dataset = {
      liveProcess: "/admin/processes/owner/job/live",
      liveRunning: "true",
      liveMore: "false",
    };
    page.children = [log, badge, stop];
  }
  const document = {
    hidden: false,
    activeElement: null as Element | null,
    querySelector: () => page,
    createTextNode: (textContent: string) => ({ textContent }),
    addEventListener: (name: string, callback: () => void) => {
      events.set(name, callback);
    },
  };
  const window = {
    location: { href: "https://dev.example/admin/processes?owner=me&page=2" },
    scrollX: 11,
    scrollY: 300,
    scrollTo: vi.fn(),
    getSelection: () => ({ isCollapsed: true }),
    addEventListener: (name: string, callback: () => void) => {
      events.set(name, callback);
    },
  };
  const fetch = vi.fn();
  const start = () => {
    runInNewContext(source, {
      document,
      window,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch,
      DOMParser: class {
        parseFromString() {
          return { querySelector: () => nextPage };
        }
      },
    });
  };
  const respond = (
    output: string,
    cursor: string,
    status = "running",
    more = false,
  ) => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        process: {
          status,
          statusLabel: status === "running" ? "실행 중" : "종료",
        },
        output,
        cursor,
        more,
      }),
    });
  };
  return {
    page,
    log,
    badge,
    stop,
    nextPage,
    document,
    window,
    events,
    fetch,
    start,
    respond,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live process logs", () => {
  it("appends literal text once, follows the bottom and preserves a reader's scroll position", async () => {
    const h = harness();
    h.log.textContent = "existing\n";
    h.respond("<script>text</script>\n", "cursor-2");
    h.respond("new output\n", "cursor-3");
    h.start();
    expect(h.log.scrollTop).toBe(h.log.scrollHeight);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.log.textContent).toBe("existing\n<script>text</script>\n");
    expect(h.log.replacements).toBe(0);
    expect(h.log.scrollTop).toBe(h.log.scrollHeight);
    expect(h.fetch.mock.calls[0][0].searchParams.get("cursor")).toBe(
      "initial-cursor",
    );
    expect(h.fetch.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });

    h.log.scrollTop = 250;
    h.log.scrollLeft = 40;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fetch.mock.calls[1][0].searchParams.get("cursor")).toBe(
      "cursor-2",
    );
    expect(h.log.textContent).toBe(
      "existing\n<script>text</script>\nnew output\n",
    );
    expect(h.log.scrollTop).toBe(250);
    expect(h.log.scrollLeft).toBe(40);
    expect(h.window.scrollTo).not.toHaveBeenCalled();
  });

  it("drains final output after exit, updates status and removes stop controls before stopping", async () => {
    const h = harness();
    const error = new Element("[data-log-error]");
    const fallback = new Element("[data-live-next]");
    h.page.children.push(error, fallback);
    h.respond("final page\n", "cursor-2", "exited", true);
    h.respond("final line\n", "cursor-3", "exited", false);
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.badge.textContent).toBe("종료");
    expect(h.badge.className).toBe("badge exited");
    expect(h.stop.removed).toBe(true);
    expect(error.removed).toBe(true);
    expect(fallback.removed).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.log.textContent).toBe("final page\nfinal line\n");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("pauses in the background without overlapping a pending request and refreshes on return", async () => {
    const h = harness();
    let resolve!: (response: unknown) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.respond("visible", "cursor-2");
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    h.document.hidden = true;
    h.events.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(4000);
    h.document.hidden = false;
    h.events.get("visibilitychange")!();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    resolve({
      ok: true,
      status: 200,
      json: async () => ({
        process: { status: "running", statusLabel: "실행 중" },
        output: "first",
        cursor: "cursor-1",
        more: false,
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    h.document.hidden = true;
    h.events.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.document.hidden = false;
    h.events.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.log.textContent).toBe("firstvisible");
  });

  it("does not consume an unseen background response or lose its output on return", async () => {
    const h = harness();
    let resolve!: (response: unknown) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.respond("background output", "cursor-2");
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    h.document.hidden = true;
    h.events.get("visibilitychange")!();
    resolve({
      ok: true,
      status: 200,
      json: async () => ({
        process: { status: "running", statusLabel: "실행 중" },
        output: "background output",
        cursor: "cursor-2",
        more: false,
      }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.log.textContent).toBe("");
    h.document.hidden = false;
    h.events.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch.mock.calls[1][0].searchParams.get("cursor")).toBe(
      "initial-cursor",
    );
    expect(h.log.textContent).toBe("background output");
  });

  it("times out a stalled request, backs off, and retries from the unchanged cursor", async () => {
    const h = harness();
    h.fetch.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    h.respond("recovered", "cursor-2");
    h.start();
    await vi.advanceTimersByTimeAsync(22_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch.mock.calls[1][0].searchParams.get("cursor")).toBe(
      "initial-cursor",
    );
    expect(h.log.textContent).toBe("recovered");
  });

  it("stops on revoked access and aborts on page exit", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    h.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);

    const pending = harness();
    pending.fetch.mockImplementation(() => new Promise(() => {}));
    pending.start();
    await vi.advanceTimersByTimeAsync(2000);
    pending.events.get("pagehide")!();
    expect(pending.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("live page regions", () => {
  it("preserves filters and form values, skips unchanged HTML, and retains scrolling", async () => {
    const h = harness(false);
    const current = new Element("[data-live-region]", { liveRegion: "rows" });
    const next = new Element("[data-live-region]", { liveRegion: "rows" });
    const form = new Element("form");
    const formRegion = new Element("[data-live-region]", {
      liveRegion: "form",
    });
    const nextFormRegion = new Element("[data-live-region]", {
      liveRegion: "form",
    });
    const table = new Element("table");
    current.innerHTML = "old rows";
    current.scrollTop = 80;
    current.scrollLeft = 60;
    current.children = [table];
    table.scrollTop = 15;
    next.innerHTML = "new rows";
    formRegion.innerHTML = "user input";
    formRegion.children = [form];
    nextFormRegion.innerHTML = "server input";
    h.page.children = [current, formRegion];
    h.nextPage.children = [next, nextFormRegion];
    h.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "page",
    });
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.fetch.mock.calls[0][0].href).toBe(h.window.location.href);
    expect(current.innerHTML).toBe("new rows");
    expect(current.scrollTop).toBe(80);
    expect(current.scrollLeft).toBe(60);
    expect(table.scrollTop).toBe(15);
    expect(formRegion.innerHTML).toBe("user input");
    expect(current.replacements).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(current.replacements).toBe(2);
    next.innerHTML = "newer rows";
    h.document.activeElement = table;
    await vi.advanceTimersByTimeAsync(2000);
    expect(current.innerHTML).toBe("new rows");
    h.document.activeElement = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(current.innerHTML).toBe("newer rows");
  });
});
