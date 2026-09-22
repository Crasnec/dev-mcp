import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json-store.ts";
import type { User } from "./user-store.ts";

export interface RunnerLimits {
  network: boolean;
  memoryMiB: number;
  cpus: number;
  pids: number;
  fileSizeMiB: number;
  storageMiB: number;
}
export interface RunnerControl {
  revision: string;
  action: "create" | "start" | "stop" | "restart" | "apply";
  limits?: RunnerLimits;
  requestedAt: number;
  actorId: string;
}
export interface RunnerObservation {
  revision?: string;
  phase?: "applying" | "applied" | "failed";
  message?: string;
  state: string;
  memoryMiB?: number;
  cpus?: number;
  pids?: number;
  network?: boolean;
  fileSizeMiB?: number;
  storageMiB?: number;
  storageUsedMiB?: number;
  observedAt: number;
}

export class RunnerControlStore {
  private readonly store: JsonStore<{ entries: Record<string, RunnerControl> }>;
  constructor(
    dataDir: string,
    private readonly statusDir: string,
  ) {
    this.store = new JsonStore(
      path.join(dataDir, "runner-controls.json"),
      () => ({ entries: {} }),
    );
  }

  async read(id: string) {
    const control = (await this.store.read()).entries[id];
    let observation: RunnerObservation | undefined;
    try {
      const status = JSON.parse(
        await readFile(path.join(this.statusDir, "status.json"), "utf8"),
      );
      observation = status.entries?.[id];
    } catch {
      // Unavailable or malformed status never means an operation succeeded.
    }
    return { control, observation };
  }

  async request(
    owner: User,
    actorId: string,
    expectedRevision: string,
    action: string,
    limits?: RunnerLimits,
  ) {
    if (!["create", "start", "stop", "restart", "apply"].includes(action)) {
      throw new Error("올바른 실행 환경 작업을 선택해 주세요.");
    }
    if (owner.runner !== "primary" && owner.runner !== owner.id) {
      throw new Error("실행 환경 소유자를 확인할 수 없습니다.");
    }
    if (
      action === "create" &&
      (owner.runner === "primary" || owner.status !== "active")
    ) {
      throw new Error("승인된 사용자의 전용 환경만 생성할 수 있습니다.");
    }
    if (["start", "restart"].includes(action) && owner.status !== "active") {
      throw new Error("승인된 계정의 실행 환경만 시작할 수 있습니다.");
    }
    if (action === "apply") {
      if (
        !limits ||
        typeof limits.network !== "boolean" ||
        !integer(limits.memoryMiB, 0, 1048576) ||
        (limits.memoryMiB > 0 && limits.memoryMiB < 64) ||
        !Number.isFinite(limits.cpus) ||
        limits.cpus < 0 ||
        limits.cpus > 1024 ||
        !integer(limits.pids, 0, 1048576) ||
        (limits.pids > 0 && limits.pids < 16) ||
        !integer(limits.fileSizeMiB, 0, 1048576) ||
        !integer(limits.storageMiB, 0, 102400) ||
        (limits.storageMiB > 0 && limits.storageMiB < 64)
      ) {
        throw new Error(
          "제한값을 확인해 주세요. 메모리는 64 MiB 이상, 프로세스 수는 16 이상이며 0은 무제한입니다.",
        );
      }
      if (
        owner.runner === "primary" &&
        (limits.storageMiB > 0 || limits.fileSizeMiB > 0)
      ) {
        throw new Error(
          "기본 환경은 호스트 공유 디렉터리를 사용합니다. 저장공간·파일 크기 제한은 전용 사용자 환경에서 설정해 주세요.",
        );
      }
    }
    return this.store.update((db) => {
      const current = db.entries[owner.id];
      if ((current?.revision ?? "") !== expectedRevision) {
        throw new Error(
          "다른 운영 요청이 저장되었습니다. 새로고침 후 다시 시도해 주세요.",
        );
      }
      const next: RunnerControl = {
        revision: randomUUID(),
        action: action as RunnerControl["action"],
        limits: action === "apply" ? limits : current?.limits,
        requestedAt: Date.now(),
        actorId,
      };
      db.entries[owner.id] = next;
      return next;
    });
  }
}

function integer(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
