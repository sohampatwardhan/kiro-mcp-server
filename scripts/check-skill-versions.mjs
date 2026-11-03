#!/usr/bin/env node
// Fails if any SKILL.md lacks a SemVer 2.0.0 `metadata.version` in its YAML frontmatter.
// Dependency-free: parses only the small frontmatter subset that SKILL.md files use.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Official SemVer 2.0.0 regex (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string)
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const root = process.argv[2] ?? process.cwd();

function findSkillFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findSkillFiles(join(dir, entry.name)));
    } else if (entry.name === "SKILL.md") {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Returns an error string, or null if the file is valid.
function checkFile(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  if (lines[0] !== "---") return "missing YAML frontmatter";
  const end = lines.indexOf("---", 1);
  if (end === -1) return "unterminated YAML frontmatter";
  const fm = lines.slice(1, end);

  const start = fm.findIndex((l) => /^metadata:\s*$/.test(l));
  if (start === -1) return "missing `metadata` map in frontmatter";

  for (const line of fm.slice(start + 1)) {
    if (!/^\s+/.test(line)) break; // left the metadata block
    const m = line.match(/^\s+version:\s*(.*)$/);
    if (m) {
      const version = unquote(m[1]);
      if (!/^\s*["']/.test(m[1])) return `metadata.version must be a quoted string (got ${m[1]})`;
      return SEMVER.test(version) ? null : `metadata.version "${version}" is not valid SemVer 2.0.0`;
    }
  }
  return "missing `metadata.version`";
}

const files = findSkillFiles(root);
if (files.length === 0) {
  console.error("No SKILL.md files found.");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const error = checkFile(file);
  const rel = relative(root, file) || file;
  if (error) {
    failed++;
    console.error(`FAIL ${rel}: ${error}`);
  } else {
    console.log(`ok   ${rel}`);
  }
}

if (failed) {
  console.error(`\n${failed} of ${files.length} SKILL.md file(s) failed the version check.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} SKILL.md file(s) have a valid metadata.version.`);
