import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { defineTool } from "./define.js";
import { configOptionView, sessionId } from "./schemas.js";
import { configOptionsOf } from "./views.js";

export function registerConfigureTools(server: McpServer, core: Core): void {
  const { host, sessions } = core;

  defineTool(
    server,
    "kiro_session_configure",
    {
      title: "Configure a Kiro session",
      description: "Change an attached session's settings. `title` renames it with _kiro/session/rename.",
      input: z
        .object({
          session_id: sessionId,
          title: z.string().min(1).max(200).optional(),
        })
        .strict(),
      output: z.object({
        session_id: z.string(),
        title: z.string().nullable(),
        current_mode: z.string().nullable(),
        config_options: z.array(configOptionView),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { session } = await sessions.attachById(args.session_id);
      if (args.title !== undefined) {
        await host.call("_kiro/session/rename", { sessionId: session.sessionId, title: args.title });
        session.title = args.title;
      }
      return {
        session_id: session.sessionId,
        title: session.title ?? null,
        current_mode: session.currentModeId ?? null,
        config_options: configOptionsOf(session),
      };
    },
  );
}
