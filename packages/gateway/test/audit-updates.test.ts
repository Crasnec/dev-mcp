import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../public/audit-updates.js", import.meta.url),
  "utf8",
);

// A small DOM model with real node movement and deterministic row geometry.
// It lets these tests exercise fetch races and viewport anchoring without a
// browser dependency or access to the deployed administrator service.
class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, (event: unknown) => void>();
  className = "";
  textContent = "";
  get innerHTML(): string {
    throw new Error("HTML parsing is forbidden for polling updates");
  }
  set innerHTML(_value: string) {
    throw new Error("HTML parsing is forbidden for polling updates");
  }
  hidden = false;
  connectedRoot = false;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 1000;
  clientHeight = 100;
  height = 40;
  geometryScroll = () => 0;
  onFocus = () => {};

  constructor(
    readonly tagName: string,
    dataset: Record<string, string> = {},
  ) {
    this.dataset = dataset;
  }

  get isConnected(): boolean {
    return this.connectedRoot || (this.parentElement?.isConnected ?? false);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  classList = {
    toggle: (name: string, force: boolean) => {
      this.className = force ? name : "";
    },
  };

  matches(selector: string): boolean {
    return selector.split(", ").some((part) => {
      const segments = part.split(" ");
      if (segments.length > 1) {
        return (
          this.matches(segments.at(-1)!) &&
          !!this.parentElement?.closest(segments.slice(0, -1).join(" "))
        );
      }
      const tag = part.match(/^[a-z]+/)?.[0];
      const attribute = part.match(/\[data-([a-z-]+)\]/)?.[1];
      const key = attribute?.replace(/-([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase(),
      );
      if (part.startsWith(".")) {
        return this.className.split(" ").includes(part.slice(1));
      }
      return (!tag || tag === this.tagName) && (!key || key in this.dataset);
    });
  }

  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): Element | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }

  contains(node: Element | null): boolean {
    return (
      !!node &&
      (node === this || this.children.some((child) => child.contains(node)))
    );
  }

  append(...nodes: (Element | { textContent: string })[]) {
    for (const node of nodes) {
      if (node instanceof Element) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      } else {
        this.textContent += node.textContent;
        this.scrollHeight += node.textContent.length;
      }
    }
  }

  insertBefore(node: Element, before: Element | null) {
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentElement = this;
  }

  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }

  replaceChildren(...nodes: Element[]) {
    for (const child of [...this.children]) {
      child.remove();
    }
    this.append(...nodes);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getBoundingClientRect() {
    const siblings = this.parentElement?.children ?? [];
    const before = siblings.slice(0, siblings.indexOf(this));
    const top =
      100 +
      before.reduce((sum, row) => sum + (row.hidden ? 0 : row.height), 0) -
      this.geometryScroll();
    return { top, bottom: top + (this.hidden ? 0 : this.height) };
  }

  focus() {
    this.onFocus();
  }

  addEventListener(name: string, handler: (event: unknown) => void) {
    this.events.set(name, handler);
  }
}

function processCard(id: string, running = true, more = false) {
  const card = new Element("article", {
    auditProcess: id,
    liveUrl: `/admin/processes/owner/${id}/live`,
    running: String(running),
    more: String(more),
  });
  const log = new Element("pre", { auditLog: "", cursor: "initial-cursor" });
  log.textContent = "initial\n";
  const badge = new Element("span", { processStatus: "" });
  const header = new Element("header", { auditProcessHeader: "" });
  header.append(badge);
  card.append(header, log);
  return { card, log, badge };
}

function fragment(...cards: Element[]) {
  const root = new Element("div", { auditFragment: "" });
  const raw = new Element("details");
  raw.setAttribute("open", "");
  const meta = new Element("div", { auditProcessMeta: "" });
  meta.append(new Element("h3"));
  const list = new Element("div", { auditProcesses: "" });
  list.append(...cards);
  root.append(raw, meta, list);
  return { root, raw, meta, list };
}

