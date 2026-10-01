import { describe, expect, it } from "vitest";
import express from "express";
import inject from "light-my-request";
import { LiveSnapshots } from "../src/live-snapshots.ts";

describe("bounded live snapshot baselines", () => {
  it("resets after eviction or expiry, isolates scopes, and still omits unchanged bodies without a cached baseline", async () => {
    let clock = 1000;
    let value: Record<string, unknown> = {
      order: ["a"],
      "row:a": { label: "first" },
    };
    const snapshots = new LiveSnapshots(4096, 1, 100, () => clock);
    const app = express();
    app.get("/:scope", (req, res) =>
      snapshots.send(req, res, req.params.scope, "test", value),
    );
    const get = (url: string) => inject(app, { method: "GET", url });
    const initial = (await get("/one")).json();
    const another = (await get("/two?since=" + initial.revision)).json();
    expect(another.reset).toBe(true);
    expect(another.revision).not.toBe(initial.revision);
    expect((await get("/one?since=" + initial.revision)).statusCode).toBe(204);
    value = { order: ["a"], "row:a": { label: "changed" } };
    clock += 101;
    const expired = (await get("/one?since=" + initial.revision)).json();
    expect(expired.reset).toBe(true);
    expect(expired.changes).toEqual(value);
    await get("/two");
    value = { order: [] };
    const evicted = (await get("/one?since=" + expired.revision)).json();
    expect(evicted.reset).toBe(true);
    expect(evicted.changes).toEqual(value);
  });

  it("keeps oversized payloads out of the baseline cache and accepts only bounded single revisions", async () => {
    const snapshots = new LiveSnapshots(200, 2);
    const app = express();
    let text = "x".repeat(1000);
    app.get("/", (req, res) =>
      snapshots.send(req, res, "scope", "test", { text }),
    );
    const get = (url: string) => inject(app, { method: "GET", url });
    const first = (await get("/")).json();
    text += "new";
    expect((await get("/?since=" + first.revision)).json().reset).toBe(true);
    for (const query of [
      "since=invalid",
      "since=" + "a".repeat(25),
      "since=" + "a".repeat(24) + "&since=" + "b".repeat(24),
    ]) {
      const response = await get("/?" + query);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_live_revision");
    }
  });
});
