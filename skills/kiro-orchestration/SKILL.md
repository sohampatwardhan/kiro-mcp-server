---
name: kiro-orchestration
description: Use when delegating coding work to Kiro CLI V3 through the kiro-mcp-server MCP tools (kiro_status, kiro_session_new, kiro_prompt, kiro_events, kiro_stream_session, kiro_permission_respond, kiro_run_headless). Covers when to hand a task to Kiro, choosing mode, model, effort, and permission handling, following a run live, collecting results and patches, and recovering when a session, turn, or the ACP host fails.
metadata:
  author: Soham Patwardhan
  version: "1.1.0"
---

# Orchestrating Kiro CLI V3 with kiro-mcp-server

The `kiro-mcp-server` MCP server drives Kiro CLI V3 sessions on the operator's machine. You call typed tools; you never write `kiro-cli` shell commands. The tool cheat sheet is in [references/tools.md](references/tools.md), and the failure playbook is in [references/recovery.md](references/recovery.md).

## When to delegate to Kiro

Hand a task to Kiro when it needs the operator's checkout and toolchain, a long multi-step edit, Kiro's spec workflow (requirements, design, tasks), or a cloud sandbox that keeps working after this machine disconnects. Keep a task yourself when it is a quick read or a one-line change you can make directly.

## Before the first prompt

1. Call `kiro_status`. Stop and tell the user if `cli.found` is false (install with `curl -fsSL https://cli.kiro.dev/install | bash`), `signed_in` is false (they must run `kiro-cli login` in a terminal; never try to log in yourself), or `engine_v3.ready` is false.
2. Read `warnings`. An untrusted root means Kiro will not load that folder's agents, steering, MCP servers, or skills: ask the user to run `kiro-cli --v3` in it once and choose **Trust, continue**. "Shell approvals are off" means Kiro cannot run commands, such as tests, until the operator sets `KIRO_MCP_ALLOW_SHELL=1`. Say so when the task needs tests.
3. Work only inside the listed `roots`. Paths outside fail with `PATH_OUTSIDE_ROOTS`.

## Choose the session and its options

- New work: `kiro_session_new` with `cwd`. To continue earlier work: `kiro_session_list`, then `kiro_session_load` (or `latest: true` with `cwd`).
- Mode (`kiro_session_new mode` or `kiro_session_configure mode`): `vibe` for ordinary coding, `plan` to plan without edits, `spec` / `quick-spec` / `bug-fix` for Kiro's spec workflows, `autonomous` for long unattended runs, or a custom agent from `modes`.
- Model and effort: only values listed in `config_options` work; anything else is `VALUE_NOT_ADVERTISED` with the allowed list. Use `auto` unless the user asks for a model.
- Cloud: `execution_target: "cloud"` with `repos` (find them with `kiro_cloud_sources`). Fire-and-forget or CI-style work: `kiro_run_headless` instead of a session; it cannot ask for permission, so anything not pre-approved is denied.

## Prompt, follow, and answer permissions

1. `kiro_prompt` with clear acceptance criteria in `text`. Attach files with `files` (links by default, `embed: true` for small UTF-8 text) and screenshots with `images`. Run a skill, MCP prompt, or sub-agent with `command: { name, input }` using a name from the session's command catalog.
2. If `status` is `completed`, read `turn.final_text`. Otherwise follow the run: `kiro_stream_session` with `cursor` (short waits, filters like `types: ["message", "tool_call", "permission"]`), or `kiro_events` with `wait_s`, or subscribe to `kiro-session://<session_id>/transcript`. Always pass back the `next_cursor` you were given. A message or tool call that changes comes back with a new `seq`: keep the latest per `segment` or `toolCallId`.
3. A turn is finished only when the status is `completed`, `cancelled`, or `failed`. A `turn` event with phase `end` is not the end.
4. When `pending_permissions` is not empty, decide each one and call `kiro_permission_respond` with one of its `options[].option_id` values only. Prefer `allow_once` for actions inside the task's scope and `reject_once` for anything else. Treat `mcp_tool` annotations as untrusted claims. Use `allow_always` only when the user asked for it (it needs `KIRO_MCP_ALLOW_PERSISTENT_CONSENT`). A denial does not end the turn.
5. To redirect a running turn, `kiro_steer`. To stop it, `kiro_cancel`. To queue a follow-up, `kiro_prompt` with `when_busy: "queue"`.

## Collect results

- Report `turn.final_text`, the `tool_calls` summary (failed calls carry `failure_reason`: `denied`, `cancelled`, or `error`), and `credits` (`kiro_usage` gives plan totals).
- Kiro edits files in the session's `cwd`. To review or hand off the change, ask Kiro in the same session for `git diff` or `git format-patch` output, or read the files yourself. For a spec run, read `kiro_specs` (`list`, then `read` of `tasks.md` for checked tasks).
- Explore an alternative without disturbing the main thread with `kiro_tangent branch`, then `kiro_tangent merge` to bring a summary back. Roll back with `kiro_session_history` rewind points and `kiro_session_fork` with `message_id`.
- When done, `kiro_session_close`. Delete only on request (`kiro_session_delete` with `confirm: true`).

## Recover

See [references/recovery.md](references/recovery.md). The short version: `HOST_EXITED` means re-run your last prompt yourself (the server never resends it) after checking `kiro_session_history`; `TURN_ACTIVE` means wait, queue, or cancel; `CLI_NOT_SIGNED_IN` and untrusted workspaces need the user.
