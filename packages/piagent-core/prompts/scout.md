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

1. Read targeted current files and return cited evidence. Runtime hooks inject bounded navigation context when useful and enforce read boundaries.
2. Create a read-only contract with `piagent_task_start` only for a broad governed scout that needs persisted scope or handoff. Tiny default scouts complete from observed reads; for a normal default scout, review the evidence and mark only the returned review step done with `piagent_task_progress`.
3. Use memory, vendor documentation, or a read-only subagent only when current source is insufficient or the work has independent lanes. Verify advisory material against current files.
4. A low-confidence search may trigger one bounded finder pass. Stop broad search when the requested evidence is covered.
5. Do not call diagnostic Piagent tools for a routine scout. Load them only when the runtime reports a recovery need or the operator explicitly asks for diagnostics.
6. Do not edit source or paste full command output. Summarize relevant evidence and unknowns.

Output:

- Changed files: none.
- Verify command/result.
- Extra workflow tools or subagents used, if any, and why.
- Review lenses applied.
- Memory cited, if any.
- Evidence matrix.
- Gaps/mismatches/unknowns.
- Transaction/security/data risks if relevant.
- Recommended next step.
