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
  textContent = "";
  className = "";
  tagName: string;
  attributes = new Map<string, string>();
  parentElement: Element | null = null;
  content?: Element;
  hidden = false;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 1000;
  clientHeight = 100;
  removed = false;
  replacements = 0;
  private html = "";
  private nodes: Element[] = [];
  constructor(selector: string, dataset: Record<string, string> = {}) {
    this.selectors.add(selector);
    this.tagName = /^([a-z-]+)/.exec(selector)?.[1] || "div";
    this.dataset = dataset;
  }
  get children() {
    return this.nodes;
  }
  set children(nodes: Element[]) {
    this.nodes = nodes;
    for (const node of nodes) node.parentElement = this;
  }
  get firstElementChild() {
    return this.children[0];
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    this.replacements += 1;
  }
  matches(selector: string) {
    return selector.split(",").some((raw) => {
      const part = raw.trim();
      if (part === "*" || this.selectors.has(part)) {
        return true;
      }
      const tag = /^([a-z-]+)/.exec(part)?.[1];
      if (tag && tag !== this.tagName) {
        return false;
      }
      const attrs = [...part.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
      if (!attrs.length) {
        return !!tag;
      }
      return attrs.every(([, name, value]) => {
        const actual = this.getAttribute(name!);
        return actual !== null && (value === undefined || value === actual);
      });
    });
  }
  getAttribute(name: string) {
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return (
        this.dataset[key] ?? (this.selectors.has("[" + name + "]") ? "" : null)
      );
    }
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      this.dataset[key] = value;
    } else this.attributes.set(name, value);
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) =>
      child.removed
        ? []
        : [
            ...(child.matches(selector) ? [child] : []),
            ...child.querySelectorAll(selector),
          ],
    );
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  contains(element: Element | null) {
    return this === element || this.querySelectorAll("*").includes(element!);
  }
  append(...nodes: Array<Element | { textContent: string }>) {
    for (const node of nodes) {
      if (node instanceof Element) {
        this.insertBefore(node, null);
      } else {
        this.textContent += node.textContent;
        this.scrollHeight += node.textContent.length;
      }
    }
  }
  insertBefore(node: Element, reference: Element | null) {
    if (node.parentElement)
      node.parentElement.nodes = node.parentElement.nodes.filter(
        (item) => item !== node,
      );
    const index = reference ? this.nodes.indexOf(reference) : -1;
    this.nodes.splice(index < 0 ? this.nodes.length : index, 0, node);
    node.parentElement = this;
    node.removed = false;
  }
  replaceChildren(...nodes: Element[]) {
    for (const child of this.nodes) child.parentElement = null;
    this.children = nodes;
    this.replacements += 1;
  }
  cloneNode(deep: boolean): Element {
    const node = new Element(this.tagName, { ...this.dataset });
    node.selectors = new Set(this.selectors);
    node.attributes = new Map(this.attributes);
    node.className = this.className;
    node.textContent = this.textContent;
    if (deep)
      node.children = this.children.map((child) => child.cloneNode(true));
    return node;
  }
  remove() {
    this.removed = true;
    if (this.parentElement)
      this.parentElement.nodes = this.parentElement.nodes.filter(
        (child) => child !== this,
      );
  }
}

function row(id: string) {
  const result = new Element("tr", { liveRow: id });
  result.children = [
    "username",
    "status",
    "connection",
    "projectCount",
    "command",
    "pid",
    "started",
    "href",
  ].map(
    (name) =>
      new Element(
        name === "href" ? "a" : name === "started" ? "time" : "span",
        { liveField: name },
      ),
  );
  return result;
}

