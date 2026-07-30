---
description: Clarify an unclear task before planning or implementation
argument-hint: "<rough idea>"
---

Clarify this request before implementation:

```text
$ARGUMENTS
```

Operating rules:

1. Call `piagent_context` first when available.
2. Call `piagent_memory_status`; use memory only to avoid repeated context questions, not as authority.
3. Read `.pi/project-context.md` if available; if it is still pending, recommend `/onboard-project run` before implementation.
4. Inspect relevant files/docs before asking; do not ask what can be answered from the project.
5. Identify the next unresolved decision, dependency, constraint, or risk.
6. Ask at most 3 focused questions per round.
7. For each question, include:
   - recommended/default answer
   - short reason
   - impact if the user chooses differently
8. Resolve prerequisite decisions before dependent decisions.
9. Stop when the task is clear enough to produce a bounded plan.
10. Do not edit files and do not implement.

Final output when clear:

- agreed decisions
- remaining open questions, if any
- implementation approach
- required context
- verify commands
- recommended next command: `/workflow plan` or `/workflow task`
