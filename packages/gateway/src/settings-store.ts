import path from "node:path";
import { JsonStore } from "./json-store.ts";

export interface SiteSettings {
  registrationOpen: boolean;
  registrationMessage: string;
  // Whether apps may be published to anyone with the link.
  publicApps: boolean;
  // Only used to build "open in VS Code" links; not an access boundary.
  vscodeSshHost: string;
  vscodePathFrom: string;
  vscodePathTo: string;
}

const defaults = (): SiteSettings => ({
  registrationOpen: true,
  registrationMessage: "",
  publicApps: true,
  vscodeSshHost: "",
  vscodePathFrom: "",
  vscodePathTo: "",
});

const absolutePath = (value: string) =>
  value === "" ||
  (value.startsWith("/") &&
    value !== "/" &&
    !value.endsWith("/") &&
    value.length <= 512 &&
    !/[\0-\x1f\x7f]/.test(value));

export class SettingsStore {
  private readonly store: JsonStore<Partial<SiteSettings>>;
  constructor(dataDir: string) {
    this.store = new JsonStore(path.join(dataDir, "settings.json"), defaults);
  }
  async read(): Promise<SiteSettings> {
    return { ...defaults(), ...(await this.store.read()) };
  }
  async save(value: Partial<SiteSettings>): Promise<void> {
    if (
      ("registrationOpen" in value &&
        typeof value.registrationOpen !== "boolean") ||
      ("registrationMessage" in value &&
        (typeof value.registrationMessage !== "string" ||
          value.registrationMessage.length > 1000))
    ) {
      throw new Error("가입 안내는 1,000자 이내로 입력해 주세요.");
    }
    if ("publicApps" in value && typeof value.publicApps !== "boolean") {
      throw new Error("공개 링크 허용 여부를 확인해 주세요.");
    }
    if (
      "vscodeSshHost" in value &&
      (typeof value.vscodeSshHost !== "string" ||
        !/^(?:[A-Za-z0-9][A-Za-z0-9._@-]{0,252})?$/.test(value.vscodeSshHost))
    ) {
      throw new Error(
        "SSH 호스트는 영문, 숫자, 점, 밑줄, @, - 로만 입력해 주세요.",
      );
    }
    for (const key of ["vscodePathFrom", "vscodePathTo"] as const) {
      if (
        key in value &&
        (typeof value[key] !== "string" || !absolutePath(value[key]))
      ) {
        throw new Error(
          "경로 변환에는 끝에 /가 없는 절대경로를 입력하거나 비워 두세요.",
        );
      }
    }
    await this.store.update((current) => Object.assign(current, value));
  }
}

// vscode://vscode-remote/ssh-remote+<host><path> opens a folder through the
// Remote - SSH extension. The optional prefix mapping covers editors attached
// to another view of the same files, such as a dev container.
export function vscodeUrl(
  settings: SiteSettings,
  hostPath: string | undefined,
): string | undefined {
  if (!settings.vscodeSshHost || !hostPath) {
    return undefined;
  }
  let remote = hostPath;
  const from = settings.vscodePathFrom;
  if (from && (hostPath === from || hostPath.startsWith(from + "/"))) {
    remote = (settings.vscodePathTo || from) + hostPath.slice(from.length);
  }
  const encoded = remote
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  // The host pattern admits only URL-safe characters.
  return `vscode://vscode-remote/ssh-remote+${settings.vscodeSshHost}${encoded}`;
}
