import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import inject from "light-my-request";
import { createApp } from "../src/app.ts";
import { SshAccessStore } from "../src/ssh-access-store.ts";
import { WorkspaceControlStore } from "../src/workspace-control-store.ts";
import { UserStore } from "../src/user-store.ts";
import { adminAccount } from "./accounts.ts";
import { sshAccessRevision } from "../../../scripts/ssh-access.mjs";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const origin = "https://dev.example.test";
function publicKey() {
  const bytes = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  const wire = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    bytes,
  ]);
  return "ssh-ed25519 " + wire.toString("base64");
}
async function fixture(enabled = true) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mcp-ssh-ui-"));
  temporary.push(dataDir);
  const statusDir = path.join(dataDir, "status");
  await mkdir(statusDir);
  const users = new UserStore(dataDir);
  const admin = await adminAccount(users, dataDir);
  const { user } = await users.googleAccount(
    { sub: "alice", email: "alice@example.test" },
    true,
  );
  const alice = await users.update(admin.id, user.id, {
    role: "user",
    status: "active",
  });
  const access = new SshAccessStore(dataDir);
  const app = createApp(
    {
      port: 3000,
      publicBaseUrl: origin,
      dataDir,
      runnerStatusDir: statusDir,
      ssh: enabled ? { host: "ssh.example.test", port: 2222 } : undefined,
    },
    { users, sshAccess: access },
  );
  const session = await users.createSession(alice);
  const cookie = "__Host-dev-mcp-session=" + session.token;
  const get = (url = "/account/workspace") =>
    inject(app, { method: "GET", url, headers: { cookie } });
  const post = (
    url: string,
    values: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    inject(app, {
      method: "POST",
      url,
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      payload: new URLSearchParams(values).toString(),
    });
  return {
    dataDir,
    statusDir,
    users,
    alice,
    admin,
    access,
    app,
    get,
    post,
    csrf: session.csrf,
  };
}

it("shows each user's own connection, registers keys with CSRF, and waits for provisioner confirmation", async () => {
  const f = await fixture();
  expect((await f.get()).payload).toContain("SSH 공개키");
  const key = publicKey();
  expect(
    (
      await f.post("/account/workspace/keys", {
        csrf: f.csrf,
        name: "<script>laptop</script>",
        publicKey: key,
      })
    ).statusCode,
  ).toBe(303);
  const entry = (await f.access.get(f.alice.id))!;
  let page = await f.get();
  expect(page.payload).toContain("HostName ssh.example.test");
  expect(page.payload).toContain("Port 2222");
  expect(page.payload).toContain("Workspace와 공개키를 준비");
  expect(page.payload).not.toContain('href="vscode://');
  expect(page.payload).not.toContain("<script>laptop</script>");
  await writeFile(
    path.join(f.statusDir, "status.json"),
    JSON.stringify({
      entries: {},
      workspaces: {
        [f.alice.id]: {
          state: "running",
          sshReady: true,
          observedAt: Date.now(),
          sshRevision: sshAccessRevision(f.alice, entry),
          sshHostFingerprint: "SHA256:host-fingerprint",
        },
      },
    }),
  );
  page = await f.get();
  expect(page.payload).toContain(
    `href="vscode://vscode-remote/ssh-remote+${f.alice.id}.ssh.example.test/workspace"`,
  );
  expect(page.payload).toContain("SHA256:host-fingerprint");
  expect(page.payload).not.toContain("/host/");
  expect(
    (
      await f.post("/account/workspace/keys/" + entry.keys[0]!.id + "/delete", {
        csrf: f.csrf,
      })
    ).statusCode,
  ).toBe(303);
  expect((await f.access.get(f.alice.id))?.keys).toEqual([]);
});

