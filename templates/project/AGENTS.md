# Project Agent Instructions

## Operating model

This project uses Pi Agent Platform.

Before implementation:

1. Load `.pi/piagent-profile.json` with `piagent_context`.
2. If `.pi/project-context.md` still says "Generated: not yet", run `/onboard-project` after login/model selection before the first implementation task.
3. Check `.pi/context-index.json` with `/context-index` or `piagent_context_index_status` when available; use it only as an advisory navigation map.
4. Read `.pi/project-context.md` and required context files listed in the profile; use `piagent_context_budget` for large files.
5. Check project memory with `piagent_memory_status` when relevant; memory is advisory, source files are authoritative.
6. Start source-changing work with `piagent_task_start`.
7. Respect protected paths.
8. Use `piagent_exec_policy_check` before high-impact or complex shell commands.
9. Use `piagent_tool_policy_check` before non-piagent MCP/app tools.
10. Use MCP/tools only when declared in profile.
11. Use `piagent_usage_snapshot` or `/piagent-usage` when the user asks about token/context usage or session follow-up.
12. Record context/verify/trace with `piagent_context_record`, `piagent_verify_record`, and `piagent_trace_record`. Passing verify evidence must be the exact command from `task.verifyCommands`.
13. Run `piagent_task_gate_check` before DONE.
14. For unclear tasks, use `/discuss` first; do not implement while requirements are unresolved.
15. For external source repos, use `piagent-source-cache` and read targeted files only.
16. For medium/large tasks, auto-delegate independent read-only scout/planning/review work to `piagent-scout`, `piagent-planner`, `piagent-reviewer`, or `piagent-oracle` when `pi-subagents` is available. Do not require the user to type `/run` for normal task orchestration.
17. Keep implementation single-writer by default. Use parallel writers only with explicit user approval or safe worktree isolation and disjoint write sets.
18. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns, review loops, native supervisor coordination, and safety boundaries.

## Review

Use `REVIEW_GUIDELINES.md` when reviewing code in this project.

## Secrets

Do not commit OAuth tokens, API keys, `.env`, `auth.json`, session files, `.pi/memory/MEMORY.md`, `.pi/memory/memory_summary.md`, or `.pi/memory/local/`.
