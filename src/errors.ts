import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every code a tool error may carry. New codes also go in the README error table. */
export type ErrorCode =
  // CLI and engine
  | "CLI_NOT_FOUND"
  | "CLI_NOT_SIGNED_IN"
  | "ENGINE_V3_UNAVAILABLE"
  | "HOST_EXITED"
  | "UNSUPPORTED_BY_KIRO"
  | "KIRO_ERROR"
  | "KIRO_REFUSED"
  | "OUTPUT_PARSE_FAILED"
  | "TIMEOUT"
  | "CLI_EXIT"
  // Paths and content
  | "PATH_OUTSIDE_ROOTS"
  | "PATH_EXISTS"
  | "CONTENT_TOO_LARGE"
  // Sessions and turns
  | "SESSION_NOT_FOUND"
  | "TURN_ACTIVE"
  | "NO_ACTIVE_TURN"
  | "QUEUE_FULL"
  | "VALUE_NOT_ADVERTISED"
  // Permissions
  | "PERMISSION_NOT_FOUND"
  | "OPTION_NOT_OFFERED"
  | "PERSISTENT_CONSENT_DISABLED"
  | "SHELL_APPROVAL_DISABLED"
  // Operator gates
  | "HEADLESS_TRUST_DISABLED"
  | "CONFIG_WRITES_DISABLED"
  | "STDIO_SERVER_WITHHELD"
  | "SETTING_WITHHELD"
  | "CONFIRMATION_REQUIRED"
  | "USAGE_LIMIT_NEAR"
  // Lookups
  | "JOB_NOT_FOUND"
  | "SPEC_NOT_FOUND"
  | "TANGENT_NOT_FOUND"
  | "INVALID_MERGE_TARGET"
  | "NOTHING_TO_BRANCH";

export const ERROR_CODES: readonly ErrorCode[] = [
  "CLI_NOT_FOUND",
  "CLI_NOT_SIGNED_IN",
  "ENGINE_V3_UNAVAILABLE",
  "HOST_EXITED",
  "UNSUPPORTED_BY_KIRO",
  "KIRO_ERROR",
  "KIRO_REFUSED",
  "OUTPUT_PARSE_FAILED",
  "TIMEOUT",
  "CLI_EXIT",
  "PATH_OUTSIDE_ROOTS",
  "PATH_EXISTS",
  "CONTENT_TOO_LARGE",
  "SESSION_NOT_FOUND",
  "TURN_ACTIVE",
  "NO_ACTIVE_TURN",
  "QUEUE_FULL",
  "VALUE_NOT_ADVERTISED",
  "PERMISSION_NOT_FOUND",
  "OPTION_NOT_OFFERED",
  "PERSISTENT_CONSENT_DISABLED",
  "SHELL_APPROVAL_DISABLED",
  "HEADLESS_TRUST_DISABLED",
  "CONFIG_WRITES_DISABLED",
  "STDIO_SERVER_WITHHELD",
  "SETTING_WITHHELD",
  "CONFIRMATION_REQUIRED",
  "USAGE_LIMIT_NEAR",
  "JOB_NOT_FOUND",
  "SPEC_NOT_FOUND",
  "TANGENT_NOT_FOUND",
  "INVALID_MERGE_TARGET",
  "NOTHING_TO_BRANCH",
];

/** A failure a tool reports to the caller with a stable code. */
export class ToolError extends Error {
  override name = "ToolError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Tool errors carry `{ error: { code, message, details } }` as their text body. */
export function toolErrorResult(err: unknown): CallToolResult & { content: { type: "text"; text: string }[] } {
  const error =
    err instanceof ToolError
      ? { code: err.code, message: err.message, details: err.details }
      : { code: "KIRO_ERROR" as const, message: err instanceof Error ? err.message : String(err), details: {} };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** A success result: the structured body, mirrored as JSON text for clients without structured output. */
export function okResult(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}
