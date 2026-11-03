import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import { okResult, toolErrorResult } from "../errors.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ToolSpec<I extends z.ZodObject, O extends z.ZodObject> {
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
}

/** Names of every tool registered through defineTool, in registration order. */
export const registeredTools: string[] = [];

/**
 * Register a tool with a strict input schema and an outputSchema. The handler
 * returns the structured body; a thrown ToolError becomes the documented
 * `{ error: { code, message, details } }` tool error.
 */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  name: string,
  spec: ToolSpec<I, O>,
  handler: (args: z.infer<I>, extra: ToolExtra) => Promise<z.input<O>>,
): void {
  registeredTools.push(name);
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: spec.annotations,
    },
    // The SDK infers the handler's argument type from the schema generic.
    (async (args: z.infer<I>, extra: ToolExtra): Promise<CallToolResult> => {
      try {
        return okResult((await handler(args, extra)) as Record<string, unknown>);
      } catch (err) {
        return toolErrorResult(err);
      }
    }) as never,
  );
}
