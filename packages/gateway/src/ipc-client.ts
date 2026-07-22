import { randomUUID } from "node:crypto";
import net from "node:net";
import type { RpcRequest, RpcResponse, ToolResult } from "./protocol.ts";
import { MAX_IPC_MESSAGE_BYTES, fail } from "./protocol.ts";

export class IpcClient {
  constructor(private readonly socketPath: string) {}

  async call(
    method: string,
    params: Record<string, unknown>,
    actor: string,
  ): Promise<ToolResult> {
    const request: RpcRequest = { id: randomUUID(), method, params, actor };
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let completed = false;
      const finish = (result: ToolResult): void => {
        if (completed) {
          return;
        }
        completed = true;
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () =>
        socket.write(`${JSON.stringify(request)}\n`),
      );
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_IPC_MESSAGE_BYTES) {
          return finish(
            fail(
              "IPC_TOO_LARGE",
              "Runner response exceeded the IPC size limit",
            ),
          );
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          return;
        }
        try {
          const response = JSON.parse(
            buffer.subarray(0, newline).toString("utf8"),
          ) as RpcResponse;
          if (response.id !== request.id) {
            return finish(
              fail(
                "IPC_MISMATCH",
                "Runner response ID did not match the request",
              ),
            );
          }
          finish(response.result);
        } catch (error) {
          finish(
            fail(
              "IPC_INVALID_RESPONSE",
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      });
      socket.once("error", (error) =>
        finish(fail("RUNNER_UNAVAILABLE", error.message)),
      );
      socket.once("end", () => {
        if (!completed) {
          finish(
            fail(
              "RUNNER_DISCONNECTED",
              "Runner disconnected without a complete response",
            ),
          );
        }
      });
    });
  }
}