function harness(detail = true) {
  const events = new Map<string, (event?: { persisted: boolean }) => void>();
  const page = new Element("main[data-live-page]");
  const log = new Element("pre[data-live-log]", { cursor: "initial-cursor" });
  const badge = new Element("[data-process-status]");
  const stop = new Element("[data-process-stop]");
  const feed = new Element("section", {
    liveFeed: "processes",
    liveUrl: "/admin/processes/live",
  });
  const body = new Element("tbody", { liveRows: "" });
  const region = new Element("div", { liveRegion: "processes" });
  const template = new Element("template", { liveRowTemplate: "" });
  template.content = new Element("fragment");
  template.content.children = [row("")];
  const pager = new Element("div", { livePagination: "" });
  region.children = [body, pager];
  if (!detail) {
    page.children = [feed, region, template];
  }
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
    createElement: (tag: string) => new Element(tag),
    addEventListener: (name: string, callback: () => void) => {
      events.set(name, callback);
    },
  };
  const selection = {
    isCollapsed: true,
    anchorNode: null as Element | null,
    focusNode: null as Element | null,
  };
  const window = {
    location: { href: "https://dev.example/admin/processes?owner=me&page=2" },
    scrollX: 11,
    scrollY: 300,
    scrollTo: vi.fn(),
    getSelection: () => selection,
    devMcpTime: { localize: vi.fn() },
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
    feed,
    body,
    region,
    pager,
    selection,
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
  it("keeps an EOF cursor on bodyless idle responses and still receives terminal status changes", async () => {
    const h = harness();
    const json = vi.fn();
    h.fetch.mockResolvedValueOnce({ ok: true, status: 204, json });
    h.respond("", "initial-cursor", "exited", false);
    h.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.fetch.mock.calls[0][0].searchParams.get("status")).toBe("running");
    expect(h.fetch.mock.calls[0][1].headers.Accept).toBe("application/json");
    expect(json).not.toHaveBeenCalled();
    expect(h.log.dataset.cursor).toBe("initial-cursor");
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch.mock.calls[1][0].searchParams.get("cursor")).toBe(
      "initial-cursor",
    );
    expect(h.stop.removed).toBe(true);
    expect(h.badge.textContent).toBe("종료");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("appends literal text once, follows the bottom and preserves a reader's scroll position", async () => {
    const h = harness();
    h.log.textContent = "existing\n";
    h.respond("<script>text</script>\n", "cursor-2");
    h.respond("new output\n", "cursor-3");
    h.start();
    expect(h.log.scrollTop).toBe(h.log.scrollHeight);

    await vi.advanceTimersByTimeAsync(3000);
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
    await vi.advanceTimersByTimeAsync(3000);
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
    await vi.advanceTimersByTimeAsync(3000);
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
    h.respond("back", "cursor-3");
    h.start();
    await vi.advanceTimersByTimeAsync(3000);
    h.document.hidden = true;
    h.events.get("visibilitychange")!();
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
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
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.document.hidden = true;
    h.events.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.document.hidden = false;
    h.events.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.log.textContent).toBe("visibleback");
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
    await vi.advanceTimersByTimeAsync(3000);
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
    await vi.advanceTimersByTimeAsync(23_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5999);
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
    await vi.advanceTimersByTimeAsync(3000);
    pending.events.get("pagehide")!();
    expect(pending.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending.fetch).toHaveBeenCalledTimes(1);
  });
});

const processRow = (id: string, command = "work") => ({
  id,
  command,
  status: "running",
  statusLabel: "실행 중",
  pid: 42,
  startedDateTime: "2026-10-01T01:00:00.000Z",
  startedLabel: "2026-10-01 01:00 UTC",
  href: "/admin/processes/owner/" + id,
});
function snapshot(
  h: ReturnType<typeof harness>,
  revision: string,
  changes: Record<string, unknown>,
  reset = false,
  removed: string[] = [],
) {
  h.fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      schemaVersion: 1,
      kind: h.feed.dataset.liveFeed,
      revision,
      reset,
      changes,
      removed,
    }),
    text: () => {
      throw new Error("HTML responses are forbidden");
    },
  });
}
const value = (node: Element, name: string) =>
  node.querySelector(`[data-live-field="${name}"]`)!;

