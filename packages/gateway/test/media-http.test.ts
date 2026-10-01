import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import type { IpcClient } from "../src/ipc-client.ts";
import { UserStore } from "../src/user-store.ts";
import { adminAccount } from "./accounts.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("removed image endpoint", () => {
  it("rejects even a valid previously issued URL without calling a runner", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-media-removed-"));
    temporary.push(dataDir);
    const users = new UserStore(dataDir);
    const admin = await adminAccount(users, dataDir);
    // Sign the old wire format to ensure removal, rather than invalid-token rejection.
    const claims = Buffer.from(
      JSON.stringify({
        v: 1,
        projectId: "00000000-0000-4000-8000-000000000000",
        path: "pixel.png",
        actor: "test-client",
        userId: admin.id,
        authVersion: admin.authVersion,
        expiresAt: Date.now() + 600_000,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", "secret")
      .update(claims)
      .digest("base64url");
    const call = vi.fn();
    const app = createApp(
      {
        port: 3000,
        publicBaseUrl: "https://dev.example.test",
        dataDir,
      },
      { users, ipc: { call } as unknown as IpcClient },
    );
    const response = await inject(app, {
      method: "GET",
      url: `/media/${claims}.${signature}`,
    });
    expect(response.statusCode).toBe(404);
    expect(call).not.toHaveBeenCalled();
  });
});