it("rejects missing sessions, cross-origin writes, foreign selectors and malformed public keys", async () => {
  const f = await fixture();
  expect(
    (await inject(f.app, { method: "GET", url: "/account/workspace" }))
      .statusCode,
  ).toBe(303);
  const values = { csrf: f.csrf, name: "Laptop", publicKey: publicKey() };
  expect(
    (await f.post("/account/workspace/keys", { ...values, csrf: "wrong" }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await f.post("/account/workspace/keys", values, {
        origin: "https://foreign.example",
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await f.post("/account/workspace/keys", { ...values, owner: f.admin.id }))
      .statusCode,
  ).toBe(400);
  expect(
    (await f.get("/account/workspace?owner=" + f.admin.id)).statusCode,
  ).toBe(400);
  expect(
    (
      await f.post("/account/workspace/keys", {
        ...values,
        publicKey: "command=sh " + values.publicKey,
      })
    ).statusCode,
  ).toBe(400);
  expect(await f.access.get(f.alice.id)).toBeUndefined();
  expect(await f.access.get(f.admin.id)).toBeUndefined();
});

it("does not register keys when SSH is disabled", async () => {
  const f = await fixture(false);
  const page = await f.get();
  expect(page.payload).toContain("workspace SSH 접속을 아직 활성화하지");
  expect(page.payload).not.toContain('name="publicKey"');
  expect(
    (
      await f.post("/account/workspace/keys", {
        csrf: f.csrf,
        name: "Laptop",
        publicKey: publicKey(),
      })
    ).statusCode,
  ).toBe(400);
  expect(await f.access.get(f.alice.id)).toBeUndefined();
});

it("accepts only the session owner's versioned workspace lifecycle and rejects stale or foreign requests", async () => {
  const f = await fixture();
  const controls = new WorkspaceControlStore(f.dataDir, f.statusDir);
  const values = { csrf: f.csrf, revision: "", action: "start" };
  expect(
    (
      await f.post("/account/workspace/operations", {
        ...values,
        owner: f.admin.id,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.post("/account/workspace/operations", {
        ...values,
        action: "exec",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.post("/account/workspace/operations", {
        ...values,
        csrf: "wrong",
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await f.post("/account/workspace/operations", values)).statusCode,
  ).toBe(303);
  const first = (await controls.read(f.alice.id)).control!;
  expect(first.action).toBe("start");
  expect(first.actorId).toBe(f.alice.id);
  expect((await controls.read(f.admin.id)).control).toBeUndefined();
  expect(
    (await f.post("/account/workspace/operations", values)).statusCode,
  ).toBe(400);
  expect((await controls.read(f.alice.id)).control?.revision).toBe(
    first.revision,
  );
  expect(
    (
      await f.post("/account/workspace/operations", {
        ...values,
        revision: first.revision,
        action: "stop",
      })
    ).statusCode,
  ).toBe(303);
  const config = await f.get("/account/workspace/config");
  expect(config.statusCode).toBe(200);
  expect(config.payload).toContain("ProxyJump dev-mcp-entry-" + f.alice.id);
  expect(config.payload).toContain("User workspace");
  expect(config.payload).not.toContain(f.admin.id);
  expect(config.headers["content-disposition"]).toContain("attachment");
});

it("hides stale connection readiness and invalidates browser access after account disablement", async () => {
  const f = await fixture();
  await f.access.add(f.alice, "Laptop", publicKey());
  const entry = await f.access.get(f.alice.id);
  await writeFile(
    path.join(f.statusDir, "status.json"),
    JSON.stringify({
      entries: {},
      workspaces: {
        [f.alice.id]: {
          state: "running",
          sshReady: true,
          observedAt: Date.now() - 60_000,
          sshRevision: sshAccessRevision(f.alice, entry),
        },
      },
    }),
  );
  expect((await f.get()).payload).not.toContain('href="vscode://');
  await f.users.update(f.admin.id, f.alice.id, {
    role: "user",
    status: "disabled",
  });
  expect((await f.get()).statusCode).toBe(303);
  expect(
    (
      await f.post("/account/workspace/operations", {
        csrf: f.csrf,
        revision: "",
        action: "start",
      })
    ).statusCode,
  ).toBe(303);
});
