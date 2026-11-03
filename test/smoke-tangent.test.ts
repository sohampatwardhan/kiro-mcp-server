import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { connect, requests } from "./smoke-helpers.js";

interface TreeNode {
  session_id: string;
  name: string | null;
  children: TreeNode[];
}
interface TangentResult {
  tangent_session_id: string | null;
  name: string | null;
  tree: TreeNode;
  merge: { destination_session_id: string; summary: string; turn: { status: string; final_text: string | null } } | null;
  note: string;
}

describe("kiro_tangent", () => {
  it("refuses to branch an empty session, then branches, merges, and shows the tree", async () => {
    const c = await connect();
    try {
      const root = (await c.ok<{ session_id: string }>("kiro_session_new", { cwd: c.work })).session_id;
      assert.equal((await c.fail("kiro_tangent", { action: "branch", session_id: root })).code, "NOTHING_TO_BRANCH");
      await c.ok("kiro_prompt", { session_id: root, text: "main work" });
      const a = await c.ok<TangentResult>("kiro_tangent", { action: "branch", session_id: root });
      assert.equal(a.name, "tangent-1");
      assert.match(a.note, /does not survive a restart/);
      assert.deepEqual(requests(c, "session/fork").at(-1)?.params, { sessionId: root });
      const b = await c.ok<TangentResult>("kiro_tangent", { action: "branch", session_id: a.tangent_session_id, name: "perf" });
      assert.equal(b.tree.session_id, root);
      assert.deepEqual(b.tree.children[0]?.children.map((n) => n.name), ["perf"]);

      assert.equal((await c.fail("kiro_tangent", { action: "merge", session_id: b.tangent_session_id, destination: "nope" })).code, "TANGENT_NOT_FOUND");
      assert.equal((await c.fail("kiro_tangent", { action: "merge", session_id: b.tangent_session_id, destination: "perf" })).code, "INVALID_MERGE_TARGET");

      const m = await c.ok<TangentResult>("kiro_tangent", { action: "merge", session_id: b.tangent_session_id, destination: "root" });
      assert.equal(m.merge?.destination_session_id, root);
      assert.match(m.merge?.summary ?? "", /Summarize the findings/);
      assert.equal(m.merge?.turn.status, "completed");
      assert.match(m.merge?.turn.final_text ?? "", /Findings from tangent perf/);
      const tree = await c.ok<TangentResult>("kiro_tangent", { action: "tree", session_id: root });
      assert.equal(tree.tree.children.length, 1);
    } finally {
      await c.close();
    }
  });
});
