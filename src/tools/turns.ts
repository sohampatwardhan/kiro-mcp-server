import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { NAME_PATTERN } from "../argv.js";
import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import type { EventFeed, KiroEvent } from "../events.js";
import { buildPromptBlocks } from "../prompt.js";
import type { AttachedSession } from "../sessions.js";
import { turnView, type Turn } from "../turns.js";
import { defineTool, type ToolExtra } from "./define.js";
import { json, pathInput, sessionId, waitS } from "./schemas.js";

const turnShape = z.object({
  turn_id: z.string(),
  session_id: z.string(),
  status: z.string(),
  stop_reason: z.string().nullable(),
  final_text: z.string().nullable(),
  tool_calls: z.array(
    z.object({ tool_call_id: z.string(), title: z.string(), kind: z.string().nullable(), status: z.string(), failure_reason: z.string().nullable() }),
  ),
  credits: z.array(json),
  elapsed_ms: z.number().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const turnOutput = turnShape;

/** Send MCP progress notifications while a call waits, when the request carried a progressToken (Requirement 10.9). */
export function progressReporter(extra: ToolExtra, feed: EventFeed, startCursor: number): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  let last = -1;
  const send = () => {
    const count = feed.latestSeq - startCursor;
    if (count === last) return;
    last = count;
    void extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.max(count, 0), message: `${Math.max(count, 0)} new events` } })
      .catch(() => undefined);
  };
  send();
  const unsubscribe = feed.onAppend(() => {
    if (timer === undefined) timer = setTimeout(flush, 250);
  });
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    send();
  };
  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function turnStatusView(core: Core, turn: Turn | undefined) {
  if (turn === undefined) return { status: "idle", turn: null };
  const view = turnView(turn);
  const status = core.turns.statusOf(turn);
  return { status, turn: { ...view, status } };
}

export interface EventsQuery {
  cursor: number;
  limit: number;
  waitMs: number;
  includeThoughts: boolean;
  signal?: AbortSignal;
  filter?: (event: KiroEvent) => boolean;
}

/** Long-poll a feed: wait until a matching event is newer than the cursor, or the time runs out. */
export async function pollFeed(feed: EventFeed, q: EventsQuery) {
  const deadline = Date.now() + q.waitMs;
  let omittedThoughts = 0;
  const filter = (event: KiroEvent) => {
    if (event.type === "thought" && !q.includeThoughts) {
      omittedThoughts++;
      return false;
    }
    return q.filter === undefined || q.filter(event);
  };
  for (;;) {
    omittedThoughts = 0;
    const page = feed.read(q.cursor, q.limit, filter);
    if (page.events.length > 0 || feed.closed) return { ...page, omittedThoughts };
    const remaining = deadline - Date.now();
    if (remaining <= 0 || q.signal?.aborted === true) return { ...page, omittedThoughts };
    const woke = await feed.waitFor(page.nextCursor, remaining, q.signal);
    if (!woke) return { ...feed.read(q.cursor, q.limit, filter), omittedThoughts };
  }
}

