# Harness Next: explicit ISO expiry contract

Status: development implementation and calibration checkpoint, not a release or a production campaign.

## Implemented boundary

The prior selection library had numeric/Date temporal behavior but no reusable contract for the original ISO expiry obligation. `iso-expiry-millisecond-profile` now supplies a data-only, parameterized export contract in the Node/TypeScript adapter. Its 209 cases cover 43 literal valid timestamps at before/equal/after boundaries, invalid calendars/types/syntax, Date stability and default-clock behavior. Every case instruments the clock. Core execution, host authority, source binding, finite repair budgets and completion gates are unchanged.

The family explicitly chooses four-digit years, uppercase separators, mandatory colon-separated offsets or Z, optional seconds, millisecond truncation and rejection of `24:00`/leap seconds. These choices are an application profile, not full ISO 8601, RFC 3339 or Date.parse conformance. A criterion merely saying “ISO timestamp” does not authorize automatic selection of every choice. The [adapter guide](../../adapters/node-typescript/contract-families.md) records the complete contract, unsupported inputs and required semantic review. Normative sources and their differences are documented in [the evidence review](../research/harness-next-evidence-review.md#follow-up-temporal-contract-semantics-before-correctness-labels).

## Calibration and failure transparency

Expected epochs were authored independently with Gregorian day arithmetic and labelled input fields, then checked against V8 for the valid forms. Calendar-invalid expectations are explicit TypeError labels, not Date.parse normalization. Expected values remain outside the worker. No benchmark hidden grader or candidate output supplies the oracle.

Two development implementations use different calendar conversion structures: UTC Date operations and an ordinal-day accumulation. Both pass all 209 cases in the real isolated worker. Seventeen deliberate defects are rejected with source-bound input/expected/observed counterexamples: inclusive boundary, capture groups, small-year remapping, century leap rules, calendar normalization, offset sign/minutes/range, fraction rounding/padding, whitespace trimming, numeric expiry coercion, falsey/undefined default clocks, eager clock use, Date mutation and numeric-now TimeClip.

One initial negative mutation removed a redundant full-length match check. It was incorrectly labelled as defective: without the multiline flag, JavaScript `$` already requires end-of-input. Both V8 and the worker confirmed the equivalent behavior, consistent with [ECMAScript's CompileAssertion rules](https://tc39.es/ecma262/2024/multipage/text-processing.html#sec-compileassertion). The failed initial log is retained; this mutation is separately tested as equivalent/pass, not counted among the 17 rejected defects. No oracle case or production verdict was relaxed to make it pass. A real whitespace-trimming defect remains rejected.

The retained expiry source also passes the selected family unchanged, with SHA-256 `06e12ad0b3709d9cb1936501f423ee7eded80609e4c5f28d4d76f0b70159e1bf` checked before and after. This is a read-only development diagnostic with zero provider calls, not a repaired campaign, a held-out evaluation or token-saving evidence. The older 194-case diagnostic remains separately present; the new 209 cases are not claimed as a strict superset.

## Integration and remaining intake limitation

Actual completion-hook fixtures exercise the selected ISO family on valid code, a calendar defect and a controlled repair. The project verifier intentionally covers only an epoch smoke check; the independent family must expose the invalid-calendar defect. The model flow is simulated by the test harness: these tests do not demonstrate that a real model performs the repair. Nonselected obligations must not borrow family receipts; repeated completion claims must not renew an attempt budget.

The first two integration runs stopped before verification because the long fixture prompt's trailing “Fix a defect only if verification exposes one” was classified as requiring mutation. Inspection located the bounded phrase-distance patterns in `hasConditionalRepairIntent`; moving the explicit condition before the detailed API contract selects conditional mutation correctly. The final fixture uses that supported form to isolate ISO execution. This is **not a fix** for general long-prompt intake: the suffix/prefix diagnostic and failed logs are retained, and the limitation remains an explicit next implementation item. No mutation/authorization classifier or completion requirement was changed in this checkpoint.

## Remaining full-objective gates

The data family, development mutants and retained replay cannot be relabelled as held-out evidence. Remaining work includes long-prompt conditional-intake handling, independently frozen held-out evaluation across all required domains, other real production obligations/backend compatibility, operator projections, complete minimum-runtime execution, complete offline verification and a new frozen spend-controlled 108-session campaign. The benchmark session/environment code does not yet create/bind the new host-approved contracts and strips inherited PIAGENT variables; supplying an inherited approval path is not campaign integration. Prior campaigns remain closed. No 35% savings, exhaustive correctness or completed big release is claimed.

## Recorded verification outcome

- ISO calibration: 4/4 test groups; actual completion-hook ISO scenarios: 3/3; acceptance/binding/execution checks: 277/277; product/package checks: 35/35. All have zero skips and exit 0; overlapping counts are not independent sessions.
- Existing selected-development calibration: 21/21 labels, eight correct passes, nine defects rejected, four unknown. Those labels do not include the separately exercised ISO variants and remain non-held-out. Corpus digest `62ea7214ea0a5e8337df697d5b4fd25193eb385b8b06acd16f4dfb2ef5bb1351`; current installed-verifier digest `e6f2d99d3fed4c4796f6553ed4c3667ae3ae98bd3228aa2043187233a19278f6`.
- Node 22.23.2 host components: 44/44. Exact Node 22.19.0 in a cached Linux arm64 image: 26/44 passed, 18 execution-dependent failures because that Node-only image lacks the Docker CLI. This is not complete minimum-runtime execution evidence.
- An actual offline install of the local platform tarball plus its declared ws dependency on Node 22.19.0 passed installed-bin help, 209-case ISO selection, new plan output, non-writing approval preview, separate explicit fixture approval and current authenticated installed binding. No network, model or worker was used. The first external install-check script invoked the dispatcher filename incorrectly; the failed log is retained and the corrected check uses the npm-installed bin. No product code was changed for that correction.
- Typecheck, architecture (545 source files), documentation-language and whitespace checks passed. Worker image is unchanged: `sha256:37a861a0160063480e7670c7bdb562e9ff8495851213daa69edda6099d19a901`.

**Full offline verification failed.** The repository's default-concurrency test stage reports 3,429 passes, 10 failures, zero skips out of 3,439 tests, in 941.2 seconds; the script stops before its browser E2E stage. This is a release blocker, not overridden by the focused results. An earlier launcher attempt rejected an unsupported NODE_OPTIONS concurrency setting before tests; its log is separate.

Focused reruns reproduce nine aggregate test failures on both this tree (139/148) and unchanged predecessor `224b195` (125/134; without the extra isolated-executor file). They comprise historical FS5 artifact/current-schema hash disagreement, missing golden fixtures for four new contract schemas, five real-Pi completion/recovery leaf failures (plus their failed parent), and a corrupt-journal fixture whose expected file was never created. They are not introduced by the ISO family, but remain unresolved in the harness upgrade. Historical protocol hashes must not be rewritten simply to green the current tree.

The additional full-run failure was the isolated-executor cancellation test: a fixed 150 ms abort produced `container-create-failed` with unconfirmed cleanup under the full run; all 14 tests in that executor file passed on the focused rerun. That observation does not prove the race fixed or all cancellation paths safe. Its actual worker-start/create timing and cleanup guarantees need a separate regression design. No completion gate or test assertion was relaxed here.

Subsequent lifecycle, native nested-verifier and recovery-projection corrections are recorded in [the runtime validation checkpoint](harness-next-runtime-validation-checkpoint.md). That follow-up supersedes the affected real-host fixture evidence, not this historical full-offline failure or the remaining release gates.
