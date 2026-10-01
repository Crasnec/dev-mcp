import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { RpcRequest, RpcResponse } from "./protocol.ts";
import { MAX_IPC_MESSAGE_BYTES, fail } from "./protocol.ts";
import type { RunnerRuntime } from "./runtime.ts";

const TUNNEL_MAX_AGE_MS = 30_000;
const MAX_TUNNELS = 64;

// Every request must be HMAC-signed with the runner's own key.
export async function startIpcServer(
  socketPath: string,
  runtime: RunnerRuntime,
  secret: string,
): Promise<net.Server> {
  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("Invalid runner IPC key");
  }
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o777 });
  await rm(socketPath, { force: true });
  const tunnels: TunnelState = { active: 0, seen: new Map() };
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let handled = false;
    // A peer hanging up mid-reply must not crash the runner.
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30_000, () =>
      socket.destroy(new Error("IPC request timed out")),
    );
    const onData = (chunk: Buffer) => {
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
      const authenticated = authenticate(
        buffered.subarray(0, newline).toString("utf8"),
        secret,
      );
      if ("response" in authenticated) {
        socket.end(`${JSON.stringify(authenticated.response)}\n`);
        return;
      }
      if (authenticated.request.method === "http_tunnel") {
        socket.off("data", onData);
        openTunnel(
          socket,
          authenticated.request,
          buffered.subarray(newline + 1),
          tunnels,
        );
        return;
      }
      void dispatch(authenticated.request, runtime).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    };
    socket.on("data", onData);
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

function authenticate(
  line: string,
  secret: string,
): { request: RpcRequest } | { response: RpcResponse } {
  try {
    let request = JSON.parse(line) as RpcRequest;
    const payload = request.params?.payload;
    const signature = request.params?.signature;
    if (
      request.method !== "__authenticated_call" ||
      typeof payload !== "string" ||
      typeof signature !== "string"
    ) {
      throw new Error("Runner authentication required");
    }
    const expected = createHmac("sha256", secret).update(payload).digest();
    const actual = Buffer.from(signature, "hex");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Invalid runner authentication");
    }
    request = JSON.parse(payload) as RpcRequest;
    if (
      !request ||
      typeof request.id !== "string" ||
      typeof request.method !== "string" ||
      typeof request.params !== "object" ||
      !request.params
    ) {
      throw new Error("Malformed IPC request");
    }
    return { request };
  } catch (error) {
    return {
      response: {
        id: "",
        result: fail(
          "INVALID_IPC",
          error instanceof Error ? error.message : String(error),
        ),
      },
    };
  }
}

async function dispatch(
  request: RpcRequest,
  runtime: RunnerRuntime,
): Promise<RpcResponse> {
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

interface TunnelState {
  active: number;
  // Request id → issue time, to refuse replays within the validity window.
  seen: Map<string, number>;
}

// A signed request turns this connection into a byte stream to a server the
// account runs inside its own container, so the gateway can publish it
// without sharing a network with the runner.
function openTunnel(
  socket: net.Socket,
  request: RpcRequest,
  rest: Buffer,
  state: TunnelState,
): void {
  const reply = (result: RpcResponse["result"]) =>
    `${JSON.stringify({ id: request.id, result })}\n`;
  const { port, issuedAt } = request.params as {
    port?: unknown;
    issuedAt?: unknown;
  };
  const now = Date.now();
  for (const [id, at] of state.seen) {
    if (now - at > 2 * TUNNEL_MAX_AGE_MS) {
      state.seen.delete(id);
    }
  }
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof issuedAt !== "number" ||
    Math.abs(now - issuedAt) > TUNNEL_MAX_AGE_MS ||
    state.seen.has(request.id) ||
    state.seen.size >= 10_000
  ) {
    socket.end(reply(fail("INVALID_TUNNEL", "Invalid or replayed tunnel")));
    return;
  }
  state.seen.set(request.id, issuedAt);
  if (state.active >= MAX_TUNNELS) {
    socket.end(reply(fail("TUNNEL_LIMIT", "Too many open app connections")));
    return;
  }
  socket.pause();
  socket.setTimeout(0);
  connectLocal(port, (upstream) => {
    if (socket.destroyed) {
      upstream?.destroy();
      return;
    }
    if (!upstream) {
      socket.end(
        reply(
          fail(
            "UPSTREAM_UNAVAILABLE",
            "No server is listening on this port in the runner",
          ),
        ),
      );
      return;
    }
    state.active += 1;
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        state.active -= 1;
        socket.destroy();
        upstream.destroy();
      }
    };
    socket.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    socket.write(reply({ ok: true, data: { port }, truncated: false }));
    if (rest.length) {
      upstream.write(rest);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
    console.log(
      JSON.stringify({
        event: "runner_tunnel",
        id: request.id,
        port,
        actor: request.actor ?? "unknown",
      }),
    );
  });
}

// Development servers often bind only one loopback address family.
function connectLocal(
  port: number,
  done: (socket: net.Socket | undefined) => void,
): void {
  const attempt = (hosts: string[]) => {
    const [host, ...others] = hosts;
    if (!host) {
      done(undefined);
      return;
    }
    const upstream = net.createConnection({ host, port });
    upstream.once("connect", () => {
      upstream.removeAllListeners("error");
      done(upstream);
    });
    upstream.once("error", () => {
      upstream.destroy();
      attempt(others);
    });
  };
  attempt(["127.0.0.1", "::1"]);
}
