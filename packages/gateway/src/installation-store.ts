import path from "node:path";
import { readFile } from "node:fs/promises";
import { JsonStore } from "./json-store.ts";

// Installation-level state chosen by the local installer during onboarding.
// The provisioner reads this file through its read-only gateway-data mount.
export interface Installation {
  workspaceRoot?: string;
  onboardingCompletedAt?: number;
  onboardingCompletedBy?: string;
}
export interface WorkspaceRootStatus {
  path: string;
  state: "ready" | "invalid";
  message?: string;
  observedAt: number;
}
export interface InstallationObservation {
  workspaceRoot?: WorkspaceRootStatus;
  primaryWorkspace?: string;
  observedAt?: number;
}

// Host paths become comma-separated Docker --mount values.
export function validateWorkspaceRoot(input: string): string {
  const value = input.trim();
  if (!value.startsWith("/") || value === "/") {
    throw new Error(
      "Docker 호스트 기준 절대경로를 입력해 주세요. 루트(/)는 사용할 수 없습니다.",
    );
  }
  if (value.length > 512 || /[,\0-\x1f\x7f]/.test(value)) {
    throw new Error(
      "경로는 512자 이내이며 쉼표나 제어 문자를 포함할 수 없습니다.",
    );
  }
  if (value.endsWith("/") || path.posix.normalize(value) !== value) {
    throw new Error(
      "정규화된 경로를 입력해 주세요. 끝의 /, 연속된 /, . 또는 .. 구간은 사용할 수 없습니다.",
    );
  }
  return value;
}

export const workspaceNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Mirrors workspaceNames() in scripts/runner-operations.mjs; the provisioner
// makes the final, collision-free choice.
export function suggestWorkspaceName(
  email: string | undefined,
  id: string,
): string {
  const local = String(email ?? "")
    .split("@")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32)
    .replace(/[-._]+$/, "");
  return local || "user-" + id.slice(0, 8);
}

export function insideOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}

export class InstallationStore {
  private readonly store: JsonStore<Installation>;
  constructor(
    dataDir: string,
    private readonly statusDir: string,
  ) {
    this.store = new JsonStore(
      path.join(dataDir, "installation.json"),
      () => ({}),
    );
  }

  read(): Promise<Installation> {
    return this.store.read();
  }

  async observed(): Promise<InstallationObservation> {
    try {
      const status = JSON.parse(
        await readFile(path.join(this.statusDir, "status.json"), "utf8"),
      );
      return status.installation ?? {};
    } catch {
      // Unavailable status never means the root was verified.
      return {};
    }
  }

  // The provisioner's latest verdict for the currently configured root only.
  async rootStatus(
    installation?: Installation,
  ): Promise<WorkspaceRootStatus | undefined> {
    const root = (installation ?? (await this.read())).workspaceRoot;
    const status = (await this.observed()).workspaceRoot;
    return root && status?.path === root ? status : undefined;
  }

  // A quick lexical check for immediate feedback; the provisioner makes the
  // authoritative comparison of kernel-resolved mount locations.
  async setWorkspaceRoot(value: string | undefined): Promise<Installation> {
    const root = value === undefined ? undefined : validateWorkspaceRoot(value);
    const primary = (await this.observed()).primaryWorkspace;
    if (root && primary && insideOrEqual(root, primary)) {
      throw new Error(
        `기본 실행 환경의 작업 공간(${primary}) 안이나 같은 경로는 쓸 수 없습니다. 기본 실행 환경이 다른 계정의 파일에 접근하지 않도록 바깥 경로를 지정해 주세요.`,
      );
    }
    return this.store.update((current) => {
      if (current.onboardingCompletedAt) {
        throw new Error(
          "온보딩을 마친 뒤에는 작업 공간 루트를 바꿀 수 없습니다.",
        );
      }
      if (root === undefined) {
        delete current.workspaceRoot;
      } else {
        current.workspaceRoot = root;
      }
      return { ...current };
    });
  }

  complete(actor: string): Promise<Installation> {
    return this.store.update((current) => {
      if (current.onboardingCompletedAt) {
        throw new Error("온보딩이 이미 완료되었습니다.");
      }
      current.onboardingCompletedAt = Date.now();
      current.onboardingCompletedBy = actor;
      return { ...current };
    });
  }
}
