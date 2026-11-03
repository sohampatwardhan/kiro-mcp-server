# Kiro MCP Server

[![npm version](https://img.shields.io/npm/v/@sohampatwardhan/kiro-mcp-server.svg)](https://www.npmjs.com/package/@sohampatwardhan/kiro-mcp-server)
[![CI](https://github.com/sohampatwardhan/kiro-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/sohampatwardhan/kiro-mcp-server/actions/workflows/ci.yml)

MCP server that lets AI agents with an always-on computer (Grok Bot, Claude, Cursor, Codex, and other MCP clients) orchestrate [Kiro CLI V3](https://kiro.dev/docs/cli/v3.md) coding sessions through typed tools instead of shell commands. It is the Kiro sibling of [`claude-code-mcp-server`](https://github.com/sohampatwardhan/claude-code-mcp-server).

> **Requires `kiro-cli` with the V3 engine, installed and signed in, on the machine that runs this server.**
>
> 1. Install it: `curl -fsSL https://cli.kiro.dev/install | bash` (or `brew install kiro-cli` on macOS).
> 2. Sign in: run `kiro-cli login` in a terminal (`kiro-cli login --use-device-flow` on a machine without a browser).
> 3. Trust each workspace once: run `kiro-cli --v3` in the folder and choose **Trust, continue** (see [Workspace trust](#workspace-trust)).
>
> Without the CLI, tools return `CLI_NOT_FOUND` with the install command, and the server prints the same warning on stderr at startup. A signed-out CLI gives `CLI_NOT_SIGNED_IN`. This server never logs in for you.

The server drives Kiro three ways: one long-lived ACP host (`kiro-cli acp --agent-engine=v3 --auth-method=cli`, newline-delimited JSON-RPC) for sessions, prompts, streaming, permissions, and Kiro's extension methods; headless runs (`kiro-cli chat --v3 --no-interactive --output-format stream-json`) for fire-and-forget work; and a few fixed-argv subcommands (`whoami`, `settings`, `agent`, `mcp`, `powers`). It exposes 32 tools and one subscribable transcript resource. The full feature-parity matrix, with what is exposed, composed, gated, withheld, or impossible and why, is in [`.kiro/specs/kiro-v3-orchestration/requirements.md`](.kiro/specs/kiro-v3-orchestration/requirements.md#feature-parity-matrix).

## Design

- **Strict schemas, typed results.** Every tool has a strict input schema (`additionalProperties: false`) and an `outputSchema`, and returns `structuredContent`. Errors are `{ "error": { "code", "message", "details" } }` with a code from the [error table](#errors).
- **No escape hatch.** No shell tool, no raw argv, no field that forwards free-form CLI flags, and no "send any ACP method" tool. Kiro commands that only exist in the terminal UI are mapped to typed tools, or listed as not possible.
- **Fixed argv.** The only place `kiro-cli` argv is built is `src/argv.ts`. Values are attached as `--flag=value` or follow `--`; prompts go on stdin. The v2-only `--agent`, `--model`, `--effort`, and `--trust-*` flags are never passed to `acp`: agent mode, model, and effort are set through session options.
- **Operator policy.** Kiro runs only inside `KIRO_MCP_ROOTS` (checked with `realpath`). Shell approvals, persistent consent, headless trust flags, and config writes each need an explicit opt-in.
- **Bounded processes.** Every child is spawned detached in its own process group and tracked. Closing stdin, SIGINT, SIGTERM, or SIGHUP cancels running turns, closes the host's stdin, and stops every process group.
- **In memory.** Event feeds, jobs, tangent trees, pending permissions, and queued prompts live in memory. The server never writes Kiro's session files. No telemetry; no tokens, `KIRO_API_KEY`, or authorization URLs in output or logs.

## Prerequisites

- Node.js 20 or later.
- `kiro-cli` 2.37 or later with the V3 engine (`kiro-cli acp --agent-engine=v3` must start), signed in. Set `KIRO_BIN` when `kiro-cli` is not on the server's `PATH`.

## Install

```bash
npx -y @sohampatwardhan/kiro-mcp-server@latest
```

### Claude Code

```bash
claude mcp add kiro -e KIRO_MCP_ROOTS=$HOME/code -- npx -y @sohampatwardhan/kiro-mcp-server@latest
```

### Cursor, Claude Desktop, and other JSON configs

```json
{
  "mcpServers": {
    "kiro": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/kiro-mcp-server@latest"],
      "env": { "KIRO_MCP_ROOTS": "/Users/me/code" }
    }
  }
}
```

### Codex

```toml
[mcp_servers.kiro]
command = "npx"
args = ["-y", "@sohampatwardhan/kiro-mcp-server@latest"]
env = { KIRO_MCP_ROOTS = "/home/me/code" }
```

## Environment variables

All are optional. An invalid value makes the server print the variable name and reason on stderr and exit with code 2. Booleans accept `1`, `true`, `yes`, `0`, `false`, `no`.

| Variable | Default | Effect |
| --- | --- | --- |
| `KIRO_BIN` | `kiro-cli` | CLI path or name |
| `KIRO_MCP_CWD` | process cwd | Default root when `KIRO_MCP_ROOTS` is unset |
| `KIRO_MCP_ROOTS` | `KIRO_MCP_CWD` | Comma-separated absolute directories Kiro may run in. `/` is refused. The first is the ACP host's cwd |
| `KIRO_MCP_PERMISSIONS` | `ask` | `ask` (the calling agent answers), `deny` (reject all), or `allow` (approve once; shell still follows `KIRO_MCP_ALLOW_SHELL`) |
| `KIRO_MCP_PERMISSION_TIMEOUT_MS` | `600000` | Unanswered permissions are rejected after this long |
| `KIRO_MCP_ALLOW_SHELL` | off | Lets shell-command requests be approved. Off: they are rejected at once |
| `KIRO_MCP_ALLOW_PERSISTENT_CONSENT` | off | Allows `allow_always` answers |
| `KIRO_MCP_HEADLESS_TRUST` | `none` | `tools` allows headless `trust_tools`; `all` also allows `trust_all_tools` |
| `KIRO_MCP_ALLOW_TRUST_WORKSPACE` | off | Allows headless `trust_workspace` |
| `KIRO_MCP_ALLOW_CONFIG_WRITES` | off | Allows agent, MCP config, settings, and powers writes |
| `KIRO_MCP_CLI_TIMEOUT_MS` | `120000` | Subcommand timeout |
| `KIRO_MCP_REQUEST_TIMEOUT_MS` | `120000` | ACP request timeout (prompts have none) |
| `KIRO_MCP_HEADLESS_TIMEOUT_MS` | `3600000` | Headless job timeout; `timeout_s` may lower it |

`KIRO_API_KEY`, when set in the server's environment, is inherited by headless runs only. No tool can read or set it.

### Workspace trust

ACP has no method for trusting a workspace. Until a folder is trusted, Kiro does not load its custom agents, steering, MCP servers, skills, or workflows, and asks before every shell and MCP call. Trust each root once: run `kiro-cli --v3` in the folder and choose **Trust, continue**. `kiro_status` reports the saved trust for every root (read-only, from Kiro's per-workspace permissions file) and warns for each untrusted one. Kiro never saves trust for your home directory.

### Shell approvals

Shell approvals are off by default, as in `claude-code-mcp-server`: Kiro's requests to run commands (including tests and builds) are rejected at once and recorded as `policy: "shell_disabled"`. To let the calling agent approve them one at a time, set `KIRO_MCP_ALLOW_SHELL=1`. To approve every non-shell request automatically as well, add `KIRO_MCP_PERMISSIONS=allow`.

## Typical flow

1. `kiro_status` checks the CLI, sign-in, V3 engine, trust, and policy.
2. `kiro_session_new` (or `kiro_session_load`) attaches a session; `kiro_session_configure` picks mode (`vibe`, `plan`, `spec`, `quick-spec`, `bug-fix`, `autonomous`, or a custom agent), model, and effort.
3. `kiro_prompt` sends a prompt and waits up to `wait_s`. If the turn is still running, poll `kiro_events` (or `kiro_stream_session`) with the returned cursor until the status is `completed`, `cancelled`, or `failed`.
4. Answer `pending_permissions` with `kiro_permission_respond`. When the client supports MCP elicitation, the request is also shown to its user.
5. Steer with `kiro_steer`, stop with `kiro_cancel`, branch with `kiro_session_fork` or `kiro_tangent`, and close with `kiro_session_close`.

## Tool reference

| Tool | What it does |
| --- | --- |
| `kiro_status` | CLI path and version, V3 engine, capabilities, sign-in (account type, email, profile), roots and trust, policy, log paths, optional diagnostics |
| `kiro_usage` | Plan usage and credits (`_kiro/account/getUsage`), plus credits observed for a session |
| `kiro_session_new` | New local or cloud session, with mode, model, effort, title |
| `kiro_session_list` | Saved sessions by workspace or user scope, with source, title, and limit filters |
| `kiro_session_load` | Resume a session by id, or the latest for a workspace, with replay |
| `kiro_session_configure` | Mode, model, effort, other advertised options, title |
| `kiro_session_state` | MCP servers, tools, steering, skills, powers, governance, agent errors, commands, modes, config, context, `/config` panel, models |
| `kiro_session_history` | Paged transcript and rewind points |
| `kiro_session_fork` | Fork, optionally at a user message (`/rewind`) |
| `kiro_session_export` | Export to a file inside the roots |
| `kiro_session_compact` | Compact an idle session's context |
| `kiro_session_close` | Close a session (cancels its turn, rejects its permissions) |
| `kiro_session_delete` | Delete a session from Kiro's store (`confirm: true`) |
| `kiro_prompt` | Prompt with text, files, images, or an advertised command; wait or queue |
| `kiro_events` | Cursor-based event feed for a session or headless job, with long-poll |
| `kiro_steer` | Steer a running turn |
| `kiro_cancel` | Cancel a running turn, or stop a headless job |
| `kiro_permissions` | Pending permission requests |
| `kiro_permission_respond` | Answer one with an offered option |
| `kiro_tangent` | Branch, merge, and list tangents |
| `kiro_specs` | List and read `.kiro/specs` documents with parsed tasks |
| `kiro_memory` | List, read, create, update, delete memories; sync status |
| `kiro_knowledge` | Knowledge base subcommands |
| `kiro_code_intelligence` | Code intelligence subcommands |
| `kiro_workflow` | Workflow recipes and runs |
| `kiro_cloud_sources` | Connected source providers and repositories |
| `kiro_run_headless` | Headless run as a job |
| `kiro_agents` | List and validate custom agents; create, set default, upgrade (gated) |
| `kiro_mcp_config` | List and status of MCP config; add HTTP servers and remove (gated) |
| `kiro_settings` | List and get settings; set and delete (gated, sensitive keys withheld) |
| `kiro_powers` | List powers; install and uninstall (gated) |
| `kiro_stream_session` | Follow any session's transcript live with a cursor |

Resource: `kiro-session://<session_id>/transcript` returns a session's newest events as JSON. Subscribe with `resources/subscribe` to get `notifications/resources/updated` within a second of new events.

## Errors

| Code | Meaning |
| --- | --- |
| `CLI_NOT_FOUND` | `kiro-cli` (or `KIRO_BIN`) is missing; the message has the install command |
| `CLI_NOT_SIGNED_IN` | Kiro reports a missing login; run `kiro-cli login` |
| `ENGINE_V3_UNAVAILABLE` | `kiro-cli acp --agent-engine=v3` did not initialize; names the CLI version and reason |
| `HOST_EXITED` | The ACP host exited during the call; the session re-attaches on next use and the prompt is not resent |
| `UNSUPPORTED_BY_KIRO` | Kiro does not advertise or implement the method or target |
| `KIRO_ERROR` | Other Kiro JSON-RPC error; `details.kiro` has Kiro's code, message, and error type |
| `KIRO_REFUSED` | Kiro answered `success: false` or refused for trust or access level |
| `OUTPUT_PARSE_FAILED` | CLI or Kiro output could not be parsed |
| `TIMEOUT` | A subcommand, request, or job passed its timeout; its process group was stopped |
| `CLI_EXIT` | A subcommand exited nonzero; `details.cli` has cleaned output tails |
| `PATH_OUTSIDE_ROOTS` | A path resolves outside `KIRO_MCP_ROOTS` |
| `PATH_EXISTS` | Export destination exists and `overwrite` is not true |
| `CONTENT_TOO_LARGE` | A file or image is too large, not UTF-8, or not an allowed image type |
| `SESSION_NOT_FOUND` | The session is unknown to Kiro or not attached here |
| `TURN_ACTIVE` | The session already has a running turn |
| `NO_ACTIVE_TURN` | Steering needs a running turn |
| `QUEUE_FULL` | Five prompts already wait for this session |
| `VALUE_NOT_ADVERTISED` | Mode, option, value, command, or recipe input is not advertised; lists the allowed values |
| `PERMISSION_NOT_FOUND` | The permission is not pending |
| `OPTION_NOT_OFFERED` | The option id was not offered |
| `PERSISTENT_CONSENT_DISABLED` | `allow_always` needs `KIRO_MCP_ALLOW_PERSISTENT_CONSENT` |
| `SHELL_APPROVAL_DISABLED` | Shell approvals need `KIRO_MCP_ALLOW_SHELL` |
| `HEADLESS_TRUST_DISABLED` | A headless trust flag is not allowed by the operator |
| `CONFIG_WRITES_DISABLED` | Config writes need `KIRO_MCP_ALLOW_CONFIG_WRITES` |
| `STDIO_SERVER_WITHHELD` | Stdio MCP servers run arbitrary commands and cannot be added |
| `SETTING_WITHHELD` | The setting key is withheld |
| `CONFIRMATION_REQUIRED` | The call needs `confirm: true` |
| `JOB_NOT_FOUND` | Unknown or expired headless job |
| `SPEC_NOT_FOUND` | The spec or document does not exist |
| `TANGENT_NOT_FOUND` | Not part of a tangent tree, or no tangent with that name |
| `INVALID_MERGE_TARGET` | The merge destination resolves to the tangent itself or nothing |
| `NOTHING_TO_BRANCH` | The session has no messages yet |

## Development

```bash
npm ci
npm run build   # strict tsc is the static check
npm test        # builds, then node --test against the fake kiro-cli
```

Tests never run a real `kiro-cli`: `test/fixtures/fake-kiro.mjs` stands in for it through `KIRO_BIN`. See [AGENTS.md](AGENTS.md) for the architecture and rules.

## Releasing

Bump `version` in `package.json`, merge, then push a matching tag (`git tag v0.1.0 && git push origin v0.1.0`). The release workflow checks the tag against `package.json`, builds, tests, publishes to npm with provenance through trusted publishing (GitHub OIDC, no `NPM_TOKEN`), creates a GitHub release, and mirrors the package to GitHub Packages.

## Credits

Inspired by [vanphappi/kiro-cli-mcp](https://github.com/vanphappi/kiro-cli-mcp). No code was copied.

## License

MIT
