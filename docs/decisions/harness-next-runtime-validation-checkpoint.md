# Harness Next: real-host lifecycle and recovery validation

Status: development checkpoint, not a frozen release or a production campaign.

## What changed and why

The full offline run recorded at the ISO checkpoint failed; focused passing suites did not override it. Investigation of the real-Pi failures found that the SDK fixture never called `bindExtensions`, so no `session_start` activated the completion lifetime. It now follows the installed 0.84.1 host lifecycle, including shutdown. An uninitialized-session negative case still cannot approve completion.

A deliberately failing authorization test exposed another fixture defect: native Pi bash inherited the outer Node test runner's `NODE_TEST_CONTEXT`. The nested verifier skipped its test files and returned success. The fixture now uses the native bash tool definition with a spawn hook removing only that test-runner variable. Invoked project verifiers must report nonzero test counts, zero skips and no recursive-run warning. The authorization fixture must actually fail before bounded source repair is permitted. Earlier passes from this real-host fixture are not evidence that nested project tests executed.

The corrected lifecycle also exposed two product issues:

- An unchanged host session-name announcement rewrote the task timestamp and journal before an authority rollback. Identical normalized names now cause no task write, rebind or rename trace. A genuine rename still persists; the strict rollback test retains its byte-for-byte original-task assertion.
- Critical recovery guidance evaluated baseline-bound verifier evidence without passing the current repository revision. Receipt and guidance projections now share revision selection and propagate it to every evidence check. Historical unbound records remain readable exactly as before; they do not acquire runtime completion or reuse authority. Stale before/after revisions remain missing evidence.

Missing-proof diagnostics now name their task-derived target, criterion and missing dimension. They omit edit-oriented hints and retain the non-mutation restriction. A scripted unauthorized source write is rejected. The positive repair fixture instead supplies a real failed assertion, enters exactly one `verification-failed` repair transition, consumes the existing single continuation and hands off without a second semantic-review turn. The classifier, authority rules, completion requirements and continuation ceilings are unchanged.

The corrupt-journal fixture no longer relies on accepting an invalid unversioned verifier digest to create its journal. It explicitly checks that rejection, seeds a valid contract event, then corrupts the journal and verifies fail-closed recovery and symlink refusal. No production journal validation was relaxed.

Primary-source reasoning is recorded in [the evidence review](../research/harness-next-evidence-review.md#follow-up-lifecycle-correct-evaluation-before-performance-claims).

## Verification and limitations

- Runtime, lifecycle, recovery policy, journal chaos and receipt projection: 110/110, zero skips, exit 0 on Node 24.11.1. The pinned Pi host is real; model turns are scripted and make no provider calls.
- The same 110 tests also pass with the Node 22.23.2 test process, zero skips. This is not the outstanding complete minimum-22.19.0 execution proof.
- Acceptance, source/revision binding, native bash observations, exact-verifier reuse and selected development calibration: 277/277, zero skips, exit 0 with the existing isolated worker image. Overlapping tests across commands are not independent sessions.
- Full guard integration plus authority-resume, session replacement, failure classification, continuation budgets and independent recovery: 176/176, zero skips, exit 0, 774.307 seconds. This includes all 18 actual independent-completion scenarios, including ISO, module/family variants, unavailable backend, unsupported code, timeout, shutdown, pending and exhausted attempts.
- Existing benchmark checkpoint/ownership/long-horizon recovery regressions: 14/14, zero skips, exit 0. They kill real coordinator processes at bounded unit and commit boundaries, verify checkpoint recovery, and reject a duplicate surviving lane or obsolete reservation. These are fault-injection fixtures, not a new full S0, S12 or 108-session run; no benchmark runner was changed in this checkpoint.
- Typecheck, architecture (545 source files), documentation-language and whitespace checks pass. The first architecture attempt identified a three-line module-budget overrun; moving shared revision selection to the verification module resolved it without changing the budget.
- The two untouched offline blocker files still report 110/112 with two failures: historical FS5 artifact/current-schema hash disagreement and missing golden fixtures for four contract schemas. Old frozen protocol hashes were not rewritten.
- A read-only provenance audit identifies the task-contract schema as the only mismatching declared artifact in protocols v1/v4/v5. Their expected SHA-256 `b936a604db87a697bf69581c33d753e26d9e5e2ccce40bf9c9b2070948f49919` is present at commit `b6acd17d16a66fbd4c4c4980796ea74e021231f3`; current schema changes begin at `11498d85bc69055dfe3640c48acb70c7b7fbc4b9`. This supports historical validation, not permission to execute an old protocol against changed artifacts.
- Complete offline verification has not been rerun to green. The earlier full-concurrency cancellation/create race is not proven fixed by a passing focused worker run. Browser E2E, complete minimum-runtime execution, held-out evaluation and campaign integration are still required.

## Next gates

1. Add real valid/invalid schema fixtures connected to production validators; distinguish historical frozen artifact provenance from a new candidate's current binding without modifying old campaign identities.
2. Exercise worker cancellation at known create/start phases and confirm ownership-bound cleanup, then rerun the complete offline workflow.
3. Complete the independently frozen held-out evaluation, long-prompt conditional intake, minimum-runtime and benchmark host-approval integration documented in the ISO checkpoint.
4. Only after readiness is green, freeze a new candidate and run the finite spend-controlled campaign. Preserve durable logs and completed evidence, reconcile interrupted attempts, and never merge results across changed source identities. S0/S12 failures stop progression; no automatic repair-and-restart loop or 35% claim is authorized by these development tests.

The old campaign remains closed. No new 108-session production result is claimed.
