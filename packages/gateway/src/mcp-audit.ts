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
    super({ name: "dev-mcp", version: "0.1.0" });
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

export function safeMcpMethod(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^(?:initialize|ping|(?:tools|resources|prompts|tasks)\/[a-z_]+|notifications\/[a-z_]+)$/.test(
    value,
  )
    ? value.slice(0, 80)
    : "unknown";
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
