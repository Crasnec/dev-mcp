import { randomUUID } from "node:crypto";
import path from "node:path";
import { JsonStore } from "./json-store.ts";
import type { User } from "./user-store.ts";
import {
  MAX_SSH_KEYS,
  parseSshPublicKey,
  validSshAccess,
  type SshAccess,
} from "../../../scripts/ssh-access.mjs";

export class SshAccessStore {
  private readonly store: JsonStore<{ entries: Record<string, SshAccess> }>;
  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "ssh-access.json"), () => ({
      entries: {},
    }));
  }

  async get(id: string): Promise<SshAccess | undefined> {
    const entry = (await this.store.read()).entries[id];
    return validSshAccess(entry) ? entry : undefined;
  }

  async add(user: User, name: string, publicKey: string) {
    if (user.status !== "active" || user.runner !== user.id) {
      throw new Error(
        "승인된 내 실행 환경에만 SSH 공개키를 등록할 수 있습니다.",
      );
    }
    name = name.trim();
    if (!name || name.length > 80 || /[\0-\x1f\x7f]/.test(name)) {
      throw new Error("공개키 이름은 80자 이내로 입력해 주세요.");
    }
    const parsed = parseSshPublicKey(publicKey);
    const result = await this.store.update((db) => {
      let entry = db.entries[user.id];
      if (entry && !validSshAccess(entry)) {
        throw new Error("SSH 연결 설정을 확인할 수 없습니다.");
      }
      if (!entry) {
        entry = {
          revision: randomUUID(),
          authVersion: user.authVersion,
          keys: [],
        };
        db.entries[user.id] = entry;
      }
      if (entry.authVersion !== user.authVersion) {
        entry.authVersion = user.authVersion;
        entry.keys = [];
      }
      if (entry.keys.length >= MAX_SSH_KEYS) {
        throw new Error(
          `SSH 공개키는 최대 ${MAX_SSH_KEYS}개까지 등록할 수 있습니다.`,
        );
      }
      if (entry.keys.some((key) => key.fingerprint === parsed.fingerprint)) {
        throw new Error("이미 등록된 공개키입니다.");
      }
      const key = { id: randomUUID(), name, ...parsed, createdAt: Date.now() };
      entry.keys.push(key);
      entry.revision = randomUUID();
      return key;
    });
    return result;
  }

  async remove(user: User, keyId: string) {
    await this.store.update((db) => {
      const entry = db.entries[user.id];
      if (
        !validSshAccess(entry) ||
        entry.authVersion !== user.authVersion ||
        !entry.keys.some((key) => key.id === keyId)
      ) {
        throw new Error("내 계정에 등록된 공개키를 선택해 주세요.");
      }
      entry.keys = entry.keys.filter((key) => key.id !== keyId);
      entry.revision = randomUUID();
    });
  }
}
