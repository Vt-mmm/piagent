---
name: piagent-ops
description: Piagent operating policy for Pi tasks across projects.
---

# Piagent Ops Skill

Use this skill for every implementation, review, planning, MCP, or tooling task in a project using Pi Agent Platform.

## Mandatory steps

1. Load active project profile with `piagent_context`.
2. Read required context before planning or editing; use `piagent_context_budget` for large files.
3. Start source-changing work with `piagent_task_start`.
4. Respect `protectedPaths`.
5. Check complex/high-impact shell with `piagent_exec_policy_check`.
6. Check non-piagent MCP/app tools with `piagent_tool_policy_check`.
7. Use MCP only when capability is declared.
8. Prefer small diffs with explicit verification.
9. Run the exact command from `task.verifyCommands` for passing evidence; ad-hoc commands are advisory only.
10. Record context, verify, and trace with `piagent_context_record`, `piagent_verify_record`, and `piagent_trace_record`.
11. Before DONE, call `piagent_task_gate_check`.

## Risk gates

Stop for human confirmation when task touches:

- auth
- payments
- data migration
- external provider setup
- deploy/release
- destructive filesystem operation
- broad refactor across unrelated modules

## Final response

Always include:

- what changed
- where
- exact verification result
- task gate result
- what remains manual
