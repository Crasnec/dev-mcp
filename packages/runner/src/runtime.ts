import type { NetworkIntent, RpcRequest, ToolResult } from "./protocol.ts";
import { errorMessage, fail } from "./protocol.ts";
import type { RunnerConfig } from "./config.ts";
import { CommandService } from "./command-service.ts";
import { FileService } from "./file-service.ts";
import { GitService } from "./git-service.ts";
import { OutputStore } from "./output-store.ts";
import { ProcessService } from "./process-service.ts";
import { ProjectService } from "./project-service.ts";

export class RunnerRuntime {
  readonly projects: ProjectService;
  readonly files: FileService;
  readonly commands: CommandService;
  readonly processes: ProcessService;
  readonly git: GitService;
  readonly outputs: OutputStore;

  constructor(private readonly config: RunnerConfig) {
    this.projects = new ProjectService(config);
    this.outputs = new OutputStore(config.dataDir, config.maxOutputBytes);
    this.files = new FileService(config, this.projects);
    this.commands = new CommandService(config, this.projects, this.outputs);
    this.processes = new ProcessService(config, this.projects);
    this.git = new GitService(config, this.projects, this.outputs);
  }

  async initialize(): Promise<void> {
    await this.projects.initialize();
    await this.processes.initialize();
  }

  async dispatch(request: RpcRequest): Promise<ToolResult> {
    const p = request.params;
    try {
      switch (request.method) {
        case "project_list":
          return this.projects.list();
        case "project_register":
          return this.projects.register(
            str(p, "name"),
            str(p, "relative_path"),
          );
        case "project_clone":
          return this.projects.clone(
            str(p, "name"),
            str(p, "repo_url"),
            optionalStr(p, "ref"),
          );
        case "project_unregister":
          return this.projects.unregister(str(p, "project_id"));
        case "project_delete":
          return this.projects.delete(str(p, "project_id"));
        case "file_list":
          return this.files.list(
            str(p, "project_id"),
            optionalStr(p, "path") ?? ".",
            optionalInt(p, "depth") ?? 2,
            optionalStr(p, "cursor"),
          );
        case "file_read":
          return this.files.read(
            str(p, "project_id"),
            str(p, "path"),
            optionalInt(p, "start_line") ?? 1,
            optionalInt(p, "line_count") ?? 200,
          );
        case "image_read":
          return this.files.readImage(str(p, "project_id"), str(p, "path"));
        case "file_search":
          return this.files.search(
            str(p, "project_id"),
            str(p, "query"),
            optionalStrArray(p, "globs") ?? [],
            optionalStr(p, "cursor"),
          );
        case "file_apply_patch":
          return this.files.applyPatch(str(p, "project_id"), str(p, "patch"));
        case "command_run":
          return this.commands.run(
            str(p, "project_id"),
            str(p, "command"),
            optionalStr(p, "cwd") ?? ".",
            optionalInt(p, "timeout_ms"),
            networkIntent(p),
          );
        case "command_output":
          return this.outputs.read(
            str(p, "continuation"),
            optionalInt(p, "max_bytes"),
          );
        case "process_start":
          return this.processes.start(
            str(p, "project_id"),
            str(p, "command"),
            optionalStr(p, "cwd") ?? ".",
            networkIntent(p),
          );
        case "process_list":
          return this.processes.list(optionalStr(p, "project_id"));
        case "process_logs":
          return this.processes.logs(
            str(p, "process_id"),
            optionalStr(p, "cursor"),
            optionalInt(p, "max_bytes"),
          );
        case "process_stop":
          return this.processes.stop(str(p, "process_id"));
        case "git_read":
          return this.git.read(
            str(p, "project_id"),
            str(p, "operation"),
            optionalBool(p, "staged") ?? false,
            optionalInt(p, "limit") ?? 20,
          );
        case "git_commit":
          return this.git.commit(
            str(p, "project_id"),
            str(p, "message"),
            optionalStrArray(p, "paths"),
          );
        default:
          return fail(
            "METHOD_NOT_FOUND",
            `Unknown runner method: ${request.method}`,
          );
      }
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "INVALID_PARAMS",
        errorMessage(error),
      );
    }
  }
}

function str(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value[key];
}
function optionalStr(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  if (value[key] === undefined) {
    return undefined;
  }
  return str(value, key);
}
function optionalInt(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  if (value[key] === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value[key])) {
    throw new Error(`${key} must be an integer`);
  }
  return value[key] as number;
}
function optionalBool(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (value[key] === undefined) {
    return undefined;
  }
  if (typeof value[key] !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value[key];
}
function optionalStrArray(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (value[key] === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value[key]) ||
    !(value[key] as unknown[]).every((entry) => typeof entry === "string")
  ) {
    throw new Error(`${key} must be a string array`);
  }
  return value[key] as string[];
}
function networkIntent(value: Record<string, unknown>): NetworkIntent {
  const intent = value.network_intent ?? "none";
  if (intent !== "none" && intent !== "read" && intent !== "write") {
    throw new Error("network_intent must be none, read, or write");
  }
  return intent;
}
