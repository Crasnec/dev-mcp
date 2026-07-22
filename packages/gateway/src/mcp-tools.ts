import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ToolResult } from "./protocol.ts";
import { fail } from "./protocol.ts";
import type { Scope } from "./config.ts";
import type { IpcClient } from "./ipc-client.ts";
import type { AuditLogger } from "./audit.ts";

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
  ipc: IpcClient;
  audit: AuditLogger;
}): McpServer {
  const server = new McpServer({ name: "dev-mcp", version: "0.1.0" });
  const add = <Shape extends z.ZodRawShape>(definition: {
    name: string;
    title: string;
    description: string;
    inputSchema: Shape;
    scopes: Scope[] | ((params: Record<string, unknown>) => Scope[]);
    annotations: ToolAnnotations;
  }): void => {
    const handler = async (
      typedParams: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      const params = typedParams;
      const required =
        typeof definition.scopes === "function"
          ? definition.scopes(params)
          : definition.scopes;
      const missing = required.filter(
        (scope) => !options.scopes.includes(scope),
      );
      let result: ToolResult;
      if (missing.length) {
        result = fail(
          "INSUFFICIENT_SCOPE",
          `Missing required OAuth scope: ${missing.join(" ")}`,
          { required },
        );
      } else {
        result = await options.ipc.call(definition.name, params, options.actor);
      }
      await options.audit.write({
        event: "tool_call",
        actor: options.actor,
        tool: definition.name,
        requiredScopes: required,
        ok: result.ok,
        errorCode: result.error?.code,
        params: auditParams(params),
      });
      const summary = result.ok
        ? `${definition.name} succeeded${result.truncated ? "; output truncated, use continuation" : ""}.`
        : `${definition.name} failed: ${result.error?.message ?? "unknown error"}`;
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: result as StructuredToolResult,
        isError: !result.ok,
      };
    };
    server.registerTool<typeof resultShape, Shape>(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: resultShape,
        annotations: definition.annotations,
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
    title: "Clone public project",
    description:
      "Clone a public HTTPS repository from GitHub, GitLab, or Bitbucket into /workspace and register it. Credentials and private network targets are rejected.",
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
    title: "Run shell command",
    description:
      "Run a Bash command in a project. This can change files, contact external systems, or perform destructive operations. Set network_intent accurately. Output beyond 64 KiB is paginated.",
    inputSchema: {
      project_id: projectId,
      command: z
        .string()
        .min(1)
        .max(128 * 1024),
      cwd: relativePath.optional(),
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
      "Start a Bash command as a tracked background process. This can change files or contact external systems.",
    inputSchema: {
      project_id: projectId,
      command: z
        .string()
        .min(1)
        .max(128 * 1024),
      cwd: relativePath.optional(),
      network_intent: networkIntent,
    },
    scopes: (p) => [
      "command:run",
      ...(p.network_intent === "none" ? [] : ["command:network" as const]),
    ],
    annotations: shell,
  });
  add({
    name: "process_list",
    title: "List processes",
    description:
      "List tracked background processes, optionally for one project.",
    inputSchema: { project_id: projectId.optional() },
    scopes: ["command:run"],
    annotations: readOnly,
  });
  add({
    name: "process_status",
    title: "Process status",
    description: "Get the current state of a tracked background process.",
    inputSchema: { process_id: z.string().uuid() },
    scopes: ["command:run"],
    annotations: readOnly,
  });
  add({
    name: "process_logs",
    title: "Read process logs",
    description:
      "Read a page of combined stdout and stderr for a tracked background process.",
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
    name: "git_status",
    title: "Git status",
    description: "Show concise Git working-tree status.",
    inputSchema: { project_id: projectId },
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "git_diff",
    title: "Git diff",
    description: "Show unstaged or staged Git changes.",
    inputSchema: { project_id: projectId, staged: z.boolean().optional() },
    scopes: ["workspace:read"],
    annotations: readOnly,
  });
  add({
    name: "git_log",
    title: "Git log",
    description:
      "Show recent commits with hashes, timestamps, authors, and subjects.",
    inputSchema: {
      project_id: projectId,
      limit: z.number().int().min(1).max(200).optional(),
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
  return server;
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
