---
description: Scout a project area read-only under piagent policy
argument-hint: "<area/spec/risk to map>"
---

Scout read-only:

```text
$ARGUMENTS
```

Use this when the user needs evidence before deciding whether to implement. Do not edit source.

Preflight first:

1. Call `piagent_context_preflight` with `workflow=scout`.
2. If it recommends `fresh-session`, stop loading context in this session and tell the user to use `/fresh-scout <request>` unless this command already runs in a fresh session.
3. Call `piagent_context` with `detail=full`.
4. Call `piagent_orchestration_policy`; keep scout solo-first unless independent read-only lanes are useful.
5. Call `piagent_memory_status`; cite relevant memory or Field Guide only with `piagent_memory_citation_record`, then verify against current repo files.
6. Read `.pi/project-context.md`; if pending, stop and ask for `/onboard-project`.
7. Create a read-only task contract with `piagent_task_start` before broad scouting:
   - risk lane;
   - expected output;
   - scope / out of scope;
   - protected paths;
   - required context;
   - read-only verify command.
   - review lenses and a compact read-only workPlan.
8. Read required context and targeted task files. Use `piagent_context_budget` before large files.
9. Use read-only subagents for independent mapping when useful: `piagent-scout`, builtin `context-builder`, and `piagent-reviewer` for final evidence review. Continue single-agent if unavailable, too small, or likely to burn more context than it saves.
10. Record context with `piagent_context_record`.
11. If shell is needed beyond simple read/list/test, call `piagent_exec_policy_check`.
12. Run the exact verify command from the task contract and record with `piagent_verify_record`.
13. Record handoff with `piagent_trace_record`.
14. Call `piagent_task_gate_check`. If the gate fails, report partial/blocked.
15. Do not paste full tool/test logs into chat or final output. Summarize the signal, quote only relevant lines, and use `/piagent-logs` or a narrower command when oversized output has been compacted.

Output:

- Changed files: none.
- Verify command/result.
- Context manifest.
- Subagents used/not used and why.
- Review lenses applied.
- Memory cited, if any.
- Evidence matrix.
- Gaps/mismatches/unknowns.
- Transaction/security/data risks if relevant.
- Task gate result.
- Recommended next step.
