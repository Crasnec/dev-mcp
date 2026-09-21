import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "./protocol.ts";
import { errorMessage, fail, ok } from "./protocol.ts";
import type { ProjectService } from "./project-service.ts";
import {
  relativeFrom,
  resolveExisting,
  resolveForWrite,
  validateRelativePath,
} from "./paths.ts";
import { cleanEnvironment, execFile } from "./subprocess.ts";
import type { RunnerConfig } from "./config.ts";

interface ListEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
}

export class FileService {
  constructor(
    private readonly config: RunnerConfig,
    private readonly projects: ProjectService,
  ) {}

  async list(
    projectId: string,
    requestedPath = ".",
    depth = 2,
    cursor?: string,
  ): Promise<ToolResult> {
    try {
      const { root } = await this.projects.get(projectId);
      const start = await resolveExisting(root, requestedPath);
      const maxDepth = Math.min(Math.max(depth, 0), 10);
      const entries: ListEntry[] = [];
      await this.walk(root, start, maxDepth, entries);
      const offset = decodeCursor(cursor, "file-list");
      const page = entries.slice(offset, offset + 500);
      const next = offset + page.length;
      return ok(
        { entries: page },
        {
          truncated: next < entries.length,
          ...(next < entries.length
            ? { continuation: encodeCursor("file-list", next) }
            : {}),
        },
      );
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "FILE_LIST_FAILED",
        errorMessage(error),
      );
    }
  }

  private async walk(
    root: string,
    current: string,
    depth: number,
    output: ListEntry[],
  ): Promise<void> {
    const info = await lstat(current);
    output.push({
      path: relativeFrom(root, current),
      type: info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other",
      size: info.size,
    });
    if (!info.isDirectory() || info.isSymbolicLink() || depth === 0) {
      return;
    }
    const children = await readdir(current);
    children.sort((a, b) => a.localeCompare(b));
    for (const child of children)
      await this.walk(root, path.join(current, child), depth - 1, output);
  }

  async read(
    projectId: string,
    requestedPath: string,
    startLine = 1,
    lineCount = 200,
  ): Promise<ToolResult> {
    try {
      if (startLine < 1 || lineCount < 1 || lineCount > 2_000) {
        return fail(
          "INVALID_RANGE",
          "Line range is invalid (maximum 2000 lines)",
        );
      }
      const { root } = await this.projects.get(projectId);
      const filename = await resolveExisting(root, requestedPath);
      const info = await lstat(filename);
      if (!info.isFile()) {
        return fail("NOT_A_FILE", "Requested path is not a regular file");
      }
      if (info.size > 16 * 1024 * 1024) {
        return fail(
          "FILE_TOO_LARGE",
          "Files larger than 16 MiB cannot be read with this tool",
        );
      }
      const lines = (await readFile(filename, "utf8")).split(/\r?\n/);
      const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
      const endLine = startLine + selected.length - 1;
      return ok(
        {
          path: relativeFrom(root, filename),
          startLine,
          endLine,
          totalLines: lines.length,
          content: selected.join("\n"),
        },
        {
          truncated: endLine < lines.length,
          ...(endLine < lines.length
            ? { continuation: encodeCursor("file-read", endLine + 1) }
            : {}),
        },
      );
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "FILE_READ_FAILED",
        errorMessage(error),
      );
    }
  }

  async readImage(
    projectId: string,
    requestedPath: string,
  ): Promise<ToolResult> {
    try {
      const { root } = await this.projects.get(projectId);
      const filename = await resolveExisting(root, requestedPath);
      const info = await lstat(filename);
      if (!info.isFile()) {
        return fail("NOT_A_FILE", "Requested path is not a regular file");
      }
      if (info.size > 1 * 1024 * 1024) {
        return fail(
          "FILE_TOO_LARGE",
          "Images larger than 1 MiB cannot be read with this tool",
        );
      }
      const content = await readFile(filename);
      const mimeType = detectImageMimeType(content);
      if (!mimeType) {
        return fail(
          "UNSUPPORTED_IMAGE_TYPE",
          "Supported image formats are PNG, JPEG, GIF, and WebP",
        );
      }
      return ok({
        path: relativeFrom(root, filename),
        mimeType,
        size: content.length,
        base64: content.toString("base64"),
      });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "IMAGE_READ_FAILED",
        errorMessage(error),
      );
    }
  }

  async search(
    projectId: string,
    query: string,
    globs: string[] = [],
    cursor?: string,
  ): Promise<ToolResult> {
    try {
      if (!query) {
        return fail("INVALID_QUERY", "Search query cannot be empty");
      }
      const { root } = await this.projects.get(projectId);
      const args = [
        "--line-number",
        "--column",
        "--no-heading",
        "--color=never",
        "--fixed-strings",
      ];
      for (const glob of globs) {
        if (glob.includes("\0")) {
          return fail("INVALID_GLOB", "Glob contains a NUL byte");
        }
        args.push("--glob", glob);
      }
      args.push("--", query, ".");
      const result = await execFile("rg", args, {
        cwd: root,
        env: cleanEnvironment({ home: this.config.dataDir }),
        maxCaptureBytes: 8 * 1024 * 1024,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return fail("SEARCH_FAILED", result.stderr.toString("utf8"));
      }
      const matches = result.stdout
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
      const offset = decodeCursor(cursor, "file-search");
      const page = matches.slice(offset, offset + 500);
      const next = offset + page.length;
      return ok(
        { matches: page },
        {
          truncated: next < matches.length,
          ...(next < matches.length
            ? { continuation: encodeCursor("file-search", next) }
            : {}),
        },
      );
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "SEARCH_FAILED",
        errorMessage(error),
      );
    }
  }

  async applyPatch(projectId: string, patch: string): Promise<ToolResult> {
    try {
      if (!patch || Buffer.byteLength(patch) > 1024 * 1024) {
        return fail(
          "INVALID_PATCH",
          "Patch must be non-empty and no larger than 1 MiB",
        );
      }
      const { root } = await this.projects.get(projectId);
      const paths = extractPatchPaths(patch);
      if (paths.length === 0) {
        return fail("INVALID_PATCH", "No unified-diff file paths were found");
      }
      for (const candidate of paths)
        await resolveForWrite(root, validateRelativePath(candidate, false));
      const result = await execFile(
        "git",
        ["apply", "--recount", "--whitespace=nowarn", "-"],
        {
          cwd: root,
          env: cleanEnvironment({ home: this.config.dataDir }),
          input: patch,
          maxCaptureBytes: this.config.maxOutputBytes,
        },
      );
      if (result.exitCode !== 0) {
        return fail(
          "PATCH_FAILED",
          result.stderr.toString("utf8") || "git apply rejected the patch",
        );
      }
      return ok({ paths });
    } catch (error) {
      return fail(
        (error as { code?: string }).code ?? "PATCH_FAILED",
        errorMessage(error),
      );
    }
  }
}

export function extractPatchPaths(patch: string): string[] {
  const found = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = /^(?:---|\+\+\+)\s+([^\t ]+)/.exec(line);
    if (!match || match[1] === "/dev/null") {
      continue;
    }
    let filename = match[1]!;
    if (filename.startsWith("a/") || filename.startsWith("b/")) {
      filename = filename.slice(2);
    }
    found.add(filename);
  }
  return [...found];
}

function detectImageMimeType(content: Buffer): string | undefined {
  if (
    content.length >= 8 &&
    content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (content.length >= 6) {
    const signature = content.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function encodeCursor(kind: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, offset })).toString(
    "base64url",
  );
}
function decodeCursor(cursor: string | undefined, kind: string): number {
  if (!cursor) {
    return 0;
  }
  const value = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  ) as { v?: number; kind?: string; offset?: number };
  if (
    value.v !== 1 ||
    value.kind !== kind ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset ?? -1) < 0
  ) {
    throw Object.assign(new Error("Cursor is invalid for this operation"), {
      code: "INVALID_CURSOR",
    });
  }
  return value.offset as number;
}
