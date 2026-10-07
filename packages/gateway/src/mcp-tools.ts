import type {
  McpServer,
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ToolResult } from "./protocol.ts";
import { fail } from "./protocol.ts";
import type { Scope } from "./config.ts";
import type { IpcClient } from "./ipc-client.ts";
import type { AuditLogger } from "./audit.ts";
import type { Principal, User } from "./user-store.ts";
import type { AppService } from "./apps.ts";
import type { AppRecord } from "./app-store.ts";
import { appNamePattern } from "./app-store.ts";
import { AuditedMcpServer } from "./mcp-audit.ts";

const resultShape = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
  truncated: z.boolean(),
  continuation: z.string().optional(),
};
const resultSchema = z.object(resultShape);
type StructuredToolResult = z.infer<typeof resultSchema>;

const projectId = z.string().uuid().describe("Registered project identifier");
const callReason = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(
    "Brief user-facing purpose of this call in one sentence (1–500 characters). Visible in the audit log; do not include secrets.",
  );
const relativePath = z
  .string()
  .max(4096)
  .describe("Path relative to the registered project root");
const networkIntent = z
  .enum(["none", "read", "write"])
  .describe(
    "Whether the command is expected to access the network; used for authorization and audit",
  );
const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const write: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const destructive: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const shell: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function createMcpServer(options: {
  scopes: Scope[];
  actor: string;
  principal: Principal;
  clientId?: string;
  ipc: IpcClient;
  audit: AuditLogger;
  resourceMetadataUrl: string;
  requestStarted?: () => () => void;
  protocolEra?: "legacy" | "modern";
  failureRecorded?: () => void;
  apps?: {
    service: AppService;
    owner: User;
    publicAllowed: () => Promise<boolean>;
  };
}): McpServer {
  const schemas = new Map<string, z.ZodObject<z.ZodRawShape>>();
  const server = new AuditedMcpServer({
    audit: options.audit,
    actor: options.actor,
    userId: options.principal.userId,
    clientId: options.clientId,
    requestStarted: options.requestStarted,
    protocolEra: options.protocolEra,
    failureRecorded: options.failureRecorded,
    diagnoseTool: async (name, args) => {
      const schema = typeof name === "string" ? schemas.get(name) : undefined;
      if (!schema) {
        return {
          stage: "tool_lookup",
          errorCode: "UNKNOWN_TOOL",
          message: "Requested tool is not registered",
        };
      }
      const parsed = await schema.safeParseAsync(args);
      if (!parsed.success) {
        return {
          stage: "tool_input",
          errorCode: "INVALID_TOOL_ARGUMENTS",
          message: "Tool arguments failed validation",
          tool: name as string,
          // Only schema field names and issue codes, never input values or
          // Zod messages (enum errors can echo secret-bearing input).
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            field:
              typeof issue.path[0] === "string" &&
              Object.hasOwn(schema.shape, issue.path[0])
                ? issue.path[0]
                : "arguments",
            code: issue.code,
          })),
        };
      }
      return {
        stage: "tool_handler",
        errorCode: "TOOL_HANDLER_ERROR",
        message: "Tool handler or output validation failed",
        tool: name as string,
      };
    },
  });
  const add = <Shape extends z.ZodRawShape>(definition: {
    name: string;
    title: string;
    description: string;
    inputSchema: Shape;
    scopes: Scope[] | ((params: Record<string, unknown>) => Scope[]);
    securityScopes?: Scope[];
    annotations: ToolAnnotations;
    // Handled in the gateway instead of forwarding to the runner.
    local?: (params: Record<string, unknown>) => Promise<ToolResult>;
  }): void => {
    const handler = async (
      typedParams: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      const { reason, ...params } = typedParams;
      const required =
        typeof definition.scopes === "function"
          ? definition.scopes(params)
          : definition.scopes;
      const missing = required.filter(
        (scope) => !options.scopes.includes(scope),
      );
      let result: ToolResult;
      let authenticationMeta: Record<string, unknown> | undefined;
      if (missing.length) {
        result = fail(
          "INSUFFICIENT_SCOPE",
          `Missing required OAuth scope: ${missing.join(" ")}`,
          { required },
        );
        authenticationMeta = {
          "mcp/www_authenticate": [
            createScopeChallenge(options.resourceMetadataUrl, missing),
          ],
        };
      } else if (definition.local) {
        try {
          result = await definition.local(params);
        } catch (error) {
          result = fail(
            "APP_ERROR",
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        result = await options.ipc.call(definition.name, params, options.actor);
      }
      await options.audit.write({
        event: "tool_call",
        actor: options.actor,
        userId: options.principal.userId,
        tool: definition.name,
        reason,
        requiredScopes: required,
        ok: result.ok,
        errorCode: result.error?.code,
        params: auditParams(params),
        ...auditResult(definition.name, result),
      });
      const summary = result.ok
        ? `${definition.name} succeeded${result.truncated ? "; output truncated, use continuation" : ""}.`
        : `${definition.name} failed: ${result.error?.message ?? "unknown error"}`;
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: result as StructuredToolResult,
        isError: !result.ok,
        _meta: authenticationMeta,
      };
    };
    const securityScopes =
      typeof definition.scopes === "function"
        ? definition.securityScopes
        : definition.scopes;
    if (!securityScopes) {
      throw new Error(
        `Dynamic scope tool ${definition.name} must declare securityScopes`,
      );
    }
    const inputSchema = { ...definition.inputSchema, reason: callReason };
    schemas.set(definition.name, z.object(inputSchema));
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: z.object(inputSchema),
        outputSchema: resultSchema,
        annotations: definition.annotations,
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: securityScopes }],
        },
      },
      handler as never,
    );
  };

  add({
    name: "project_list",
    title: "List projects",
    description: "List projects registered under /workspace.",
    inputSchema: {},
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "project_register",
    title: "Register project",
    description:
      "Register an existing directory below /workspace without changing its files.",
    inputSchema: {
      name: z.string().min(1).max(200),
      relative_path: relativePath,
    },
    scopes: ["workspace:write"],
    annotations: write,
  });
  add({
    name: "project_clone",
    title: "Clone project",
    description:
      "Clone an HTTPS repository from GitHub, GitLab, or Bitbucket into /workspace and register it. Uses HTTPS Git/gh authentication exported from the separate development container; developer HOME, programs and AI credentials are inaccessible. Credentials embedded in URLs and private network targets are rejected.",
    inputSchema: {
      name: z.string().min(1).max(200),
      repo_url: z.string().url(),
      ref: z.string().min(1).max(500).optional(),
    },
    scopes: ["workspace:write", "command:network"],
    annotations: { ...write, openWorldHint: true },
  });
  add({
    name: "project_unregister",
    title: "Unregister project",
    description:
      "Remove a project from the registry while leaving its files untouched.",
    inputSchema: { project_id: projectId },
    scopes: ["workspace:write"],
    annotations: write,
  });
  add({
    name: "project_delete",
    title: "Delete project",
    description:
      "Permanently delete a registered project directory and unregister it.",
    inputSchema: { project_id: projectId },
    scopes: ["workspace:write"],
    annotations: destructive,
  });

  add({
    name: "file_list",
    title: "List files",
    description:
      "List a bounded tree below a project path. Use the continuation cursor when truncated.",
    inputSchema: {
      project_id: projectId,
      path: relativePath.optional(),
      depth: z.number().int().min(0).max(10).optional(),
      cursor: z.string().optional(),
    },
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "file_read",
    title: "Read file",
    description:
      "Read a line range from a UTF-8 project file. Continue with start_line when truncated.",
    inputSchema: {
      project_id: projectId,
      path: relativePath,
      start_line: z.number().int().min(1).optional(),
      line_count: z.number().int().min(1).max(2000).optional(),
    },
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "file_search",
    title: "Search files",
    description:
      "Search project text with ripgrep using a literal query and optional glob filters.",
    inputSchema: {
      project_id: projectId,
      query: z.string().min(1).max(10_000),
      globs: z.array(z.string().max(500)).max(50).optional(),
      cursor: z.string().optional(),
    },
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "file_apply_patch",
    title: "Apply patch",
    description:
      "Apply a unified git diff below the project root. Absolute paths, parent traversal, and symlink escapes are rejected.",
    inputSchema: {
      project_id: projectId,
      patch: z
        .string()
        .min(1)
        .max(1024 * 1024),
    },
    scopes: ["workspace:write"],
    annotations: destructive,
  });

  add({
    name: "command_run",
    title: "Run command and wait for completion",
    description:
      "Run a Bash command and wait for it to finish; returns exit status, output and a tracked process ID visible in the console. Use process_start to return immediately for servers or long-running work. Captures stdout/stderr; for output redirected to a file, set log_file to also capture that file. Perform the work directly; invoking or delegating to Codex, Claude or another AI agent, including through alternate launch paths, is forbidden. This can change files, contact external systems, or perform destructive operations. Set network_intent accurately. Output beyond 64 KiB is paginated through command_output.",
    inputSchema: {
      project_id: projectId,
      command: z
        .string()
        .min(1)
        .max(128 * 1024),
      cwd: relativePath.optional(),
      log_file: relativePath
        .describe(
          "Optional log file relative to the project root, independent of cwd. Copies the file from its beginning and follows new writes into the execution log, alongside stdout/stderr. Use for shell redirections; omit when using tee to avoid duplicate output.",
        )
        .optional(),
      timeout_ms: z
        .number()
        .int()
        .min(0)
        .max(24 * 60 * 60_000)
        .optional(),
      network_intent: networkIntent,
    },
    scopes: (p) => [
      "command:run",
      ...(p.network_intent === "none" ? [] : ["command:network" as const]),
    ],
    securityScopes: ["command:run", "command:network"],
    annotations: shell,
  });
  add({
    name: "command_output",
    title: "Read command output",
    description:
      "Read the next page of previously truncated command or Git output.",
    inputSchema: {
      continuation: z.string().min(1),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024)
        .optional(),
    },
    scopes: ["command:run"],
    annotations: readOnly,
  });

  add({
    name: "process_start",
    title: "Start background process",
    description:
      "Start a tracked Bash command in the MCP container and return its process ID immediately, without waiting for completion. Use for servers or long-running work; command_run waits and returns exit status/output. Inspect state with process_list, read stdout/stderr with process_logs, and stop with process_stop. Set log_file to also capture output redirected to a file. Do not add shell backgrounding (&) or nohup; the server manages the process. Invoking or delegating to Codex, Claude or another AI agent, including through alternate launch paths, is forbidden. This can change files or contact external systems.",
    inputSchema: {
      project_id: projectId,
      command: z
        .string()
        .min(1)
        .max(128 * 1024),
      cwd: relativePath.optional(),
      log_file: relativePath
        .describe(
          "Optional log file relative to the project root, independent of cwd. Copies the file from its beginning and follows new writes into the execution log, alongside stdout/stderr. Use for shell redirections; omit when using tee to avoid duplicate output.",
        )
        .optional(),
      network_intent: networkIntent,
    },
    scopes: (p) => [
      "command:run",
      ...(p.network_intent === "none" ? [] : ["command:network" as const]),
    ],
    securityScopes: ["command:run", "command:network"],
    annotations: shell,
  });
  add({
    name: "process_list",
    title: "List processes",
    description:
      "List tracked executions from command_run and process_start with their current state and execution mode, optionally for one project.",
    inputSchema: { project_id: projectId.optional() },
    scopes: ["command:run"],
    annotations: readOnly,
  });
  add({
    name: "process_logs",
    title: "Read process logs",
    description:
      "Read a page of captured stdout/stderr and any selected log_file for an execution from command_run or process_start. Reuse the returned cursor to follow new output, including after an empty page.",
    inputSchema: {
      process_id: z.string().uuid(),
      cursor: z.string().optional(),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024)
        .optional(),
    },
    scopes: ["command:run"],
    annotations: readOnly,
  });
  add({
    name: "process_stop",
    title: "Stop process",
    description:
      "Send SIGTERM to a tracked background process group after verifying its PID start identity.",
    inputSchema: { process_id: z.string().uuid() },
    scopes: ["command:run"],
    annotations: destructive,
  });

  add({
    name: "git_read",
    title: "Read Git state",
    description:
      "Read Git status, diff, or recent commits. staged applies only to diff; limit applies only to log. Continue truncated output with command_output.",
    inputSchema: {
      project_id: projectId,
      operation: z.enum(["status", "diff", "log"]),
      staged: z.boolean().optional().describe("For diff: show staged changes"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("For log: maximum commits (default 20)"),
    },
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "git_commit",
    title: "Create Git commit",
    description:
      "Stage selected paths (or all changes) and create a local commit. The runner must have GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL configured.",
    inputSchema: {
      project_id: projectId,
      message: z.string().min(1).max(10_000),
      paths: z.array(relativePath).max(500).optional(),
    },
    scopes: ["workspace:write"],
    annotations: write,
  });
  const apps = async () => {
    if (!options.apps) {
      throw new Error("Apps are not available");
    }
    return options.apps;
  };
  const describe = async (app: AppRecord) => {
    const { service, owner } = await apps();
    const status = await service.status(owner, app, options.actor);
    return {
      name: app.slug,
      url: service.url(app.slug) ?? null,
      projectId: app.projectId,
      command: app.command,
      port: app.port,
      visibility: app.visibility,
      state: status.state,
      processId: app.processId ?? null,
    };
  };
  const ownApp = async (name: unknown) => {
    const { service, owner } = await apps();
    const app = await service.store.get(String(name));
    if (!app || app.ownerId !== owner.id) {
      throw new Error("Unknown app: " + String(name));
    }
    return app;
  };
  const appName = z
    .string()
    .regex(appNamePattern)
    .describe(
      "App name: lowercase letters, digits and -, up to 40 characters. The app is served at https://<name>.<preview domain>.",
    );
  add({
    name: "app_list",
    title: "List apps",
    description:
      "List this account's apps with their URL, port, visibility and whether their server is running.",
    inputSchema: {},
    scopes: ["command:run"],
    annotations: readOnly,
    local: async () => {
      const { service, owner } = await apps();
      const mine = (await service.store.list()).filter(
        (app) => app.ownerId === owner.id,
      );
      return {
        ok: true,
        data: { apps: await Promise.all(mine.map(describe)) },
        truncated: false,
      };
    },
  });
  add({
    name: "app_deploy",
    title: "Deploy app",
    description:
      "Save an app and (re)start its server as a tracked background process, then return its URL. The command must start a server listening on `port` (localhost or 0.0.0.0) inside the runner. Private apps open only for the owner and administrators; public apps for anyone with the link. Redeploying an existing app restarts it with the new settings.",
    inputSchema: {
      name: appName,
      project_id: projectId,
      command: z.string().min(1).max(2000),
      port: z.number().int().min(1024).max(65535),
      visibility: z.enum(["private", "public"]).optional(),
      cwd: relativePath.optional(),
      network_intent: networkIntent,
    },
    scopes: (p) => [
      "command:run",
      ...(p.network_intent === "none" ? [] : ["command:network" as const]),
    ],
    securityScopes: ["command:run", "command:network"],
    annotations: shell,
    local: async (p) => {
      const { service, owner, publicAllowed } = await apps();
      const visibility = (p.visibility as AppRecord["visibility"]) ?? "private";
      if (visibility === "public" && !(await publicAllowed())) {
        return fail(
          "PUBLIC_APPS_DISABLED",
          "An administrator has disabled public app links; deploy it as private.",
        );
      }
      const { app, result } = await service.deploy(
        owner,
        {
          slug: String(p.name),
          projectId: String(p.project_id),
          command: String(p.command),
          ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          port: Number(p.port),
          visibility,
          networkIntent: p.network_intent as AppRecord["networkIntent"],
        },
        options.actor,
      );
      return result.ok
        ? { ok: true, data: { app: await describe(app) }, truncated: false }
        : result;
    },
  });
  add({
    name: "app_stop",
    title: "Stop app",
    description: "Stop an app's server process. Its definition and URL stay.",
    inputSchema: { name: appName },
    scopes: ["command:run"],
    annotations: destructive,
    local: async (p) => {
      const { service, owner } = await apps();
      const app = await ownApp(p.name);
      const result = await service.stop(owner, app, options.actor);
      return result.ok
        ? {
            ok: true,
            data: { name: app.slug, stopped: true },
            truncated: false,
          }
        : result;
    },
  });
  add({
    name: "app_delete",
    title: "Delete app",
    description:
      "Stop an app's server and delete its definition and URL. Project files are not changed.",
    inputSchema: { name: appName },
    scopes: ["command:run"],
    annotations: destructive,
    local: async (p) => {
      const { service, owner } = await apps();
      const app = await ownApp(p.name);
      await service.remove(owner, app, options.actor);
      return {
        ok: true,
        data: { name: app.slug, deleted: true },
        truncated: false,
      };
    },
  });

  return server;
}

