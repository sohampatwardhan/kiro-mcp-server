import type { Readable, Writable } from "node:stream";

/**
 * Newline-delimited JSON-RPC 2.0 over a readable/writable pair: the framing
 * Kiro's ACP server speaks. Hand-written (design Decision 11): requests with
 * ids and timeouts, notifications, request and notification handlers, an
 * automatic -32601 for agent-to-client requests nobody handles, and a line cap.
 */

export type RpcId = number | string;

export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class RpcTimeoutError extends Error {
  override name = "RpcTimeoutError";
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} got no response within ${timeoutMs} ms`);
  }
}

export class RpcClosedError extends Error {
  override name = "RpcClosedError";
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type RequestHandler = (params: unknown, id: RpcId) => unknown;
type NotificationHandler = (params: unknown, method: string) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface PeerOptions {
  /** Lines longer than this (bytes) are dropped and counted. */
  maxLineBytes: number;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly anyNotification: NotificationHandler[] = [];
  private readonly closeHandlers: ((reason: string) => void)[] = [];
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  /** True while skipping the rest of an oversized line. */
  private discarding = false;
  private closedReason: string | null = null;
  /** Lines dropped because they were too long or not a JSON-RPC object. */
  droppedLines = 0;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly opts: PeerOptions,
  ) {
    input.on("data", (chunk: Buffer | string) => this.onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    input.once("end", () => this.close("stream ended"));
    input.once("close", () => this.close("stream closed"));
    input.once("error", (err: Error) => this.close(`stream error: ${err.message}`));
    output.on("error", () => this.close("output error"));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closedReason !== null) return Promise.reject(new RpcClosedError(`connection closed: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { method, resolve, reject, timer: undefined };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closedReason !== null) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
  }

  /** Called for every notification, after the method-specific handlers. */
  onAnyNotification(handler: NotificationHandler): void {
    this.anyNotification.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    if (this.closedReason !== null) handler(this.closedReason);
    else this.closeHandlers.push(handler);
  }

  /** Reject every pending request and stop accepting new ones. Idempotent. */
  close(reason = "closed"): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new RpcClosedError(`connection closed before ${entry.method} answered: ${reason}`));
      this.pending.delete(id);
    }
    for (const handler of this.closeHandlers.splice(0)) handler(reason);
  }

  private write(message: unknown): void {
    try {
      this.output.write(JSON.stringify(message) + "\n");
    } catch {
      this.close("write failed");
    }
  }

  private onData(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      this.append(chunk.subarray(start, newline));
      this.flushLine();
      start = newline + 1;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
  }

  private append(piece: Buffer): void {
    if (this.discarding) return;
    if (this.bufferedBytes + piece.length > this.opts.maxLineBytes) {
      this.discarding = true;
      this.chunks = [];
      this.bufferedBytes = 0;
      return;
    }
    this.chunks.push(piece);
    this.bufferedBytes += piece.length;
  }

  private flushLine(): void {
    if (this.discarding) {
      this.discarding = false;
      this.droppedLines++;
      return;
    }
    const line = Buffer.concat(this.chunks).toString("utf8").trim();
    this.chunks = [];
    this.bufferedBytes = 0;
    if (line === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.droppedLines++;
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.droppedLines++;
      return;
    }
    this.dispatch(message as Record<string, unknown>);
  }

  private dispatch(message: Record<string, unknown>): void {
    const { id, method } = message;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof method === "string") {
      if (hasId) this.handleRequest(id, method, message.params);
      else this.handleNotification(method, message.params);
      return;
    }
    if (!hasId) {
      this.droppedLines++;
      return;
    }
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (error !== undefined && error !== null) {
      entry.reject(
        new RpcError(typeof error.code === "number" ? error.code : INTERNAL_ERROR, typeof error.message === "string" ? error.message : "error", error.data),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private handleRequest(id: RpcId, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method);
    if (handler === undefined) {
      this.write({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(params, id))
      .then(
        (result) => this.write({ jsonrpc: "2.0", id, result: result ?? null }),
        (err: unknown) => {
          const error =
            err instanceof RpcError
              ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
              : { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) };
          this.write({ jsonrpc: "2.0", id, error });
        },
      );
  }

  private handleNotification(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers.get(method) ?? []) safely(() => handler(params, method));
    for (const handler of this.anyNotification) safely(() => handler(params, method));
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    process.stderr.write(`kiro-mcp-server: notification handler failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
