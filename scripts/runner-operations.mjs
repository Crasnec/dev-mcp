import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

const MiB = 1048576;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class OperationError extends Error {}
export const validUser = (user) =>
  user &&
  uuid.test(user.id) &&
  (user.runner === user.id || user.runner === "primary");
// Host paths become comma-separated --mount values; keep them unambiguous.
export const validWorkspaceRoot = (root) =>
  typeof root === "string" &&
  root.length <= 512 &&
  root.startsWith("/") &&
  root !== "/" &&
  !root.endsWith("/") &&
  path.posix.normalize(root) === root &&
  !/[,\0-\x1f\x7f]/.test(root);
export const validWorkspaceName = (name) =>
  typeof name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);

// Candidate directory names from the account's email, then numbered variants.
export function workspaceNames(user) {
  const local = String(user.email ?? "")
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32)
    .replace(/[-._]+$/, "");
  const base = local || "user-" + user.id.slice(0, 8);
  return [base, ...Array.from({ length: 19 }, (_, i) => `${base}-${i + 2}`)];
}

// Runs inside the runner image as its unprivileged user (DEV_UID), so created
// directories get the same owner as files written by the runner.
const directoryScript = String.raw`
const fs = require("node:fs");
const [operation, name = ""] = process.argv.slice(1);
const root = "/workspace-root";
const target = root + "/" + name;
// Compare kernel-resolved mount locations, so symlinks or bind aliases in host
// paths cannot hide a root inside the primary runner's workspace.
const unescape = (value) =>
  value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
const mounts = fs
  .readFileSync("/proc/self/mountinfo", "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const fields = line.split(" ");
    return { device: fields[2], root: unescape(fields[3]), point: unescape(fields[4]) };
  });
const mountAt = (point) => mounts.filter((mount) => mount.point === point).at(-1);
const insidePrimary = () => {
  const own = mountAt(root);
  const primary = mountAt("/primary-workspace");
  return (
    !!own &&
    !!primary &&
    own.device === primary.device &&
    (primary.root === "/" ||
      own.root === primary.root ||
      own.root.startsWith(primary.root + "/"))
  );
};
if (!fs.statSync(root).isDirectory()) {
  console.log("not_directory");
} else if (insidePrimary()) {
  console.log("inside_primary");
} else if (operation === "probe") {
  try {
    fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK);
    console.log("ok");
  } catch {
    console.log("not_writable");
  }
} else if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
  throw new Error("Invalid workspace directory name");
} else if (operation === "mkdir") {
  try {
    fs.mkdirSync(target, { mode: 0o755 });
    console.log("created");
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    console.log("exists");
  }
} else if (operation === "verify") {
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  console.log(info?.isDirectory() && info.uid === process.getuid() ? "ok" : "invalid");
} else if (operation === "remove") {
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (info?.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log("removed");
} else {
  throw new Error("Invalid operation");
}
`;
const workspaceMount = (info) =>
  info?.Mounts?.find((mount) => mount.Destination === "/workspace");
const rootMessages = {
  ok: "작업 공간 루트를 사용할 수 있습니다.",
  not_directory: "지정한 경로가 디렉터리가 아닙니다.",
  not_writable:
    "실행 환경 사용자가 이 디렉터리에 쓸 수 없습니다. 호스트에서 소유자와 권한을 확인해 주세요.",
  inside_primary:
    "기본 실행 환경의 작업 공간 안이거나 같은 위치라서 쓸 수 없습니다. 기본 실행 환경이 다른 계정의 파일에 접근하지 않도록 바깥 경로를 지정해 주세요.",
  unavailable:
    "Docker 호스트에서 이 디렉터리를 찾거나 마운트하지 못했습니다. 호스트 기준 경로가 존재하는지 확인해 주세요.",
};

export function validControl(control) {
  if (
    !control ||
    !uuid.test(control.revision) ||
    !["create", "start", "stop", "restart", "apply", "workspace"].includes(
      control.action,
    ) ||
    (control.action === "workspace" &&
      !validWorkspaceName(control.workspace?.name))
  ) {
    return false;
  }
  const limits = control.limits;
  if (limits === undefined) {
    return control.action !== "apply";
  }
  const integer = (value, min, max) =>
    Number.isSafeInteger(value) && value >= min && value <= max;
  return (
    typeof limits.network === "boolean" &&
    integer(limits.memoryMiB, 0, 1048576) &&
    (limits.memoryMiB === 0 || limits.memoryMiB >= 64) &&
    Number.isFinite(limits.cpus) &&
    limits.cpus >= 0 &&
    limits.cpus <= 1024 &&
    integer(limits.pids, 0, 1048576) &&
    (limits.pids === 0 || limits.pids >= 16) &&
    integer(limits.fileSizeMiB, 0, 1048576) &&
    integer(limits.storageMiB, 0, 102400) &&
    (limits.storageMiB === 0 || limits.storageMiB >= 64)
  );
}

