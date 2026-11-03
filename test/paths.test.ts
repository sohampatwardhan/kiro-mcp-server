import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { Roots, RootsError, parseRoots } from "../src/paths.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kiro-mcp-paths-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const root = join(tmp, "work");
const sibling = join(tmp, "work-other");
const outside = join(tmp, "outside");
for (const dir of [root, sibling, outside, join(root, "src")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "x");
writeFileSync(join(sibling, "b.ts"), "x");
writeFileSync(join(tmp, "file.txt"), "x");
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(root, "src"), join(outside, "into-root"));

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
}

describe("parseRoots", () => {
  it("defaults to the fallback directory, as a real path", () => {
    assert.deepEqual(parseRoots(undefined, root), [root]);
  });

  it("splits a comma list and stores real paths", () => {
    assert.deepEqual(parseRoots(` ${root} , ${join(outside, "into-root")} `, tmp), [root, join(root, "src")]);
  });

  it("refuses /, relative paths, missing paths, and files", () => {
    for (const raw of ["/", "relative/dir", join(tmp, "missing"), join(tmp, "file.txt")]) {
      assert.throws(() => parseRoots(raw, tmp), RootsError, raw);
    }
  });

  it("makes loadConfig fail with KIRO_MCP_ROOTS in the message", () => {
    assert.throws(
      () => loadConfig({ KIRO_MCP_CWD: tmp, KIRO_MCP_ROOTS: "/" }),
      (err: unknown) => err instanceof ConfigError && err.message.includes("KIRO_MCP_ROOTS"),
    );
  });
});

describe("Roots.resolveInside", () => {
  const roots = new Roots([root]);

  it("accepts the root and paths inside it", async () => {
    assert.equal(await roots.resolveInside(root), root);
    assert.equal(await roots.resolveInside(join(root, "src", "a.ts")), join(root, "src", "a.ts"));
  });

  it("resolves relative paths against the base", async () => {
    assert.equal(await roots.resolveInside("src/a.ts", root), join(root, "src", "a.ts"));
  });

  it("refuses a sibling that shares the name prefix", async () => {
    assert.equal(await code(roots.resolveInside(join(sibling, "b.ts"))), "PATH_OUTSIDE_ROOTS");
  });

  it("refuses a symlink that points outside", async () => {
    assert.equal(await code(roots.resolveInside(join(root, "escape"))), "PATH_OUTSIDE_ROOTS");
  });

  it("accepts a symlink outside that points into a root", async () => {
    assert.equal(await roots.resolveInside(join(outside, "into-root")), join(root, "src"));
  });

  it("refuses .. traversal and missing paths", async () => {
    assert.equal(await code(roots.resolveInside(join(root, "..", "outside"))), "PATH_OUTSIDE_ROOTS");
    assert.equal(await code(roots.resolveInside(join(root, "missing.txt"))), "PATH_OUTSIDE_ROOTS");
  });

  it("resolves a new file's parent for writes", async () => {
    assert.equal(await roots.resolveForWrite(join(root, "src", "new.json")), join(root, "src", "new.json"));
    assert.equal(await code(roots.resolveForWrite(join(outside, "new.json"))), "PATH_OUTSIDE_ROOTS");
    assert.equal(await code(roots.resolveForWrite(join(root, "escape", "new.json"))), "PATH_OUTSIDE_ROOTS");
  });

  it("treats /tmp and /private/tmp as one path on macOS", { skip: process.platform !== "darwin" }, async () => {
    const dir = mkdtempSync("/tmp/kiro-mcp-mac-");
    try {
      const real = realpathSync(dir);
      assert.ok(real.startsWith("/private/tmp/"));
      const macRoots = new Roots(parseRoots(dir, tmp));
      assert.equal(await macRoots.resolveInside(dir), real);
      assert.equal(await macRoots.resolveInside(real), real);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
