import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  isJSONRPCRequest,
  isJSONRPCResultResponse as isJSONRPCResponse,
  isJSONRPCErrorResponse as isJSONRPCError,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
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
  protocolEra?: "legacy" | "modern";
  failureRecorded?: () => void;
  requestStarted?: () => () => void;
  diagnoseTool: (name: unknown, args: unknown) => Promise<McpFailure>;
}

// Observe the public transport boundary: SDK validation errors are returned
// before a tool handler (and its normal tool_call audit) can run.
export class AuditedMcpServer extends McpServer {
  constructor(private readonly auditOptions: AuditOptions) {
    super(
      { name: "dev-mcp", version: "0.1.0" },
      {
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS.filter(
          (version) =>
            version >= "2026-01-01" === (auditOptions.protocolEra === "modern"),
        ),
        instructions:
          "Perform development work yourself using this server's tools. Never invoke, install, authenticate, or delegate work to Codex, Claude Code, or another AI agent through command_run, process_start, app_deploy, scripts, aliases, wrappers, copied binaries, remote execution, or any other workaround. A denied or unavailable agent must not be retried by another route. MCP runs in a separate container with Git/GitHub credentials only; the interactive development container and its AI credentials are unavailable.",
      },
    );
  }

  override connect(transport: Transport): Promise<void> {
    const pending = new Map<
      RequestId,
      { request: JSONRPCRequest; finish?: () => void }
    >();
    const options = this.auditOptions;
    const clearPending = () => {
      for (const request of pending.values()) request.finish?.();
      pending.clear();
    };
    const wrapped: Transport = {
      start: () => transport.start(),
      close: () => {
        clearPending();
        return transport.close();
      },
      get sessionId() {
        return transport.sessionId;
      },
      setProtocolVersion: transport.setProtocolVersion?.bind(transport),
      setSupportedProtocolVersions:
        transport.setSupportedProtocolVersions?.bind(transport),
      get hasPerRequestStream() {
        return transport.hasPerRequestStream;
      },
      get onclose() {
        return transport.onclose;
      },
      set onclose(handler) {
        transport.onclose = () => {
          clearPending();
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
              if (isJSONRPCRequest(message) && !pending.has(message.id)) {
                pending.set(message.id, {
                  request: message,
                  finish: options.requestStarted?.(),
                });
              }
              handler(message, extra);
            }
          : undefined;
      },
      async send(message: JSONRPCMessage, sendOptions?: TransportSendOptions) {
        let finish: (() => void) | undefined;
        try {
          if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
            const tracked =
              message.id === null || message.id === undefined
                ? undefined
                : pending.get(message.id);
            const request = tracked?.request;
            finish = tracked?.finish;
            if (message.id !== null && message.id !== undefined) {
              pending.delete(message.id);
            }
            if (request) {
              let failure: McpFailure | undefined;
              if (isJSONRPCError(message)) {
                failure =
                  request.method === "tools/call" &&
                  typeof request.params?.name === "string"
                    ? await options.diagnoseTool(
                        request.params?.name,
                        request.params?.arguments,
                      )
                    : {
                        stage: "protocol",
                        errorCode: "MCP_PROTOCOL_ERROR",
                        message:
                          "MCP request was rejected by the protocol handler",
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
                options.failureRecorded?.();
              }
            }
          }
          return await transport.send(message, sendOptions);
        } finally {
          finish?.();
        }
      },
    };
    return super.connect(wrapped);
  }
}

// Exact protocol names only: a syntactically valid custom method can still
// contain credentials. Include nested paths, camel-case names and the skills
// discovery extension used by OpenAI clients.
const auditedMethods = new Set([
  "server/discover",
  "subscriptions/listen",
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
