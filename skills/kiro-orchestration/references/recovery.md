# Recovery playbook

| Symptom | What happened | Do this |
| --- | --- | --- |
| `CLI_NOT_FOUND` | `kiro-cli` is not installed or `KIRO_BIN` is wrong | Tell the user to install it (`curl -fsSL https://cli.kiro.dev/install | bash`) |
| `CLI_NOT_SIGNED_IN` | Kiro's login is missing or expired | Ask the user to run `kiro-cli login` in a terminal. Never try to log in |
| `ENGINE_V3_UNAVAILABLE` | The V3 ACP engine did not start | Report the message (it names the CLI version); the user may need to update `kiro-cli` |
| `HOST_EXITED` | The ACP host crashed during the call | The session re-attaches on its next use. The prompt was not resent: check `kiro_session_history`, then send it again if it did not land |
| Turn `failed` | Kiro answered the prompt with an error, or the host exited | Read `turn.error`; retry once, then report |
| `TURN_ACTIVE` | A turn is already running | Wait with `kiro_events`, queue with `when_busy: "queue"`, or `kiro_cancel` |
| `QUEUE_FULL` | Five prompts already wait | Wait for the queue to drain |
| `VALUE_NOT_ADVERTISED` | Mode, option, command, or recipe input is not offered | Pick from `details.allowed` or `details.closest` |
| Tool call `failure_reason: "denied"` with `policy: "shell_disabled"` | Shell approvals are off | Tell the user the task needs `KIRO_MCP_ALLOW_SHELL=1`, or ask Kiro to proceed without running commands |
| `policy: "timeout"` | Nobody answered a permission in time | Answer faster; poll `kiro_permissions` while a turn runs |
| `PATH_OUTSIDE_ROOTS` | A path is outside `KIRO_MCP_ROOTS` | Use a path inside the roots from `kiro_status` |
| `gap: true` in events | Older events were dropped from the bounded feed | Continue from `lowest_cursor`; use `kiro_session_history` for the full transcript |
| Kiro ignores the workspace's agents, steering, or skills | The folder is not trusted | Ask the user to run `kiro-cli --v3` there once and choose **Trust, continue** |
| Headless exit 3 or 4 | MCP startup failed, or the named agent is missing | Read `stderr_tail`; fix the MCP config or the agent name |
| A cloud session waits for approval | Approvals made while no client was attached | `kiro_session_load` returns them in `pending_permissions` |
