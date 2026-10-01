import type { GatewayConfig } from "./config.ts";
import { fail, type ToolResult } from "./protocol.ts";
import type { RunnerRouter } from "./runner-router.ts";
import type { User } from "./user-store.ts";
import type { AppInput, AppRecord, AppStore } from "./app-store.ts";
import { previewOrigin } from "./preview-proxy.ts";

export interface AppStatus {
  state: "running" | "stopped" | "unknown";
  processId?: string;
}

// Shared by the console and the MCP tools: an app is defined, then started as
// a tracked background process in its owner's runner.
export class AppService {
  constructor(
    readonly store: AppStore,
    private readonly runners: RunnerRouter,
    private readonly config: GatewayConfig,
  ) {}

  url(slug: string): string | undefined {
    return previewOrigin(this.config, slug);
  }

  async status(owner: User, app: AppRecord, actor: string): Promise<AppStatus> {
    if (!app.processId) {
      return { state: "stopped" };
    }
    const result = await this.runners
      .forUser(owner)
      .call("process_list", { project_id: app.projectId }, actor, {
        timeoutMs: 5_000,
      });
    if (!result.ok) {
      return { state: "unknown", processId: app.processId };
    }
    const process = (
      result.data as { processes?: Array<{ id: string; status: string }> }
    )?.processes?.find((entry) => entry.id === app.processId);
    return {
      state: process?.status === "running" ? "running" : "stopped",
      processId: app.processId,
    };
  }

  // Saves the definition, replaces a running process and starts a new one.
  async deploy(
    owner: User,
    input: AppInput,
    actor: string,
  ): Promise<{ app: AppRecord; result: ToolResult }> {
    const current = await this.store.get(input.slug);
    if (current && current.ownerId !== owner.id) {
      throw new Error("이미 다른 계정이 쓰는 앱 이름입니다.");
    }
    let app = await this.store.save(owner.id, input);
    if (current) {
      await this.stopProcess(owner, current, actor);
    }
    const result = await this.runners.forUser(owner).call(
      "process_start",
      {
        project_id: app.projectId,
        command: app.command,
        ...(app.cwd ? { cwd: app.cwd } : {}),
        network_intent: app.networkIntent,
      },
      actor,
    );
    const processId = (result.data as { process?: { id?: unknown } })?.process
      ?.id;
    app = await this.store.update(app.slug, owner.id, {
      processId:
        result.ok && typeof processId === "string" ? processId : undefined,
    });
    return { app, result };
  }

  async stop(owner: User, app: AppRecord, actor: string): Promise<ToolResult> {
    const result = await this.stopProcess(owner, app, actor);
    await this.store.update(app.slug, owner.id, { processId: undefined });
    return result;
  }

  async remove(owner: User, app: AppRecord, actor: string): Promise<void> {
    await this.stopProcess(owner, app, actor);
    await this.store.remove(app.slug, owner.id);
  }

  private async stopProcess(
    owner: User,
    app: AppRecord,
    actor: string,
  ): Promise<ToolResult> {
    if (!app.processId) {
      return { ok: true, data: { stopped: false }, truncated: false };
    }
    const result = await this.runners
      .forUser(owner)
      .call("process_stop", { process_id: app.processId }, actor);
    // An already finished, stale or unknown process needs no stopping.
    return result.ok ||
      ["PROCESS_NOT_FOUND", "PROCESS_STALE"].includes(result.error?.code ?? "")
      ? { ok: true, data: { stopped: result.ok }, truncated: false }
      : result.error
        ? result
        : fail("RUNNER_UNAVAILABLE", "Could not stop the app process");
  }
}
