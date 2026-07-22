import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord, ToolResult } from "./protocol.ts";
import { errorMessage, fail, ok } from "./protocol.ts";
import { JsonStore } from "./json-store.ts";
import {
  canonicalRoot,
  resolveExisting,
  validateRelativePath,
} from "./paths.ts";
import { cleanEnvironment, execFile } from "./subprocess.ts";
import type { RunnerConfig } from "./config.ts";

interface Registry {
  projects: ProjectRecord[];
}

export class ProjectService {
  private readonly store: JsonStore<Registry>;

  constructor(private readonly config: RunnerConfig) {
    this.store = new JsonStore(
      path.join(config.dataDir, "projects.json"),
      () => ({ projects: [] }),
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.workspaceRoot, { recursive: true });
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
  }

  async list(): Promise<ToolResult> {
    const registry = await this.store.read();
    return ok({ projects: registry.projects });
  }

  async get(
    projectId: string,
  ): Promise<{ record: ProjectRecord; root: string }> {
    const registry = await this.store.read();
    const record = registry.projects.find(
      (project) => project.id === projectId,
    );
    if (!record) {
      throw Object.assign(new Error(`Unknown project: ${projectId}`), {
        code: "PROJECT_NOT_FOUND",
      });
    }
    const root = await resolveExisting(
      this.config.workspaceRoot,
      record.relativePath,
    );
    return { record, root };
  }

  async register(name: string, relativePath: string): Promise<ToolResult> {
    try {
      const normalized = validateRelativePath(relativePath, false);
      const workspace = await canonicalRoot(this.config.workspaceRoot);
      const projectRoot = await resolveExisting(workspace, normalized);
      const storedPath = path
        .relative(workspace, projectRoot)
        .split(path.sep)
        .join("/");
      if (!storedPath || storedPath === ".") {
        return fail(
          "INVALID_PROJECT",
          "The workspace root itself cannot be registered",
        );
      }
      const record: ProjectRecord = {
        id: randomUUID(),
        name: name.trim(),
        relativePath: storedPath,
        createdAt: new Date().toISOString(),
      };
      if (!record.name) {
        return fail("INVALID_NAME", "Project name cannot be empty");
      }
      await this.store.update((registry) => {
        if (
          registry.projects.some(
            (entry) =>
              entry.name === record.name ||
              entry.relativePath === record.relativePath,
          )
        ) {
          throw Object.assign(
            new Error("A project with that name or path is already registered"),
            { code: "PROJECT_EXISTS" },
          );
        }
        registry.projects.push(record);
      });
      return ok({ project: record });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "REGISTER_FAILED",
        errorMessage(error),
      );
    }
  }

  async clone(
    name: string,
    repoUrl: string,
    ref?: string,
  ): Promise<ToolResult> {
    try {
      const url = validateCloneUrl(repoUrl);
      const folder = validateRelativePath(name.trim(), false);
      if (folder.includes(path.sep)) {
        return fail(
          "INVALID_NAME",
          "Clone name must be a single directory name",
        );
      }
      const workspace = await canonicalRoot(this.config.workspaceRoot);
      const destination = path.join(workspace, folder);
      const args = ["clone", "--", url.toString(), destination];
      if (ref) {
        args.splice(1, 0, "--branch", ref, "--single-branch");
      }
      const result = await execFile("git", args, {
        cwd: workspace,
        env: cleanEnvironment({ home: this.config.dataDir }),
        maxCaptureBytes: this.config.maxOutputBytes,
      });
      if (result.exitCode !== 0) {
        return fail(
          "CLONE_FAILED",
          result.stderr.toString("utf8") ||
            `git clone exited ${result.exitCode}`,
        );
      }
      const registered = await this.register(name, folder);
      if (!registered.ok) {
        await rm(destination, { recursive: true, force: true });
      }
      return registered;
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "CLONE_FAILED",
        errorMessage(error),
      );
    }
  }

  async unregister(projectId: string): Promise<ToolResult> {
    try {
      const removed = await this.store.update((registry) => {
        const index = registry.projects.findIndex(
          (project) => project.id === projectId,
        );
        if (index < 0) {
          return undefined;
        }
        return registry.projects.splice(index, 1)[0];
      });
      return removed
        ? ok({ project: removed })
        : fail("PROJECT_NOT_FOUND", `Unknown project: ${projectId}`);
    } catch (error) {
      return fail("UNREGISTER_FAILED", errorMessage(error));
    }
  }

  async delete(projectId: string): Promise<ToolResult> {
    try {
      const { record, root } = await this.get(projectId);
      await rm(root, { recursive: true, force: false });
      await this.store.update((registry) => {
        registry.projects = registry.projects.filter(
          (project) => project.id !== projectId,
        );
      });
      return ok({ project: record, deleted: true });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "DELETE_FAILED",
        errorMessage(error),
      );
    }
  }
}

export function validateCloneUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Repository URL is invalid"), {
      code: "INVALID_REPO_URL",
    });
  }
  if (url.protocol !== "https:") {
    throw Object.assign(new Error("Only HTTPS repository URLs are allowed"), {
      code: "INVALID_REPO_URL",
    });
  }
  if (url.username || url.password) {
    throw Object.assign(
      new Error("Credentials in repository URLs are forbidden"),
      { code: "INVALID_REPO_URL" },
    );
  }
  if (
    !new Set(["github.com", "gitlab.com", "bitbucket.org"]).has(
      url.hostname.toLowerCase(),
    )
  ) {
    throw Object.assign(
      new Error("Only public GitHub, GitLab, and Bitbucket hosts are allowed"),
      { code: "INVALID_REPO_URL" },
    );
  }
  if (!url.pathname || url.pathname === "/" || url.search || url.hash) {
    throw Object.assign(
      new Error("Repository URL must contain only a repository path"),
      { code: "INVALID_REPO_URL" },
    );
  }
  return url;
}
