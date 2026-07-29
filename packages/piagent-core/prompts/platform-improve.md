---
description: Improve Pi Agent Platform workflows, policies, or package behavior
argument-hint: "<goal + affected area>"
---

Improve the Pi Agent Platform in a bounded, verifiable way.

Request:

```text
$ARGUMENTS
```

Use this workflow for platform-level work such as:

- updating package prompts, skills, extensions, or subagents;
- improving setup, onboarding, MCP, model, memory, or usage flows;
- tightening runtime policy, task gates, or verification behavior;
- adding project-agnostic workflow support for teams.

Mandatory flow:

1. Call `piagent_context` with `detail=full` and inspect the active project profile.
2. Call `piagent_orchestration_policy`; keep the platform change solo-first unless bounded scout/planning/review lanes are useful.
3. Call `piagent_memory_status`; if prior decisions or Field Guide notes are relevant, search memory and record citations with `piagent_memory_citation_record`.
4. Read `.pi/project-context.md`. If pending, stop and ask the user to run `/onboard-project`.
5. Read the required context declared by the active profile. Before loading large files, call `piagent_context_budget`.
6. Classify the task risk lane and create a task contract with `piagent_task_start`, including review lenses and a compact workPlan, before source edits.
7. Decide whether bounded subagents are useful enough to justify extra token/tool cost:
   - use `piagent-scout` for read-only code/package mapping;
   - use `piagent-planner` for a plan when multiple modules are affected;
   - use `piagent-reviewer` for diff, docs, and verification review;
   - continue single-agent for small, localized edits.
8. If the task needs external repository context provided by the user, use `piagent_source_checkout` when available and read only targeted files.
9. Before shell commands that fetch, build, publish, or mutate package state, call `piagent_exec_policy_check`.
10. Before non-piagent MCP/app tools, call `piagent_tool_policy_check`.
11. Produce an implementation matrix:

    | Area | Current behavior | Target behavior | Files/config | Verification |
    |---|---|---|---|---|

12. Implement only the bounded target behavior.
13. If runtime behavior changes, update README/docs and add/adjust a decision note when appropriate.
14. For source-changing tasks, run the exact verify command from `task.verifyCommands` through Pi bash, record observed verify evidence, trace, then call `piagent_task_gate_check` before final.
15. Do not paste full test/build/tool logs into chat or final output. Summarize the signal, quote only relevant failing lines, and use `/piagent-logs` or a narrower command when oversized output has been compacted.

Default verification:

```bash
bash scripts/verify-local.sh
bash scripts/team-doctor.sh /path/to/piagent --strict-share
pi list --approve
```

If setup/init behavior changed, also verify with a disposable fixture:

```bash
bash scripts/setup.sh /tmp/pi-fixture --project-only --profile auto --package-source "$(git rev-parse --show-toplevel)"
```

Final output:

- Goal and scope handled.
- Changed files.
- Verification command/result.
- Subagents used/not used and why.
- Review lenses applied.
- Memory cited, if any.
- Task gate result.
- Remaining risks or follow-up.
