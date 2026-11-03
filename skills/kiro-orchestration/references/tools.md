# kiro-mcp-server tool cheat sheet

| Goal | Tool | Notes |
| --- | --- | --- |
| Check setup | `kiro_status` | CLI, sign-in, V3 engine, root trust, policy, warnings |
| Plan usage | `kiro_usage` | `session_id` adds credits observed for that session |
| Start a session | `kiro_session_new` | `cwd`, `mode`, `model`, `effort`, `title`, `execution_target`, `repos` |
| Find sessions | `kiro_session_list` | `scope: "user"` spans workspaces; `source: "remote"` for cloud |
| Resume | `kiro_session_load` | `session_id`, or `latest: true` with `cwd` |
| Change mode, model, effort | `kiro_session_configure` | Values must be advertised |
| See MCP servers, steering, skills, context | `kiro_session_state` | `include: ["mcp", "steering", "skills", "context", "configuration"]` |
| Prompt | `kiro_prompt` | `text`, `files`, `images`, `command`, `wait_s`, `when_busy` |
| Poll | `kiro_events` | `cursor`, `wait_s`, `include_thoughts`; `job_id` for headless jobs |
| Stream any session | `kiro_stream_session` | Loads sessions this server did not start; `types`, `max_chars` |
| Steer or stop | `kiro_steer`, `kiro_cancel` | Cancel also stops headless jobs by `job_id` |
| Permissions | `kiro_permissions`, `kiro_permission_respond` | Offered `option_id` only |
| Transcript and rewind | `kiro_session_history`, `kiro_session_fork` | Rewind points carry `message_id` |
| Side conversations | `kiro_tangent` | `branch`, `tree`, `merge` |
| Specs | `kiro_specs` | `list`, `read` with parsed tasks |
| Compact | `kiro_session_compact` | Idle sessions only |
| Memory, knowledge, code intelligence | `kiro_memory`, `kiro_knowledge`, `kiro_code_intelligence` | Kiro may refuse (KIRO_REFUSED) |
| Workflows and goals | `kiro_workflow` | `list_recipes`, `invoke` with declared inputs |
| Cloud repositories | `kiro_cloud_sources` | Providers, then `provider: "GITHUB"` |
| Headless job | `kiro_run_headless` | Poll with `kiro_events job_id`; exit 3 = MCP startup failed, 4 = agent not found |
| Kiro config | `kiro_agents`, `kiro_mcp_config`, `kiro_settings`, `kiro_powers` | Writes need `KIRO_MCP_ALLOW_CONFIG_WRITES` |

Composed commands: `/clear` = `kiro_session_new`; `/spawn` = `kiro_session_new` + `kiro_prompt`; `/spec run` = mode `spec` + a prompt naming the spec; `/goal` = `kiro_workflow invoke` of the goal recipe, or mode `autonomous` with explicit acceptance criteria.
