import type { ToolResult } from "./protocol.ts";
import { errorMessage, fail, ok } from "./protocol.ts";
import type { RunnerConfig } from "./config.ts";
import type { ProjectService } from "./project-service.ts";
import { resolveForWrite } from "./paths.ts";
import { cleanEnvironment, execFile } from "./subprocess.ts";
import { OutputStore } from "./output-store.ts";

export class GitService {
  constructor(
    private readonly config: RunnerConfig,
    private readonly projects: ProjectService,
    private readonly outputs: OutputStore,
  ) {}

  async status(projectId: string): Promise<ToolResult> {
    return this.readGit(projectId, ["status", "--short", "--branch"]);
  }

  async diff(projectId: string, staged = false): Promise<ToolResult> {
    return this.readGit(projectId, [
      "diff",
      ...(staged ? ["--cached"] : []),
      "--no-ext-diff",
    ]);
  }

  async log(projectId: string, limit = 20): Promise<ToolResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return fail("INVALID_LIMIT", "Git log limit must be between 1 and 200");
    }
    return this.readGit(projectId, [
      "log",
      `--max-count=${limit}`,
      "--date=iso-strict",
      "--pretty=format:%H%x09%ad%x09%an%x09%s",
    ]);
  }

  private async readGit(
    projectId: string,
    args: string[],
  ): Promise<ToolResult> {
    try {
      const { root } = await this.projects.get(projectId);
      const result = await execFile("git", args, {
        cwd: root,
        env: cleanEnvironment({ home: this.config.dataDir }),
        maxCaptureBytes: 64 * 1024 * 1024,
      });
      if (result.exitCode !== 0) {
        return fail("GIT_FAILED", result.stderr.toString("utf8"));
      }
      const saved = await this.outputs.save(result.stdout);
      return ok(
        { output: saved.preview },
        {
          truncated: saved.truncated,
          ...(saved.continuation ? { continuation: saved.continuation } : {}),
        },
      );
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "GIT_FAILED",
        errorMessage(error),
      );
    }
  }

  async commit(
    projectId: string,
    message: string,
    paths?: string[],
  ): Promise<ToolResult> {
    try {
      if (!this.config.gitAuthorName || !this.config.gitAuthorEmail) {
        return fail(
          "GIT_IDENTITY_REQUIRED",
          "GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL must be configured before committing",
        );
      }
      if (!message.trim()) {
        return fail("INVALID_MESSAGE", "Commit message cannot be empty");
      }
      const { root } = await this.projects.get(projectId);
      const selected = paths?.length ? paths : undefined;
      for (const selectedPath of selected ?? [])
        await resolveForWrite(root, selectedPath);
      const env = cleanEnvironment({
        home: this.config.dataDir,
        gitAuthorName: this.config.gitAuthorName,
        gitAuthorEmail: this.config.gitAuthorEmail,
      });
      const add = await execFile(
        "git",
        selected ? ["add", "-A", "--", ...selected] : ["add", "-A"],
        { cwd: root, env, maxCaptureBytes: this.config.maxOutputBytes },
      );
      if (add.exitCode !== 0) {
        return fail("GIT_ADD_FAILED", add.stderr.toString("utf8"));
      }
      const commit = await execFile("git", ["commit", "-m", message], {
        cwd: root,
        env,
        maxCaptureBytes: this.config.maxOutputBytes,
      });
      if (commit.exitCode !== 0) {
        return fail(
          "GIT_COMMIT_FAILED",
          commit.stderr.toString("utf8") || commit.stdout.toString("utf8"),
        );
      }
      const head = await execFile("git", ["rev-parse", "HEAD"], {
        cwd: root,
        env,
        maxCaptureBytes: 1024,
      });
      return ok({
        commit: head.stdout.toString("utf8").trim(),
        output: commit.stdout.toString("utf8"),
      });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "GIT_COMMIT_FAILED",
        errorMessage(error),
      );
    }
  }
}
