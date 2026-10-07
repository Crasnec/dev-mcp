import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";
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
  it("bounds reconnect sessions, returns 404 for evicted sessions and allows clients to initialize again", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-reconnect-"));
    temporary.push(dataDir);
    const users = new UserStore(dataDir),
      store = new AuthStore(dataDir);
    const owner = await adminAccount(users, dataDir);
    const client = await store.registerClient("reconnecting", [
      "https://example.test/callback",
    ]);
    const token = (
      await store.issueTokens(client.clientId, ["workspace:read"], {
        userId: owner.id,
        authVersion: owner.authVersion,
      })
    ).accessToken;
    const app = createApp(
      { port: 3000, publicBaseUrl: "https://dev.example.test", dataDir },
      { users },
    );
    const initialize = () =>
      mcpPost(app, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "reconnect", version: "1" },
        },
      });
    const ids: string[] = [];
    for (let index = 0; index < 18; index += 1) {
      const response = await initialize();
      expect(response.statusCode).toBe(200);
      ids.push(String(response.headers["mcp-session-id"]));
    }
    const list = (id: string) =>
      mcpPost(
        app,
        token,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        id,
      );
    expect((await list(ids[0]!)).statusCode).toBe(404);
    expect((await list(ids[17]!)).statusCode).toBe(200);
    const burst = await Promise.all(Array.from({ length: 40 }, initialize));
    for (const response of burst) {
      expect([200, 429]).toContain(response.statusCode);
      if (response.statusCode === 200)
        ids.push(String(response.headers["mcp-session-id"]));
    }
    const alive: string[] = [];
    for (const id of ids) {
      const response = await list(id);
      expect([200, 404]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        alive.push(id);
      }
    }
    expect(alive).toHaveLength(16);
    await Promise.all(
      alive.map((id) =>
        inject(app, {
          method: "DELETE",
          url: "/mcp",
          headers: mcpHeaders(token, id),
        }),
      ),
    );
    expect((await initialize()).statusCode).toBe(200);
  });
  it("closes selected user sessions and revokes one user's connection without affecting another", async () => {
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "mcp-session-management-"),
    );
    temporary.push(dataDir);
    const users = new UserStore(dataDir),
      store = new AuthStore(dataDir);
    const admin = await adminAccount(users, dataDir);
    const pending = await pendingAccount(users, dataDir, "owner");
    const owner = await users.update(admin.id, pending.id, {
      role: "user",
      status: "active",
    });
    const client = await store.registerClient("shared-client", [
      "https://example.test/callback",
    ]);
    const tokens = await Promise.all(
      [admin, owner].map((user) =>
        store.issueTokens(client.clientId, ["workspace:read"], {
          userId: user.id,
          authVersion: user.authVersion,
        }),
      ),
    );
    const app = createApp(
      { port: 3000, publicBaseUrl: "https://dev.example.test", dataDir },
      { users },
    );
    const initialize = (token: string) =>
      mcpPost(app, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
    const initialized = await Promise.all(
      tokens.map((issued) => initialize(issued.accessToken)),
    );
    const ids = initialized.map((response) =>
      String(response.headers["mcp-session-id"]),
    );
    const login = await users.createSession(admin);
    const post = (url: string) =>
      inject(app, {
        method: "POST",
        url,
        headers: {
          cookie: "__Host-dev-mcp-session=" + login.token,
          origin: "https://dev.example.test",
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: new URLSearchParams({ csrf: login.csrf }).toString(),
      });
    const list = (index: number) =>
      mcpPost(
        app,
        tokens[index]!.accessToken,
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ids[index],
      );
    const detail = await inject(app, {
      method: "GET",
      url: "/admin/users/" + owner.id,
      headers: { cookie: "__Host-dev-mcp-session=" + login.token },
    });
    expect(detail.payload).toContain(ids[1]);
    expect(detail.payload).not.toContain(ids[0]);
    expect(
      (await post(`/admin/users/${admin.id}/mcp-sessions/${ids[1]}/close`))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(`/admin/users/${owner.id}/mcp-sessions/${ids[1]}/close`))
        .statusCode,
    ).toBe(303);
    expect((await list(1)).statusCode).toBe(404);
    expect(await store.access(tokens[1]!.accessToken)).toBeTruthy();
    expect((await list(0)).statusCode).toBe(200);
    const replacement = await initialize(tokens[1]!.accessToken);
    ids[1] = String(replacement.headers["mcp-session-id"]);
    expect(
      (
        await post(
          `/admin/users/${owner.id}/connections/${client.clientId}/revoke`,
        )
      ).statusCode,
    ).toBe(303);
    expect((await list(1)).statusCode).toBe(401);
    expect((await list(0)).statusCode).toBe(200);
    await inject(app, {
      method: "DELETE",
      url: "/mcp",
      headers: mcpHeaders(tokens[0]!.accessToken, ids[0]),
    });
  });
  it("keeps a session across requests and access-token rotation", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-http-session-"));
    temporary.push(dataDir);
    const store = new AuthStore(dataDir);
    const users = new UserStore(dataDir);
    const admin = await adminAccount(users, dataDir);
    const principal = { userId: admin.id, authVersion: admin.authVersion };
    const client = await store.registerClient("session-test", [
      "https://chat.example.test/oauth/callback",
    ]);
    const issued = await store.issueTokens(
      client.clientId,
      ["workspace:read"],
      principal,
    );
    const app = createApp({
      port: 3000,
      publicBaseUrl: "https://dev.example.test",
      dataDir,
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

    const refreshed = await store.issueTokens(
      client.clientId,
      ["workspace:read"],
      principal,
    );
    const afterRefresh = await mcpPost(
      app,
      refreshed.accessToken,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      sessionId as string,
    );
    expect(afterRefresh.statusCode).toBe(200);

    const other = await pendingAccount(users, dataDir, "another-user");
    const activeOther = await users.update(admin.id, other.id, {
      status: "active",
      role: "user",
    });
    const otherTokens = await store.issueTokens(
      client.clientId,
      ["workspace:read"],
      {
        userId: other.id,
        authVersion: activeOther.authVersion,
      },
    );
    const crossUser = await mcpPost(
      app,
      otherTokens.accessToken,
      { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} },
      sessionId as string,
    );
    expect(crossUser.statusCode).toBe(404);

    const broadened = await store.issueTokens(
      client.clientId,
      ["workspace:read", "workspace:write"],
      principal,
    );
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
