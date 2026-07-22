export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  actor: string;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: ToolError;
  truncated: boolean;
  continuation?: string;
}

export interface RpcResponse {
  id: string;
  result: ToolResult;
}

export const MAX_IPC_MESSAGE_BYTES = 2 * 1024 * 1024;

export function fail(
  code: string,
  message: string,
  details?: unknown,
): ToolResult {
  const error: ToolError = {
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
  return { ok: false, error, truncated: false };
}
