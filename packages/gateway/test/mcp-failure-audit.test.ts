import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import inject from "light-my-request";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../src/app.ts";
import { createMcpServer } from "../src/mcp-tools.ts";
import { UserStore } from "../src/user-store.ts";
import { AuthStore } from "../src/auth-store.ts";
import { AuditLogger } from "../src/audit.ts";
import type { IpcClient } from "../src/ipc-client.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";

const temporary: string[] = [];
const audits: AuditLogger[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all(audits.splice(0).map((audit) => audit.recent()));
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-failure-audit-"));
  temporary.push(dataDir);
  const users = new UserStore(dataDir);
  const auth = new AuthStore(dataDir);
  const audit = new AuditLogger(dataDir);
  audits.push(audit);
  const admin = await adminAccount(users, dataDir);
  const pending = await pendingAccount(users, dataDir, "owner");
  const owner = await users.update(admin.id, pending.id, {
    role: "user",
    status: "active",
  });
  const client = await auth.registerClient("failure-audit", [
    "https://example.test/callback",
  ]);
  const principal = { userId: owner.id, authVersion: owner.authVersion };
  const tokens = await auth.issueTokens(
    client.clientId,
    ["workspace:read"],
    principal,
  );
  const config = {
    port: 3000,
    publicBaseUrl: "https://dev.example.test",
    dataDir,
  };
  const app = createApp(config, { users, audit });
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: "Bearer " + tokens.accessToken,
  };
  const post = (
    payload: unknown,
    sessionId?: string,
    overrides: Record<string, string> = {},
  ) =>
    inject(app, {
      method: "POST",
      url: "/mcp",
      headers: {
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...overrides,
      },
      payload: JSON.stringify(payload),
    });
  const initialize = () =>
    post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
  return {
    dataDir,
    users,
    auth,
    audit,
    admin,
    owner,
    principal,
    client,
    tokens,
    config,
    app,
    headers,
    post,
    initialize,
  };
}

