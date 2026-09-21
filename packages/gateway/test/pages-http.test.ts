import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("browser pages", () => {
  it("serves connection instructions and HTML or JSON not-found responses", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-pages-http-"));
    temporary.push(dataDir);
    const app = createApp({
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      runnerSocket: path.join(dataDir, "missing.sock"),
      adminPasswordHash: "unused-on-public-pages",
    });

    const home = await inject(app, {
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.headers["content-security-policy"]).toContain(
      "form-action 'none'",
    );
    expect(home.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(home.payload).toContain('src="/assets/message-dialogs.js" defer');
    expect(home.payload).toContain("내 작업 공간을");
    expect(home.payload).toContain("https://dev.example.test/mcp");

    const security = await inject(app, {
      method: "GET",
      url: "/security",
      headers: { accept: "text/html" },
    });
    expect(security.statusCode).toBe(404);

    const missingPage = await inject(app, {
      method: "GET",
      url: "/missing",
      headers: { accept: "text/html" },
    });
    expect(missingPage.statusCode).toBe(404);
    expect(missingPage.payload).toContain("Page not found");

    const missingApi = await inject(app, {
      method: "GET",
      url: "/missing",
      headers: { accept: "application/json" },
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toEqual({ error: "not_found" });
  });
});