export async function readJson(filename, initial) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return initial;
    }
    throw error;
  }
}

export async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  await writeFile(filename + ".tmp", JSON.stringify(value), { mode: 0o644 });
  await rename(filename + ".tmp", filename);
}

export class RunnerOperations {
  constructor(docker, provision, statusDir, project, installationFile) {
    this.docker = docker;
    this.provision = provision;
    this.statusDir = statusDir;
    this.project = project;
    this.installationFile = installationFile;
    this.pool = project + "-quota-pool";
    this.images = project + "-quota-images";
  }

  async inspect(name) {
    const ids = await this.docker(
      "ps",
      "-a",
      "--filter",
      "name=^/" + name + "$",
      "--format",
      "{{.ID}}",
    );
    if (!ids) {
      return undefined;
    }
    return JSON.parse(await this.docker("inspect", name))[0];
  }

  async owned(user, primaryId) {
    const name =
      user.runner === "primary" ? primaryId : "dev-mcp-user-" + user.id;
    const info =
      user.runner === "primary"
        ? JSON.parse(await this.docker("inspect", primaryId))[0]
        : await this.inspect(name);
    if (info) {
      const labels = info.Config.Labels ?? {};
      const valid =
        user.runner === "primary"
          ? labels["com.docker.compose.project"] === this.project &&
            labels["com.docker.compose.service"] === "runner"
          : labels["dev-mcp.user"] === user.id;
      if (!valid) {
        throw new Error("컨테이너 소유권을 확인할 수 없습니다.");
      }
    }
    return { name, info };
  }

  async helperImage() {
    if (!this.image) {
      this.image = JSON.parse(
        await this.docker("inspect", process.env.HOSTNAME),
      )[0].Image;
    }
    return this.image;
  }

