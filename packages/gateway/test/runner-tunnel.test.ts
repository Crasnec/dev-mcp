import { afterEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startIpcServer } from "../../runner/src/ipc-server.ts";
import type { RunnerRuntime } from "../../runner/src/runtime.ts";
import { IpcClient } from "../src/ipc-client.ts";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});
const key = "c".repeat(64);
const runtime = {
  dispatch: async () => ({ ok: true, data: {}, truncated: false }),
} as unknown as RunnerRuntime;

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-tunnel-"));
  closers.push(() => rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "runner.sock");
  const keyPath = path.join(dir, "runner.key");
  await writeFile(keyPath, key);
  const server = await startIpcServer(socketPath, runtime, key);
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  // An app server inside the "runner": HTTP plus a raw WebSocket-style upgrade.
  const app = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          body,
        }),
      );
    });
  });
  app.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.pipe(socket);
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => app.close(() => done())));
  const port = (app.address() as net.AddressInfo).port;
  return {
    socketPath,
    port,
    client: new IpcClient(socketPath, keyPath),
    raw: (request: Record<string, unknown>, secret = key) => {
      const payload = JSON.stringify(request);
      const line = JSON.stringify({
        id: request.id,
        method: "__authenticated_call",
        params: {
          payload,
          signature: createHmac("sha256", secret).update(payload).digest("hex"),
        },
      });
      return new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath, () =>
          socket.write(line + "\n"),
        );
        let output = "";
        socket.on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) {
            socket.destroy();
            resolve(output.split("\n")[0]!);
          }
        });
        socket.on("error", reject);
      });
    },
  };
}

function requestOver(
  socket: net.Socket,
  options: http.RequestOptions,
  body = "",
): Promise<{ status: number; json: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        ...options,
        createConnection: () => {
          process.nextTick(() => socket.resume());
          return socket;
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, json: JSON.parse(text) }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("signed runner tunnels", () => {
  it("carries HTTP requests and upgraded streams to a server inside the runner", async () => {
    const { client, port } = await fixture();
    const socket = await client.tunnel(port, "user:test");
    expect(socket).toBeInstanceOf(net.Socket);
    const response = await requestOver(
      socket as net.Socket,
      {
        method: "POST",
        path: "/api/echo?x=1",
        headers: { host: "localhost:" + port },
      },
      "hello",
    );
    expect(response).toEqual({
      status: 200,
      json: {
        method: "POST",
        url: "/api/echo?x=1",
        host: "localhost:" + port,
        body: "hello",
      },
    });
    const upgraded = (await client.tunnel(port, "user:test")) as net.Socket;
    upgraded.resume();
    const echoed = await new Promise<string>((resolve) => {
      let text = "";
      upgraded.on("data", (chunk) => {
        text += chunk;
        if (text.includes("ping")) {
          resolve(text);
        }
      });
      upgraded.write(
        "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n",
      );
      setTimeout(() => upgraded.write("ping"), 50);
    });
    expect(echoed).toContain("101 Switching Protocols");
    expect(echoed.endsWith("ping")).toBe(true);
    upgraded.destroy();
  });

  it("refuses unsigned, wrongly signed, stale and replayed tunnels", async () => {
    const { socketPath, port, raw } = await fixture();
    const unsigned = await new IpcClient(socketPath).tunnel(port, "x");
    expect(unsigned).toMatchObject({
      ok: false,
      error: { code: "RUNNER_UNAVAILABLE" },
    });
    const request = {
      id: randomUUID(),
      method: "http_tunnel",
      params: { port, issuedAt: Date.now() },
      actor: "x",
    };
    expect(JSON.parse(await raw(request, "d".repeat(64))).result).toMatchObject(
      {
        ok: false,
        error: { code: "INVALID_IPC" },
      },
    );
    expect(JSON.parse(await raw(request)).result.ok).toBe(true);
    // The same signed request cannot open a second stream.
    expect(JSON.parse(await raw(request)).result).toMatchObject({
      ok: false,
      error: { code: "INVALID_TUNNEL" },
    });
    for (const params of [
      { port, issuedAt: Date.now() - 60_000 },
      { port: 0, issuedAt: Date.now() },
      { port: "80", issuedAt: Date.now() },
      { port },
    ]) {
      expect(
        JSON.parse(await raw({ ...request, id: randomUUID(), params })).result,
      ).toMatchObject({ ok: false, error: { code: "INVALID_TUNNEL" } });
    }
  });

  it("reports a port without a listening server", async () => {
    const { client } = await fixture();
    const closed = net.createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    expect(await client.tunnel(port, "x")).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM_UNAVAILABLE" },
    });
  });
});
