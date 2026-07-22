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
      ipc: new IpcClient(path.join(data, "missing.sock")),
      audit: new AuditLogger(data),
      resourceMetadataUrl:
        "https://dev.example.test/.well-known/oauth-protected-resource",
    });
    const client = new Client({ name: "catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    expect(catalog.tools).toHaveLength(20);
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
      "process_status",
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
});