  async storage() {
    if (this.storageReady) {
      return;
    }
    await this.docker("volume", "create", this.images);
    const image = await this.helperImage();
    const device = await this.docker(
      "run",
      "--rm",
      "--privileged",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${this.images},target=/images`,
      "--mount",
      "type=bind,source=/dev,target=/dev",
      "--entrypoint",
      "sh",
      image,
      "/opt/dev-mcp/scripts/quota-storage.sh",
      "prepare",
    );
    if (!/^\/dev\/loop\d+$/.test(device)) {
      throw new Error("저장소 장치를 준비하지 못했습니다.");
    }
    const volumes = await this.docker("volume", "ls", "--format", "{{.Name}}");
    if (volumes.split("\n").includes(this.pool)) {
      const volume = JSON.parse(
        await this.docker("volume", "inspect", this.pool),
      )[0];
      if (
        volume.Options?.device !== device ||
        volume.Options?.type !== "xfs" ||
        volume.Options?.o !== "prjquota"
      ) {
        throw new Error("기존 quota 저장소 설정이 일치하지 않습니다.");
      }
    } else {
      await this.docker(
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=xfs",
        "--opt",
        "device=" + device,
        "--opt",
        "o=prjquota",
        this.pool,
      );
    }
    this.storageReady = true;
  }

  async projectId(user) {
    const file = path.join(this.statusDir, "quota-projects.json");
    const data = await readJson(file, { next: 1000, users: {} });
    if (!data.users[user.id]) {
      data.users[user.id] = data.next++;
      await writeJson(file, data);
    }
    return data.users[user.id];
  }

  async migrated(user, mark = false) {
    const file = path.join(this.statusDir, "quota-projects.json");
    const data = await readJson(file, { next: 1000, users: {} });
    if (mark) {
      data.migrated ??= {};
      data.migrated[user.id] = true;
      await writeJson(file, data);
    }
    return data.migrated?.[user.id] === true;
  }

  async workspaceRoot() {
    if (!this.installationFile) {
      return undefined;
    }
    const data = await readJson(this.installationFile, {});
    return validWorkspaceRoot(data?.workspaceRoot)
      ? data.workspaceRoot
      : undefined;
  }

  runnerImage(primaryId) {
    return this.docker("inspect", "--format", "{{.Image}}", primaryId);
  }

  async helper(primaryId, mounts, entrypoint, ...args) {
    return this.docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      ...mounts.flatMap((mount) => ["--mount", mount]),
      "--entrypoint",
      entrypoint,
      await this.runnerImage(primaryId),
      ...args,
    );
  }

  // The primary runner's workspace is mounted read-only only so the helper can
  // compare mount locations; the script never reads its files.
  async directory(primaryId, root, operation, name = "") {
    const primary = await this.primaryWorkspace(primaryId);
    if (primary !== undefined && !validWorkspaceRoot(primary)) {
      throw new OperationError(
        "기본 실행 환경의 작업 공간 경로를 확인할 수 없어 작업 공간 루트를 쓸 수 없습니다.",
      );
    }
    return this.helper(
      primaryId,
      [
        `type=bind,source=${root},target=/workspace-root`,
        ...(primary
          ? [`type=bind,source=${primary},target=/primary-workspace,readonly`]
          : []),
      ],
      "node",
      "-e",
      directoryScript,
      operation,
      name,
    );
  }

  // Probing starts a helper container, so keep a usable result for minutes and
  // retry a failing one quickly.
  async probeRoot(primaryId) {
    const root = await this.workspaceRoot();
    if (!root) {
      this.rootStatus = undefined;
      return undefined;
    }
    const cached = this.rootStatus;
    const key = root + "\n" + primaryId;
    if (
      this.rootStatusKey === key &&
      Date.now() - cached.observedAt <
        (cached.state === "ready" ? 300_000 : 15_000)
    ) {
      return cached;
    }
    let result, message;
    try {
      result = await this.directory(primaryId, root, "probe");
    } catch (error) {
      result = "unavailable";
      message = error instanceof OperationError ? error.message : undefined;
    }
    this.rootStatusKey = key;
    this.rootStatus = {
      path: root,
      state: result === "ok" ? "ready" : "invalid",
      message: message ?? rootMessages[result] ?? rootMessages.unavailable,
      observedAt: Date.now(),
    };
    return this.rootStatus;
  }

  async primaryWorkspace(primaryId) {
    const info = JSON.parse(await this.docker("inspect", primaryId))[0];
    const mount = workspaceMount(info);
    return mount?.Type === "bind" ? mount.Source : undefined;
  }

  workspaceFile() {
    return path.join(this.statusDir, "workspace-dirs.json");
  }

  async workspaceEntry(user) {
    const data = await readJson(this.workspaceFile(), { users: {} });
    const entry = data.users?.[user.id];
    return validWorkspaceRoot(entry?.root) && validWorkspaceName(entry?.name)
      ? { ...entry, path: entry.root + "/" + entry.name }
      : undefined;
  }

  async recordWorkspace(user, entry) {
    const data = await readJson(this.workspaceFile(), { users: {} });
    data.users ??= {};
    data.users[user.id] = { root: entry.root, name: entry.name };
    await writeJson(this.workspaceFile(), data);
  }

  // Exclusive creation never hands an existing host directory, such as an
  // administrator's project, to another account.
  async assignWorkspace(user, primaryId, requested) {
    const status = await this.probeRoot(primaryId);
    if (status?.state !== "ready") {
      throw new OperationError(
        "작업 공간 루트를 사용할 수 없습니다. 설치 온보딩에서 정한 경로의 상태를 확인해 주세요.",
      );
    }
    const data = await readJson(this.workspaceFile(), { users: {} });
    const taken = new Set(
      Object.entries(data.users ?? {})
        .filter(([id, entry]) => id !== user.id && entry.root === status.path)
        .map(([, entry]) => entry.name),
    );
    for (const name of requested ? [requested] : workspaceNames(user)) {
      if (
        !taken.has(name) &&
        (await this.directory(primaryId, status.path, "mkdir", name)) ===
          "created"
      ) {
        return { root: status.path, name, path: status.path + "/" + name };
      }
    }
    throw new OperationError(
      requested
        ? "이미 있는 디렉터리이거나 다른 사용자가 쓰는 이름입니다. 다른 이름을 입력해 주세요."
        : "비어 있는 작업 공간 디렉터리 이름을 찾지 못했습니다.",
    );
  }

  // Docker resolves symlinks in bind sources, so check before every mount.
  async verifyWorkspace(primaryId, entry) {
    const result = await this.directory(
      primaryId,
      entry.root,
      "verify",
      entry.name,
    );
    if (result === "inside_primary") {
      throw new OperationError(
        "작업 공간 디렉터리가 기본 실행 환경의 작업 공간 안에 있어 사용할 수 없습니다.",
      );
    }
    if (result !== "ok") {
      throw new OperationError(
        "작업 공간 디렉터리가 실제 디렉터리가 아니거나 소유자가 다릅니다. 호스트에서 확인해 주세요.",
      );
    }
  }

  async volumeExists(name) {
    const names = await this.docker(
      "volume",
      "ls",
      "--quiet",
      "--filter",
      "name=" + name,
    );
    return names.split("\n").includes(name);
  }

  async hostWorkspace(user, info) {
    const mount = workspaceMount(info);
    if (user.runner === "primary" || mount?.Type !== "bind") {
      return undefined;
    }
    const entry = await this.workspaceEntry(user);
    if (entry?.path !== mount.Source) {
      throw new Error(
        "작업 공간 디렉터리 기록이 컨테이너와 일치하지 않습니다.",
      );
    }
    return entry;
  }

  async create(user, limits, primaryId) {
    const quotaStorage = await this.migrated(user);
    if (quotaStorage) {
      await this.storage();
    }
    let workspace = quotaStorage ? undefined : await this.workspaceEntry(user);
    // A remaining volume means earlier data; keep using it until an
    // administrator moves it explicitly.
    if (
      !quotaStorage &&
      !workspace &&
      (await this.workspaceRoot()) &&
      !(await this.volumeExists(`dev-mcp-user-${user.id}-workspace`))
    ) {
      workspace = await this.assignWorkspace(user, primaryId);
      await this.recordWorkspace(user, workspace);
    }
    if (workspace) {
      await this.verifyWorkspace(primaryId, workspace);
      if (limits) {
        limits = { ...limits, storageMiB: 0 };
      }
    }
    await this.provision(user, limits, quotaStorage, false, workspace?.path);
    if (limits) {
      await this.apply(user, { action: "apply", limits }, primaryId);
    }
    await this.docker("start", "dev-mcp-user-" + user.id);
  }

  async moveWorkspace(user, request, primaryId, name, info) {
    if (user.runner === "primary") {
      throw new OperationError(
        "기본 환경은 Compose 설정의 호스트 디렉터리를 그대로 사용합니다.",
      );
    }
    const mount = workspaceMount(info);
    if (mount?.Type === "bind") {
      throw new OperationError("이미 호스트 디렉터리를 사용하고 있습니다.");
    }
    if (
      info.Config.Labels?.["dev-mcp.storage"] === "quota" ||
      (await this.migrated(user))
    ) {
      throw new OperationError(
        "저장공간 상한 저장소를 쓰는 환경은 아직 호스트 디렉터리로 이전할 수 없습니다.",
      );
    }
    const volume = `dev-mcp-user-${user.id}-workspace`;
    if (mount?.Type !== "volume" || mount.Name !== volume) {
      throw new OperationError(
        "전용 작업 공간 볼륨만 호스트 디렉터리로 이전할 수 있습니다.",
      );
    }
    const previousName = name + "-previous";
    if (await this.inspect(previousName)) {
      throw new Error(
        "이전 재생성 작업의 컨테이너가 남아 있습니다. 복구 후 다시 요청해 주세요.",
      );
    }
    const limits = { ...this.limits(info), storageMiB: 0 };
    const wasRunning = info.State.Running;
    const workspace = await this.assignWorkspace(
      user,
      primaryId,
      request.workspace.name,
    );
    let renamed = false;
    try {
      if (wasRunning) {
        await this.docker("stop", "--time", "10", name);
      }
      await this.helper(
        primaryId,
        [
          `type=volume,source=${volume},target=/source,readonly`,
          `type=bind,source=${workspace.path},target=/target`,
        ],
        "cp",
        "-a",
        "/source/.",
        "/target/",
      );
      await this.verifyWorkspace(primaryId, workspace);
      // Retain the old container until the replacement has been created.
      // The original named volume always remains.
      await this.docker("rename", name, previousName);
      renamed = true;
      await this.provision(user, limits, false, false, workspace.path);
    } catch (error) {
      if (renamed) {
        const replacement = await this.owned(user, primaryId);
        if (replacement.info) {
          await this.docker("rm", "--force", name);
        }
        await this.docker("rename", previousName, name);
      }
      await this.directory(
        primaryId,
        workspace.root,
        "remove",
        workspace.name,
      ).catch(() => undefined);
      if (wasRunning) {
        await this.docker("start", name).catch(() => undefined);
      }
      throw error;
    }
    await this.recordWorkspace(user, workspace);
    if (wasRunning) {
      await this.docker("start", name);
    }
    await this.docker("rm", previousName);
  }

  async quota(user, limit, operation, info) {
    await this.storage();
    const args = [
      "run",
      "--rm",
      "--privileged",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${this.pool},target=/pool`,
    ];
    if (operation === "migrate") {
      for (const [destination, target, suffix] of [
        ["/workspace", "/source-workspace", "workspace"],
        ["/var/lib/dev-mcp", "/source-data", "data"],
      ]) {
        const mount = info.Mounts.find(
          (mount) => mount.Destination === destination,
        );
        if (
          mount?.Type !== "volume" ||
          mount.Name !== `dev-mcp-user-${user.id}-${suffix}`
        ) {
          throw new Error("전용 볼륨만 quota 저장소로 이전할 수 있습니다.");
        }
        args.push(
          "--mount",
          `type=volume,source=${mount.Name},target=${target},readonly`,
        );
      }
    }
    args.push(
      "--entrypoint",
      "sh",
      await this.helperImage(),
      "/opt/dev-mcp/scripts/quota-storage.sh",
      operation,
      user.id,
      String(limit),
      String(await this.projectId(user)),
    );
    return this.docker(...args);
  }

