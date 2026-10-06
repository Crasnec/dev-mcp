import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCError,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { AuditLogger } from "./audit.ts";

export interface McpFailure {
  stage: string;
  errorCode: string;
  message: string;
  tool?: string;
  issues?: { field: string; code: string }[];
}

interface AuditOptions {
  audit: AuditLogger;
  actor: string;
  userId: string;
  clientId?: string;
  diagnoseTool: (name: unknown, args: unknown) => Promise<McpFailure>;
}

// Observe the public transport boundary: SDK validation errors are returned
// before a tool handler (and its normal tool_call audit) can run.
export class AuditedMcpServer extends McpServer {
  constructor(private readonly auditOptions: AuditOptions) {
    super(
      { name: "dev-mcp", version: "0.1.0" },
      {
        instructions:
          "Perform development work yourself using this server's tools. Never invoke, install, authenticate, or delegate work to Codex, Claude Code, or another AI agent through command_run, process_start, app_deploy, scripts, aliases, wrappers, copied binaries, remote execution, or any other workaround. A denied or unavailable agent must not be retried by another route. MCP runs in a separate container with Git/GitHub credentials only; the interactive development container and its AI credentials are unavailable.",
      },
    );
  }

  override connect(transport: Transport): Promise<void> {
    const pending = new Map<RequestId, JSONRPCRequest>();
    const options = this.auditOptions;
    const wrapped: Transport = {
      start: () => transport.start(),
      close: () => {
        pending.clear();
        return transport.close();
      },
      get sessionId() {
        return transport.sessionId;
      },
      setProtocolVersion: transport.setProtocolVersion?.bind(transport),
      get onclose() {
        return transport.onclose;
      },
      set onclose(handler) {
        transport.onclose = () => {
          pending.clear();
          handler?.();
        };
      },
      get onerror() {
        return transport.onerror;
      },
      set onerror(handler) {
        transport.onerror = handler;
      },
      get onmessage() {
        return transport.onmessage;
      },
      set onmessage(handler) {
        transport.onmessage = handler
          ? (message, extra) => {
              if (isJSONRPCRequest(message)) {
                pending.set(message.id, message);
              }
              handler(message, extra);
            }
          : undefined;
      },
      async send(message: JSONRPCMessage, sendOptions?: TransportSendOptions) {
        if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
          const request =
            message.id === null || message.id === undefined
              ? undefined
              : pending.get(message.id);
          if (message.id !== null && message.id !== undefined) {
            pending.delete(message.id);
          }
          if (request) {
            let failure: McpFailure | undefined;
            if (isJSONRPCError(message)) {
              failure = {
                stage: "protocol",
                errorCode: "MCP_PROTOCOL_ERROR",
                message: "MCP request was rejected by the protocol handler",
              };
            } else if (
              request.method === "tools/call" &&
              message.result.isError === true &&
              message.result.structuredContent === undefined
            ) {
              failure = await options.diagnoseTool(
                request.params?.name,
                request.params?.arguments,
              );
            }
            if (failure) {
              await options.audit
                .write({
                  event: "mcp_error",
                  actor: options.actor,
                  userId: options.userId,
                  clientId: options.clientId,
                  sessionId: transport.sessionId,
                  requestMethod: safeMcpMethod(request.method),
                  rpcErrorCode: isJSONRPCError(message)
                    ? message.error.code
                    : undefined,
                  ok: false,
                  ...failure,
                })
                .catch(() => undefined);
            }
          }
        }
        return transport.send(message, sendOptions);
      },
    };
    return super.connect(wrapped);
  }
}

// Exact protocol names only: a syntactically valid custom method can still
// contain credentials. Include nested paths, camel-case names and the skills
// discovery extension used by OpenAI clients.
const auditedMethods = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "tasks/get",
  "tasks/result",
  "tasks/list",
  "tasks/cancel",
  "logging/setLevel",
  "sampling/createMessage",
  "elicitation/create",
  "completion/complete",
  "roots/list",
  "skills/list",
  "skills/get",
  "notifications/cancelled",
  "notifications/initialized",
  "notifications/progress",
  "notifications/tasks/status",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/prompts/list_changed",
  "notifications/tools/list_changed",
  "notifications/message",
  "notifications/elicitation/complete",
  "notifications/roots/list_changed",
]);

export function safeMcpMethod(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return auditedMethods.has(value) ? value : "unknown";
}

export function mcpMessageKind(
  value: unknown,
): "request" | "notification" | "response" | "batch" | "invalid" {
  if (Array.isArray(value)) {
    return "batch";
  }
  if (!value || typeof value !== "object") {
    return "invalid";
  }
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") {
    return "invalid";
  }
  if (typeof message.method === "string") {
    return Object.hasOwn(message, "id") ? "request" : "notification";
  }
  return Object.hasOwn(message, "id") &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ? "response"
    : "invalid";
}

export function safeMcpTool(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^(?:project_(?:list|register|clone|unregister|delete)|file_(?:list|read|search|apply_patch)|command_(?:run|output)|process_(?:start|list|logs|stop)|git_(?:read|commit)|app_(?:list|deploy|stop|delete))$/.test(
    value,
  )
    ? value
    : undefined;
}
