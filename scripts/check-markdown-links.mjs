#!/usr/bin/env node
// Checks current project Markdown; private and dependency files are excluded.
// External URLs and fragments are skipped; local relative targets must stay inside this repository and exist.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);

function gitPaths() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isProjectMarkdown(file) {
  if (!/\.mdx?$/i.test(file)) return false;
  const segments = file.split(/[\\/]+/);
  return !segments.some((segment) => [".git", "node_modules", "private", "privado"].includes(segment.toLowerCase()));
}

function withoutFencedCode(markdown) {
  const output = [];
  let fenceChar = null;
  let fenceLength = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceChar === null && fence) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      output.push("");
      continue;
    }
    if (fenceChar !== null) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
      output.push("");
      continue;
    }
    output.push(line.replace(/(`+)(.*?)\1/g, ""));
  }

  return output.join("\n");
}

function extractTargets(markdown) {
  const source = withoutFencedCode(markdown);
  const targets = [];
  const inline = /!?\[[^\]]*\]\(\s*(<[^>]*>|(?:\\.|[^\s)])+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const reference = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm;

  for (const match of source.matchAll(inline)) targets.push(match[1]);
  for (const match of source.matchAll(reference)) targets.push(match[1]);
  return targets;
}

function localPathFromTarget(target) {
  let value = target.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  value = value.replace(/\\(.)/g, "$1");

  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//") || value.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  const pathPart = value.split(/[?#]/, 1)[0];
  if (!pathPart) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
  return decoded;
}

const markdownFiles = [...new Set(gitPaths().filter(isProjectMarkdown))]
  .filter((file) => {
    const absolute = path.join(root, file);
    return existsSync(absolute) && lstatSync(absolute).isFile();
  })
  .sort();

const errors = [];
for (const file of markdownFiles) {
  const source = readFileSync(path.join(root, file), "utf8");
  for (const target of extractTargets(source)) {
    const localPath = localPathFromTarget(target);
    if (localPath === null) continue;

    const resolved = path.resolve(root, path.dirname(file), localPath);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      errors.push(`${file}: relative link leaves the repository: ${target}`);
      continue;
    }
    if (!existsSync(resolved)) errors.push(`${file}: missing link target: ${target}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked relative Markdown links in ${markdownFiles.length} project files.\n`);
}