function auditRow(id: string, expanded = false, detailFragment?: Element) {
  const summary = new Element("tr", { auditId: id });
  const toggle = new Element("a", {
    auditToggle: "",
    detailUrl: `/admin/audit/${id}/live`,
  });
  toggle.setAttribute("aria-expanded", String(expanded));
  for (const name of ["event", "time", "actor"]) {
    const cell = new Element("td");
    cell.className = "audit-" + name;
    summary.append(cell);
  }
  summary.append(toggle);
  const detail = new Element("tr", { auditDetailRow: id });
  detail.height = 240;
  detail.hidden = !expanded;
  const content = new Element("div", { auditDetailContent: "" });
  if (detailFragment) {
    content.append(detailFragment);
  }
  detail.append(content);
  return { summary, toggle, detail, content };
}

function harness(initial: ReturnType<typeof auditRow>[]) {
  const page = new Element("main", { liveAudit: "" });
  page.connectedRoot = true;
  const scroller = new Element("div");
  scroller.className = "table-scroll";
  const body = new Element("tbody", { auditRows: "" });
  const filter = new Element("input");
  filter.textContent = "unsaved filter";
  scroller.append(body);
  page.append(filter, scroller);
  const windowEvents = new Map<
    string,
    (event?: { persisted: boolean }) => void
  >();
  const documentEvents = new Map<string, () => void>();
  const document = {
    hidden: false,
    activeElement: null as Element | null,
    querySelector: () => page,
    createTextNode: (textContent: string) => ({ textContent }),
    createElement: (tag: string) => {
      const node = new Element(tag);
      node.geometryScroll = () => window.scrollY;
      return node;
    },
    addEventListener: (name: string, handler: () => void) =>
      documentEvents.set(name, handler),
  };
  const selection = {
    isCollapsed: true,
    anchorNode: null as Element | null,
    focusNode: null as Element | null,
  };
  const window = {
    location: {
      href: "https://dev.example/admin/audit?q=build&page=2&detail=a#record",
    },
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(({ left, top }: { left: number; top: number }) => {
      window.scrollX = left;
      window.scrollY = top;
    }),
    getSelection: () => selection,
    addEventListener: (name: string, handler: () => void) =>
      windowEvents.set(name, handler),
  };
  function attach(row: ReturnType<typeof auditRow>) {
    row.summary.geometryScroll = row.detail.geometryScroll = () =>
      window.scrollY;
    row.toggle.onFocus = () => {
      document.activeElement = row.toggle;
    };
    body.append(row.summary, row.detail);
  }
  for (const row of initial) {
    attach(row);
  }
  const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
  const listResponse = (
    revision: string,
    records: ReturnType<typeof record>[],
  ) =>
    deltaResponse("audit", revision, {
      order: records.map((row) => row.id),
      ...Object.fromEntries(records.map((row) => ["row:" + row.id, row])),
      pagination: { total: records.length, page: 1, pages: 1, pageItems: [] },
      clipped: false,
    });
  const start = () =>
    runInNewContext(source, {
      page,
      document,
      window,
      Date,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      fetch,
    });
  const click = (row: ReturnType<typeof auditRow>, modifiers = {}) => {
    const event = {
      target: row.toggle,
      button: 0,
      preventDefault: vi.fn(),
      ...modifiers,
    };
    page.events.get("click")!(event);
    return event;
  };
  return {
    page,
    body,
    scroller,
    filter,
    window,
    document,
    selection,
    windowEvents,
    documentEvents,
    fetch,
    start,
    click,
    listResponse,
  };
}

function record(id: string, reason = "") {
  return {
    id,
    at: "2026-10-01 12:00",
    atDateTime: "2026-10-01T12:00:00Z",
    event: "tool_call",
    actor: "Admin",
    tool: "terminal.exec",
    reason,
    detailHref: "/admin/audit?detail=" + id,
  };
}

