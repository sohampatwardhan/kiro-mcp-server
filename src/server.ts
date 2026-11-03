import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";

export const SERVER_NAME = "kiro-mcp-server";
export const SERVER_VERSION = "0.1.0";

/** Server-level guidance sent to clients in the initialize result (Requirement 25.5). */
export const SERVER_INSTRUCTIONS = "Orchestrates Kiro CLI V3 sessions. Call kiro_status first.";

/** Composition root: builds the core modules and registers every tool in src/tools. */
export function createServer(config: Config): McpServer {
  void config;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  return server;
}
