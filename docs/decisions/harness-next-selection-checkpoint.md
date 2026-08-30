# Harness Next: reusable contract selection

Status: verified development checkpoint; not a release or production campaign.

## Gap and mechanism

The approved-module checkpoint could execute real source graphs, but operators still had to author every expanded expected-result table and bind criterion IDs/hashes manually. This checkpoint adds a data-only reusable family compiler and a preview command, with library assets alongside the Node/TypeScript profile rather than project business logic in the core.

`compileContractSelection` takes only JSON library, recipe and task-criterion snapshots. It matches exact criterion text plus obligation, verifies that text against the task's criterion hash, substitutes typed parameter nodes, validates the complete expanded independent plan and retains all unselected criteria in the preview. There is no source input, fuzzy function-name matching, candidate-output oracle or dynamic evaluation. Missing/ambiguous/duplicate requested selections or pinned-family drift yield unknown and no approval plan. Malformed inputs fail before execution.

The compiler does not determine the semantic adequacy of an arbitrary natural-language requirement. The operator must choose a family whose declared behavior actually covers the selected criterion; identity matching is not a semantic proof. The library's six families and explicit limits are documented in [the adapter guide](../../adapters/node-typescript/contract-families.md).

## Authority and integration

`piagent select-verification` only previews and optionally creates a new private, unapproved plan file. It never overwrites a plan, creates keys/receipts, executes a worker or calls a model. The existing separate explicit approval path remains required. Task JSON is selection input, not a forged live verifier observation.

Expanded checks and family/parameter identities are included in the authenticated host approval. Selection text must hash to the approved criterion. The installed bundled library participates in installed-verifier identity; drift revokes prior approval. Runtime completion, current project-verifier binding, exact source graphs, authenticated admission and finite repair budgets are unchanged. Unselected criteria receive no family assessment.

## Verification scope

Initial selection/approval checks passed 32/32, including six-family schema coverage, exact matching, ambiguity, malformed parameters, data substitution, changed installed-family data, preview-only CLI behavior, no-overwrite output, separate explicit approval, actual worker execution of the 21 labelled development variants and the unchanged five-file production redactor. The 21 variants are repeated development labels, not independent held-out cases. A test-fixture shared-backend mutation initially contaminated later tests; it was corrected by isolating each recipe's backend object. The failed log is retained.

The first completion integration run accepted the family-valid implementation and captured the expected TypeError counterexample for the two defective scenarios. Two legacy assertions still required the old handwritten case ID `bad-left`; the family correctly names it `text-left`. Only those test expectations were corrected. No production gate or verdict was relaxed. The three corrected actual-completion scenarios subsequently passed, including finite repair and leaving nonselected obligations without family receipts.

Coverage review then reproduced two real false acceptances in the initial family tables: a finite-list implementation accepted negative infinity, and a checkpoint implementation sorted entries instead of retaining application order. The prior 21/21 development score did not expose either. The retained `family-mutations-before.log` has both failures. The tables now cover negative infinity/basic invalid types on both scalar/temporal argument positions, invalid list elements, invalid-Date stability, out-of-order checkpoint IDs and replay with the same ID but a different payload. The strengthened direct selection/approval/calibration-accounting suite passes 40/40, including both previously accepted defects and the changed-payload replay mutant.

After table strengthening, acceptance/binding/runtime-contract checks passed 273/273, product/package checks 35/35 and the three actual family-completion/repair scenarios 3/3, all with zero skips and exit 0. The broad runtime regression passed 236/236; it started before table strengthening while production compiler/runtime code stayed unchanged. The separate final-table family run verifies the data-dependent integration delta; the earlier broad run is not presented as a fresh all-files release verification. Typecheck, architecture (545 source files), documentation-language and whitespace checks passed on Node `v24.11.1`.

Selected-family calibration matched all 21 development labels: eight valid programs passed, nine defects failed with counterexamples and four unsupported variants remained unknown. Its corpus ID is `harness-next-selected-development-v1`, digest `62ea7214ea0a5e8337df697d5b4fd25193eb385b8b06acd16f4dfb2ef5bb1351`; the installed-verifier digest is `924434a2dafef4bef7cff30b11f661ee35d79217c96912b558c6edf022743f04`, verified current after execution. Each row preserves family identity and actual observations. `heldOut` and `claimEligible` remain false. The worker image is unchanged from the approved-module checkpoint.

## Remaining full-objective gates

These declarative tables are reusable coverage, not randomized property generation, shrinking, a constraint solver, general formal verification or automatic natural-language oracle synthesis. New family semantics require their own independently reviewed cases and calibration. Independently frozen held-out evaluation across the required domains, remaining real production obligations/backend compatibility, operator projections, minimum-Node installation, full offline verification and a fresh frozen spend-controlled release campaign remain outstanding. Old campaigns remain closed; no 108-session or 35% saving claim follows from this checkpoint.

In particular, `deadline-status` is not the production ISO-expiry contract: it intentionally rejects string inputs. Before the production campaign, independently specified ISO/calendar/timezone obligations must be represented by a suitable reusable family and calibrated against equivalent correct implementations and defects. The current numeric/Date family must not be substituted merely because it has passing development samples.