function processMetadata(id: string, status = "running") {
  return {
    id,
    pid: 123,
    command: "echo <literal>",
    status,
    statusLabel: status,
    startedLabel: "2026-10-01 12:00",
    startedDateTime: "2026-10-01T12:00:00Z",
    href: "/admin/processes/owner/" + id,
    liveUrl: "/admin/processes/owner/" + id + "/live",
    runningText: String(status === "running"),
    moreText: "true",
  };
}

function deltaResponse(
  kind: "audit" | "audit-detail",
  revision: string,
  changes: Record<string, unknown>,
  reset = true,
  removed: string[] = [],
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      schemaVersion: 1,
      kind,
      revision,
      changes,
      reset,
      removed,
    }),
  };
}

function detailResponse(
  revision: string,
  processes: ReturnType<typeof processMetadata>[] = [],
) {
  return deltaResponse("audit-detail", revision, {
    record: {
      ...record("a", "작업 <이유>"),
      details: '{"literal":"<script>"}',
      command: "echo <literal>",
      processId: processes[0]?.id ?? "requested-job",
    },
    meta: {
      ownerLabel: "Admin",
      processListHref: "/admin/processes",
      message: "",
      command: "echo <literal>",
    },
    order: processes.map((process) => process.id),
    ...Object.fromEntries(
      processes.map((process) => ["process:" + process.id, process]),
    ),
  });
}

