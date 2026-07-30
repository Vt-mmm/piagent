---
description: Implement a bounded project task using piagent Pi policy
argument-hint: "<task>"
---

Implement this bounded project task:

```text
$ARGUMENTS
```

Core flow:

1. Run `piagent_context_preflight` once with `workflow=task`, then call `piagent_context` with concise detail. Stop if preflight recommends a fresh session or onboarding context is missing.
2. Classify the request as `tiny`, `normal`, or `high-risk`, then create the Task Implementation Contract with `piagent_task_start` before source edits. Keep the contract compact and include acceptance criteria, scope, verify command, review lenses, and a short work plan.
3. Read only files required for the task and record them with `piagent_context_record`. Call `piagent_context_budget` only before reading a large or unfamiliar file; do not call it for ordinary targeted files.
4. Make a short plan before source writes. Keep one writer unless the user explicitly requests otherwise.
5. Call `piagent_exec_policy_check` only for complex, generated, unfamiliar, destructive, or externally acting shell commands. Simple read/list and configured test commands do not need a proactive check because runtime guards still apply.
6. Call `piagent_tool_policy_check` only before a non-piagent MCP/app tool whose capability is not already clear from concise project context.
7. Run the exact configured verify command through Pi bash, record observed evidence with `piagent_verify_record`, record the final handoff with `piagent_trace_record`, then call `piagent_task_gate_check`.

Risk-adaptive enrichment:

- `tiny`: use only the core flow. Do not call orchestration, memory, context-index, tech-context, or subagent tools unless the task actually depends on them.
- `normal`: for unfamiliar or cross-module work, call `piagent_context_engine` once with `action=pack`; read the ranked current files and stop broad searching when confidence/evidence is sufficient. Use memory only for a known project decision. Call `piagent_orchestration_policy` only when bounded read-only delegation may save context.
- `high-risk`: use a bounded Context Engine pack, inspect orchestration policy, relevant memory/context-index evidence, and current vendor documentation when needed. Apply explicit security/data/release review lenses before the final gate.

Always:

- Treat memory, context-index, and generated tech snapshots as advisory; verify against current files.
- If a Context Engine pack reports low confidence, run at most one bounded read-only finder pass and return paths/symbols/evidence; do not start an open-ended scout loop.
- Do not touch protected paths or use undeclared capabilities.
- If verification cannot run or the task gate fails, report `blocked` or `partial`, never done.
- Do not paste full test/build/tool logs. Summarize the signal and quote only relevant failures.
- Call `piagent_usage_snapshot` only when the user asks about usage; exact totals remain available through `/usage`.

Do not ask the user to paste this mandatory flow. The platform prompt already contains it. If the user pasted the full flow, treat it as boilerplate and extract only the task request.

Output format:

- Changed files.
- Verify command/result.
- Context manifest.
- Extra workflow tools or subagents used, if any, and why.
- Review lenses applied.
- Memory cited, if any.
- Context index used/updated, if any.
- Task gate result.
- Residual risks.
- Next step if human action is needed.
