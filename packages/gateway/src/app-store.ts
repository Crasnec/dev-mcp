import path from "node:path";
import { JsonStore } from "./json-store.ts";

export type AppVisibility = "private" | "public";
export type NetworkIntent = "none" | "read" | "write";

// An app is a server command run in its owner's runner and published at
// https://<slug>.<PREVIEW_DOMAIN>.
export interface AppRecord {
  slug: string;
  ownerId: string;
  projectId: string;
  command: string;
  cwd?: string;
  port: number;
  visibility: AppVisibility;
  networkIntent: NetworkIntent;
  processId?: string;
  createdAt: number;
  updatedAt: number;
}
export type AppInput = Pick<
  AppRecord,
  | "slug"
  | "projectId"
  | "command"
  | "cwd"
  | "port"
  | "visibility"
  | "networkIntent"
>;

export const appNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const MAX_APPS_PER_ACCOUNT = 10;
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "dev-mcp",
  "login",
  "mail",
  "mcp",
  "preview",
  "static",
  "www",
]);

export function validateApp(input: AppInput): AppInput {
  const slug = String(input.slug ?? "").trim();
  if (!appNamePattern.test(slug) || RESERVED.has(slug)) {
    throw new Error(
      "앱 이름은 영문 소문자, 숫자, -로 40자 이내이며 -로 시작하거나 끝날 수 없습니다. 예약된 이름은 쓸 수 없습니다.",
    );
  }
  const command = String(input.command ?? "").trim();
  if (!command || command.length > 2000 || command.includes("\0")) {
    throw new Error("실행 명령을 2,000자 이내로 입력해 주세요.");
  }
  const projectId = String(input.projectId ?? "");
  if (!projectId || projectId.length > 200) {
    throw new Error("프로젝트를 선택해 주세요.");
  }
  const cwd = input.cwd?.trim() || undefined;
  if (cwd && (cwd.length > 1000 || cwd.includes("\0"))) {
    throw new Error("작업 디렉터리 경로가 너무 깁니다.");
  }
  if (
    !Number.isSafeInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535
  ) {
    throw new Error("포트는 1024부터 65535 사이로 입력해 주세요.");
  }
  if (!["private", "public"].includes(input.visibility)) {
    throw new Error("공개 범위를 선택해 주세요.");
  }
  if (!["none", "read", "write"].includes(input.networkIntent)) {
    throw new Error("네트워크 사용 여부를 선택해 주세요.");
  }
  return {
    slug,
    projectId,
    command,
    ...(cwd ? { cwd } : {}),
    port: input.port,
    visibility: input.visibility,
    networkIntent: input.networkIntent,
  };
}

export class AppStore {
  private readonly store: JsonStore<{ apps: Record<string, AppRecord> }>;
  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "apps.json"), () => ({
      apps: {},
    }));
  }

  async list(): Promise<AppRecord[]> {
    return Object.values((await this.store.read()).apps).sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
  }

  async get(slug: string): Promise<AppRecord | undefined> {
    return appNamePattern.test(slug)
      ? (await this.store.read()).apps[slug]
      : undefined;
  }

  // Creates the app or updates the caller's own app of the same name.
  async save(ownerId: string, input: AppInput): Promise<AppRecord> {
    const app = validateApp(input);
    return this.store.update((db) => {
      const current = db.apps[app.slug];
      if (current && current.ownerId !== ownerId) {
        throw new Error("이미 다른 계정이 쓰는 앱 이름입니다.");
      }
      if (
        !current &&
        Object.values(db.apps).filter((entry) => entry.ownerId === ownerId)
          .length >= MAX_APPS_PER_ACCOUNT
      ) {
        throw new Error(
          `계정마다 앱은 ${MAX_APPS_PER_ACCOUNT}개까지 만들 수 있습니다.`,
        );
      }
      const now = Date.now();
      const next: AppRecord = {
        ...app,
        ownerId,
        ...(current?.processId ? { processId: current.processId } : {}),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      db.apps[app.slug] = next;
      return next;
    });
  }

  update(
    slug: string,
    ownerId: string,
    changes: Partial<Pick<AppRecord, "processId" | "visibility">>,
  ): Promise<AppRecord> {
    return this.store.update((db) => {
      const current = db.apps[slug];
      if (!current || current.ownerId !== ownerId) {
        throw new Error("앱을 찾을 수 없습니다.");
      }
      if (
        changes.visibility !== undefined &&
        !["private", "public"].includes(changes.visibility)
      ) {
        throw new Error("공개 범위를 선택해 주세요.");
      }
      const next: AppRecord = { ...current, ...changes, updatedAt: Date.now() };
      if ("processId" in changes && !changes.processId) {
        delete next.processId;
      }
      db.apps[slug] = next;
      return next;
    });
  }

  remove(slug: string, ownerId: string): Promise<void> {
    return this.store.update((db) => {
      if (db.apps[slug]?.ownerId !== ownerId) {
        throw new Error("앱을 찾을 수 없습니다.");
      }
      delete db.apps[slug];
    });
  }
}
