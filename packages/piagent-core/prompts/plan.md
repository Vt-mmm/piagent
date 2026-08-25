---
description: Create an implementation plan using piagent Pi policy
argument-hint: "<goal>"
---

Create a concise implementation plan for:

```text
$ARGUMENTS
```

Rules:

1. Call `piagent_context`.
2. Call `piagent_orchestration_policy`; default to solo-first and choose review lenses/model roles before considering subagents.
3. Call `piagent_memory_status`; search memory or Field Guide if it can reduce re-scouting, but treat it as advisory.
4. Read `.pi/project-context.md`; if it is missing or still pending, recommend `/onboard-project run` before implementation.
5. Read required context.
6. Identify protected paths and external/high-risk actions.
7. Keep planning in the parent. At most one fresh read-only helper may run only when runtime evidence proves two independent workstreams, no dependency on later parent output, and at least 30% projected total token savings after transfer/merge. Never delegate implementation, fork parent history, retry a deterministic helper failure, or add a helper only for review quality.
8. Produce a compact task tree/workPlan with exact files, commands, owner role, review lenses, and verify gates.
9. Do not implement yet unless the user explicitly asks.

Include:

- Outcome.
- Scope and out-of-scope.
- Touchpoints.
- Risks.
- Verify commands.
- WorkPlan/task tree.
- Review lenses.
- Subagents used/not used and why.
- Memory cited, if any.
- Open questions.
