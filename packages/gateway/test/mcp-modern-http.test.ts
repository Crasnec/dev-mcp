import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { AuthStore } from "../src/auth-store.ts";
import { AuditLogger } from "../src/audit.ts";
import { UserStore } from "../src/user-store.ts";
import type { IpcClient } from "../src/ipc-client.ts";
import { adminAccount, pendingAccount } from "./accounts.ts";

const revision = "2026-07-28";
const temporary: string[] = [];
const audits: AuditLogger[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(audits.splice(0).map((audit) => audit.flush()));
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-modern-"));
  temporary.push(dataDir);
  const users = new UserStore(dataDir);
  const auth = new AuthStore(dataDir);
  const audit = new AuditLogger(dataDir);
  audits.push(audit);
  const owner = await adminAccount(users, dataDir);
  const pending = await pendingAccount(users, dataDir, "other");
  const other = await users.update(owner.id, pending.id, {
    role: "user",
    status: "active",
  });
  const client = await auth.registerClient("modern-client", [
    "https://example.test/callback",
  ]);
  const issued = await Promise.all(
    [owner, other].map((user) =>
      auth.issueTokens(client.clientId, ["workspace:read"], {
        userId: user.id,
        authVersion: user.authVersion,
      }),
    ),
  );
  const call = vi.fn(async () => ({
    ok: true,
    data: { projects: [] },
    truncated: false,
  }));
  const app = createApp(
    { port: 3000, publicBaseUrl: "https://dev.example.test", dataDir },
    { users, audit, ipc: { call } as unknown as IpcClient },
  );
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": revision,
  };
  const post = (
    method: string,
    params: Record<string, unknown> = {},
    overrides: Record<string, string> = {},
    token = issued[0]!.accessToken,
  ) =>
    inject(app, {
      method: "POST",
      url: "/mcp",
      headers: {
        ...headers,
        authorization: "Bearer " + token,
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        ...overrides,
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": revision,
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-test",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
          ...params,
        },
      }),
    });
  return {
    dataDir,
    users,
    auth,
    audit,
    owner,
    other,
    client,
    issued,
    app,
    call,
    headers,
    post,
  };
}

