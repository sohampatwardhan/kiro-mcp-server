import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NAME_PATTERN } from "../argv.js";
import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { TangentTree, treeView } from "../tangent.js";
import { turnView } from "../turns.js";
import { defineTool } from "./define.js";
import { forkSession } from "./history.js";
import { json, sessionId, waitS } from "./schemas.js";
import { turnOutput } from "./turns.js";

const SUMMARY_PROMPT =
  "Summarize the findings of this tangent for the main conversation: what you explored, what you concluded, and anything that should change. Be brief.";
const IN_MEMORY_NOTE = "The tangent tree is held in this server's memory and does not survive a restart; the forked sessions stay in Kiro's store.";

export function registerBranchingTools(server: McpServer, core: Core): void {
  const { sessions, turns } = core;
  const tree = new TangentTree();

  defineTool(
    server,
    "kiro_tangent",
    {
      title: "Kiro tangents",
      description:
        "Tangents, like /tangent: `branch` forks the session at its latest message into a named side conversation (default tangent-N) and attaches it; " +
        "`tree` shows the recorded tangent tree; `merge` prompts the tangent once for a short findings summary, then sends that summary to the destination " +
        "(`parent` by default, `root`, or a tangent name) as a new turn. The tangent itself is left unchanged. " +
        IN_MEMORY_NOTE,
      input: z
        .object({
          action: z.enum(["branch", "tree", "merge"]),
          session_id: sessionId,
          name: z.string().regex(NAME_PATTERN).optional(),
          destination: z.string().regex(NAME_PATTERN).optional(),
          wait_s: waitS(LIMITS.maxWaitS - 5, "Seconds to wait for the summary turn and the destination turn"),
        })
        .strict(),
      output: z.object({
        action: z.string(),
        tangent_session_id: z.string().nullable(),
        name: z.string().nullable(),
        tree: json,
        merge: z.object({ destination_session_id: z.string(), summary: z.string(), cursor: z.number(), turn: turnOutput }).nullable(),
        note: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { session } = await sessions.attachById(args.session_id);
      if (args.action === "tree") {
        return { action: "tree", tangent_session_id: null, name: null, tree: treeView(tree.tree(session.sessionId)), merge: null, note: IN_MEMORY_NOTE };
      }
      if (args.action === "branch") {
        const hasMessages = session.userMessages.length > 0 || session.feed.read(0, LIMITS.feedEvents).events.some((e) => e.type === "message" || e.type === "user_message");
        if (!hasMessages) throw new ToolError("NOTHING_TO_BRANCH", "this session has no messages to branch from yet");
        const fork = await forkSession(core, session.sessionId);
        const node = tree.branch(session.sessionId, fork.sessionId, args.name);
        return { action: "branch", tangent_session_id: fork.sessionId, name: node.name, tree: treeView(tree.tree(session.sessionId)), merge: null, note: IN_MEMORY_NOTE };
      }
      const destId = tree.resolve(session.sessionId, args.destination ?? "parent");
      const { session: dest } = await sessions.attachById(destId);
      if (turns.activeTurn(dest.sessionId) !== undefined) throw new ToolError("TURN_ACTIVE", "the merge destination has a running turn; wait for it or cancel it");
      await core.usage.guard();
      const waitMs = (args.wait_s ?? LIMITS.maxWaitS - 5) * 1_000;
      const deadline = Date.now() + waitMs;
      const summaryTurn = turns.start(session, [{ type: "text", text: SUMMARY_PROMPT }], "reject");
      if (!(await turns.waitSettled(summaryTurn, waitMs))) {
        throw new ToolError("TIMEOUT", "the tangent did not finish its summary in time; poll kiro_events on the tangent and merge again", { turn_id: summaryTurn.turnId });
      }
      if (summaryTurn.status !== "completed") throw new ToolError("KIRO_ERROR", `the summary turn ended ${summaryTurn.status}`, { turn: turnView(summaryTurn) });
      const node = tree.tree(session.sessionId);
      const name = findName(node, session.sessionId) ?? session.sessionId;
      const summary = summaryTurn.finalText;
      const mergeTurn = turns.start(dest, [{ type: "text", text: `Findings from tangent ${name}:\n\n${summary}` }], "reject");
      await turns.waitSettled(mergeTurn, Math.max(0, deadline - Date.now()));
      return {
        action: "merge",
        tangent_session_id: session.sessionId,
        name,
        tree: treeView(node),
        merge: { destination_session_id: dest.sessionId, summary, cursor: dest.feed.latestSeq, turn: { ...turnView(mergeTurn), status: turns.statusOf(mergeTurn) } },
        note: IN_MEMORY_NOTE,
      };
    },
  );
}

function findName(node: ReturnType<TangentTree["tree"]>, sessionId: string): string | null {
  if (node.sessionId === sessionId) return node.name;
  for (const child of node.children) {
    const hit = findName(child, sessionId);
    if (hit !== null) return hit;
  }
  return null;
}
