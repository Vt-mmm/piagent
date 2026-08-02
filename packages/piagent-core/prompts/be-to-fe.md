---
description: Implement frontend from backend spec/contract with backend read-only
argument-hint: "<BE spec/change + FE outcome>"
---

Implement a frontend change from a backend spec, backend diff, or backend source contract without modifying backend source.

Request:

```text
$ARGUMENTS
```

Use this for tasks like:

- BE endpoint/DTO changed and FE must consume it.
- BE feature spec must be surfaced in FE.
- FE needs to map validation/errors/state from backend contract.
- Backend source must be scouted but not edited.

Flow:

1. Read the current backend contract and narrow frontend touchpoints. Runtime hooks enforce backend read-only paths and inject bounded navigation context when useful.
2. Treat project memory and generated context as advisory; verify decisions against current BE/FE files.
3. Classify the task:
   - BE scout: read-only.
   - FE implementation: source-write.
   - Auth/data migration/external provider: high-risk, ask before implementation.
4. Use bounded read-only subagents only when BE/FE mapping has independent lanes worth the extra token/tool cost:
   - `piagent-scout` maps backend contract read-only;
   - `piagent-scout` maps frontend touchpoints read-only;
   - builtin `context-builder` may create handoff context when the BE→FE mapping touches multiple journeys/forms/contracts;
   - `piagent-planner` produces the FE implementation plan when the contract touches multiple layers;
   - `piagent-reviewer` reviews diff/verification after implementation.
   Continue single-agent if subagents are unavailable, the task is tiny, or requirements are unresolved.
5. Scout backend contract read-only:
   - controller/route/handler;
   - request/response DTO/schema;
   - validation/error model;
   - backend tests;
   - OpenAPI/spec/docs if available;
   - migration/schema only when it affects API shape or UI constraints.
6. Produce a contract snapshot before FE writes:

   | Contract area | Backend evidence | FE implication |
   |---|---|---|

7. If backend contract is missing/contradictory, do not guess and do not edit BE. Record the gap in the final response or a project report if requested.
8. Map FE touchpoints:
   - API client/query/mutation layer;
   - types/decoders;
   - state/cache invalidation;
   - route/page/component/form;
   - tests/e2e.
9. Call `piagent_task_start` exactly once before FE source writes and reuse an active contract.
10. Implement FE only with one writer by default.
11. Run every exact command returned in `task.verifyCommands` after the latest mutation. For a normal default plan, review the final diff and mark only its review step done with `piagent_task_progress`.
12. Let runtime hooks record context, verification, trace, and final-gate state. Use recovery tools only if the runtime reports missing evidence.
13. Do not paste full test/build/tool logs into chat or final output. Summarize the signal and quote only relevant failing lines.

For generic projects, use profile `be-readonly-fe` when the repo policy is “BE scout only, FE write allowed”.

Do not ask the user to paste the mandatory flow. The platform prompt already contains it. If the user asks only for scout/audit, stay read-only and prefer `/workflow scout` or `/piagent-session fresh scout`.

Final output:

- Backend files read and why.
- Contract snapshot summary.
- FE files changed.
- Verify command/result.
- Subagents used/not used and why.
- Review lenses applied.
- Memory cited, if any.
- Backend gaps, if any.
- Residual risk.
