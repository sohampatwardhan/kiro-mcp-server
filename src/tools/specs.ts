import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { SPEC_DOCUMENTS, SPEC_NAME_PATTERN, listSpecs, readSpec } from "../specs.js";
import { defineTool } from "./define.js";
import { json, pathInput } from "./schemas.js";

export function registerSpecTools(server: McpServer, core: Core): void {
  defineTool(
    server,
    "kiro_specs",
    {
      title: "Kiro spec documents",
      description:
        "Read Kiro spec-driven development output under <cwd>/.kiro/specs, like /spec and /spec view. `list` shows each spec folder, which of " +
        "requirements.md, bugfix.md, design.md, and tasks.md exist, their modification times, and checked versus unchecked task counts. `read` returns one " +
        "document (truncated at 200 KiB), with parsed tasks for tasks.md. To create or run a spec, select mode spec (or quick-spec, bug-fix) with " +
        "kiro_session_configure and prompt the agent, for example \"run the tasks in the <name> spec\".",
      input: z
        .object({
          action: z.enum(["list", "read"]),
          cwd: pathInput("Workspace directory inside KIRO_MCP_ROOTS."),
          spec: z.string().regex(SPEC_NAME_PATTERN).optional(),
          document: z.enum(SPEC_DOCUMENTS).optional(),
        })
        .strict(),
      output: z.object({ cwd: z.string(), specs: z.array(json).nullable(), document: json }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const cwd = await core.roots.resolveInside(args.cwd);
      if (args.action === "list") return { cwd, specs: await listSpecs(core.roots, cwd), document: null };
      if (args.spec === undefined || args.document === undefined) throw new ToolError("SPEC_NOT_FOUND", "read needs spec and document");
      return { cwd, specs: null, document: await readSpec(core.roots, cwd, args.spec, args.document) };
    },
  );
}
