import { createHash } from "node:crypto";
import type { Request, Response } from "express";

interface Snapshot {
  scope: string;
  fields: Map<string, string>;
  bytes: number;
  touchedAt: number;
}

// Short-lived, bounded baselines for browser deltas. A lost baseline always
// produces a complete reset; authentication is checked before every call.
export class LiveSnapshots {
  private readonly entries = new Map<string, Snapshot>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = 8 * 1024 * 1024,
    private readonly maxEntries = 128,
    private readonly lifetimeMs = 120_000,
    private readonly now = Date.now,
  ) {}

  send(
    req: Request,
    res: Response,
    scope: string,
    kind: string,
    values: Record<string, unknown>,
  ): void {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const since = req.query.since;
    if (
      since !== undefined &&
      (typeof since !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(since))
    ) {
      res.status(400).json({ error: "invalid_live_revision" });
      return;
    }
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.touchedAt >= this.lifetimeMs) {
        this.remove(key);
      }
    }
    const fields = new Map(
      Object.keys(values)
        .sort()
        .map((key) => [key, JSON.stringify(values[key] ?? null)]),
    );
    const hash = createHash("sha256").update(JSON.stringify([scope, kind]));
    for (const field of fields) hash.update(JSON.stringify(field));
    const revision = hash.digest("base64url").slice(0, 24);
    const prior =
      typeof since === "string" ? this.entries.get(since) : undefined;
    const previous = prior?.scope === scope ? prior : undefined;
    const changes: Record<string, unknown> = Object.create(null);
    for (const [key, value] of fields) {
      if (previous?.fields.get(key) !== value) {
        changes[key] = JSON.parse(value);
      }
    }
    const removed = previous
      ? [...previous.fields.keys()].filter((key) => !fields.has(key))
      : [];
    this.remove(revision);
    const bytes = [...fields].reduce(
      (total, [key, value]) =>
        total + Buffer.byteLength(key) + Buffer.byteLength(value) + 64,
      256 + Buffer.byteLength(scope),
    );
    if (bytes <= this.maxBytes) {
      this.entries.set(revision, { scope, fields, bytes, touchedAt: now });
      this.bytes += bytes;
      const sameScope = [...this.entries].filter(
        ([, entry]) => entry.scope === scope,
      );
      for (const [key] of sameScope.slice(0, -3)) this.remove(key);
      while (
        this.bytes > this.maxBytes ||
        this.entries.size > this.maxEntries
      ) {
        this.remove(this.entries.keys().next().value!);
      }
    }
    if (since === revision) {
      res.status(204).end();
      return;
    }
    res.json({
      schemaVersion: 1,
      kind,
      revision,
      reset: !previous,
      changes,
      removed,
    });
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
}
