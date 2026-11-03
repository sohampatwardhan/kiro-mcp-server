#!/usr/bin/env node
import { constants } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { stopAll } from "./children.js";
import { ConfigError, loadConfig } from "./config.js";
import { cliNotFoundMessage, findCli } from "./prereq.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`kiro-mcp-server: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (findCli(config.kiroBin, process.env, config.cwd) === null) {
    // Keep serving: tools that need the CLI return CLI_NOT_FOUND with the same message.
    process.stderr.write(`kiro-mcp-server: warning: ${cliNotFoundMessage(config.kiroBin)}\n`);
  }
  const { server, shutdown } = createServer(config);
  await server.connect(new StdioServerTransport());

  // The client closing stdin, or a signal, ends the server: cancel running turns, close the
  // ACP host's stdin, and stop every process group this server started (Requirement 24.3).
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    const hard = setTimeout(() => {
      void stopAll(500).finally(() => process.exit(code));
    }, 8_000);
    hard.unref();
    void shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(code));
  };
  process.stdin.once("end", () => stop(0));
  process.stdin.once("close", () => stop(0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => stop(128 + constants.signals[signal]));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`kiro-mcp-server: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
