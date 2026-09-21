import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import type { RpcRequest, RpcResponse, ToolResult } from "./protocol.ts";
import { MAX_IPC_MESSAGE_BYTES, fail } from "./protocol.ts";

export class IpcClient {
  constructor(
    private readonly socketPath: string,
    private readonly secretPath?: string,
  ) {}

  async call(
    method: string,
    params: Record<string, unknown>,
    actor: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    const request: RpcRequest = { id: randomUUID(), method, params, actor };
    let wireRequest = request;
    if (this.secretPath) {
      try {
        const secret = (await readFile(this.secretPath, "utf8")).trim();
        if (!/^[a-f0-9]{64}$/.test(secret)) {
          throw new Error("Invalid runner key");
        }
        const payload = JSON.stringify(request);
        wireRequest = {
          id: request.id,
          actor,
          method: "__authenticated_call",
          params: {
            payload,
            signature: createHmac("sha256", secret)
              .update(payload)
              .digest("hex"),
          },
        };
      } catch {
        return fail(
          "RUNNER_UNAVAILABLE",
          "User runner has not been provisioned",
        );
      }
    }
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = Buffer.alloc(0);
      let completed = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: ToolResult): void => {
        if (completed) {
          return;
        }
        completed = true;
        if (timer) {
          clearTimeout(timer);
        }
        socket.destroy();
        resolve(result);
      };
      if (options.timeoutMs) {
        timer = setTimeout(
          () =>
            finish(fail("RUNNER_TIMEOUT", "Runner did not respond in time")),
          options.timeoutMs,
        );
        timer.unref();
      }
      socket.once("connect", () =>
        socket.write(`${JSON.stringify(wireRequest)}\n`),
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
