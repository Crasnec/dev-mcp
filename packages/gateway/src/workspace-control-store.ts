import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json-store.ts";
import type { User } from "./user-store.ts";

export interface WorkspaceControl {
  revision: string;
  action: "create" | "start" | "stop" | "restart";
  actorId: string;
  requestedAt: number;
}
export interface WorkspaceObservation {
  revision?: string;
  phase?: "applying" | "applied" | "failed";
  message?: string;
  state: string;
  sshReady?: boolean;
  sshRevision?: string;
  sshHostFingerprint?: string;
  entryFingerprint?: string;
  observedAt: number;
}
export class WorkspaceControlStore {
  private readonly store: JsonStore<{
    entries: Record<string, WorkspaceControl>;
  }>;
  constructor(
    dataDir: string,
    private readonly statusDir: string,
  ) {
    this.store = new JsonStore(
      path.join(dataDir, "workspace-controls.json"),
      () => ({ entries: {} }),
    );
  }
  async read(id: string) {
    const control = (await this.store.read()).entries[id];
    let observation: WorkspaceObservation | undefined;
    try {
      const status = JSON.parse(
        await readFile(path.join(this.statusDir, "status.json"), "utf8"),
      );
      observation = status.workspaces?.[id];
    } catch {}
    return { control, observation };
  }
  async request(user: User, expectedRevision: string, action: string) {
    if (user.status !== "active" || user.runner !== user.id) {
      throw new Error("승인된 내 workspace만 관리할 수 있습니다.");
    }
    if (!["create", "start", "stop", "restart"].includes(action)) {
      throw new Error("올바른 workspace 작업을 선택해 주세요.");
    }
    return this.store.update((db) => {
      const current = db.entries[user.id];
      if ((current?.revision ?? "") !== expectedRevision) {
        throw new Error(
          "다른 운영 요청이 저장되었습니다. 새로고침 후 다시 시도해 주세요.",
        );
      }
      const next: WorkspaceControl = {
        revision: randomUUID(),
        action: action as WorkspaceControl["action"],
        actorId: user.id,
        requestedAt: Date.now(),
      };
      db.entries[user.id] = next;
      return next;
    });
  }
}
