import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { RpcRequest, RpcResponse } from "./protocol.ts";
import { MAX_IPC_MESSAGE_BYTES, fail } from "./protocol.ts";
import type { RunnerRuntime } from "./runtime.ts";

export async function startIpcServer(
  socketPath: string,
  runtime: RunnerRuntime,
): Promise<net.Server> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o777 });
  await chmod(path.dirname(socketPath), 0o777);
  await rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(30_000, () =>
      socket.destroy(new Error("IPC request timed out")),
    );
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_IPC_MESSAGE_BYTES) {
        handled = true;
        socket.end(
          `${JSON.stringify({ id: "", result: fail("IPC_TOO_LARGE", "IPC request is too large") })}\n`,
        );
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      handled = true;
      void handleLine(
        buffered.subarray(0, newline).toString("utf8"),
        runtime,
      ).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o666);
  return server;
}

async function handleLine(
  line: string,
  runtime: RunnerRuntime,
): Promise<RpcResponse> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
    if (
      !request ||
      typeof request.id !== "string" ||
      typeof request.method !== "string" ||
      typeof request.params !== "object" ||
      !request.params
    ) {
      throw new Error("Malformed IPC request");
    }
  } catch (error) {
    return {
      id: "",
      result: fail(
        "INVALID_IPC",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
  const started = Date.now();
  const result = await runtime.dispatch(request);
  console.log(
    JSON.stringify({
      event: "runner_call",
      id: request.id,
      method: request.method,
      actor: request.actor ?? "unknown",
      ok: result.ok,
      durationMs: Date.now() - started,
    }),
  );
  return { id: request.id, result };
}
