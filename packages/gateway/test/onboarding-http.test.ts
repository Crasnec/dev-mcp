import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createOnboardingApp, onboardingCode } from "../src/onboarding.ts";
import {
  InstallationStore,
  validateWorkspaceRoot,
} from "../src/installation-store.ts";
import { UserStore } from "../src/user-store.ts";
import { AuditLogger } from "../src/audit.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const host = "127.0.0.1:3100";
const origin = "http://" + host;

async function fixture(googleEnabled = true) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-onboarding-"));
  temporary.push(dataDir);
  const statusDir = path.join(dataDir, "status");
  await mkdir(statusDir);
  const users = new UserStore(dataDir);
  const installation = new InstallationStore(dataDir, statusDir);
  const code = onboardingCode();
  const app = createOnboardingApp({
    users,
    installation,
    audit: new AuditLogger(dataDir),
    code,
    googleEnabled,
    publicBaseUrl: "https://dev.example.test",
  });
  const get = (cookie = "", headers: Record<string, string> = {}) =>
    inject(app, {
      method: "GET",
      url: "/",
      headers: { host, cookie, ...headers },
    });
  const post = (
    url: string,
    values: Record<string, string>,
    cookie = "",
    headers: Record<string, string> = {},
  ) =>
    inject(app, {
      method: "POST",
      url,
      headers: {
        host,
        origin,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      payload: new URLSearchParams(values).toString(),
    });
  const signIn = async () => {
    const response = await post("/code", { code });
    expect(response.statusCode).toBe(303);
    const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    const page = await get(cookie);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.payload)![1]!;
    return { cookie, csrf, page };
  };
  const observe = (installationStatus: Record<string, unknown>) =>
    writeFile(
      path.join(statusDir, "status.json"),
      JSON.stringify({ entries: {}, installation: installationStatus }),
    );
  return {
    app,
    users,
    installation,
    dataDir,
    code,
    get,
    post,
    signIn,
    observe,
  };
}

