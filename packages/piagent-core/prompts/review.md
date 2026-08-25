---
description: Review current project changes under piagent policy
argument-hint: "<target or git diff>"
---

Review:

```text
$ARGUMENTS
```

Rules:

1. Read the current diff and the narrow surrounding source/tests. Runtime hooks inject bounded navigation context when useful.
2. Select review lenses from the actual change risk; do not load orchestration or diagnostic tools just to choose them.
3. Stay read-only unless explicitly asked to write a report.
4. Check protected paths, unrelated change drift, acceptance behavior, and verify-command coverage. Treat task scope as an initial focus, not write authority.
5. Review directly in the parent. A non-trivial diff does not itself justify another model run. At most one fresh read-only reviewer is eligible only when a runtime estimate proves an independent lane and at least 30% projected total token savings after handoff/merge; never run parallel review or retry a deterministic helper failure. If the user explicitly asks for a loop, keep it parent-controlled and bounded.
6. Report findings by severity.
7. Do not call diagnostic Piagent tools for routine review and do not paste full diff/test/tool logs. Summarize the signal and quote only relevant lines.

Output:

| Severity | File/area | Finding | Required fix |
|---|---|---|---|

Also include:

- Review lenses covered.
- Subagents used/not used and why.
