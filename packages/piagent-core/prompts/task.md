---
description: Implement a bounded project task using piagent Pi policy
argument-hint: "<task>"
---

Implement this task:

```text
$ARGUMENTS
```

Mandatory flow:

0. Call `piagent_context_preflight` with `workflow=task`. If it recommends `fresh-session`, stop loading context in this session and tell the user to use `/fresh-task <request>` unless this command already runs in a fresh session.
1. Call `piagent_context` and read the project profile/runtime policy.
2. Call `piagent_orchestration_policy` and keep the task solo-first unless the policy and task shape make bounded subagents clearly useful.
3. Call `piagent_memory_status`. If memory or the Field Guide is enabled and relevant to the task, search/read it as advisory context, record citations with `piagent_memory_citation_record`, then verify against current repo files.
4. Call `piagent_context_index_status` when available, then read `.pi/project-context.md`. If `.pi/project-context.md` is missing or still says `Generated: not yet`, stop and ask the user to run `/onboard-project` after login/model selection before implementation.
   - Use `piagent_context_index_search` for navigation hints when the task touches an unfamiliar module/tech/risk area.
   - Treat context-index hits as advisory; open and verify cited files before editing.
5. Build a Task Implementation Contract with `piagent_task_start` before editing:
   - task id or short slug
   - risk lane
   - expected output
   - acceptance criteria
   - scope / out of scope
   - protected paths
   - required context
   - verify command
   - review lenses
   - a compact workPlan/task tree
6. Read all required context files from the profile before planning, then call `piagent_context_budget` for large or unfamiliar files.
   - If `piagent_context` reports a configured tech stack, read only the concise `.pi/tech-context/*.json` snapshots relevant to the task.
   - If a selected tech has pending Context7 status and the task depends on that tech, read current docs through Context7 and record a compact snapshot with `piagent_profile_tech_context_record`.
   - Do not paste or store large vendor documentation blocks in project files.
7. Decide whether subagents are worth their extra token/tool cost. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns and safety boundaries. If `pi-subagents`/`subagent(...)` is available, use bounded subagents only for independent read-heavy scout/planning/review work:
   - use `piagent-scout` for unfamiliar module/spec mapping;
   - use builtin `context-builder` when a large task needs a handoff context/meta-prompt before planning;
   - use `piagent-planner` for medium/high-risk implementation planning;
   - use `piagent-reviewer` for final diff/test/scope review;
   - use explicit review lenses instead of spawning a broad swarm;
   - keep implementation single-writer unless the user explicitly asks for parallel writers or worktree isolation is clearly safe;
   - if subagents are unavailable or not useful, continue single-agent and record why.
8. Record context manifest with `piagent_context_record`: file + reason.
9. If the task requires shell commands beyond simple read/list/test, call `piagent_exec_policy_check` first.
10. If the task requires non-piagent MCP/app tools, call `piagent_tool_policy_check` first.
11. If the task requires source writes, make a short plan first.
12. Do not touch protected paths.
13. Use MCP/tools only when the profile capability allows it.
14. Before final answer, run the exact verify command from `task.verifyCommands` through Pi bash, then record the observed result with `piagent_verify_record`. Do not use `true`, `echo ok`, or `|| true` as passing evidence unless that exact command is part of the task verify plan.
15. Record handoff with `piagent_trace_record`. If the task produces durable, non-secret project knowledge and the workflow is approved, record a compact cited node with `piagent_context_index_record`; do not save raw transcript.
16. Call `piagent_task_gate_check`. If gate fails, final outcome is blocked/partial, not done.
17. If the user asks about token/context/cost usage, call `piagent_usage_snapshot`; for exact token/cost totals, tell the user to run `/session` or `piagent-usage <project-path>`.
18. If verify cannot run, stop and report the exact blocker. Do not call it done.
19. Do not paste full test/build/tool logs into chat or final output. Summarize the signal, quote only the relevant failing lines, and use `/piagent-logs` or a narrower command when oversized output has been compacted.

Do not ask the user to paste this mandatory flow. The platform prompt already contains it. If the user pasted the full flow, treat it as boilerplate and extract only the task request.

Output format:

- Changed files.
- Verify command/result.
- Context manifest.
- Subagents used/not used and why.
- Review lenses applied.
- Memory cited, if any.
- Context index used/updated, if any.
- Task gate result.
- Residual risks.
- Next step if human action is needed.
