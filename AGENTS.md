# AGENTS.md

Guide for coding agents working in this repository. `CLAUDE.md` includes this file.

## What this is

`@sohampatwardhan/kiro-mcp-server` (bin `kiro-mcp-server`) is an MCP stdio server that lets calling agents orchestrate Kiro CLI V3 sessions through 32 typed tools and one subscribable resource. It is the sibling of `claude-code-mcp-server` and follows its layout and conventions. The spec, including the feature-parity matrix and every decision, lives in `.kiro/specs/kiro-v3-orchestration/`. Steering is in `.kiro/steering/`.

## Architecture

| Path | Owns |
| --- | --- |
| `src/index.ts` | Config load (exit 2 on `ConfigError`), stdio transport, shutdown on stdin close and signals |
| `src/server.ts` | `createServer` composition root, `SERVER_INSTRUCTIONS`, permission wiring, `shutdown` |
| `src/core.ts` | The `Core` bundle every tool group receives |
| `src/config.ts` | Environment variables and fixed `LIMITS` |
| `src/errors.ts` | `ErrorCode`, `ToolError`, result helpers |
| `src/paths.ts` | `Roots`: realpath and the root check |
| `src/argv.ts` | The only place `kiro-cli` argv is built: `acpArgv`, `headlessArgv`, `subcommandArgv` |
| `src/children.ts` | The only module that signals processes: process groups, scopes, `stopAll` |
| `src/cli.ts`, `src/prereq.ts`, `src/parse.ts` | Subcommand runner, CLI lookup and messages, output parsers |
| `src/acp/jsonrpc.ts`, `src/acp/host.ts` | NDJSON JSON-RPC peer; the ACP host lifecycle, method gating (`KNOWN_UNADVERTISED`), error mapping. Only `host.ts` writes to the host |
| `src/sessions.ts` | `SessionRegistry`, `AttachedSession`, routing, snapshots, re-attach |
| `src/events.ts` | `SessionNormalizer` and the `EventFeed` ring buffer |
| `src/turns.ts` | `TurnManager`: start, queue, settle (only from the prompt response), steer, cancel |
| `src/permissions.ts` | `PermissionBroker`: policy, shell gate, consent, timeout, elicitation |
| `src/prompt.ts`, `src/tangent.ts`, `src/specs.ts`, `src/jobs.ts`, `src/headless.ts`, `src/transcript.ts`, `src/trust.ts` | Prompt blocks, tangent tree, spec reader, job store, headless runner, stream reader and notifier, workspace trust |
| `src/tools/*.ts` | One file per tool group. Tools call core modules; core modules never import tools |
| `test/fixtures/fake-kiro.mjs` | Stand-in `kiro-cli`: ACP server, headless chat, subcommands |
| `skills/` | Agent skills installed with `npx skills` |

## Setup, build, test

```bash
npm ci
npm run build   # tsc -p tsconfig.json; strict tsc is the static check (no lint script)
npm test        # build, then node --test dist/test/*.test.js
```

## Coding conventions

- TypeScript strict with `noUncheckedIndexedAccess` and `noImplicitOverride`, ESM with `.js` extensions on relative imports.
- Double quotes, semicolons, trailing commas, 2-space indent, numeric separators.
- Runtime dependencies are `@modelcontextprotocol/sdk` and `zod` only.
- Check MCP SDK APIs against Context7 (`.mcp.json`) or the installed `.d.ts`, not memory. Check Kiro behavior against https://kiro.dev/llms.txt and the CLI's `--help`.

## Testing

- Tests never run a real `kiro-cli`. They point `KIRO_BIN` at `test/fixtures/fake-kiro.mjs`. Prompt markers such as `[permission:shell]`, `[long:800]`, and `[crash]` select scripted turns; `FAKE_KIRO_*` variables select other scenarios (see the file header).
- `test/smoke-*.test.ts` drive the built server over stdio with the SDK `Client`; `test/smoke.test.ts` holds the suite-wide checks (exact tool list, schemas, error shapes, secrets, shutdown).
- Poll for conditions with `waitFor`; avoid fixed sleeps.

## Safety

- No shell tool, raw argv, free-form flag field, or ACP passthrough. Never pass `--agent`, `--model`, `--effort`, or `--trust-*` to `acp`.
- Every path goes through `Roots.resolveInside` before any process starts or request is sent.
- Every child is spawned `detached: true`, `shell: false`, and tracked; only tracked process groups are signalled.
- Never log or return tokens, `KIRO_API_KEY`, authorization URLs, or `process.env`. Never read or write Kiro's session files.
- A new tool needs a spec change (requirement, parity-matrix row), a strict schema, an `outputSchema`, and smoke coverage. New error codes go in `ErrorCode` and the README error table.

## Pull requests and commits

- Conventional commits (`feat(scope): ...`), one per task, with the task number, requirement ids, and `Refs #<issue>` in the body. No AI attribution trailers.
- Spec and steering changes are committed to `main` as `docs(spec): ...` / `docs(steering): ...`. Implementation goes through one PR per spec on `feat/<issue>-<slug>`; a human merges it.
- Questions go on the issue, never in a PR body.