describe("local installer onboarding", () => {
  it("answers loopback Host headers only and rejects cross-origin posts", async () => {
    const { get, post, code } = await fixture();
    for (const name of [
      "dev.example.test",
      "evil.example:3100",
      "127.0.0.2:3100",
      "localhost.evil.example",
    ]) {
      expect((await get("", { host: name })).statusCode).toBe(421);
    }
    for (const name of ["localhost:8080", "[::1]:3100", host]) {
      expect((await get("", { host: name })).statusCode).toBe(200);
    }
    expect(
      (await post("/code", { code }, "", { origin: "https://evil.example" }))
        .statusCode,
    ).toBe(403);
    const page = await get();
    expect(page.payload).toContain("설치 코드");
    expect(page.headers["content-security-policy"]).toContain(
      "form-action 'self'",
    );
  });

  it("requires the logged one-time code and limits guessing", async () => {
    const { post, code } = await fixture();
    expect((await post("/code", { code: "WRONG" })).statusCode).toBe(400);
    const relaxed = code.toLowerCase().replaceAll("-", " ");
    expect((await post("/code", { code: relaxed })).statusCode).toBe(303);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await post("/code", { code: "WRONG" });
    }
    expect((await post("/code", { code })).statusCode).toBe(429);
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
  });

  it("approves the chosen pending Google account as the first administrator", async () => {
    const { users, signIn, post } = await fixture();
    const { user } = await users.googleAccount(
      { sub: "installer-subject", email: "installer@example.test" },
      true,
    );
    const session = await signIn();
    expect(session.page.payload).toContain("installer@example.test");
    expect(
      (await post("/admin", { userId: user.id, csrf: "wrong" }, session.cookie))
        .statusCode,
    ).toBe(400);
    expect(
      (await post("/admin", { userId: user.id, csrf: session.csrf }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          "/admin",
          { userId: user.id, csrf: session.csrf },
          session.cookie,
        )
      ).statusCode,
    ).toBe(303);
    expect(await users.get(user.id)).toMatchObject({
      role: "admin",
      status: "active",
    });
    const again = await post(
      "/admin",
      { userId: user.id, csrf: session.csrf },
      session.cookie,
    );
    expect(again.statusCode).toBe(400);
  });

  it("validates the workspace root and completes only after the provisioner verifies it", async () => {
    const { users, installation, signIn, post, get, observe, dataDir } =
      await fixture();
    const { user } = await users.googleAccount(
      { sub: "installer-subject", email: "installer@example.test" },
      true,
    );
    const session = await signIn();
    const form = (values: Record<string, string>) =>
      post(
        "/workspace-root",
        { csrf: session.csrf, ...values },
        session.cookie,
      );
    for (const workspaceRoot of [
      "relative",
      "/",
      "/srv/a/../b",
      "/srv/a,b",
      "/srv/",
    ]) {
      const response = await form({ mode: "host", workspaceRoot });
      expect(response.statusCode).toBe(400);
      expect(response.payload).toContain("error-banner");
    }
    expect(
      (await form({ mode: "host", workspaceRoot: "/srv/ws" })).statusCode,
    ).toBe(303);
    expect((await installation.read()).workspaceRoot).toBe("/srv/ws");
    const checking = await get(session.cookie);
    expect(checking.payload).toContain('http-equiv="refresh"');
    expect(
      (await post("/complete", { csrf: session.csrf }, session.cookie))
        .statusCode,
    ).toBe(400);
    await post(
      "/admin",
      { userId: user.id, csrf: session.csrf },
      session.cookie,
    );
    await observe({
      workspaceRoot: {
        path: "/srv/ws",
        state: "invalid",
        message: "쓸 수 없습니다.",
        observedAt: 1,
      },
      reservedWorkspaces: ["/srv/ws/admin"],
    });
    const invalid = await get(session.cookie);
    expect(invalid.payload).toContain("쓸 수 없습니다.");
    expect(invalid.payload).not.toContain("호스트 작업 공간(<code>");
    expect(
      (await post("/complete", { csrf: session.csrf }, session.cookie))
        .statusCode,
    ).toBe(400);
    // A reserved host workspace (for example a migrated administrator
    // environment) that contains the root blocks completion even when its
    // observation arrives after the root was saved.
    await observe({
      workspaceRoot: {
        path: "/srv/ws",
        state: "ready",
        message: "사용할 수 있습니다.",
        observedAt: 1,
      },
      reservedWorkspaces: ["/srv"],
    });
    const overlapping = await get(session.cookie);
    expect(overlapping.payload).toContain("안에 있어 쓸 수 없습니다");
    expect(overlapping.payload).not.toContain('action="/complete"');
    expect(
      (await post("/complete", { csrf: session.csrf }, session.cookie))
        .statusCode,
    ).toBe(400);
    await observe({
      workspaceRoot: {
        path: "/srv/ws",
        state: "ready",
        message: "사용할 수 있습니다.",
        observedAt: 1,
      },
      reservedWorkspaces: ["/srv/ws/admin"],
    });
    expect(
      (await post("/complete", { csrf: session.csrf }, session.cookie))
        .statusCode,
    ).toBe(303);
    const done = await installation.read();
    expect(done).toMatchObject({
      workspaceRoot: "/srv/ws",
      onboardingCompletedBy: "local_installer",
    });
    expect((await get(session.cookie)).payload).toContain("온보딩을 마쳤어요");
    // Completion ends the session and freezes the root.
    expect((await form({ mode: "none" })).statusCode).toBe(400);
    await expect(installation.setWorkspaceRoot(undefined)).rejects.toThrow(
      "바꿀 수 없습니다",
    );
    const audit = await readFile(path.join(dataDir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"bootstrap_google_admin"');
    expect(audit).toContain('"event":"onboarding_completed"');
  });

  it("rejects roots inside or equal to another runner's host workspace", async () => {
    const { signIn, post, observe, installation } = await fixture();
    await observe({ reservedWorkspaces: ["/home/me/workspace"] });
    const session = await signIn();
    const form = (workspaceRoot: string) =>
      post(
        "/workspace-root",
        { csrf: session.csrf, mode: "host", workspaceRoot },
        session.cookie,
      );
    for (const root of ["/home/me/workspace", "/home/me/workspace/users"]) {
      const response = await form(root);
      expect(response.statusCode).toBe(400);
      expect(response.payload).toContain("안이나 같은 경로는 쓸 수 없습니다");
    }
    expect((await installation.read()).workspaceRoot).toBeUndefined();
    expect((await form("/home/me/workspace-users")).statusCode).toBe(303);
    expect((await form("/home/me")).statusCode).toBe(303);
    expect((await installation.read()).workspaceRoot).toBe("/home/me");
  });

  it("saves a blank workspace root as Docker volumes and completes onboarding", async () => {
    const { users, installation, signIn, post } = await fixture();
    const { user } = await users.googleAccount(
      { sub: "installer-subject", email: "installer@example.test" },
      true,
    );
    const session = await signIn();
    expect(session.page.payload).toContain('name="mode" value="none"');
    expect(
      (
        await post(
          "/admin",
          { userId: user.id, csrf: session.csrf },
          session.cookie,
        )
      ).statusCode,
    ).toBe(303);
    for (const workspaceRoot of ["", "   "]) {
      await installation.setWorkspaceRoot("/srv/ws");
      expect(
        (
          await post(
            "/workspace-root",
            { csrf: session.csrf, mode: "host", workspaceRoot },
            session.cookie,
          )
        ).statusCode,
      ).toBe(303);
      expect((await installation.read()).workspaceRoot).toBeUndefined();
    }
    expect(
      (await post("/complete", { csrf: session.csrf }, session.cookie))
        .statusCode,
    ).toBe(303);
    expect(await installation.read()).toMatchObject({
      onboardingCompletedBy: "local_installer",
    });
  });

  it("explains missing Google login and requires an administrator to complete", async () => {
    const { signIn, post, installation } = await fixture(false);
    const session = await signIn();
    expect(session.page.payload).toContain("Google 로그인이 설정되지 않아");
    expect(
      (await post("/complete", { csrf: session.csrf }, session.cookie))
        .statusCode,
    ).toBe(400);
    expect((await installation.read()).onboardingCompletedAt).toBeUndefined();
  });

  it("normalizes nothing silently when validating roots", () => {
    expect(validateWorkspaceRoot(" /srv/ws ")).toBe("/srv/ws");
    expect(() => validateWorkspaceRoot("/srv/./ws")).toThrow();
    expect(() => validateWorkspaceRoot("/srv//ws")).toThrow();
    expect(() => validateWorkspaceRoot("/srv/" + "x".repeat(600))).toThrow();
  });
});
