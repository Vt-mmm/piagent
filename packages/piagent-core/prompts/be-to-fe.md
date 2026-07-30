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

Mandatory flow:

0. Call `piagent_context_preflight` with `workflow=be-to-fe`. If it recommends `fresh-session`, stop loading context in this session and tell the user to use `/piagent-session fresh be-to-fe <request>` unless this command already runs in a fresh session.
1. Call `piagent_context` with `detail=full` and confirm profile/protected backend paths.
2. Call `piagent_orchestration_policy`; keep the workflow solo-first unless bounded BE/FE scouting or review is worth the extra token/tool cost.
3. Call `piagent_memory_status`; search memory or Field Guide for prior BE/FE mapping decisions if relevant, record citations with `piagent_memory_citation_record`, then verify against current BE/FE files.
4. Read `.pi/project-context.md`. If pending, stop and ask for `/onboard-project run`.
5. Read required context from the active profile and call `piagent_context_budget` for BE/FE files that look large.
6. Classify the task:
   - BE scout: read-only.
   - FE implementation: source-write.
   - Auth/data migration/external provider: high-risk, ask before implementation.
7. Decide whether bounded subagents are useful. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns and safety boundaries. If `pi-subagents`/`subagent(...)` is available, prefer read-only delegation only when BE/FE mapping has independent lanes:
   - `piagent-scout` maps backend contract read-only;
   - `piagent-scout` maps frontend touchpoints read-only;
   - builtin `context-builder` may create handoff context when the BE→FE mapping touches multiple journeys/forms/contracts;
   - `piagent-planner` produces the FE implementation plan when the contract touches multiple layers;
   - `piagent-reviewer` reviews diff/verification after implementation.
   Continue single-agent if subagents are unavailable, the task is tiny, or requirements are unresolved.
8. Scout backend contract read-only:
   - controller/route/handler;
   - request/response DTO/schema;
   - validation/error model;
   - backend tests;
   - OpenAPI/spec/docs if available;
   - migration/schema only when it affects API shape or UI constraints.
9. Produce a contract snapshot before FE writes:

   | Contract area | Backend evidence | FE implication |
   |---|---|---|

10. If backend contract is missing/contradictory, do not guess and do not edit BE. Record the gap in the final response or a project report if requested.
11. Map FE touchpoints:
   - API client/query/mutation layer;
   - types/decoders;
   - state/cache invalidation;
   - route/page/component/form;
   - tests/e2e.
12. Before source writes, create a Task Implementation Contract with `piagent_task_start`, including review lenses and a compact workPlan.
13. Record BE/FE context files with `piagent_context_record`.
14. Before shell commands beyond simple read/list/test, call `piagent_exec_policy_check`.
15. Implement FE only.
16. Run the exact FE verify command from the profile/task through Pi bash and record the observed result with `piagent_verify_record`. Ad-hoc commands are advisory only and will not satisfy the passing gate.
17. Record handoff with `piagent_trace_record`.
18. Call `piagent_task_gate_check`; if it fails, report blocked/partial instead of done.
19. Do not paste full test/build/tool logs into chat or final output. Summarize the signal, quote only relevant failing lines, and use `/piagent-logs` or a narrower command when oversized output has been compacted.

For generic projects, use profile `be-readonly-fe` when the repo policy is “BE scout only, FE write allowed”.

Do not ask the user to paste the mandatory flow. The platform prompt already contains it. If the user asks only for scout/audit, stay read-only and prefer `/workflow scout` or `/piagent-session fresh scout`.

Final output:

- Backend files read and why.
- Contract snapshot summary.
- FE files changed.
- Verify command/result.
- Subagents used/not used and why.
- Review lenses applied.
- Task gate result.
- Memory cited, if any.
- Backend gaps, if any.
- Residual risk.
