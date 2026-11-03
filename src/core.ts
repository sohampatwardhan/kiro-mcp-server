import { AcpHost } from "./acp/host.js";
import type { Config } from "./config.js";
import { Roots } from "./paths.js";
import { ToolError } from "./errors.js";
import { SessionRegistry, type AttachedSession } from "./sessions.js";
import { TurnManager } from "./turns.js";

/** The core modules every tool group uses, built once per server. */
export interface Core {
  config: Config;
  roots: Roots;
  host: AcpHost;
  sessions: SessionRegistry;
  turns: TurnManager;
  /** kiro_events for a headless job id. Replaced by the job store. */
  jobEvents: (jobId: string, args: Record<string, unknown>, extra: unknown) => Promise<never> | Promise<Record<string, unknown>>;
  /** Pending permissions for a session, as tool output. Replaced by the permission broker. */
  pendingPermissions: (sessionId?: string) => Record<string, unknown>[];
  /** Run before a session closes: cancel its turn, reject its permissions. */
  closeHooks: ((session: AttachedSession) => Promise<void>)[];
}

export function createCore(config: Config, version: string): Core {
  const roots = new Roots(config.roots);
  const host = new AcpHost({
    bin: config.kiroBin,
    cwd: roots.primary,
    requestTimeoutMs: config.requestTimeoutMs,
    clientVersion: version,
  });
  const sessions = new SessionRegistry(host, roots);
  const turns = new TurnManager(host, sessions);
  return {
    config,
    roots,
    host,
    sessions,
    turns,
    jobEvents: (jobId) => Promise.reject(new ToolError("JOB_NOT_FOUND", `no headless job ${jobId}`)),
    pendingPermissions: () => [],
    closeHooks: [],
  };
}
