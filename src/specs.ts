import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";
import type { Roots } from "./paths.js";

export const SPEC_DOCUMENTS = ["requirements.md", "bugfix.md", "design.md", "tasks.md"] as const;
export type SpecDocument = (typeof SPEC_DOCUMENTS)[number];
export const SPEC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ParsedTask {
  number: string;
  title: string;
  checked: boolean;
  optional: boolean;
  requirements: string[];
}

/** Numbered `- [ ]` / `- [x]` lines outside code fences, with their `_Requirements:_` ids. */
export function parseTasks(text: string): { tasks: ParsedTask[]; checked: number; unchecked: number } {
  const tasks: ParsedTask[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const task = /^\s*- \[([ xX])\]\*?\s+(\d+(?:\.\d+)?)\.?\s+(.*)$/.exec(line);
    if (task !== null) {
      const title = (task[3] ?? "").trim();
      tasks.push({ number: task[2] ?? "", title, checked: task[1] !== " ", optional: /\(optional\)\s*$/i.test(title) || /- \[[ xX]\]\*/.test(line), requirements: [] });
      continue;
    }
    const reqs = /^\s*- _Requirements:\s*([^_]*)_\s*$/.exec(line);
    const last = tasks.at(-1);
    if (reqs !== null && last !== undefined) last.requirements = (reqs[1] ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  }
  const checked = tasks.filter((t) => t.checked).length;
  return { tasks, checked, unchecked: tasks.length - checked };
}

async function mtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Every folder under `<cwd>/.kiro/specs` (Requirement 14.2). */
export async function listSpecs(roots: Roots, cwd: string) {
  const dir = join(cwd, ".kiro", "specs");
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && SPEC_NAME_PATTERN.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries.sort()) {
    try {
      await roots.resolveInside(join(dir, name));
    } catch {
      continue; // a symlink out of the roots is not listed
    }
    const documents: Record<string, { exists: boolean; modified_at: string | null }> = {};
    for (const doc of SPEC_DOCUMENTS) {
      const modified = await mtime(join(dir, name, doc));
      documents[doc] = { exists: modified !== null, modified_at: modified };
    }
    let tasks = { checked: 0, unchecked: 0 };
    if (documents["tasks.md"]?.exists === true) {
      try {
        const real = await roots.resolveInside(join(dir, name, "tasks.md"));
        const parsed = parseTasks(await readFile(real, "utf8"));
        tasks = { checked: parsed.checked, unchecked: parsed.unchecked };
      } catch {
        // unreadable or outside the roots: counts stay zero
      }
    }
    out.push({ name, kind: documents["bugfix.md"]?.exists === true ? "bugfix" : "feature", documents, tasks });
  }
  return out;
}

/** One spec document, truncated at the read cap, with parsed tasks for tasks.md (Requirement 14.3, 14.4). */
export async function readSpec(roots: Roots, cwd: string, spec: string, document: SpecDocument) {
  if (!SPEC_NAME_PATTERN.test(spec)) throw new ToolError("SPEC_NOT_FOUND", `invalid spec name ${JSON.stringify(spec)}`);
  const path = join(cwd, ".kiro", "specs", spec, document);
  let real: string;
  try {
    real = await roots.resolveInside(path);
  } catch (err) {
    if (err instanceof ToolError && err.details.reason === "does not exist") throw new ToolError("SPEC_NOT_FOUND", `${spec}/${document} does not exist`, { spec, document });
    throw err;
  }
  const bytes = await readFile(real);
  const truncated = bytes.length > LIMITS.specReadBytes;
  const text = bytes.subarray(0, LIMITS.specReadBytes).toString("utf8");
  return {
    spec,
    document,
    path: real,
    bytes: bytes.length,
    truncated,
    text,
    tasks: document === "tasks.md" ? parseTasks(text).tasks : null,
  };
}