export function registerTurnTools(server: McpServer, core: Core): void {
  const { sessions, turns, host, roots } = core;

  defineTool(
    server,
    "kiro_prompt",
    {
      title: "Prompt a Kiro session",
      description:
        "Send a prompt to an attached session (session/prompt) and wait up to wait_s for the turn to finish. Returns the finished turn " +
        "(final text, tool calls, credits) or status `running` with a turn_id and cursor: then poll kiro_events with that cursor until the status is " +
        "completed, cancelled, or failed, answering any pending_permissions with kiro_permission_respond. A turn finishes only when Kiro answers the prompt. " +
        "Add files as links (or embedded UTF-8 text with embed: true) and images from a path or base64. `command` runs an advertised skill, MCP prompt, " +
        "or sub-agent as `/<name> <input>`; text starting with `@name` runs a saved prompt. when_busy `queue` waits behind the running turn.",
      input: z
        .object({
          session_id: sessionId,
          text: z.string().min(1).max(LIMITS.maxTextChars).optional(),
          files: z.array(z.object({ path: pathInput("File inside KIRO_MCP_ROOTS."), embed: z.boolean().optional() }).strict()).max(LIMITS.maxFiles).optional(),
          images: z
            .array(z.union([z.object({ path: pathInput("Image file inside KIRO_MCP_ROOTS.") }).strict(), z.object({ data: z.string().min(1), mime_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]) }).strict()]))
            .max(LIMITS.maxImages)
            .optional(),
          command: z.object({ name: z.string().regex(NAME_PATTERN), input: z.string().max(LIMITS.maxTextChars).optional() }).strict().optional(),
          wait_s: waitS(LIMITS.defaultWaitS),
          when_busy: z.enum(["reject", "queue"]).optional(),
        })
        .strict()
        .refine((v) => v.text !== undefined || v.command !== undefined, { message: "pass text or command" }),
      output: z.object({
        turn_id: z.string(),
        session_id: z.string(),
        status: z.string(),
        queued: z.boolean(),
        cursor: z.number(),
        turn: turnShape,
        pending_permissions: z.array(json),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const { session } = await sessions.attachById(args.session_id);
      await host.ensureStarted();
      const blocks = await buildPromptBlocks(
        {
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.files !== undefined ? { files: args.files } : {}),
          ...(args.images !== undefined ? { images: args.images } : {}),
          ...(args.command !== undefined ? { command: { name: args.command.name, ...(args.command.input !== undefined ? { input: args.command.input } : {}) } } : {}),
        },
        { roots, cwd: session.cwd, promptCapabilities: host.capabilities?.promptCapabilities ?? {}, commands: session.commands },
      );
      const startCursor = session.feed.latestSeq;
      const turn = turns.start(session, blocks, args.when_busy ?? "reject");
      const stopProgress = progressReporter(extra, session.feed, startCursor);
      try {
        await turns.waitSettled(turn, (args.wait_s ?? LIMITS.defaultWaitS) * 1_000, extra.signal);
      } finally {
        stopProgress();
      }
      const status = turns.statusOf(turn);
      return {
        turn_id: turn.turnId,
        session_id: session.sessionId,
        status,
        queued: turn.status === "queued",
        cursor: session.feed.latestSeq,
        turn: { ...turnView(turn), status },
        pending_permissions: core.pendingPermissions(session.sessionId),
      };
    },
  );

  defineTool(
    server,
    "kiro_events",
    {
      title: "Read Kiro session events",
      description:
        "Read normalized events after `cursor` from a session's (or headless job's) event feed: agent text, tool calls, plan updates, permission requests, " +
        "turn boundaries with credits, mode and config changes, steering, workflow, and notices. Long-polls up to wait_s when nothing is newer. " +
        "A message or tool call that changes is re-sent with a new seq: keep the latest per `segment` or `toolCallId`. Thoughts are left out unless include_thoughts. " +
        "Returns next_cursor, lowest_cursor (gap: true when older events were dropped), the turn status, and pending permissions.",
      input: z
        .object({
          session_id: sessionId.optional(),
          job_id: z.string().regex(/^job_[0-9a-f]{24}$/).optional(),
          cursor: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(1_000).optional(),
          wait_s: waitS(0),
          include_thoughts: z.boolean().optional(),
        })
        .strict()
        .refine((v) => (v.session_id === undefined) !== (v.job_id === undefined), { message: "pass exactly one of session_id or job_id" }),
      output: z.object({
        session_id: z.string().nullable(),
        job_id: z.string().nullable(),
        events: z.array(json),
        next_cursor: z.number(),
        lowest_cursor: z.number(),
        gap: z.boolean(),
        omitted_thoughts: z.number(),
        status: z.string(),
        turn: turnShape.nullable(),
        job: json,
        pending_permissions: z.array(json),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      if (args.job_id !== undefined) return (await core.jobEvents(args.job_id, args, extra)) as never;
      const session = sessionFeedOwner(core, args.session_id ?? "");
      const cursor = args.cursor ?? 0;
      const stopProgress = progressReporter(extra, session.feed, cursor);
      let page;
      try {
        page = await pollFeed(session.feed, {
          cursor,
          limit: args.limit ?? 200,
          waitMs: (args.wait_s ?? 0) * 1_000,
          includeThoughts: args.include_thoughts === true,
          ...(extra.signal ? { signal: extra.signal } : {}),
        });
      } finally {
        stopProgress();
      }
      const { status, turn } = turnStatusView(core, turns.latest(session.sessionId));
      return {
        session_id: session.sessionId,
        job_id: null,
        events: page.events,
        next_cursor: page.nextCursor,
        lowest_cursor: page.lowestCursor,
        gap: page.gap,
        omitted_thoughts: page.omittedThoughts,
        status: session.closed && status === "idle" ? "closed" : status,
        turn,
        job: null,
        pending_permissions: core.pendingPermissions(session.sessionId),
      };
    },
  );
}

/** An attached or recently closed session whose feed can be read. */
export function sessionFeedOwner(core: Core, id: string): AttachedSession {
  const session = core.sessions.get(id);
  if (session === undefined) throw new ToolError("SESSION_NOT_FOUND", `session ${id} is not attached to this server; load it with kiro_session_load`, { sessionId: id });
  return session;
}
