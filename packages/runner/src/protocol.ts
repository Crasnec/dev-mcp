export interface RpcRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  actor?: string;
}

export interface RpcResponse {
  id: string;
  result: ToolResult;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ToolError;
  truncated: boolean;
  continuation?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  relativePath: string;
  createdAt: string;
}

export type NetworkIntent = "none" | "read" | "write";

export const MAX_IPC_MESSAGE_BYTES = 2 * 1024 * 1024;

export function ok<T>(
  data: T,
  options: { truncated?: boolean; continuation?: string } = {},
): ToolResult<T> {
  return {
    ok: true,
    data,
    truncated: options.truncated ?? false,
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
}

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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
