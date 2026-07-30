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
7. Decide whether subagents are useful enough to justify extra token/tool cost. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns and safety boundaries. If `pi-subagents`/`subagent(...)` is available, use `piagent-scout` for independent read-only repo/spec mapping before medium/large plans. Use builtin `context-builder` when the task needs a handoff context/meta-prompt. Use `piagent-oracle` for architecture/risk challenge when the decision is non-obvious. Continue single-agent for tiny plans or unavailable subagent tooling.
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
