import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { UserStore } from "../src/user-store.ts";
import { vscodeUrl, type SiteSettings } from "../src/settings-store.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const origin = "https://dev.example.test";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-workspace-ui-"));
  temporary.push(dataDir);
  const statusDir = path.join(dataDir, "status");
  await mkdir(statusDir);
  const users = new UserStore(dataDir, "unused-legacy-hash");
  const admin = (await users.list())[0]!;
  const { user } = await users.googleAccount(
    { sub: "mina-subject", email: "Mina@example.test" },
    true,
  );
  const target = await users.update(admin.id, user.id, {
    status: "active",
    role: "user",
  });
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: origin,
      dataDir,
      runnerSocket: path.join(dataDir, "primary.sock"),
      userRunnerSocketDir: path.join(dataDir, "runners"),
      runnerStatusDir: statusDir,
      adminPasswordHash: "unused-legacy-hash",
      google: { clientId: "test-client", clientSecret: "test-secret" },
    },
    { users },
  );
  const sessionFor = async (id: string) =>
    "__Host-dev-mcp-session=" +
    (await users.createSession((await users.get(id))!)).token;
  const adminCookie = await sessionFor(admin.id);
  const get = (url: string, cookie = adminCookie) =>
    inject(app, { method: "GET", url, headers: { cookie } });
  const post = (url: string, values: Record<string, string>) =>
    inject(app, {
      method: "POST",
      url,
      headers: {
        cookie: adminCookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams(values).toString(),
    });
  const form = async (url: string) => {
    const page = await get(url);
    return {
      page,
      csrf: /name="csrf" value="([^"]+)"/.exec(page.payload)![1]!,
      revision: /name="revision" value="([^"]*)"/.exec(page.payload)?.[1] ?? "",
    };
  };
  const observe = (entry: Record<string, unknown>, rootState = "ready") =>
    writeFile(
      path.join(statusDir, "status.json"),
      JSON.stringify({
        entries: {
          [target.id]: { state: "running", observedAt: Date.now(), ...entry },
        },
        installation: {
          workspaceRoot: {
            path: "/srv/ws",
            state: rootState,
            message:
              rootState === "ready" ? "사용할 수 있습니다." : "쓸 수 없습니다.",
            observedAt: Date.now(),
          },
        },
      }),
    );
  await writeFile(
    path.join(dataDir, "installation.json"),
    JSON.stringify({ workspaceRoot: "/srv/ws" }),
  );
  return {
    app,
    users,
    admin,
    target,
    dataDir,
    get,
    post,
    form,
    observe,
    sessionFor,
  };
}

describe("runner workspace location", () => {
  it("offers a move to a host directory and records the validated request", async () => {
    const { target, dataDir, post, form, observe } = await fixture();
    const url = "/admin/runners/" + target.id;
    await observe({ workspaceMode: "volume" });
    const { page, csrf, revision } = await form(url);
    expect(page.payload).toContain("작업 공간 위치");
    expect(page.payload).toContain("Docker 볼륨");
    expect(page.payload).toContain('name="workspaceName"');
    expect(page.payload).toContain('value="mina"');
    expect(page.payload).toContain("<code>/srv/ws</code>");
    for (const workspaceName of ["", "../etc", "Mina", "a/b", ".x"]) {
      expect(
        (
          await post(url + "/operations", {
            csrf,
            revision,
            action: "workspace",
            workspaceName,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await post(url + "/operations", {
          csrf,
          revision,
          action: "workspace",
          workspaceName: "mina",
        })
      ).statusCode,
    ).toBe(303);
    const controls = JSON.parse(
      await readFile(path.join(dataDir, "runner-controls.json"), "utf8"),
    );
    expect(controls.entries[target.id]).toMatchObject({
      action: "workspace",
      workspace: { name: "mina" },
    });
  });

  it("does not offer moves until the root is verified or for unknown storage", async () => {
    const { target, get, observe } = await fixture();
    const url = "/admin/runners/" + target.id;
    await observe({ workspaceMode: "volume" }, "invalid");
    let page = await get(url);
    expect(page.payload).not.toContain('name="workspaceName"');
    expect(page.payload).toContain("쓸 수 없습니다.");
    await observe({ workspaceMode: "quota" });
    page = await get(url);
    expect(page.payload).not.toContain('name="workspaceName"');
    expect(page.payload).toContain("저장공간 상한 저장소를 쓰는 환경은");
  });

  it("shows host paths with a VS Code link to administrators only and rejects storage limits", async () => {
    const { target, get, post, form, observe, sessionFor } = await fixture();
    const url = "/admin/runners/" + target.id;
    await observe({ workspaceMode: "host", workspaceHostPath: "/srv/ws/mina" });
    let { page, csrf, revision } = await form(url);
    expect(page.payload).toContain("<code>/srv/ws/mina</code>");
    expect(page.payload).not.toContain('name="storageMiB" type="number"');
    expect(page.payload).toContain('name="storageMiB" value="0"');
    expect(page.payload).not.toContain("vscode://");
    const limits = {
      csrf,
      revision,
      action: "apply",
      network: "on",
      memoryMiB: "0",
      cpus: "0",
      pids: "0",
      fileSizeMiB: "0",
      storageMiB: "1024",
    };
    expect((await post(url + "/operations", limits)).statusCode).toBe(400);
    expect(
      (
        await post(url + "/operations", {
          csrf,
          revision,
          action: "workspace",
          workspaceName: "other",
        })
      ).statusCode,
    ).toBe(400);
    const settings = await form("/admin/settings");
    expect(settings.page.payload).toContain("<code>/srv/ws</code>");
    expect(
      (
        await post("/admin/settings/editor", {
          csrf: settings.csrf,
          vscodeSshHost: "dev box",
          vscodePathFrom: "",
          vscodePathTo: "",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post("/admin/settings/editor", {
          csrf: settings.csrf,
          vscodeSshHost: "dev-box",
          vscodePathFrom: "/srv",
          vscodePathTo: "/workspace",
        })
      ).statusCode,
    ).toBe(303);
    ({ page } = await form(url));
    expect(page.payload).toContain(
      'href="vscode://vscode-remote/ssh-remote+dev-box/workspace/ws/mina"',
    );
    const self = await get(
      "/account/runners/" + target.id,
      await sessionFor(target.id),
    );
    expect(self.statusCode).toBe(200);
    expect(self.payload).not.toContain("/srv/ws");
    expect(self.payload).not.toContain("작업 공간 위치");
  });

  it("builds VS Code links with an optional path mapping", () => {
    const settings: SiteSettings = {
      registrationOpen: true,
      registrationMessage: "",
      vscodeSshHost: "me@server",
      vscodePathFrom: "/home/me/workspace",
      vscodePathTo: "/workspace",
    };
    expect(vscodeUrl(settings, "/home/me/workspace")).toBe(
      "vscode://vscode-remote/ssh-remote+me@server/workspace",
    );
    expect(vscodeUrl(settings, "/home/me/workspace/a b")).toBe(
      "vscode://vscode-remote/ssh-remote+me@server/workspace/a%20b",
    );
    expect(vscodeUrl(settings, "/home/me/workspace-other")).toBe(
      "vscode://vscode-remote/ssh-remote+me@server/home/me/workspace-other",
    );
    expect(vscodeUrl({ ...settings, vscodeSshHost: "" }, "/x")).toBeUndefined();
  });
});
