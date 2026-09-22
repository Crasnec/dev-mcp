import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

const MiB = 1048576;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class OperationError extends Error {}
export const validUser = (user) =>
  user &&
  uuid.test(user.id) &&
  (user.runner === user.id || user.runner === "primary");

export function validControl(control) {
  if (
    !control ||
    !uuid.test(control.revision) ||
    !["create", "start", "stop", "restart", "apply"].includes(control.action)
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
  constructor(docker, provision, statusDir, project) {
    this.docker = docker;
    this.provision = provision;
    this.statusDir = statusDir;
    this.project = project;
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

  async create(user, limits, primaryId) {
    const quotaStorage = await this.migrated(user);
    if (quotaStorage) {
      await this.storage();
    }
    await this.provision(user, limits, quotaStorage, false);
    if (limits) {
      await this.apply(user, { action: "apply", limits }, primaryId);
    }
    await this.docker("start", "dev-mcp-user-" + user.id);
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
    const state = {
      state: info.State.Status,
      ...this.limits(info),
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
    if (action === "start" || action === "restart") {
      if (info.Config.Labels?.["dev-mcp.storage"] === "quota") {
        await this.storage();
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
          await this.provision(user, limits, migrate || quotaStorage, false);
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
