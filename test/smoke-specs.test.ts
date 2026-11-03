import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { connect } from "./smoke-helpers.js";

describe("kiro_specs", () => {
  it("lists spec folders and reads documents with parsed tasks", async () => {
    const c = await connect({
      setup: (work, dir) => {
        const spec = join(work, ".kiro", "specs", "reading-queue");
        mkdirSync(spec, { recursive: true });
        writeFileSync(join(spec, "requirements.md"), "# Requirements\n");
        writeFileSync(join(spec, "tasks.md"), "- [x] 1. CI\n- [ ] 2. Build\n  - _Requirements: 1.1_\n");
        const bug = join(work, ".kiro", "specs", "login-bug");
        mkdirSync(bug, { recursive: true });
        writeFileSync(join(bug, "bugfix.md"), "# Bug\n");
        mkdirSync(join(dir, "outside-spec"));
        writeFileSync(join(dir, "outside-spec", "tasks.md"), "- [ ] 1. secret\n");
        symlinkSync(join(dir, "outside-spec"), join(work, ".kiro", "specs", "escape"));
      },
    });
    try {
      const list = await c.ok<{ specs: { name: string; kind: string; documents: Record<string, { exists: boolean }>; tasks: { checked: number; unchecked: number } }[] }>("kiro_specs", { action: "list", cwd: c.work });
      assert.deepEqual(list.specs.map((s) => s.name), ["login-bug", "reading-queue"]);
      const rq = list.specs.find((s) => s.name === "reading-queue");
      assert.equal(rq?.documents["tasks.md"]?.exists, true);
      assert.equal(rq?.documents["design.md"]?.exists, false);
      assert.deepEqual(rq?.tasks, { checked: 1, unchecked: 1 });
      assert.equal(list.specs.find((s) => s.name === "login-bug")?.kind, "bugfix");
      const read = await c.ok<{ document: { text: string; truncated: boolean; tasks: { number: string; requirements: string[] }[] } }>("kiro_specs", { action: "read", cwd: c.work, spec: "reading-queue", document: "tasks.md" });
      assert.match(read.document.text, /Build/);
      assert.equal(read.document.truncated, false);
      assert.deepEqual(read.document.tasks.map((t) => [t.number, t.requirements]), [["1", []], ["2", ["1.1"]]]);
      assert.equal((await c.fail("kiro_specs", { action: "read", cwd: c.work, spec: "reading-queue", document: "design.md" })).code, "SPEC_NOT_FOUND");
      assert.equal((await c.fail("kiro_specs", { action: "read", cwd: c.work, spec: "nope", document: "tasks.md" })).code, "SPEC_NOT_FOUND");
      assert.equal((await c.fail("kiro_specs", { action: "read", cwd: c.work, spec: "escape", document: "tasks.md" })).code, "PATH_OUTSIDE_ROOTS");
      assert.equal((await c.fail("kiro_specs", { action: "list", cwd: "/" })).code, "PATH_OUTSIDE_ROOTS");
    } finally {
      await c.close();
    }
  });
});
