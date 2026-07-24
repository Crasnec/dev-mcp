import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.ts";
import { AuthStore } from "../src/auth-store.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("MCP HTTP sessions", () => {
  it("keeps a session across requests and access-token rotation", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-http-session-"));
    temporary.push(dataDir);
    const store = new AuthStore(dataDir);
    const client = await store.registerClient("session-test", [
      "https://chat.example.test/oauth/callback",
    ]);
    const issued = await store.issueTokens(client.clientId, ["workspace:read"]);
    const app = createApp({
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
      runnerSocket: path.join(dataDir, "missing.sock"),
      adminPasswordHash: "unused-in-this-test",
    });

    const initialized = await mcpPost(app, issued.accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "session-test", version: "1.0.0" },
      },
    });
    expect(initialized.statusCode).toBe(200);
    const sessionId = initialized.headers["mcp-session-id"];
    expect(sessionId).toEqual(expect.any(String));
    expect(initialized.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "dev-mcp" } },
    });

    const notification = await mcpPost(
      app,
      issued.accessToken,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      sessionId as string,
    );
    expect(notification.statusCode).toBe(202);

    const tools = await mcpPost(
      app,
      issued.accessToken,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId as string,
    );
    expect(tools.statusCode).toBe(200);
    expect(
      (tools.json() as { result: { tools: { name: string }[] } }).result.tools,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project_list" }),
      ]),
    );

    const refreshed = await store.issueTokens(client.clientId, [
      "workspace:read",
    ]);
    const afterRefresh = await mcpPost(
      app,
      refreshed.accessToken,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      sessionId as string,
    );
    expect(afterRefresh.statusCode).toBe(200);

    const broadened = await store.issueTokens(client.clientId, [
      "workspace:read",
      "workspace:write",
    ]);
    const changedAuthorization = await mcpPost(
      app,
      broadened.accessToken,
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      sessionId as string,
    );
    expect(changedAuthorization.statusCode).toBe(403);
    expect(changedAuthorization.json()).toMatchObject({
      error: { message: expect.stringContaining("initialize a new session") },
    });

    const closed = await inject(app, {
      method: "DELETE",
      url: "/mcp",
      headers: mcpHeaders(refreshed.accessToken, sessionId as string),
    });
    expect(closed.statusCode).toBe(200);

    const afterClose = await mcpPost(
      app,
      refreshed.accessToken,
      { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
      sessionId as string,
    );
    expect(afterClose.statusCode).toBe(404);
  });
});

function mcpPost(
  app: ReturnType<typeof createApp>,
  accessToken: string,
  body: unknown,
  sessionId?: string,
) {
  return inject(app, {
    method: "POST",
    url: "/mcp",
    headers: {
      ...mcpHeaders(accessToken, sessionId),
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

function mcpHeaders(accessToken: string, sessionId?: string) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    ...(sessionId
      ? {
          "mcp-session-id": sessionId,
          "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
        }
      : {}),
  };
}
