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
4. Check protected paths, scope drift, acceptance behavior, and verify-command coverage.
5. For a non-trivial diff, use bounded read-only reviewers only when independent lanes justify their token cost:
   - correctness/edge cases;
   - tests/verification;
   - scope drift/protected paths;
   - security/high-risk only when relevant.
   If the user asks for a loop, use `/review-loop` semantics or equivalent parent-controlled max-round loop. Continue single-agent for tiny diffs or unavailable subagent tooling.
6. Report findings by severity.
7. Do not call diagnostic Piagent tools for routine review and do not paste full diff/test/tool logs. Summarize the signal and quote only relevant lines.

Output:

| Severity | File/area | Finding | Required fix |
|---|---|---|---|

Also include:

- Review lenses covered.
- Subagents used/not used and why.
