---
description: Review current project changes under piagent policy
argument-hint: "<target or git diff>"
---

Review:

```text
$ARGUMENTS
```

Rules:

0. Call `piagent_context_preflight` with `workflow=review` for large diffs or long requests. If it recommends `fresh-session`, prefer `/piagent-session fresh scout` for read-only evidence gathering or ask the user to resume in a fresh session.
1. Call `piagent_context`.
2. Call `piagent_orchestration_policy` and select explicit review lenses before reading the diff deeply.
3. Read `.pi/project-context.md` if available.
4. Stay read-only unless explicitly asked to write a report.
5. Check protected path violations.
6. Check missing required context.
7. Check verify command coverage.
8. Decide whether subagents are useful. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns and safety boundaries. If `pi-subagents`/`subagent(...)` is available and the diff is non-trivial, use bounded `piagent-reviewer` agents for independent read-only review lanes:
   - correctness/edge cases;
   - tests/verification;
   - scope drift/protected paths;
   - security/high-risk only when relevant.
   If the user asks for a loop, use `/review-loop` semantics or equivalent parent-controlled max-round loop. Continue single-agent for tiny diffs or unavailable subagent tooling.
9. Report findings by severity.
10. Do not paste full diff/test/tool logs into chat or final output. Summarize the signal, quote only relevant lines, and use `/piagent-logs` or narrower commands when oversized output has been compacted.

Output:

| Severity | File/area | Finding | Required fix |
|---|---|---|---|

Also include:

- Review lenses covered.
- Subagents used/not used and why.
