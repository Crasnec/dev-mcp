import { describe, expect, it } from "vitest";
import {
  MEDIA_URL_TTL_MS,
  createMediaUrl,
  verifyMediaToken,
} from "../src/media.ts";

describe("media URLs", () => {
  it("signs and verifies short-lived image URLs", () => {
    const now = 1_700_000_000_000;
    const created = createMediaUrl(
      "https://dev.example.test",
      "secret",
      {
        projectId: "00000000-0000-4000-8000-000000000000",
        path: "images/pixel.png",
        actor: "client",
        userId: "test-user",
        authVersion: 1,
      },
      now,
    );
    expect(created.url).toContain("https://dev.example.test/media/");
    expect(created.expiresAt).toBe(now + MEDIA_URL_TTL_MS);
    expect(
      verifyMediaToken("secret", created.url.split("/media/")[1]!, now),
    ).toEqual({
      v: 1,
      projectId: "00000000-0000-4000-8000-000000000000",
      path: "images/pixel.png",
      actor: "client",
      userId: "test-user",
      authVersion: 1,
      expiresAt: now + MEDIA_URL_TTL_MS,
    });
  });

  it("rejects altered, expired, and differently signed URLs", () => {
    const now = 1_700_000_000_000;
    const created = createMediaUrl(
      "https://dev.example.test",
      "secret",
      {
        projectId: "project",
        path: "image.png",
        actor: "client",
        userId: "test-user",
        authVersion: 1,
      },
      now,
    );
    const token = created.url.split("/media/")[1]!;
    expect(verifyMediaToken("wrong", token, now)).toBeUndefined();
    expect(verifyMediaToken("secret", `${token}x`, now)).toBeUndefined();
    expect(
      verifyMediaToken("secret", token, created.expiresAt),
    ).toBeUndefined();
  });
});
