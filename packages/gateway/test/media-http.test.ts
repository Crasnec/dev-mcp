import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { IpcClient } from "../src/ipc-client.ts";
import { UserStore } from "../src/user-store.ts";
import { createMediaUrl } from "../src/media.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("media HTTP endpoint", () => {
  it("serves an image through a signed URL", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-media-http-"));
    temporary.push(dataDir);
    const users = new UserStore(dataDir, "secret");
    const admin = (await users.list())[0]!;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const ipc = {
      call: async (
        method: string,
        params: Record<string, unknown>,
        actor: string,
      ) => {
        expect(method).toBe("image_read");
        expect(params).toEqual({
          project_id: "00000000-0000-4000-8000-000000000000",
          path: "pixel.png",
        });
        expect(actor).toBe("media:test-client");
        return {
          ok: true,
          data: {
            path: "pixel.png",
            mimeType: "image/png",
            size: png.length,
            base64: png.toString("base64"),
          },
          truncated: false,
        };
      },
    } as unknown as IpcClient;

    const projectId = "00000000-0000-4000-8000-000000000000";
    const media = createMediaUrl("https://dev.example.test", "secret", {
      projectId,
      path: "pixel.png",
      actor: "test-client",
      userId: admin.id,
      authVersion: admin.authVersion,
    });
    const app = createApp(
      {
        port: 3000,
        publicBaseUrl: "https://dev.example.test",
        dataDir,
        runnerSocket: path.join(dataDir, "runner.sock"),
        adminPasswordHash: "secret",
      },
      { ipc },
    );

    const response = await inject(app, {
      method: "GET",
      url: new URL(media.url).pathname,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.rawPayload).toEqual(png);
    await users.revokeAccess(admin.id, admin.id);
    const revoked = await inject(app, {
      method: "GET",
      url: new URL(media.url).pathname,
    });
    expect(revoked.statusCode).toBe(404);
  });
});
