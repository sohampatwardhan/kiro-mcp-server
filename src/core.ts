import { AcpHost } from "./acp/host.js";
import type { Config } from "./config.js";
import { Roots } from "./paths.js";
import { SessionRegistry, type AttachedSession } from "./sessions.js";

/** The core modules every tool group uses, built once per server. */
export interface Core {
  config: Config;
  roots: Roots;
  host: AcpHost;
  sessions: SessionRegistry;
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
  return { config, roots, host, sessions, pendingPermissions: () => [], closeHooks: [] };
}
