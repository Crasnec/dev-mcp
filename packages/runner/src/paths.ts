import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class PathViolation extends Error {
  readonly code = "PATH_VIOLATION";
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function validateRelativePath(value: string, allowEmpty = true): string {
  if (value.includes("\0")) {
    throw new PathViolation("Path contains a NUL byte");
  }
  if (path.isAbsolute(value)) {
    throw new PathViolation("Absolute paths are not allowed");
  }
  const normalized = path.normalize(value || ".");
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new PathViolation("Parent path traversal is not allowed");
  }
  if (!allowEmpty && (value === "" || normalized === ".")) {
    throw new PathViolation("A non-empty path is required");
  }
  return normalized;
}

export async function canonicalRoot(root: string): Promise<string> {
  return realpath(root);
}

export async function resolveExisting(
  root: string,
  relativePath: string,
): Promise<string> {
  const canonical = await canonicalRoot(root);
  const normalized = validateRelativePath(relativePath);
  const lexical = path.resolve(canonical, normalized);
  if (!within(canonical, lexical)) {
    throw new PathViolation("Path leaves the allowed root");
  }
  const resolved = await realpath(lexical);
  if (!within(canonical, resolved)) {
    throw new PathViolation("Symlink leaves the allowed root");
  }
  return resolved;
}

export async function resolveForWrite(
  root: string,
  relativePath: string,
): Promise<string> {
  const canonical = await canonicalRoot(root);
  const normalized = validateRelativePath(relativePath, false);
  const lexical = path.resolve(canonical, normalized);
  if (!within(canonical, lexical)) {
    throw new PathViolation("Path leaves the allowed root");
  }

  let cursor = lexical;
  while (true) {
    try {
      const info = await lstat(cursor);
      const resolved = await realpath(cursor);
      if (!within(canonical, resolved)) {
        throw new PathViolation("Symlink leaves the allowed root");
      }
      if (cursor === lexical && info.isSymbolicLink()) {
        throw new PathViolation("Writing through a symlink is not allowed");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new PathViolation("No safe existing parent was found");
      }
      cursor = parent;
    }
  }
  return lexical;
}

export function relativeFrom(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}
