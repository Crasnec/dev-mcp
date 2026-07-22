#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const fix = process.argv.includes("--fix");
const roots = ["packages", "scripts"];
const files = roots.flatMap((root) => collect(root));

if (fix) {
  for (const filename of files) {
    const original = readFileSync(filename, "utf8");
    const formatted = original
      .split("\n")
      .flatMap((line) => addIfBlock(line))
      .join("\n");
    if (formatted !== original) {
      writeFileSync(filename, formatted);
    }
  }
  process.exit(0);
}

const violations = files.flatMap((filename) => inspect(filename));
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  process.exitCode = 1;
}

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "dist" ? [] : collect(filename);
    }
    return /\.(?:ts|mjs)$/.test(entry.name) ? [filename] : [];
  });
}

function addIfBlock(line) {
  const match = /\bif\s*\(/.exec(line);
  if (!match) {
    return [line];
  }
  const close = closingParenthesis(line, line.indexOf("(", match.index));
  if (close < 0) {
    return [line];
  }
  const bodyStart = nextNonWhitespace(line, close + 1);
  if (bodyStart < 0 || line[bodyStart] === "{") {
    return [line];
  }
  const prefix = line.slice(0, bodyStart).trimEnd();
  const statement = line.slice(bodyStart).trim();
  const indentation = /^\s*/.exec(line)?.[0] ?? "";
  return [`${prefix} {`, `${indentation}  ${statement}`, `${indentation}}`];
}

function inspect(filename) {
  const source = readFileSync(filename, "utf8");
  const violations = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (/from\s+["']\.\.?\/[^"']+\.js["']/.test(line)) {
      violations.push(
        `${filename}:${index + 1}: relative imports must use .ts or omit the extension`,
      );
    }
    const match = /\bif\s*\(/.exec(line);
    if (!match) {
      continue;
    }
    const close = closingParenthesis(line, line.indexOf("(", match.index));
    if (close >= 0) {
      const bodyStart = nextNonWhitespace(line, close + 1);
      if (bodyStart >= 0 && line[bodyStart] !== "{") {
        violations.push(`${filename}:${index + 1}: if bodies must use blocks`);
      }
      if (
        bodyStart >= 0 &&
        line[bodyStart] === "{" &&
        line.slice(bodyStart + 1).includes("}")
      ) {
        violations.push(
          `${filename}:${index + 1}: if blocks must not be written on one line`,
        );
      }
    }
  }
  if (/from\s+["']@dev-mcp\/shared["']/.test(source)) {
    violations.push(`${filename}: shared package references are forbidden`);
  }
  return violations;
}

function closingParenthesis(line, open) {
  let depth = 0;
  let quote = "";
  for (let index = open; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function nextNonWhitespace(line, start) {
  for (let index = start; index < line.length; index += 1) {
    if (!/\s/.test(line[index])) {
      return index;
    }
  }
  return -1;
}
