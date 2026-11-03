import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { acpArgv } from "../argv.js";
import { KILL_GRACE_MS, killGroup, track } from "../children.js";
import { runCli } from "../cli.js";
import { LIMITS } from "../config.js";
import { ToolError } from "../errors.js";
import { cleanTerminalText, tail } from "../parse.js";
import { cliNotFoundMessage, isSignInError, parseVersion, signInMessage } from "../prereq.js";
import { JsonRpcPeer, METHOD_NOT_FOUND, RpcClosedError, RpcError, RpcTimeoutError } from "./jsonrpc.js";
import type { AgentCapabilities, InitializeResult, KiroCapabilities } from "./types.js";

/**
 * Optional methods that work on Kiro CLI 2.37.1 without being advertised in
 * `extensionMethods` (design Decision 6).
 */
export const KNOWN_UNADVERTISED = ["_kiro/account/getUsage", "_kiro/session/rename", "_session/steer"] as const;

export type HostState = "stopped" | "starting" | "ready" | "failed" | "exited" | "stopping";

export interface HostOptions {
  bin: string;
  cwd: string;
  /** Timeout for requests other than session/prompt. */
  requestTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Wait at least this long after an exit or failure before the next spawn. */
  restartBackoffMs?: number;
  clientVersion?: string;
}

export interface CallOptions {
  /** Override the request timeout; null waits for the response however long it takes. */
  timeoutMs?: number | null;
}

type NotificationHandler = (params: unknown, method: string) => void;
type RequestHandler = (params: unknown) => unknown;

/**
 * The long-lived `kiro-cli acp --agent-engine=v3` child. Only this module
 * writes to the host process. Started lazily; restarted on the next call
 * after it exits. Each start bumps `generation`, so sessions can tell that
 * they must be re-attached.
 */
export class AcpHost extends EventEmitter {
  state: HostState = "stopped";
  generation = 0;
  capabilities: AgentCapabilities | null = null;
  initResult: InitializeResult | null = null;
  lastError: ToolError | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private peer: JsonRpcPeer | null = null;
  private starting: Promise<void> | null = null;
  private lastDownAt = 0;
  private stderrText = "";
  private droppedBefore = 0;
  private readonly notificationHandlers: [string, NotificationHandler][] = [];
  private readonly anyHandlers: NotificationHandler[] = [];
  private readonly requestHandlers: [string, RequestHandler][] = [];

  constructor(private readonly opts: HostOptions) {
    super();
  }

  /** `agentCapabilities._meta.kiro` from the last initialize. */
  get kiro(): KiroCapabilities {
    return this.capabilities?._meta?.kiro ?? {};
  }

  /** Lines dropped across every host generation (Requirement 5.7). */
  get droppedLines(): number {
    return this.droppedBefore + (this.peer?.droppedLines ?? 0);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.push([method, handler]);
    this.peer?.onNotification(method, handler);
  }

