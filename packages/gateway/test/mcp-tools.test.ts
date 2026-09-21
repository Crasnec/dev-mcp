import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-tools.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { AuditLogger } from "../src/audit.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("MCP tool catalog", () => {
  it("publishes schemas, structured outputs, and safety annotations", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "mcp-catalog-"));
    temporary.push(data);
    const server = createMcpServer({
      scopes: ["workspace:read"],
      actor: "test-client",
      principal: { userId: "test-user", authVersion: 1 },
      ipc: new IpcClient(path.join(data, "missing.sock")),
      audit: new AuditLogger(data),
      resourceMetadataUrl:
        "https://dev.example.test/.well-known/oauth-protected-resource",
      mediaBaseUrl: "https://dev.example.test",
      mediaSigningSecret: "test-media-secret",
    });
    const client = new Client({ name: "catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(18);
    const names = catalog.tools.map((tool) => tool.name);
    for (const removed of [
      "git_status",
      "git_diff",
      "git_log",
      "process_status",
    ]) {
      expect(names).not.toContain(removed);
    }
    const gitRead = catalog.tools.find((tool) => tool.name === "git_read")!;
    expect(gitRead.annotations?.readOnlyHint).toBe(true);
    expect(gitRead._meta?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["workspace:read"] },
    ]);
    expect(gitRead.inputSchema.required).toContain("operation");
    const imageRead = catalog.tools.find((tool) => tool.name === "image_read")!;
    expect(imageRead.annotations?.readOnlyHint).toBe(true);
    expect(imageRead._meta?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["workspace:read"] },
    ]);
    const command = catalog.tools.find((tool) => tool.name === "command_run")!;
    expect(command.annotations?.destructiveHint).toBe(true);
    expect(command.annotations?.openWorldHint).toBe(true);
    expect(command.inputSchema.required).toContain("network_intent");
    expect(command.outputSchema?.properties).toHaveProperty("ok");
    expect(command._meta?.securitySchemes).toEqual([
      {
        type: "oauth2",
        scopes: ["command:run", "command:network"],
      },
    ]);
    for (const name of [
      "command_output",
      "process_list",
      "process_logs",
      "process_stop",
    ]) {
      const tool = catalog.tools.find((entry) => entry.name === name)!;
      expect(tool._meta?.securitySchemes).toEqual([
        { type: "oauth2", scopes: ["command:run"] },
      ]);
    }
    const processStart = catalog.tools.find(
      (tool) => tool.name === "process_start",
    )!;
    expect(processStart._meta?.securitySchemes).toEqual([
      {
        type: "oauth2",
        scopes: ["command:run", "command:network"],
      },
    ]);
    const deletion = catalog.tools.find(
      (tool) => tool.name === "project_delete",
    )!;
    expect(deletion.annotations?.destructiveHint).toBe(true);
    const denied = await client.callTool({
      name: "project_delete",
      arguments: { project_id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(denied.isError).toBe(true);
    expect(
      (denied.structuredContent as { error: { code: string } }).error.code,
    ).toBe("INSUFFICIENT_SCOPE");
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="workspace:write"'),
    ]);
    const processDenied = await client.callTool({
      name: "process_list",
      arguments: {},
    });
    expect(processDenied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('error="insufficient_scope"'),
    ]);
    expect(processDenied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="command:run"'),
    ]);
    expect(processDenied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining(
        'resource_metadata="https://dev.example.test/.well-known/oauth-protected-resource"',
      ),
    ]);
    const networkDenied = await client.callTool({
      name: "command_run",
      arguments: {
        project_id: "00000000-0000-4000-8000-000000000000",
        command: "true",
        network_intent: "read",
      },
    });
    expect(
      (
        networkDenied.structuredContent as {
          error: { details: { required: string[] } };
        }
      ).error.details.required,
    ).toEqual(["command:run", "command:network"]);
    expect(networkDenied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="command:run command:network"'),
    ]);
    const localCommandDenied = await client.callTool({
      name: "command_run",
      arguments: {
        project_id: "00000000-0000-4000-8000-000000000000",
        command: "true",
        network_intent: "none",
      },
    });
    expect(localCommandDenied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining('scope="command:run"'),
    ]);
    await client.close();
    await server.close();
  });

  it("returns a short-lived URL for image_read", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "mcp-image-url-"));
    temporary.push(data);
    const ipc = {
      call: async () => ({
        ok: true,
        data: {
          path: "pixel.png",
          mimeType: "image/png",
          size: 68,
          base64: "ignored-by-gateway",
        },
        truncated: false,
      }),
    } as unknown as IpcClient;
    const server = createMcpServer({
      scopes: ["workspace:read"],
      actor: "test-client",
      principal: { userId: "test-user", authVersion: 1 },
      ipc,
      audit: new AuditLogger(data),
      resourceMetadataUrl:
        "https://dev.example.test/.well-known/oauth-protected-resource",
      mediaBaseUrl: "https://dev.example.test",
      mediaSigningSecret: "test-media-secret",
    });
    const client = new Client({ name: "image-url-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "image_read",
      arguments: {
        project_id: "00000000-0000-4000-8000-000000000000",
        path: "pixel.png",
      },
    });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringMatching(
        /^Image URL: https:\/\/dev\.example\.test\/media\//,
      ),
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        url: expect.stringMatching(
          /^https:\/\/dev\.example\.test\/media\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
        ),
        path: "pixel.png",
        mimeType: "image/png",
        size: 68,
      },
      truncated: false,
    });
    await client.close();
    await server.close();
  });
});