function createScopeChallenge(
  resourceMetadataUrl: string,
  scopes: Scope[],
): string {
  const metadata = escapeQuotedString(resourceMetadataUrl);
  const scope = escapeQuotedString(scopes.join(" "));
  const description = escapeQuotedString(
    `Additional authorization is required for: ${scopes.join(" ")}`,
  );
  return `Bearer resource_metadata="${metadata}", error="insufficient_scope", error_description="${description}", scope="${scope}"`;
}

function escapeQuotedString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function auditParams(params: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "patch") {
      output.patchBytes =
        typeof value === "string" ? Buffer.byteLength(value) : 0;
    } else if (key === "command") {
      output.command =
        typeof value === "string" ? value.slice(0, 2_000) : value;
    } else if (!key.toLowerCase().includes("token") && key !== "continuation") {
      output[key] = value;
    }
  }
  return output;
}

function auditResult(
  tool: string,
  result: ToolResult,
): Record<string, unknown> {
  if (tool.startsWith("app_") && result.ok) {
    const data = result.data as
      { app?: { name?: unknown; url?: unknown }; name?: unknown } | undefined;
    const name = data?.app?.name ?? data?.name;
    return typeof name === "string" ? { app: name } : {};
  }
  if (!["process_start", "command_run"].includes(tool) || !result.ok) {
    return {};
  }
  const process = (
    result.data as
      { process?: { id?: unknown; projectId?: unknown } } | undefined
  )?.process;
  return {
    ...(typeof process?.id === "string" ? { processId: process.id } : {}),
    ...(typeof process?.projectId === "string"
      ? { projectId: process.projectId }
      : {}),
  };
}
