import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";
import { createCore, type Core } from "./core.js";
import { registerConfigureTools } from "./tools/configure.js";
import { registerSessionTools } from "./tools/sessions.js";

export const SERVER_NAME = "kiro-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Server-level guidance sent to clients in the initialize result (Requirement 25.5). */
export const SERVER_INSTRUCTIONS = "Orchestrates Kiro CLI V3 sessions. Call kiro_status first.";

export interface KiroServer {
  server: McpServer;
  core: Core;
}

/** Composition root: builds the core modules and registers every tool in src/tools. */
export function createServer(config: Config): KiroServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const core = createCore(config, SERVER_VERSION);
  registerSessionTools(server, core);
  registerConfigureTools(server, core);
  return { server, core };
}
