import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveExisting, resolveForWrite } from "../src/paths.ts";
import { validateCloneUrl } from "../src/project-service.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("runner security boundaries", () => {
  it("rejects parent, absolute, and symlink escapes", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "mcp-paths-"));
    temporary.push(base);
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret"), "nope");
    await symlink(outside, path.join(root, "escape"));

    await expect(resolveExisting(root, "../outside/secret")).rejects.toThrow(
      /traversal|allowed root/,
    );
    await expect(resolveExisting(root, "/etc/passwd")).rejects.toThrow(
      /Absolute/,
    );
    await expect(resolveExisting(root, "escape/secret")).rejects.toThrow(
      /Symlink/,
    );
    await expect(resolveForWrite(root, "escape/new-file")).rejects.toThrow(
      /Symlink/,
    );
  });

  it("allows only credential-free public forge HTTPS clone URLs", () => {
    expect(
      validateCloneUrl("https://github.com/openai/openai-node.git").hostname,
    ).toBe("github.com");
    expect(() =>
      validateCloneUrl("https://user:token@github.com/a/b.git"),
    ).toThrow(/Credentials/);
    expect(() => validateCloneUrl("ssh://git@github.com/a/b.git")).toThrow(
      /HTTPS/,
    );
    expect(() => validateCloneUrl("https://127.0.0.1/a/b.git")).toThrow(
      /Only public/,
    );
    expect(() =>
      validateCloneUrl("https://github.com.evil.test/a/b.git"),
    ).toThrow(/Only public/);
  });
});