function logResponse(
  output: string,
  cursor: string,
  status = "running",
  more = false,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      output,
      cursor,
      more,
      process: { status, statusLabel: status },
    }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("inline audit details", () => {
  it("updates repeat counts in open details after text selection clears without replacing the disclosure", async () => {
    const row = auditRow("a"),
      h = harness([row]);
    let calls = 0;
    h.fetch.mockImplementation((url: URL) => {
      if (url.pathname !== "/admin/audit/a/live") {
        return new Promise(() => {});
      }
      calls += 1;
      if (calls > 2) {
        return Promise.resolve({ ok: true, status: 204 });
      }
      return Promise.resolve(
        deltaResponse("audit-detail", "detail-" + calls, {
          record: {
            ...record("a", "동일 오류"),
            aggregated: true,
            details: JSON.stringify({ repeatCount: calls }),
          },
          meta: {},
          order: [],
        }),
      );
    });
    h.start();
    h.click(row);
    await vi.advanceTimersByTimeAsync(1);
    const disclosure = row.content.querySelector(".audit-raw")!;
    const raw = row.content.querySelector(".audit-json")!;
    disclosure.attributes.delete("open");
    h.selection.isCollapsed = false;
    h.selection.anchorNode = h.selection.focusNode = raw;
    await vi.advanceTimersByTimeAsync(5000);
    expect(raw.textContent).toBe('{"repeatCount":1}');
    h.selection.anchorNode = h.selection.focusNode = null;
    h.selection.isCollapsed = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(raw.textContent).toBe('{"repeatCount":2}');
    expect(row.content.querySelector(".audit-raw")).toBe(disclosure);
    expect(disclosure.attributes.has("open")).toBe(false);
  });
  it("keeps tools first in refreshed rows and displays the raw record without duplicate sections", async () => {
    const row = auditRow("a");
    const h = harness([row]);
    const call = {
      ...record("a", "프로젝트 복제"),
      tool: "project_clone",
    };
    const details = JSON.stringify({
      tool: call.tool,
      reason: call.reason,
      params: { name: "<script>project</script>", ref: "main" },
    });
    h.fetch.mockImplementation((url: URL) => {
      if (url.pathname === "/admin/audit/a/live") {
        return Promise.resolve(
          deltaResponse("audit-detail", "detail-one", {
            record: { ...call, details },
            meta: {},
            order: [],
          }),
        );
      }
      return Promise.resolve(h.listResponse("list-one", [call]));
    });
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    const heading = row.summary.querySelector(".audit-event-heading")!;
    expect(heading.firstElementChild?.textContent).toBe("project_clone");
    h.click(row);
    await vi.advanceTimersByTimeAsync(1);
    const detail = row.content.querySelector("[data-audit-fragment]")!;
    expect(detail.firstElementChild?.className).toBe("audit-raw");
    expect(detail.firstElementChild?.attributes.has("open")).toBe(true);
    expect(detail.querySelector(".audit-json")?.textContent).toBe(details);
    expect(detail.querySelector(".audit-invocation-section")).toBeNull();
    expect(detail.querySelector(".audit-reason-section")).toBeNull();
    expect(detail.querySelector(".audit-process-section")).toBeNull();
    expect(detail.querySelector("script")).toBeNull();
  });

  it("opens new self-service audit rows and their logs through account-only URLs", async () => {
    const h = harness([]);
    h.page.dataset.consoleBase = "/account";
    h.window.location.href = "https://dev.example/account/audit?q=build";
    const ownRecord = { ...record("a"), detailHref: "/account/audit?detail=a" };
    const process = {
      ...processMetadata("job"),
      href: "/account/processes/me/job",
      liveUrl: "/account/processes/me/job/live",
    };
    const response = detailResponse("detail-1", [process]);
    const payload = await response.json();
    (payload.changes.meta as Record<string, unknown>).processListHref =
      "/account/processes";
    h.fetch.mockImplementation((url: URL) => {
      if (url.pathname === "/account/audit/live")
        return Promise.resolve(h.listResponse("list-1", [ownRecord]));
      if (url.pathname === "/account/audit/a/live")
        return Promise.resolve({ ...response, json: async () => payload });
      if (url.pathname === "/account/processes/me/job/live")
        return Promise.resolve(logResponse("own log", "own-cursor"));
      throw new Error("Unexpected console URL: " + url.pathname);
    });
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    const summary = h.body.querySelector("[data-audit-id]")!;
    const toggle = summary.querySelector("[data-audit-toggle]")!;
    const detail = h.body.querySelector("[data-audit-detail-row]")!;
    const content = detail.querySelector("[data-audit-detail-content]")!;
    expect(toggle.getAttribute("href")).toBe(ownRecord.detailHref);
    expect(toggle.dataset.detailUrl).toBe("/account/audit/a/live");
    h.click({ summary, toggle, detail, content });
    await vi.advanceTimersByTimeAsync(2);
    expect(content.querySelector("[data-audit-log]")?.textContent).toBe(
      "own log",
    );
    expect(
      content.querySelectorAll("a").map((link) => link.getAttribute("href")),
    ).toContain(process.href);
    expect(
      h.fetch.mock.calls.every(([url]) => url.pathname.startsWith("/account/")),
    ).toBe(true);
  });

  it("opens inline, respects modified links, and never reopens a detail closed during fetch", async () => {
    const row = auditRow("a");
    const h = harness([row]);
    let resolve!: (response: unknown) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.start();
    expect(
      h.click(row, { ctrlKey: true }).preventDefault,
    ).not.toHaveBeenCalled();
    expect(row.detail.hidden).toBe(true);
    expect(h.click(row).preventDefault).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(row.detail.hidden).toBe(false);
    expect(row.content.attributes.get("aria-busy")).toBe("true");
    h.click(row);
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(detailResponse("late detail"));
    await vi.advanceTimersByTimeAsync(1);
    expect(row.detail.hidden).toBe(true);
    expect(row.content.children).toHaveLength(0);
    expect(row.toggle.attributes.get("aria-expanded")).toBe("false");
    expect(row.content.attributes.has("aria-busy")).toBe(false);
    h.fetch.mockResolvedValueOnce(detailResponse("fresh detail"));
    h.click(row);
    await vi.advanceTimersByTimeAsync(1);
    expect(row.content.querySelector("[data-audit-fragment]")).not.toBeNull();
    expect(row.detail.hidden).toBe(false);
  });

  it("reconciles new rows without replacing open details or moving the reading position", async () => {
    const originalFragment = fragment();
    const old = auditRow("old", true, originalFragment.root);
    const h = harness([old]);
    h.document.activeElement = old.toggle;
    h.selection.isCollapsed = false;
    h.selection.anchorNode = h.selection.focusNode = originalFragment.raw;
    h.scroller.scrollLeft = 70;
    const incoming = record("new", "실패한 검증의 원인을 <그대로> 확인합니다.");
    Object.assign(incoming, {
      commandPreview: "npm run build\nprintf '<literal>'",
    });
    h.fetch.mockResolvedValueOnce(h.listResponse("new page", [incoming]));
    h.start();
    const before = old.summary.getBoundingClientRect().top;
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      h.body.children.map(
        (row) => row.dataset.auditId || row.dataset.auditDetailRow,
      ),
    ).toEqual(["new", "new", "old", "old"]);
    expect(old.summary.getBoundingClientRect().top).toBe(before);
    expect(h.body.querySelector(".audit-reason")?.textContent).toBe(
      "실패한 검증의 원인을 <그대로> 확인합니다.",
    );
    const incomingEvent = h.body.querySelector(".audit-event")!;
    expect(incomingEvent.firstElementChild?.className).toBe(
      "audit-command-preview",
    );
    expect(incomingEvent.firstElementChild?.textContent).toBe(
      "npm run build\nprintf '<literal>'",
    );
    expect(h.window.scrollTo).toHaveBeenCalledWith({
      left: 0,
      top: 40,
      behavior: "instant",
    });
    expect(old.content.querySelector("[data-audit-fragment]")).toBe(
      originalFragment.root,
    );
    expect(originalFragment.raw.attributes.has("open")).toBe(true);
    expect(h.document.activeElement).toBe(old.toggle);
    expect(h.scroller.scrollLeft).toBe(70);
    expect(h.filter.textContent).toBe("unsaved filter");
    const listUrl = h.fetch.mock.calls[0][0] as URL;
    expect(listUrl.searchParams.get("detail")).toBeNull();
    expect(listUrl.searchParams.get("q")).toBe("build");
    expect(listUrl.searchParams.get("page")).toBe("2");
    expect(listUrl.hash).toBe("");
  });

  it("keeps log nodes and cursor when metadata discovers a new process, then drains final output", async () => {
    const existing = processCard("first");
    const detail = fragment(existing.card);
    const row = auditRow("a", true, detail.root);
    const h = harness([row]);
    let logCalls = 0;
    const metadata = detailResponse("detail-1", [
      processMetadata("first"),
      processMetadata("second", "exited"),
    ]);
    h.fetch.mockImplementation((url: URL) => {
      if (url.pathname.endsWith("/first/live")) {
        logCalls += 1;
        return Promise.resolve(
          logResponse(logCalls === 1 ? "<literal>\n" : "", "cursor-2"),
        );
      }
      if (url.pathname.endsWith("/second/live")) {
        return Promise.resolve(
          logResponse("final\n", "cursor-final", "exited"),
        );
      }
      if (url.pathname === "/admin/audit/a/live") {
        expect(url.searchParams.has("metadata")).toBe(false);
        return Promise.resolve(metadata);
      }
      return new Promise(() => {});
    });
    h.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(existing.log.textContent).toBe("initial\n<literal>\n");
    expect(existing.log.scrollTop).toBe(existing.log.scrollHeight);
    existing.log.scrollTop = 250;
    existing.log.scrollLeft = 20;
    await vi.advanceTimersByTimeAsync(5000);
    expect(row.content.querySelectorAll("[data-audit-process]")).toHaveLength(
      2,
    );
    expect(row.content.querySelector("pre[data-audit-log]")).toBe(existing.log);
    expect(existing.log.dataset.cursor).toBe("cursor-2");
    expect(existing.log.scrollTop).toBe(250);
    expect(existing.log.scrollLeft).toBe(20);
    expect(detail.raw.attributes.has("open")).toBe(true);
    const newProcess = row.content.querySelectorAll("[data-audit-process]")[1]!;
    expect(newProcess.querySelector("[data-audit-log]")?.textContent).toBe(
      "final\n",
    );
    expect(newProcess.querySelector("[data-process-status]")?.className).toBe(
      "badge exited",
    );
    await vi.advanceTimersByTimeAsync(2500);
    expect(
      h.fetch.mock.calls.filter(([url]) =>
        url.pathname.endsWith("/second/live"),
      ),
    ).toHaveLength(1);
  });

  it("does not undo the browser's own scroll anchoring for inserted rows", async () => {
    const old = auditRow("old");
    const h = harness([old]);
    h.fetch.mockResolvedValueOnce(
      h.listResponse("anchored page", [record("new"), record("old")]),
    );
    const insert = h.body.insertBefore.bind(h.body);
    h.body.insertBefore = (node, before) => {
      insert(node, before);
      if (node.dataset.auditId === "new") {
        h.window.scrollY += 40;
      }
    };
    h.start();
    const top = old.summary.getBoundingClientRect().top;
    await vi.advanceTimersByTimeAsync(2000);
    expect(old.summary.getBoundingClientRect().top).toBe(top);
    expect(h.window.scrollY).toBe(40);
    expect(h.window.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the cursor after a background response and retries failed log requests with backoff", async () => {
    const process = processCard("first");
    const row = auditRow("a", true, fragment(process.card).root);
    const h = harness([row]);
    let resolve!: (response: unknown) => void;
    let logCalls = 0;
    h.fetch.mockImplementation((url: URL) => {
      if (!url.pathname.endsWith("/first/live")) {
        return new Promise(() => {});
      }
      logCalls += 1;
      if (logCalls === 1) {
        return new Promise((done) => {
          resolve = done;
        });
      }
      if (logCalls === 2) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve(logResponse("recovered\n", "next-cursor"));
    });
    h.start();
    await vi.advanceTimersByTimeAsync(1);
    h.document.hidden = true;
    h.documentEvents.get("visibilitychange")!();
    expect(h.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    resolve(logResponse("recovered\n", "next-cursor"));
    await vi.advanceTimersByTimeAsync(1);
    expect(process.log.dataset.cursor).toBe("initial-cursor");
    expect(process.log.textContent).toBe("initial\n");
    h.document.hidden = false;
    h.documentEvents.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(logCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(3998);
    expect(logCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(logCalls).toBe(3);
    const calls = h.fetch.mock.calls.filter(([url]) =>
      url.pathname.endsWith("/first/live"),
    );
    expect(calls[2][0].searchParams.get("cursor")).toBe("initial-cursor");
    expect(process.log.textContent).toBe("initial\nrecovered\n");
  });

  it("keeps the empty-log hint until output arrives", async () => {
    const process = processCard("first");
    process.log.textContent = "";
    const empty = new Element("p", { logEmpty: "" });
    process.card.insertBefore(empty, process.log);
    const h = harness([auditRow("a", true, fragment(process.card).root)]);
    let calls = 0;
    h.fetch.mockImplementation((url: URL) => {
      if (!url.pathname.endsWith("/first/live")) {
        return new Promise(() => {});
      }
      calls += 1;
      return Promise.resolve(
        logResponse(calls === 1 ? "" : "started", String(calls)),
      );
    });
    h.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(empty.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(empty.isConnected).toBe(false);
    expect(process.log.textContent).toBe("started");
  });

  it("limits detail/log concurrency, pauses hidden tabs and aborts requests on page exit", async () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) => auditRow(id));
    const h = harness(rows);
    h.start();
    for (const row of rows) {
      h.click(row);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.document.hidden = true;
    h.documentEvents.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.document.hidden = false;
    h.documentEvents.get("visibilitychange")!();
    await vi.advanceTimersByTimeAsync(1);
    expect(
      h.fetch.mock.calls.filter(
        ([url]) =>
          url.pathname.startsWith("/admin/audit/") &&
          url.pathname !== "/admin/audit/live",
      ),
    ).toHaveLength(3);
    expect(
      h.fetch.mock.calls.filter(
        ([url]) => url.pathname === "/admin/audit/live",
      ),
    ).toHaveLength(1);
    h.windowEvents.get("pagehide")!();
    for (const [, options] of h.fetch.mock.calls) {
      expect(options.signal.aborted).toBe(true);
      expect(options.redirect).toBe("error");
    }
  });

  it("merges sparse revisions, retries protected fields on 204, and resets evicted history", async () => {
    const original = auditRow("a");
    const h = harness([original]);
    const initial = record("a", "original reason");
    const changed = record("a", "<img src=x onerror=alert(1)> literal reason");
    const idle = {
      ok: true,
      status: 204,
      json: vi.fn(() => {
        throw new Error("204 has no body");
      }),
    };
    h.fetch
      .mockResolvedValueOnce(h.listResponse("one", [initial]))
      .mockResolvedValueOnce(
        deltaResponse("audit", "two", { "row:a": changed }, false),
      )
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(
        deltaResponse(
          "audit",
          "three",
          { order: ["b"], "row:b": record("b") },
          false,
          ["row:a"],
        ),
      )
      .mockResolvedValueOnce(h.listResponse("reset", [record("c")]));
    h.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(original.summary.querySelector(".audit-reason")?.textContent).toBe(
      "original reason",
    );
    h.selection.isCollapsed = false;
    h.selection.anchorNode = h.selection.focusNode =
      original.summary.querySelector(".audit-reason");
    await vi.advanceTimersByTimeAsync(2000);
    expect(original.summary.querySelector(".audit-reason")?.textContent).toBe(
      "original reason",
    );
    h.selection.isCollapsed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(original.summary.querySelector(".audit-reason")?.textContent).toBe(
      changed.reason,
    );
    expect(original.summary.querySelector("img")).toBeNull();
    expect(idle.json).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls[1][0].searchParams.get("since")).toBe("one");
    expect(h.fetch.mock.calls[2][0].searchParams.get("since")).toBe("two");
    expect(h.fetch.mock.calls[2][1].headers.Accept).toBe("application/json");
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      h.body
        .querySelectorAll("[data-audit-id]")
        .map((node) => node.dataset.auditId),
    ).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      h.body
        .querySelectorAll("[data-audit-id]")
        .map((node) => node.dataset.auditId),
    ).toEqual(["c"]);
  });

  it("renders literal initial details, fetches only metadata deltas, and preserves raw disclosures", async () => {
    const row = auditRow("a");
    const h = harness([row]);
    let detailCalls = 0;
    h.fetch.mockImplementation((url: URL) => {
      if (url.pathname !== "/admin/audit/a/live") {
        return new Promise(() => {});
      }
      detailCalls += 1;
      if (detailCalls === 1) {
        return Promise.resolve(detailResponse("detail-one"));
      }
      expect(url.searchParams.get("since")).toBe("detail-one");
      return Promise.resolve(
        deltaResponse(
          "audit-detail",
          "detail-two",
          {
            meta: {
              ownerLabel: "Changed owner",
              message: "<literal metadata>",
            },
            order: ["new-job"],
            "process:new-job": processMetadata("new-job"),
          },
          false,
        ),
      );
    });
    h.start();
    h.click(row);
    await vi.advanceTimersByTimeAsync(1);
    const raw = row.content.querySelector(".audit-raw")!;
    expect(raw.attributes.has("open")).toBe(true);
    raw.attributes.delete("open");
    expect(row.content.querySelector(".audit-json")?.textContent).toBe(
      '{"literal":"<script>"}',
    );
    expect(row.content.querySelector(".audit-command")?.textContent).toBe(
      "echo <literal>",
    );
    const command = row.content.querySelector(".audit-request-command")!;
    expect(command.attributes.has("open")).toBe(true);
    expect(
      row.content.querySelector("[data-audit-fragment]")?.firstElementChild,
    ).toBe(command);
    expect(row.content.querySelector("script")).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(row.content.querySelector(".audit-raw")).toBe(raw);
    expect(raw.attributes.has("open")).toBe(false);
    expect(row.content.querySelector(".audit-message")?.textContent).toBe(
      "<literal metadata>",
    );
    expect(
      row.content.querySelector("[data-audit-process]")?.dataset.auditProcess,
    ).toBe("new-job");
    const logCall = h.fetch.mock.calls.find(([url]) =>
      url.pathname.endsWith("/new-job/live"),
    );
    expect(logCall?.[0].searchParams.has("cursor")).toBe(false);
    expect(logCall?.[0].searchParams.get("status")).toBe("running");
  });

  it("keeps final log status when an earlier metadata request arrives late", async () => {
    const process = processCard("first");
    const row = auditRow("a", true, fragment(process.card).root);
    const h = harness([row]);
    let logCalls = 0;
    let resolveMetadata!: (response: unknown) => void;
    h.fetch.mockImplementation((url: URL) => {
      if (url.pathname.endsWith("/first/live")) {
        logCalls += 1;
        return Promise.resolve(
          logResponse("", "cursor", logCalls < 4 ? "running" : "exited"),
        );
      }
      if (url.pathname === "/admin/audit/a/live") {
        return new Promise((resolve) => {
          resolveMetadata = resolve;
        });
      }
      return new Promise(() => {});
    });
    h.start();
    await vi.advanceTimersByTimeAsync(6001);
    expect(process.badge.className).toBe("badge exited");
    resolveMetadata(
      detailResponse("old-running-metadata", [processMetadata("first")]),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(process.card.querySelector("[data-process-status]")?.className).toBe(
      "badge exited",
    );
    expect(
      process.card.querySelector("[data-process-status]")?.textContent,
    ).toBe("exited");
    expect(process.log.dataset.cursor).toBe("cursor");
  });

  it("treats idle log 204 as empty and still receives final output and status", async () => {
    const process = processCard("first");
    const h = harness([auditRow("a", true, fragment(process.card).root)]);
    const idle = {
      ok: true,
      status: 204,
      json: vi.fn(() => {
        throw new Error("No body");
      }),
    };
    let calls = 0;
    h.fetch.mockImplementation((url: URL) => {
      if (!url.pathname.endsWith("/first/live")) {
        return new Promise(() => {});
      }
      expect(url.searchParams.get("status")).toBe("running");
      expect(url.searchParams.get("cursor")).toBe("initial-cursor");
      calls += 1;
      return Promise.resolve(
        calls === 1 ? idle : logResponse("finished\n", "last", "exited"),
      );
    });
    h.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle.json).not.toHaveBeenCalled();
    expect(process.log.textContent).toBe("initial\n");
    await vi.advanceTimersByTimeAsync(2000);
    expect(process.log.textContent).toBe("initial\nfinished\n");
    expect(process.badge.className).toBe("badge exited");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(2);
  });

  it("stops all polling when authorization is lost without navigating", async () => {
    const row = auditRow("a");
    const h = harness([row]);
    h.fetch.mockResolvedValue({ ok: false, status: 403 });
    h.start();
    h.click(row);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(
      row.content.querySelector("[data-audit-load-error]")?.textContent,
    ).toContain("접근 권한");
    expect(h.window.location.href).toContain("detail=a");
  });
});