describe("MCP failure audit", () => {
  it("identifies discovery requests and nested notifications without relaxing session checks", async () => {
    const f = await fixture();
    for (const [method, requestKind] of [
      ["skills/list", "request"],
      ["skills/get", "request"],
      ["resources/templates/list", "request"],
      ["logging/setLevel", "request"],
      ["notifications/roots/list_changed", "notification"],
    ]) {
      const response = await f.post({
        jsonrpc: "2.0",
        ...(requestKind === "request" ? { id: 2 } : {}),
        method,
        params: { secret: "secret-discovery-value" },
      });
      expect(response.statusCode).toBe(400);
      expect((await f.audit.recent()).records[0]).toMatchObject({
        event: "mcp_error",
        stage: "session",
        errorCode: "MCP_SESSION_ID_REQUIRED",
        requestMethod: method,
        requestKind,
        sessionHeaderPresent: false,
      });
    }
    const initialized = await f.initialize();
    const sid = String(initialized.headers["mcp-session-id"]);
    const before = (await f.audit.recent()).records.length;
    const accepted = await f.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sid,
    );
    expect(accepted.statusCode).toBe(202);
    expect((await f.audit.recent()).records).toHaveLength(before);
    const rejected = await f.post(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      "secret-invalid-session-header",
    );
    expect(rejected.statusCode).toBe(404);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "MCP_SESSION_NOT_FOUND",
      requestMethod: "tools/list",
      requestKind: "request",
      sessionHeaderPresent: true,
    });
    await inject(f.app, {
      method: "DELETE",
      url: "/mcp",
      headers: { ...f.headers, "mcp-session-id": sid },
    });
    const text = await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8");
    expect(text).not.toContain("secret-discovery-value");
    expect(text).not.toContain("secret-invalid-session-header");
  });

  it("classifies rejected message shapes and redacts custom method names", async () => {
    const f = await fixture();
    for (const [body, requestKind] of [
      [{ jsonrpc: "2.0", id: 1, result: {} }, "response"],
      [[{ jsonrpc: "2.0", id: 2, method: "tools/list" }], "batch"],
      [{ method: "tools/list" }, "invalid"],
      [null, "invalid"],
    ] as const) {
      expect((await f.post(body)).statusCode).toBe(400);
      expect((await f.audit.recent()).records[0]).toMatchObject({
        requestKind,
        sessionHeaderPresent: false,
      });
    }
    const response = await f.post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/secretmethodvalue",
    });
    expect(response.statusCode).toBe(400);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      requestMethod: "unknown",
      requestKind: "request",
    });
    const text = await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8");
    expect(text).not.toContain("secretmethodvalue");
    expect(text).not.toContain(f.tokens.accessToken);
  });

  it("records authentication rejection reasons and known principals without credentials", async () => {
    const f = await fixture();
    const request = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    for (const [authorization, errorCode] of [
      ["", "MISSING_BEARER_TOKEN"],
      ["Basic secret-header-value", "INVALID_AUTHORIZATION_HEADER"],
      ["Bearer secret-invalid-token", "INVALID_ACCESS_TOKEN"],
    ]) {
      expect(
        (await f.post(request, undefined, { authorization })).statusCode,
      ).toBe(401);
      expect((await f.audit.recent()).records[0]).toMatchObject({
        event: "mcp_error",
        stage: "authentication",
        errorCode,
        httpStatus: 401,
      });
    }
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
    expect((await f.post(request)).statusCode).toBe(401);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "ACCESS_TOKEN_EXPIRED",
      userId: f.owner.id,
      clientId: f.client.clientId,
    });
    expect(await f.auth.access(f.tokens.accessToken)).toBeUndefined();
    vi.restoreAllMocks();
    await f.users.revokeAccess(f.admin.id, f.owner.id);
    expect((await f.post(request)).statusCode).toBe(401);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "AUTHORIZATION_REVOKED",
      userId: f.owner.id,
    });
    await f.users.update(f.admin.id, f.owner.id, {
      status: "disabled",
      role: "user",
    });
    expect((await f.post(request)).statusCode).toBe(401);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "USER_INACTIVE",
      userId: f.owner.id,
    });
    const text = await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8");
    for (const secret of [
      f.tokens.accessToken,
      f.tokens.refreshToken,
      "secret-header-value",
      "secret-invalid-token",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("distinguishes missing, lost, foreign, and changed-authorization sessions", async () => {
    const f = await fixture();
    const request = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    expect((await f.post(request)).statusCode).toBe(400);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "session",
      errorCode: "MCP_SESSION_ID_REQUIRED",
      userId: f.owner.id,
    });
    for (const method of ["GET", "DELETE"] as const) {
      expect(
        (await inject(f.app, { method, url: "/mcp", headers: f.headers }))
          .statusCode,
      ).toBe(400);
      expect((await f.audit.recent()).records[0]).toMatchObject({
        errorCode: "MCP_SESSION_ID_REQUIRED",
        httpMethod: method,
      });
    }
    const init = await f.initialize();
    const sid = String(init.headers["mcp-session-id"]);
    const invalidTool = await f.post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "project_list", arguments: {} },
      },
      sid,
    );
    expect(invalidTool.statusCode).toBe(200);
    expect(invalidTool.json().result.isError).toBe(true);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      event: "mcp_error",
      stage: "tool_input",
      tool: "project_list",
      userId: f.owner.id,
      clientId: f.client.clientId,
      sessionId: sid,
      issues: [{ field: "reason", code: "invalid_type" }],
    });
    const invalidProtocol = await f.post(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {} },
      sid,
    );
    expect(invalidProtocol.json().error.code).toEqual(expect.any(Number));
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "protocol",
      errorCode: "MCP_PROTOCOL_ERROR",
      rpcErrorCode: invalidProtocol.json().error.code,
      sessionId: sid,
    });
    const unsupportedVersion = await f.post(request, sid, {
      "mcp-protocol-version": "2025-01-01",
    });
    expect(unsupportedVersion.statusCode).toBe(400);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "transport",
      errorCode: "MCP_PROTOCOL_VERSION_UNSUPPORTED",
      protocolVersion: "2025-01-01",
    });
    const lost = randomUUID();
    expect((await f.post(request, lost)).statusCode).toBe(404);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "MCP_SESSION_NOT_FOUND",
      sessionId: lost,
      clientId: f.client.clientId,
    });
    const other = await f.auth.issueTokens(
      f.client.clientId,
      ["workspace:read"],
      { userId: f.admin.id, authVersion: f.admin.authVersion },
    );
    expect(
      (
        await f.post(request, sid, {
          authorization: "Bearer " + other.accessToken,
        })
      ).statusCode,
    ).toBe(404);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "MCP_SESSION_OWNER_MISMATCH",
      userId: f.admin.id,
      sessionId: sid,
    });
    const changed = await f.auth.issueTokens(
      f.client.clientId,
      ["workspace:read", "workspace:write"],
      f.principal,
    );
    expect(
      (
        await f.post(request, sid, {
          authorization: "Bearer " + changed.accessToken,
        })
      ).statusCode,
    ).toBe(403);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "MCP_SESSION_AUTHORIZATION_CHANGED",
      userId: f.owner.id,
    });
    const restarted = createApp(f.config, { users: f.users, audit: f.audit });
    expect(
      (
        await inject(restarted, {
          method: "POST",
          url: "/mcp",
          headers: { ...f.headers, "mcp-session-id": sid },
          payload: JSON.stringify(request),
        })
      ).statusCode,
    ).toBe(404);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "MCP_SESSION_NOT_FOUND",
      sessionId: sid,
    });
    await inject(f.app, {
      method: "DELETE",
      url: "/mcp",
      headers: { ...f.headers, "mcp-session-id": sid },
    });
  });

  it("records malformed JSON and SDK HTTP rejections without request bodies", async () => {
    const f = await fixture();
    const invalid = await inject(f.app, {
      method: "POST",
      url: "/mcp",
      headers: f.headers,
      payload: '{"secret":"secret-body-value"',
    });
    expect(invalid.statusCode).toBe(400);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "http_input",
      errorCode: "MCP_INVALID_JSON",
      httpStatus: 400,
    });
    const refused = await f.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      undefined,
      { accept: "application/json" },
    );
    expect(refused.statusCode).toBe(406);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "transport",
      errorCode: "MCP_ACCEPT_HEADER_INVALID",
      httpStatus: 406,
    });
    expect(
      await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8"),
    ).not.toContain("secret-body-value");
  });

  it("audits SDK input and handler failures without argument values or duplicate tool calls", async () => {
    const f = await fixture();
    const call = vi.fn(async () => ({ ok: true, data: {}, truncated: false }));
    const server = createMcpServer({
      scopes: ["workspace:read"],
      actor: `${f.owner.id}:${f.client.clientId}`,
      principal: f.principal,
      clientId: f.client.clientId,
      ipc: { call } as unknown as IpcClient,
      audit: f.audit,
      resourceMetadataUrl:
        "https://dev.example.test/.well-known/oauth-protected-resource",
    });
    const client = new Client({ name: "failure-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const invalid = await client.callTool({
        name: "command_run",
        arguments: {
          project_id: randomUUID(),
          command: "secret-command-value",
          reason: "secret-reason-value",
          network_intent: "secret-enum-value",
        },
      });
      expect(invalid.isError).toBe(true);
      expect(call).not.toHaveBeenCalled();
      expect((await f.audit.recent()).records[0]).toMatchObject({
        event: "mcp_error",
        stage: "tool_input",
        errorCode: "INVALID_TOOL_ARGUMENTS",
        tool: "command_run",
        userId: f.owner.id,
        clientId: f.client.clientId,
        issues: [{ field: "network_intent", code: "invalid_value" }],
      });
      await expect(
        client.callTool({
          name: "missing_tool",
          arguments: { secret: "secret-unknown-value" },
        }),
      ).rejects.toMatchObject({ code: -32602 });
      expect((await f.audit.recent()).records[0]).toMatchObject({
        stage: "tool_lookup",
        errorCode: "UNKNOWN_TOOL",
      });
      call.mockRejectedValueOnce(new Error("secret-handler-value"));
      await client.callTool({
        name: "project_list",
        arguments: { reason: "Check projects" },
      });
      expect((await f.audit.recent()).records[0]).toMatchObject({
        stage: "tool_handler",
        errorCode: "TOOL_HANDLER_ERROR",
        tool: "project_list",
      });
      const before = (await f.audit.recent()).records.length;
      await client.callTool({
        name: "process_list",
        arguments: { reason: "Check processes" },
      });
      const records = (await f.audit.recent()).records;
      expect(records).toHaveLength(before + 1);
      expect(records[0]).toMatchObject({
        event: "tool_call",
        errorCode: "INSUFFICIENT_SCOPE",
      });
      const text = await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8");
      for (const secret of [
        "secret-command-value",
        "secret-reason-value",
        "secret-enum-value",
        "secret-unknown-value",
        "secret-handler-value",
      ]) {
        expect(text).not.toContain(secret);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("records token exchange and refresh rejection reasons without OAuth secrets", async () => {
    const f = await fixture();
    const post = (fields: Record<string, string>) =>
      inject(f.app, {
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          client_id: f.client.clientId,
          ...fields,
        }).toString(),
      });
    for (const [fields, code] of [
      [
        {
          client_id: "secret-client-value",
          grant_type: "refresh_token",
          refresh_token: "secret-refresh-value",
        },
        "OAUTH_INVALID_CLIENT",
      ],
      [
        {
          grant_type: "authorization_code",
          code: "secret-code-value",
          code_verifier: "secret-verifier-value",
        },
        "OAUTH_PKCE_VERIFIER_INVALID",
      ],
      [
        {
          grant_type: "authorization_code",
          code: "secret-code-value",
          code_verifier: "secret-verifier-value".repeat(4),
        },
        "OAUTH_CODE_INVALID",
      ],
      [
        { grant_type: "refresh_token", refresh_token: "secret-refresh-value" },
        "OAUTH_REFRESH_INVALID",
      ],
      [
        {
          grant_type: "refresh_token",
          refresh_token: "secret-refresh-value",
          scope: "secret-scope-value",
        },
        "OAUTH_INVALID_SCOPE",
      ],
      [{ grant_type: "secret-grant-value" }, "OAUTH_UNSUPPORTED_GRANT"],
    ] as [Record<string, string>, string][]) {
      expect((await post(fields)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await f.audit.recent()).records[0]).toMatchObject({
        event: "oauth_token_failed",
        stage: "oauth_token",
        errorCode: code,
        ok: false,
      });
    }
    await f.users.revokeAccess(f.admin.id, f.owner.id);
    expect(
      (
        await post({
          grant_type: "refresh_token",
          refresh_token: f.tokens.refreshToken,
        })
      ).statusCode,
    ).toBe(400);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      errorCode: "OAUTH_AUTHORIZATION_REVOKED",
      userId: f.owner.id,
      clientId: f.client.clientId,
    });
    const text = await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8");
    for (const secret of [
      "secret-client-value",
      "secret-refresh-value",
      "secret-code-value",
      "secret-verifier-value",
      "secret-scope-value",
      "secret-grant-value",
      f.tokens.refreshToken,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