describe("MCP 2026-07-28 HTTP", () => {
  it("serves discovery, lists all tools and calls them without initialization or retained sessions", async () => {
    const f = await fixture();
    const discovery = await f.post("server/discover");
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().result.capabilities.tools).toBeDefined();
    const catalog = await f.post("tools/list");
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().result.tools).toHaveLength(21);
    expect(catalog.headers["mcp-session-id"]).toBeUndefined();
    for (let index = 0; index < 20; index += 1) {
      const response = await f.post("tools/call", {
        name: "project_list",
        arguments: { reason: "Inspect projects" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toMatchObject({
        resultType: "complete",
        structuredContent: { ok: true, data: { projects: [] } },
      });
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    }
    expect(f.call).toHaveBeenCalledTimes(20);
    const login = await f.users.createSession(f.owner);
    const detail = await inject(f.app, {
      method: "GET",
      url: `/admin/users/${f.owner.id}`,
      headers: { cookie: "__Host-dev-mcp-session=" + login.token },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.payload).toContain("활성 MCP 세션이 없습니다.");
    const records = (await f.audit.recent()).records;
    expect(records.filter((record) => record.event === "mcp_error")).toEqual(
      [],
    );
    expect(
      records.filter((record) => record.event === "tool_call"),
    ).toHaveLength(20);
  });

  it("keeps a legacy session usable alongside modern requests and exposes the same tools", async () => {
    const f = await fixture();
    const headers = {
      ...f.headers,
      authorization: "Bearer " + f.issued[0]!.accessToken,
      "mcp-protocol-version": "2025-11-25",
    };
    const initialized = await inject(f.app, {
      method: "POST",
      url: "/mcp",
      headers,
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "legacy-test", version: "1" },
          capabilities: {},
        },
      }),
    });
    expect(initialized.statusCode).toBe(200);
    const session = String(initialized.headers["mcp-session-id"]);
    const modern = await f.post(
      "tools/list",
      {},
      { "mcp-session-id": session },
    );
    expect(modern.statusCode).toBe(200);
    expect(modern.headers["mcp-session-id"]).toBeUndefined();
    const legacy = await inject(f.app, {
      method: "POST",
      url: "/mcp",
      headers: { ...headers, "mcp-session-id": session },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(legacy.statusCode).toBe(200);
    expect(modern.json().result.tools).toEqual(legacy.json().result.tools);
    await inject(f.app, {
      method: "DELETE",
      url: "/mcp",
      headers: { ...headers, "mcp-session-id": session },
    });
  });

  it("reports unsupported revisions and malformed modern claims without falling into legacy initialization", async () => {
    const f = await fixture();
    const unsupported = await f.post(
      "server/discover",
      {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
      { "mcp-protocol-version": "2099-01-01" },
    );
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error.code).toBe(-32022);
    expect(unsupported.json().error.data.supported).toContain(revision);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      event: "mcp_error",
      errorCode: "MCP_PROTOCOL_VERSION_UNSUPPORTED",
      rpcErrorCode: -32022,
      requestMethod: "server/discover",
      sessionHeaderPresent: false,
    });
    const malformed = await f.post("server/discover", {
      _meta: { "io.modelcontextprotocol/protocolVersion": 123 },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe(-32602);
    const missing = await f.post("tools/list", { _meta: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe(-32602);
    const missingHeader = await f.post("tools/list", {}, { "mcp-method": "" });
    expect(missingHeader.statusCode).toBe(400);
    expect(missingHeader.json().error.code).toBe(-32020);
  });

  it("validates routing headers and audits errors without recording arbitrary names or input values", async () => {
    const f = await fixture();
    const mismatch = await f.post(
      "tools/call",
      {
        name: "project_list",
        arguments: { reason: "Inspect projects" },
      },
      { "mcp-name": "secret-header-value" },
    );
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe(-32020);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "protocol",
      errorCode: "MCP_PROTOCOL_METADATA_INVALID",
      tool: "project_list",
    });
    const invalid = await f.post("tools/call", {
      name: "project_list",
      arguments: { reason: 123, secret: "secret-input-value" },
    });
    expect(invalid.json().result.isError).toBe(true);
    const unknown = await f.post("tools/call", {
      name: "secret-tool-value",
      arguments: { secret: "secret-input-value" },
    });
    expect(unknown.json().error.code).toBe(-32602);
    expect((await f.audit.recent()).records[0]).toMatchObject({
      stage: "tool_lookup",
      errorCode: "UNKNOWN_TOOL",
    });
    expect((await f.audit.recent()).records).toHaveLength(3);
    const text = await readFile(path.join(f.dataDir, "audit.jsonl"), "utf8");
    for (const secret of [
      "secret-header-value",
      "secret-input-value",
      "secret-tool-value",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(f.call).not.toHaveBeenCalled();
  });

  it("checks the token and scopes on each request and attributes calls to the authenticated owner", async () => {
    const f = await fixture();
    const params = {
      name: "project_list",
      arguments: { reason: "Inspect projects" },
    };
    await Promise.all(
      f.issued.map((issued) =>
        f.post("tools/call", params, {}, issued.accessToken),
      ),
    );
    expect(f.call).toHaveBeenCalledWith(
      "project_list",
      {},
      `${f.owner.id}:${f.client.clientId}`,
    );
    expect(f.call).toHaveBeenCalledWith(
      "project_list",
      {},
      `${f.other.id}:${f.client.clientId}`,
    );
    const denied = await f.post("tools/call", {
      name: "process_list",
      arguments: { reason: "Inspect processes" },
    });
    expect(denied.json().result.isError).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(2);
    await f.auth.revokeConnection(f.owner.id, f.client.clientId);
    expect((await f.post("tools/list")).statusCode).toBe(401);
    expect(
      (await f.post("tools/list", {}, {}, f.issued[1]!.accessToken)).statusCode,
    ).toBe(200);
  });

  it("does not open legacy GET streams or accept session deletion on modern requests", async () => {
    const f = await fixture();
    for (const method of ["GET", "DELETE"] as const) {
      const response = await inject(f.app, {
        method,
        url: "/mcp",
        headers: {
          ...f.headers,
          authorization: "Bearer " + f.issued[0]!.accessToken,
        },
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
    }
  });
});