  limits(info) {
    const host = info.HostConfig;
    const fsize =
      host.Ulimits?.find((entry) => entry.Name === "fsize")?.Hard ?? 0;
    return {
      memoryMiB: Math.max(0, host.Memory ?? 0) / MiB,
      cpus: (host.NanoCpus ?? 0) / 1e9,
      pids: Math.max(0, host.PidsLimit ?? 0),
      fileSizeMiB: Math.max(0, fsize) / MiB,
      network: Object.keys(info.NetworkSettings.Networks).some(
        (name) => name !== "none",
      ),
    };
  }

  async observe(user, primaryId) {
    const { info } = await this.owned(user, primaryId);
    if (!info) {
      return { state: "missing", observedAt: Date.now() };
    }
    const mount = workspaceMount(info);
    const state = {
      state: info.State.Status,
      ...this.limits(info),
      workspaceMode:
        info.Config.Labels?.["dev-mcp.storage"] === "quota"
          ? "quota"
          : mount?.Type === "bind"
            ? "host"
            : mount?.Type === "volume"
              ? "volume"
              : undefined,
      workspaceHostPath: mount?.Type === "bind" ? mount.Source : undefined,
      observedAt: Date.now(),
    };
    if (info.Config.Labels?.["dev-mcp.storage"] === "quota") {
      const output = await this.quota(user, 0, "usage");
      const [used, hard] = output.split(/\s+/).map(Number);
      if (!Number.isFinite(used) || !Number.isFinite(hard)) {
        throw new Error("저장공간 quota 상태를 확인하지 못했습니다.");
      }
      state.storageUsedMiB = Math.ceil(used / 1024);
      state.storageMiB = hard / 1024;
    }
    return state;
  }

