import path from "node:path";
import { JsonStore } from "./json-store.ts";

export interface SiteSettings {
  registrationOpen: boolean;
  registrationMessage: string;
}

export class SettingsStore {
  private readonly store: JsonStore<SiteSettings>;
  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "settings.json"), () => ({
      registrationOpen: true,
      registrationMessage: "",
    }));
  }
  read(): Promise<SiteSettings> {
    return this.store.read();
  }
  async save(value: SiteSettings): Promise<void> {
    if (
      typeof value.registrationOpen !== "boolean" ||
      typeof value.registrationMessage !== "string" ||
      value.registrationMessage.length > 1000
    ) {
      throw new Error("가입 안내는 1,000자 이내로 입력해 주세요.");
    }
    await this.store.update((current) => Object.assign(current, value));
  }
}
