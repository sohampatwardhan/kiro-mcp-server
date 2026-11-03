import type { EventFeed, KiroEvent } from "./events.js";

/** `kiro-session://<session_id>/transcript` (Requirement 26.5). */
export function transcriptUri(sessionId: string): string {
  return `kiro-session://${sessionId}/transcript`;
}

export function sessionIdFromUri(uri: string): string | null {
  return /^kiro-session:\/\/([^/]+)\/transcript$/.exec(uri)?.[1] ?? null;
}

/** Stream types; `permission` covers both permission event types. */
export const STREAM_TYPES = ["message", "user_message", "thought", "tool_call", "plan", "permission", "turn", "state", "steering", "workflow", "notice", "unknown"] as const;
export type StreamType = (typeof STREAM_TYPES)[number];

export interface StreamOptions {
  types?: readonly string[];
  maxChars: number;
  limit: number;
  includeThoughts: boolean;
}

export interface StreamPage {
  events: KiroEvent[];
  nextCursor: number;
  lowestCursor: number;
  gap: boolean;
  truncated: boolean;
  omittedThoughts: number;
}

function typeOf(event: KiroEvent): string {
  return event.type === "permission_requested" || event.type === "permission_resolved" ? "permission" : event.type;
}

/** Cut long text fields so one event fits `maxChars`. */
function clip(event: KiroEvent, maxChars: number): KiroEvent {
  const copy = { ...event } as Record<string, unknown>;
  for (const key of ["text", "rawOutputTail", "message"]) {
    const value = copy[key];
    if (typeof value === "string" && value.length > maxChars / 2) copy[key] = `${value.slice(0, Math.max(0, Math.floor(maxChars / 2)))}…`;
  }
  if (JSON.stringify(copy).length > maxChars) {
    delete copy.rawInput;
    delete copy.detail;
  }
  return copy as KiroEvent;
}

/**
 * Read a feed for kiro_stream_session (Requirement 26.1, 26.3, 26.4): events
 * after `cursor` that pass the type filter, until `limit` or `maxChars` of
 * serialized events. Skipped events still advance the cursor; a truncated page
 * resumes at the first event it left out.
 */
export function readStream(feed: EventFeed, cursor: number, o: StreamOptions): StreamPage {
  const wanted = o.types !== undefined && o.types.length > 0 ? new Set(o.types) : null;
  const thoughtsOk = o.includeThoughts || (wanted?.has("thought") ?? false);
  const all = feed.read(cursor, Number.MAX_SAFE_INTEGER);
  const events: KiroEvent[] = [];
  let size = 0;
  let next = cursor;
  let truncated = false;
  let omittedThoughts = 0;
  for (const event of all.events) {
    if (event.type === "thought" && !thoughtsOk) {
      omittedThoughts++;
      next = event.seq;
      continue;
    }
    if (wanted !== null && !wanted.has(typeOf(event))) {
      next = event.seq;
      continue;
    }
    if (events.length >= o.limit) {
      truncated = true;
      break;
    }
    const length = JSON.stringify(event).length;
    if (size + length > o.maxChars) {
      if (events.length === 0) {
        events.push(clip(event, o.maxChars));
        next = event.seq;
      }
      truncated = true;
      break;
    }
    size += length;
    events.push(event);
    next = event.seq;
  }
  if (!truncated) next = Math.max(next, all.nextCursor);
  return { events, nextCursor: next, lowestCursor: all.lowestCursor, gap: all.gap, truncated, omittedThoughts };
}

/** Sends coalesced `notifications/resources/updated` for subscribed transcript URIs (Requirement 26.6). */
export class TranscriptNotifier {
  private readonly subscribed = new Set<string>();
  private readonly scheduled = new Set<string>();

  constructor(
    private readonly send: (uri: string) => Promise<void>,
    private readonly delayMs: number,
    private readonly setTimer: (fn: () => void, ms: number) => void = (fn, ms) => {
      setTimeout(fn, ms).unref();
    },
  ) {}

  subscribe(uri: string): void {
    this.subscribed.add(uri);
  }

  unsubscribe(uri: string): void {
    this.subscribed.delete(uri);
  }

  isSubscribed(uri: string): boolean {
    return this.subscribed.has(uri);
  }

  touched(sessionId: string): void {
    const uri = transcriptUri(sessionId);
    if (!this.subscribed.has(uri) || this.scheduled.has(uri)) return;
    this.scheduled.add(uri);
    this.setTimer(() => {
      this.scheduled.delete(uri);
      if (this.subscribed.has(uri)) void this.send(uri).catch(() => undefined);
    }, this.delayMs);
  }
}
