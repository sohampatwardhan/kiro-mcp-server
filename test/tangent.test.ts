import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import { TangentTree } from "../src/tangent.js";

const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
};

describe("TangentTree", () => {
  it("names branches tangent-N per root and nests them", () => {
    const t = new TangentTree();
    assert.equal(t.branch("root", "a").name, "tangent-1");
    assert.equal(t.branch("root", "b", "perf").name, "perf");
    assert.equal(t.branch("a", "c").name, "tangent-2");
    assert.equal(t.branch("root", "d", "perf").name, "perf-2");
    const tree = t.tree("c");
    assert.equal(tree.sessionId, "root");
    assert.deepEqual(tree.children.map((n) => n.name), ["tangent-1", "perf", "perf-2"]);
    assert.deepEqual(tree.children[0]?.children.map((n) => n.sessionId), ["c"]);
  });

  it("resolves parent, root, and named destinations", () => {
    const t = new TangentTree();
    t.branch("root", "a", "x");
    t.branch("a", "b", "y");
    assert.equal(t.resolve("b", "parent"), "a");
    assert.equal(t.resolve("b", "root"), "root");
    assert.equal(t.resolve("b", "x"), "a");
    assert.equal(t.resolve("a", "y"), "b");
  });

  it("refuses missing and self destinations", () => {
    const t = new TangentTree();
    t.branch("root", "a", "x");
    assert.equal(code(() => t.resolve("a", "nope")), "TANGENT_NOT_FOUND");
    assert.equal(code(() => t.resolve("a", "x")), "INVALID_MERGE_TARGET");
    assert.equal(code(() => t.resolve("root", "parent")), "INVALID_MERGE_TARGET");
    assert.equal(code(() => t.resolve("root", "root")), "INVALID_MERGE_TARGET");
    assert.equal(code(() => t.resolve("unknown", "parent")), "TANGENT_NOT_FOUND");
  });
});
