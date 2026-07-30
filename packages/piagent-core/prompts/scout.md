---
description: Scout a project area read-only under piagent policy
argument-hint: "<area/spec/risk to map>"
---

Scout read-only:

```text
$ARGUMENTS
```

Use this when the user needs evidence before deciding whether to implement. Do not edit source.

Lean scouting flow:

1. For a narrow lookup, call `piagent_context` with concise detail, read targeted files, and return cited evidence. Do not create a task contract or load memory/index/orchestration policy automatically.
2. For a broad, cross-module, or high-risk scout, run `piagent_context_preflight` once. Stop if it recommends a fresh session.
3. Create a read-only contract with `piagent_task_start` only for a broad governed scout that needs a persisted scope, verification evidence, or handoff.
4. For an unfamiliar or cross-module area, call `piagent_context_engine` once with `action=pack` before manual search. Use memory, Context7, or a read-only subagent only when the pack is insufficient or the work has independent lanes. Verify every advisory hit against current files.
5. Call `piagent_context_budget` only for large files and `piagent_exec_policy_check` only for complex or unfamiliar shell commands. Simple read/list commands do not need proactive policy calls.
6. Record the files that materially support the conclusion. For a governed scout, record verification, trace, and task gate; for a narrow lookup, provide the evidence directly.
7. A low-confidence pack may trigger one bounded finder pass. Do not loop broad search after the requested evidence is covered.
8. Do not edit source and do not paste full command output. Summarize relevant evidence and unknowns.

Output:

- Changed files: none.
- Verify command/result.
- Context manifest.
- Extra workflow tools or subagents used, if any, and why.
- Review lenses applied.
- Memory cited, if any.
- Evidence matrix.
- Gaps/mismatches/unknowns.
- Transaction/security/data risks if relevant.
- Task gate result.
- Recommended next step.
