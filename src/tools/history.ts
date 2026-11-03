import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { SessionNormalizer, type KiroEvent } from "../events.js";
import { defineTool } from "./define.js";
import { json, sessionId } from "./schemas.js";
import { sessionSummary, sessionSummaryShape } from "./sessions.js";

/** Collapse normalized events into transcript entries: one per message segment or tool call. */
export function transcriptEntries(events: KiroEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === "message" || e.type === "user_message" || e.type === "thought" || e.type === "tool_call" || e.type === "plan")
    .map((e) => {
      switch (e.type) {
        case "message":
        case "user_message":
        case "thought":
          return { role: e.type === "user_message" ? "user" : e.type === "thought" ? "thought" : "agent", text: e.text };
        case "tool_call":
          return { role: "tool", tool_call_id: e.toolCallId, title: e.title, kind: e.kind ?? null, status: e.status, failure_reason: e.failureReason ?? null };
        case "plan":
          return { role: "plan", entries: e.entries };
        default:
          return { role: "other" };
      }
    });
}

export function registerHistoryTools(server: McpServer, core: Core): void {
  const { host, sessions } = core;

  defineTool(
    server,
    "kiro_session_history",
    {
      title: "Kiro session transcript",
      description:
        "Read a session's transcript (_kiro/session/history), paged with cursor and limit, like /transcript. Falls back to this server's event feed when Kiro returns no history. " +
        "`rewind_points` lists each user message id with its turn number and a prompt preview: pass one as message_id to kiro_session_fork to rewind.",
      input: z
        .object({
          session_id: sessionId,
          cursor: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .strict(),
      output: z.object({
        session_id: z.string(),
        source: z.enum(["kiro", "feed"]),
        entries: z.array(json),
        rewind_points: z.array(z.object({ message_id: z.string(), turn_index: z.number(), preview: z.string() })),
        has_more: z.boolean(),
        next_cursor: z.number().nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session } = await sessions.attachById(args.session_id);
      const limit = args.limit ?? 100;
      const rewind_points = session.userMessages.map((m) => ({ message_id: m.messageId, turn_index: m.turnIndex, preview: m.preview }));
      let updates: unknown[] = [];
      let hasMore = false;
      let nextCursor: number | null = null;
      if (host.supports("_kiro/session/history")) {
        const result = (await host.call("_kiro/session/history", {
          sessionId: session.sessionId,
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          limit,
        })) as { updates?: unknown[]; hasMore?: unknown; nextCursor?: unknown } | null;
        updates = Array.isArray(result?.updates) ? result.updates : [];
        hasMore = result?.hasMore === true;
        nextCursor = typeof result?.nextCursor === "number" ? result.nextCursor : hasMore ? (args.cursor ?? 0) + updates.length : null;
      }
      if (updates.length > 0 || args.cursor !== undefined) {
        const norm = new SessionNormalizer();
        const collected = new Map<string, KiroEvent>();
        let seq = 0;
        for (const u of updates) {
          for (const { event, key } of norm.apply(u, { replay: true }).events) {
            const full = { ...event, seq: ++seq, at: "" } as KiroEvent;
            collected.delete(key ?? `#${seq}`);
            collected.set(key ?? `#${seq}`, full);
          }
        }
        const events = [...collected.values()].sort((a, b) => a.seq - b.seq);
        return { session_id: session.sessionId, source: "kiro" as const, entries: transcriptEntries(events), rewind_points, has_more: hasMore, next_cursor: nextCursor };
      }
      const page = session.feed.read(0, session.feed.size);
      const entries = transcriptEntries(page.events);
      return { session_id: session.sessionId, source: "feed" as const, entries: entries.slice(-limit), rewind_points, has_more: entries.length > limit, next_cursor: null };
    },
  );

  defineTool(
    server,
    "kiro_session_fork",
    {
      title: "Fork a Kiro session",
      description:
        "Fork a session with session/fork, optionally at a user message id from kiro_session_history's rewind_points (that is /rewind). " +
        "The fork is attached as a new session; the original is unchanged.",
      input: z.object({ session_id: sessionId, message_id: z.string().min(1).max(200).optional() }).strict(),
      output: z.object({ ...sessionSummaryShape, parent_session_id: z.string(), message_id: z.string().nullable() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { session } = await sessions.attachById(args.session_id);
      const fork = await forkSession(core, session.sessionId, args.message_id);
      return { ...sessionSummary(fork), parent_session_id: session.sessionId, message_id: args.message_id ?? null };
    },
  );
}

/** session/fork, then attach the new session with the parent's workspace. */
export async function forkSession(core: Core, parentId: string, messageId?: string) {
  const parent = core.sessions.require(parentId);
  if (core.host.capabilities?.sessionCapabilities?.fork === undefined) {
    throw new ToolError("UNSUPPORTED_BY_KIRO", "this Kiro host does not advertise session/fork");
  }
  const result = (await core.host.call("session/fork", {
    sessionId: parent.sessionId,
    ...(messageId !== undefined ? { _meta: { kiro: { messageId } } } : {}),
  })) as Record<string, unknown> | null;
  const id = typeof result?.sessionId === "string" ? result.sessionId : null;
  if (id === null) throw new ToolError("OUTPUT_PARSE_FAILED", "session/fork returned no sessionId");
  return core.sessions.attach(id, result ?? {}, {
    cwd: parent.cwd,
    additionalDirectories: parent.additionalDirectories,
    source: parent.source,
    executionTarget: parent.executionTarget,
  });
}