  onAnyNotification(handler: NotificationHandler): void {
    this.anyHandlers.push(handler);
    this.peer?.onAnyNotification(handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.push([method, handler]);
    this.peer?.onRequest(method, handler);
  }

  /** True for core ACP methods, advertised extension methods, and KNOWN_UNADVERTISED. */
  supports(method: string): boolean {
    if (!method.startsWith("_")) return true;
    if ((KNOWN_UNADVERTISED as readonly string[]).includes(method)) return true;
    return (this.kiro.extensionMethods ?? []).includes(method);
  }

  /** Start the host if it is not running. Concurrent callers share one start. */
  ensureStarted(): Promise<void> {
    if (this.state === "ready" && this.peer !== null && !this.peer.closed) return Promise.resolve();
    if (this.starting !== null) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const backoff = this.opts.restartBackoffMs ?? 250;
    const wait = this.lastDownAt + backoff - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.state = "starting";
    this.stderrText = "";
    this.generation++;
    const generation = this.generation;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.bin, acpArgv(), {
        cwd: this.opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: true,
        windowsHide: true,
        env: { ...(this.opts.env ?? process.env), NO_COLOR: "1" },
      });
    } catch (err) {
      throw this.fail(new ToolError("CLI_NOT_FOUND", cliNotFoundMessage(this.opts.bin), { reason: String(err) }));
    }
    track(child);
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = tail(this.stderrText + chunk.toString("utf8"), LIMITS.outputTailChars);
    });
    child.stdin.on("error", () => undefined);
    const peer = new JsonRpcPeer(child.stdout, child.stdin, { maxLineBytes: LIMITS.maxLineBytes });
    this.peer = peer;
    for (const [method, handler] of this.requestHandlers) peer.onRequest(method, handler);
    for (const [method, handler] of this.notificationHandlers) peer.onNotification(method, handler);
    for (const handler of this.anyHandlers) peer.onAnyNotification(handler);

    let spawnFailure: ToolError | null = null;
    const spawnError = new Promise<never>((_, reject) => {
      child.once("error", (err: NodeJS.ErrnoException) => {
        spawnFailure =
          err.code === "ENOENT" || err.code === "EACCES"
            ? new ToolError("CLI_NOT_FOUND", cliNotFoundMessage(this.opts.bin))
            : new ToolError("ENGINE_V3_UNAVAILABLE", `failed to start kiro-cli acp: ${err.message}`);
        reject(spawnFailure);
        peer.close("spawn error");
      });
    });
    spawnError.catch(() => undefined);
    let exitedEarly = false;
    const onDown = (reason: string) => {
      if (this.generation !== generation) return;
      exitedEarly = this.state === "starting";
      if (this.state === "ready") {
        this.state = "exited";
        this.lastDownAt = Date.now();
        this.droppedBefore += peer.droppedLines;
        this.emit("exited", generation, reason);
      }
    };
    child.once("exit", (code, signal) => {
      peer.close(`host exited (${code ?? signal})`);
      onDown(`host exited with ${code ?? signal}`);
    });
    peer.onClose((reason) => {
      onDown(reason);
      // stdout closed while the process lives on: stop it so it does not linger.
      if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGTERM");
    });

    try {
      const init = (await Promise.race([
        peer.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "kiro-mcp-server", version: this.opts.clientVersion ?? "0.0.0" },
          },
          this.opts.requestTimeoutMs,
        ),
        spawnError,
      ])) as InitializeResult | null;
      if (init === null || typeof init !== "object") throw new RpcError(-32603, "initialize returned no result");
      this.initResult = init;
      this.capabilities = init.agentCapabilities ?? {};
      this.state = "ready";
      this.lastError = null;
      this.emit("started", generation);
    } catch (err) {
      if (spawnFailure !== null) throw this.fail(spawnFailure);
      if (err instanceof ToolError) throw this.fail(err);
      // Let the exit (or stderr) land so the message can name the reason.
      await new Promise((r) => setTimeout(r, exitedEarly ? 0 : 50));
      killGroup(child, "SIGKILL");
      const version = await this.cliVersion();
      const reason = cleanTerminalText(this.stderrText).trim().split("\n").slice(-3).join(" ") || (err instanceof Error ? err.message : String(err));
      throw this.fail(
        new ToolError("ENGINE_V3_UNAVAILABLE", `kiro-cli ${version ?? "(unknown version)"} could not start the V3 ACP engine: ${reason}`, {
          cliVersion: version,
          stderrTail: tail(cleanTerminalText(this.stderrText), 2_000),
        }),
      );
    }
  }

  private fail(err: ToolError): ToolError {
    this.state = "failed";
    this.lastDownAt = Date.now();
    this.lastError = err;
    return err;
  }

  private async cliVersion(): Promise<string | null> {
    try {
      const result = await runCli(this.opts.bin, ["--version"], { timeoutMs: 10_000, cwd: this.opts.cwd, env: this.opts.env });
      return parseVersion(result.stdout);
    } catch {
      return null;
    }
  }

  /**
   * Send a request and map failures to tool errors: UNSUPPORTED_BY_KIRO for
   * an unsupported optional method or method-not-found, CLI_NOT_SIGNED_IN for
   * authentication errors, HOST_EXITED when the host goes away, TIMEOUT, and
   * KIRO_ERROR with `details.kiro` otherwise. Params never appear in errors.
   */
  async call(method: string, params: unknown, opts: CallOptions = {}): Promise<unknown> {
    if (!this.supports(method)) {
      throw new ToolError("UNSUPPORTED_BY_KIRO", `Kiro does not advertise ${method}`, { method });
    }
    await this.ensureStarted();
    const peer = this.peer;
    if (peer === null) throw new ToolError("HOST_EXITED", "the Kiro ACP host is not running");
    const timeoutMs = opts.timeoutMs === undefined ? this.opts.requestTimeoutMs : opts.timeoutMs ?? undefined;
    try {
      return await peer.request(method, params, timeoutMs);
    } catch (err) {
      throw mapRpcError(method, err);
    }
  }

  notify(method: string, params: unknown): void {
    this.peer?.notify(method, params);
  }

  /** Close the host's stdin, then stop its process group if it does not exit. */
  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.generation++;
    this.peer?.close("server stopping");
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    const timer = setTimeout(() => killGroup(child, "SIGTERM"), 1_000);
    const killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 1_000 + KILL_GRACE_MS);
    await exited;
    clearTimeout(timer);
    clearTimeout(killTimer);
    this.child = null;
    this.peer = null;
    this.state = "stopped";
  }
}

export function mapRpcError(method: string, err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof RpcClosedError) return new ToolError("HOST_EXITED", `the Kiro ACP host exited before ${method} answered`);
  if (err instanceof RpcTimeoutError) return new ToolError("TIMEOUT", err.message, { method });
  if (err instanceof RpcError) {
    const data = (typeof err.data === "object" && err.data !== null ? err.data : {}) as { errorType?: unknown; details?: unknown };
    const errorType = typeof data.errorType === "string" ? data.errorType : undefined;
    const detail = typeof data.details === "string" && data.details.length <= 500 ? data.details : undefined;
    const message = detail !== undefined && /^internal error$/i.test(err.message) ? detail : err.message;
    const kiro = { code: err.code, message, ...(errorType !== undefined ? { errorType } : {}) };
    if (err.code === METHOD_NOT_FOUND) return new ToolError("UNSUPPORTED_BY_KIRO", `Kiro does not implement ${method}`, { method, kiro });
    if ((errorType !== undefined && /auth/i.test(errorType)) || isSignInError(message)) {
      return new ToolError("CLI_NOT_SIGNED_IN", signInMessage(), { kiro });
    }
    return new ToolError("KIRO_ERROR", `${method} failed: ${message}`, { method, kiro });
  }
  return new ToolError("KIRO_ERROR", `${method} failed: ${err instanceof Error ? err.message : String(err)}`, { method });
}
