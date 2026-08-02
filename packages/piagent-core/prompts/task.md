---
description: Implement a bounded project task using piagent Pi policy
argument-hint: "<task>"
---

Implement this bounded project task:

```text
$ARGUMENTS
```

Core flow:

1. Use the runtime-created contract for a bounded source task; do not call task-management tools during automatic intake. If runtime pauses for broad, high-risk, or ambiguous scope, call `piagent_task_start` exactly once with project-relative path/glob scope and reuse an active contract.
2. Read the likely target and nearest relevant test. The runtime injects bounded navigation context when useful.
3. Make the smallest in-scope change with ordinary tools and one writer.
4. Run every exact command returned in `task.verifyCommands` after the latest mutation.
5. Automatic tasks need no lifecycle calls. Manual high-risk and explicitly requested custom plans keep their returned checkpoints.
6. Let runtime hooks record context, changed files, verification, trace, and final-gate state. Load recovery tools only if the runtime reports missing evidence.

Risk-adaptive enrichment:

- `tiny`: stay targeted; no diagnostic Piagent tools or subagents.
- `normal`: stop searching once current-file evidence is sufficient. Use a read-only subagent only for a genuinely independent lane.
- `high-risk`: inspect current source, relevant vendor documentation, and explicit security/data/release review lenses; keep required human confirmations.

Always:

- Treat memory, context-index, and generated tech snapshots as advisory; verify against current files.
- If navigation confidence is low, run at most one bounded read-only finder pass; do not start an open-ended scout loop.
- Do not touch protected paths or use undeclared capabilities.
- If verification cannot run, report `blocked` or `partial`, never done. If runtime schedules a continuation, keep working in the same task and do not repeat management tools.
- Do not paste full test/build/tool logs. Summarize the signal and quote only relevant failures.

Do not ask the user to paste this mandatory flow. The platform prompt already contains it. If the user pasted the full flow, treat it as boilerplate and extract only the task request.

Output format:

- Changed files.
- Verify command/result.
- Extra workflow tools or subagents used, if any, and why.
- Review lenses applied.
- Residual risks.
- Next step if human action is needed.