  async apply(user, request, primaryId) {
    let { name, info } = await this.owned(user, primaryId);
    const action = request.action;
    if (
      user.status !== "active" &&
      ["create", "start", "restart"].includes(action)
    ) {
      throw new Error("승인된 계정의 실행 환경만 시작할 수 있습니다.");
    }
    if (action === "create") {
      if (user.runner === "primary") {
        throw new Error("기본 환경은 Compose에서 생성해야 합니다.");
      }
      if (!info) {
        await this.create(user, request.limits, primaryId);
      }
      return;
    }
    if (!info) {
      throw new Error("컨테이너가 없습니다. 먼저 실행 환경을 생성해 주세요.");
    }
    if (action === "stop") {
      await this.docker("stop", "--time", "10", name);
      return;
    }
    if (action === "workspace") {
      await this.moveWorkspace(user, request, primaryId, name, info);
      return;
    }
    const workspace = await this.hostWorkspace(user, info);
    if (action === "start" || action === "restart") {
      if (info.Config.Labels?.["dev-mcp.storage"] === "quota") {
        await this.storage();
      }
      if (workspace) {
        await this.verifyWorkspace(primaryId, workspace);
      }
      await this.docker(action, name);
      return;
    }
    const limits = request.limits;
    if (
      user.runner === "primary" &&
      (limits.storageMiB || limits.fileSizeMiB)
    ) {
      throw new Error(
        "기본 환경의 호스트 공유 저장소는 자동 이전할 수 없습니다.",
      );
    }
    if (workspace && limits.storageMiB) {
      throw new OperationError(
        "호스트 디렉터리 작업 공간에는 저장공간 상한을 적용할 수 없습니다. 0으로 두고 다시 적용해 주세요.",
      );
    }
    const current = this.limits(info);
    const quotaStorage = info.Config.Labels?.["dev-mcp.storage"] === "quota";
    const quotaState = quotaStorage
      ? (await this.quota(user, 0, "usage")).split(/\s+/).map(Number)
      : undefined;
    if (
      quotaState &&
      (quotaState.length !== 2 ||
        quotaState.some((value) => !Number.isFinite(value)))
    ) {
      throw new Error("현재 저장공간 제한을 확인하지 못했습니다.");
    }
    const migrate = limits.storageMiB > 0 && !quotaStorage;
    const storageChange =
      migrate || (quotaStorage && quotaState[1] / 1024 !== limits.storageMiB);
    const resetResources =
      (current.memoryMiB > 0 && limits.memoryMiB === 0) ||
      (current.cpus > 0 && limits.cpus === 0);
    if (user.runner === "primary" && resetResources) {
      throw new OperationError(
        "기본 환경의 메모리·CPU 제한 해제는 Compose에서 컨테이너를 재생성해야 합니다. 기존 제한은 유지됩니다.",
      );
    }
    const recreate =
      migrate || current.fileSizeMiB !== limits.fileSizeMiB || resetResources;
    const wasRunning = info.State.Running;
    const previousName = name + "-previous";
    if (recreate && (await this.inspect(previousName))) {
      throw new Error(
        "이전 재생성 작업의 컨테이너가 남아 있습니다. 복구 후 다시 요청해 주세요.",
      );
    }
    if (recreate && workspace) {
      await this.verifyWorkspace(primaryId, workspace);
    }
    if (recreate || storageChange) {
      if (wasRunning) {
        await this.docker("stop", "--time", "10", name);
      }
      if (storageChange) {
        await this.quota(
          user,
          limits.storageMiB,
          migrate ? "migrate" : "limit",
          info,
        );
      }
      if (recreate) {
        if (migrate) {
          await this.migrated(user, true);
        }
        // Retain the old container until the replacement has been created.
        // Original named volumes always remain; never pass --volumes.
        await this.docker("rename", name, previousName);
        try {
          await this.provision(
            user,
            limits,
            migrate || quotaStorage,
            false,
            workspace?.path,
          );
          if (wasRunning) {
            await this.docker("start", name);
          }
        } catch (error) {
          const replacement = await this.owned(user, primaryId);
          if (replacement.info) {
            await this.docker("rm", "--force", name);
          }
          await this.docker("rename", previousName, name);
          throw error;
        }
        await this.docker("rm", previousName);
      }
    }
    if (!recreate) {
      await this.docker(
        "update",
        "--memory",
        String(limits.memoryMiB * MiB),
        "--memory-swap",
        limits.memoryMiB ? String(limits.memoryMiB * MiB) : "-1",
        "--cpus",
        String(limits.cpus),
        "--pids-limit",
        String(limits.pids || -1),
        name,
      );
    }
    info = (await this.owned(user, primaryId)).info;
    const network =
      user.runner === "primary" ? this.project + "_runner-egress" : name;
    for (const attached of Object.keys(info.NetworkSettings.Networks)) {
      if (!limits.network || attached !== network) {
        await this.docker("network", "disconnect", attached, name);
      }
    }
    if (limits.network && !info.NetworkSettings.Networks[network]) {
      await this.docker("network", "connect", network, name);
    }
    if (wasRunning && !recreate && storageChange) {
      await this.docker("start", name);
    }
  }
}
