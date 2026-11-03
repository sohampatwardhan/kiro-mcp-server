import { z } from "zod";

import { NAME_PATTERN } from "../argv.js";
import { LIMITS } from "../config.js";
import { SESSION_ID_PATTERN } from "../sessions.js";

export const sessionId = z.string().regex(SESSION_ID_PATTERN).describe("Kiro session id (sess_<uuid>).");
export const pathInput = (what: string) => z.string().min(1).max(4_096).describe(what);
export const name = (what: string) => z.string().regex(NAME_PATTERN).describe(what);
export const waitS = (def: number, what = "Seconds to wait") =>
  z.number().min(0).max(LIMITS.maxWaitS).optional().describe(`${what} (default ${def}, max ${LIMITS.maxWaitS}).`);

/** Loose JSON value for Kiro payloads passed through as-is. */
export const json = z.unknown();

export const modeView = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  source: z.string().optional(),
  custom: z.boolean(),
});

export const configOptionView = z.object({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  current_value: json,
  values: z.array(z.string()),
});

export const commandsView = z.object({ total: z.number(), by_type: z.record(z.string(), z.number()) });

export const contextUsageView = z
  .object({ usage_percentage: z.number().nullable(), summarization_threshold: z.number().nullable() })
  .nullable();

export const pendingPermissionView = z.object({
  permission_id: z.string(),
  session_id: z.string(),
  tool_call_id: z.string(),
  title: z.string(),
  options: z.array(z.object({ option_id: z.string(), name: z.string(), kind: z.string() })),
  consent: json,
  mcp_tool: json,
  tool_kind: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});
