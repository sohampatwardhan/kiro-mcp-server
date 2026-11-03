import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { SESSION_ID_PATTERN, type AttachedSession } from "../sessions.js";
import { STREAM_TYPES, TranscriptNotifier, readStream, sessionIdFromUri, transcriptUri } from "../transcript.js";
import { defineTool } from "./define.js";
import { json, sessionId } from "./schemas.js";
import { progressReporter } from "./turns.js";

/**
 * Live transcripts (Requirement 26): the kiro_stream_session tool and the
 * subscribable kiro-session://<id>/transcript resource, both views of the
 * session's event feed.
 */
export function registerStreamTools(server: McpServer, core: Core): void {
  const { sessions, turns } = core;
  const notifier = new TranscriptNotifier((uri) => server.server.sendResourceUpdated({ uri }), LIMITS.resourceCoalesceMs);
  const hooked = new WeakSet<AttachedSession>();
  const hook = (session: AttachedSession) => {
    if (hooked.has(session)) return;
    hooked.add(session);
    session.feed.onAppend(() => notifier.touched(session.sessionId));
  };
  sessions.on("attached", hook);
  sessions.on("closed", (session: AttachedSession) => notifier.touched(session.sessionId));

  /** The session to stream: attached or recently closed, else loaded from Kiro's store (replay first). */
  const streamable = async (id: string): Promise<AttachedSession> => {
    const known = sessions.get(id);
    if (known !== undefined) {
      if (!known.closed && known.detached) await sessions.ensureAttached(id).catch(() => undefined);
      hook(known);
      return known;
    }
    const { session } = await sessions.attachById(id);
    hook(session);
    return session;
  };

  const state = (session: AttachedSession) => {
    const turn = turns.latest(session.sessionId);
    return {
      turn_status: turn === undefined ? "idle" : turns.statusOf(turn),
      turn_id: turn?.turnId ?? null,
      session_state: session.closed ? ("closed" as const) : ("attached" as const),
    };
  };

  defineTool(
    server,
    "kiro_stream_session",
    {
      title: "Stream a Kiro session transcript",
      description:
        "Follow a session's transcript live: returns events after `cursor` (agent text, tool calls and results, plan updates, permission requests, turn " +
        "events) and the next cursor, waiting up to wait_s (default 1 s) when nothing is newer. Works for sessions this server did not start: they are loaded " +
        "first, so their history comes first (replay: true), then live events. Re-reading a cursor returns the same events; gap: true means older events " +
        "were dropped. `types` filters (skipped events still advance the cursor); `max_chars` caps the page and sets truncated: true. Also available as " +
        "the subscribable resource kiro-session://<session_id>/transcript (notifications/resources/updated within a second of new events).",
      input: z
        .object({
          session_id: sessionId,
          cursor: z.number().int().min(0).optional(),
          wait_s: z.number().min(0).max(LIMITS.maxWaitS).optional().describe(`Seconds to wait for a new event (default ${LIMITS.streamDefaultWaitS}).`),
          types: z.array(z.enum(STREAM_TYPES)).min(1).max(STREAM_TYPES.length).optional(),
          max_chars: z.number().int().min(500).max(LIMITS.streamMaxChars).optional(),
          limit: z.number().int().min(1).max(1_000).optional(),
          include_thoughts: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        session_id: z.string(),
        events: z.array(json),
        next_cursor: z.number(),
        lowest_cursor: z.number(),
        gap: z.boolean(),
        truncated: z.boolean(),
        omitted_thoughts: z.number(),
        turn_status: z.string(),
        turn_id: z.string().nullable(),
        session_state: z.enum(["attached", "closed"]),
        pending_permissions: z.array(json),
        uri: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      const session = await streamable(args.session_id);
      const cursor = args.cursor ?? 0;
      const options = {
        ...(args.types !== undefined ? { types: args.types } : {}),
        maxChars: args.max_chars ?? LIMITS.streamDefaultMaxChars,
        limit: args.limit ?? 200,
        includeThoughts: args.include_thoughts === true,
      };
      const deadline = Date.now() + (args.wait_s ?? LIMITS.streamDefaultWaitS) * 1_000;
      const stop = progressReporter(extra, session.feed, cursor);
      let page = readStream(session.feed, cursor, options);
      try {
        while (page.events.length === 0 && !session.closed && Date.now() < deadline && extra.signal.aborted !== true) {
          const woke = await session.feed.waitFor(page.nextCursor, deadline - Date.now(), extra.signal);
          page = readStream(session.feed, cursor, options);
          if (!woke) break;
        }
      } finally {
        stop();
      }
      return {
        session_id: session.sessionId,
        events: page.events,
        next_cursor: page.nextCursor,
        lowest_cursor: page.lowestCursor,
        gap: page.gap,
        truncated: page.truncated,
        omitted_thoughts: page.omittedThoughts,
        ...state(session),
        pending_permissions: core.pendingPermissions(session.sessionId),
        uri: transcriptUri(session.sessionId),
      };
    },
  );

  server.registerResource(
    "kiro-session-transcript",
    new ResourceTemplate("kiro-session://{session_id}/transcript", {
      list: async () => ({
        resources: sessions.all().map((s) => ({
          uri: transcriptUri(s.sessionId),
          name: `Transcript ${s.title ?? s.sessionId}${s.closed ? " (closed)" : ""}`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Kiro session transcript",
      description: "The newest events of a Kiro session's feed as JSON. Subscribe for notifications/resources/updated; page with kiro_stream_session.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = String(variables.session_id ?? "");
      if (!SESSION_ID_PATTERN.test(id)) throw new ToolError("SESSION_NOT_FOUND", `invalid session id in ${uri.href}`);
      const session = await streamable(id);
      const body = {
        session_id: session.sessionId,
        ...state(session),
        lowest_cursor: session.feed.lowestCursor,
        next_cursor: session.feed.latestSeq,
        events: session.feed.newest(LIMITS.transcriptResourceBytes),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body) }] };
    },
  );

  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const id = sessionIdFromUri(request.params.uri);
    if (id === null || !SESSION_ID_PATTERN.test(id)) throw new Error(`not a transcript resource: ${request.params.uri}`);
    notifier.subscribe(request.params.uri);
    const session = sessions.get(id);
    if (session !== undefined) hook(session);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    notifier.unsubscribe(request.params.uri);
    return {};
  });
}