describe("JSON live snapshots", () => {
  it("requests only dedicated JSON feeds, applies keyed deltas as literal text and preserves controls, nodes and scrolling", async () => {
    const h = harness(false);
    const existing = row("a");
    h.body.children = [existing];
    const form = new Element("form");
    const input = new Element("input");
    input.textContent = "edited filter";
    form.children = [input];
    h.page.append(form);
    h.region.scrollLeft = 91;
    h.region.scrollTop = 35;
    snapshot(
      h,
      "r1",
      {
        order: ["a"],
        "row:a": processRow("a", "<script>literal</script>"),
        ready: true,
      },
      true,
    );
    snapshot(h, "r2", {
      order: ["b", "a"],
      "row:b": processRow("b"),
      "row:a": processRow("a", "changed"),
    });
    snapshot(h, "r3", { order: ["a"] }, false, ["row:b"]);
    h.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.fetch.mock.calls[0][0].href).toBe(
      "https://dev.example/admin/processes/live?owner=me&page=2",
    );
    expect(h.fetch.mock.calls[0][1].headers.Accept).toBe("application/json");
    expect(h.body.children[0]).toBe(existing);
    expect(value(existing, "command").textContent).toBe(
      "<script>literal</script>",
    );
    expect(existing.replacements).toBe(0);
    expect(input.textContent).toBe("edited filter");
    expect(h.region.scrollLeft).toBe(91);
    expect(h.region.scrollTop).toBe(35);
    expect(h.window.devMcpTime.localize).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.fetch.mock.calls[1][0].searchParams.get("since")).toBe("r1");
    expect(h.body.children.map((node) => node.dataset.liveRow)).toEqual([
      "b",
      "a",
    ]);
    expect(h.body.children[1]).toBe(existing);
    expect(value(existing, "command").textContent).toBe("changed");
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.body.children).toEqual([existing]);
  });

  it("retains deferred changes across204 and renders after focus or text selection leaves", async () => {
    const h = harness(false);
    const existing = row("a");
    value(existing, "command").textContent = "reading";
    h.body.children = [existing];
    h.document.activeElement = value(existing, "href");
    snapshot(h, "r1", { order: ["a"], "row:a": processRow("a", "new") }, true);
    const json = vi.fn();
    h.fetch.mockResolvedValueOnce({ ok: true, status: 204, json });
    h.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(value(existing, "command").textContent).toBe("reading");
    expect(h.fetch.mock.calls[1][0].searchParams.get("since")).toBe("r1");
    expect(json).not.toHaveBeenCalled();
    h.document.activeElement = null;
    h.selection.isCollapsed = false;
    h.selection.anchorNode = value(existing, "command");
    h.events.get("focusout")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(value(existing, "command").textContent).toBe("reading");
    h.selection.isCollapsed = true;
    h.events.get("selectionchange")!();
    expect(value(existing, "command").textContent).toBe("new");
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("updates runner detail read-only regions while preserving operation form revisions and edited values", async () => {
    const h = harness(false);
    h.feed.dataset.liveFeed = "runner";
    h.feed.dataset.liveUrl = "/admin/runners/owner/live";
    const state = new Element("div", { liveRegion: "runner-state" });
    state.children = [
      new Element("dd", { liveField: "containerState" }),
      new Element("time", { liveField: "observed" }),
      new Element("p", { liveField: "observationMissing" }),
    ];
    const form = new Element("form", { liveRegion: "controls" });
    const input = new Element("input");
    input.textContent = "unsaved revision and limit";
    form.children = [input];
    h.page.children = [h.feed, state, form];
    snapshot(
      h,
      "r1",
      {
        containerState: "실행 중",
        observedDateTime: "2026-10-01T01:00:00.000Z",
        observedLabel: "UTC",
        observationFresh: true,
      },
      true,
    );
    h.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(value(state, "containerState").textContent).toBe("실행 중");
    expect(value(state, "observationMissing").hidden).toBe(true);
    expect(input.textContent).toBe("unsaved revision and limit");
    expect(form.replacements).toBe(0);
  });
});
