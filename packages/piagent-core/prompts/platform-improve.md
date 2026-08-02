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

Flow:

1. Use runtime automatic intake for a bounded platform change. If runtime pauses for broad, high-risk, or ambiguous scope, call `piagent_task_start` exactly once with project-relative path/glob scope and reuse an active contract.
2. Read the narrow current implementation, its tests, and the relevant policy/schema/docs. Runtime hooks inject bounded navigation context when useful.
3. Treat memory and generated context as advisory; verify against current files.
4. Use bounded subagents only when independent lanes justify their extra token/tool cost:
   - use `piagent-scout` for read-only code/package mapping;
   - use `piagent-planner` for a plan when multiple modules are affected;
   - use `piagent-reviewer` for diff, docs, and verification review;
   - continue single-agent for small, localized edits.
5. If the task needs external repository context provided by the user, use a targeted read-only checkout when available.
6. Produce an implementation matrix only when multiple platform areas are affected:

    | Area | Current behavior | Target behavior | Files/config | Verification |
    |---|---|---|---|---|

7. Implement only the bounded target behavior with one writer by default.
8. If runtime behavior changes, update README/docs and add or adjust a decision note when appropriate.
9. Run every exact command returned in `task.verifyCommands` after the latest mutation. For a normal default plan, review the final diff and mark only its review step done with `piagent_task_progress`.
10. Let runtime hooks record context, verification, trace, and final-gate state. Use recovery tools only if the runtime reports missing evidence.
11. Do not paste full test/build/tool logs into chat or final output. Summarize the signal and quote only relevant failing lines.

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
- Remaining risks or follow-up.
