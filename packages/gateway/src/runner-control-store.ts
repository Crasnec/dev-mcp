import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { JsonStore } from "./json-store.ts";
import type { User } from "./user-store.ts";
import { workspaceNamePattern } from "./installation-store.ts";

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
  action: "create" | "start" | "stop" | "restart" | "apply" | "workspace";
  limits?: RunnerLimits;
  workspace?: { name: string };
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
  workspaceMode?: "volume" | "quota" | "host";
  workspaceHostPath?: string;
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
    workspace?: { name: string },
  ) {
    if (
      !["create", "start", "stop", "restart", "apply", "workspace"].includes(
        action,
      )
    ) {
      throw new Error("올바른 실행 환경 작업을 선택해 주세요.");
    }
    if (owner.runner !== owner.id) {
      throw new Error("실행 환경 소유자를 확인할 수 없습니다.");
    }
    if (action === "create" && owner.status !== "active") {
      throw new Error("승인된 계정의 실행 환경만 생성할 수 있습니다.");
    }
    if (["start", "restart"].includes(action) && owner.status !== "active") {
      throw new Error("승인된 계정의 실행 환경만 시작할 수 있습니다.");
    }
    const { observation } = await this.read(owner.id);
    if (action === "workspace") {
      if (owner.status !== "active") {
        throw new Error(
          "승인된 계정의 실행 환경만 호스트 디렉터리로 이전할 수 있습니다.",
        );
      }
      if (!workspace || !workspaceNamePattern.test(workspace.name)) {
        throw new Error(
          "디렉터리 이름은 영문 소문자나 숫자로 시작하고 영문 소문자, 숫자, 점, 밑줄, -만 64자까지 쓸 수 있습니다.",
        );
      }
      if (observation?.workspaceMode !== "volume") {
        throw new Error(
          "Docker 볼륨을 쓰는 것으로 확인된 실행 환경만 이전할 수 있습니다.",
        );
      }
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
      if (observation?.workspaceMode === "host" && limits.storageMiB > 0) {
        throw new Error(
          "호스트 디렉터리 작업 공간에는 저장공간 상한을 적용할 수 없습니다.",
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
        ...(action === "workspace"
          ? { workspace: { name: workspace!.name } }
          : {}),
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
