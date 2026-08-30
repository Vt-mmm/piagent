# Harness Next: authenticated completion and counterexample recovery

Status: development integration; not a release or benchmark claim.

This checkpoint follows the [actual project observation bridge](harness-next-observed-verifier-checkpoint.md) and implements the next part of the [research-backed architecture](harness-next-evidence-architecture.md). The working branch remains `codex/harness-next`; the main workspace and closed campaigns are unchanged.

## What changed

The actual completion hook and manual completion tool can now run a host-approved independent contract against the exact source snapshot. The durable runner still returns a diagnostic that cannot approve completion by itself. A separate admission step reads the latest authenticated store event, checks the completed worker identity and cleanup, source/plan/backend bindings, required check counts, and captured counterexamples, and creates a live host-owned assessment capability.

Task JSON, a copied result, an unbranded store wrapper, old successful events behind newer pending work, a changed source or Git baseline, a changed project-verifier observation, and malformed signed observations cannot supply that capability. The installed verifier source closure is fingerprinted. A passing assessment means **bounded contract-tested assurance**, never universal proof.

Approved independent checks are additional completion requirements even for zero-delta tasks and when optional semantic review is disabled. Passing project tests or static recognition cannot override their failure. Unconfigured criteria retain the existing gates. A malformed configured authority blocks completion rather than silently falling back to legacy acceptance.

Real current counterexamples now enter the existing recovery policy as assertion failures with captured input, expected result, actual result, and a stable evidence reference. This is not a fabricated assertion string inferred from missing proof. Read-only and protected-path boundaries, phase enforcement, the one-source-repair ceiling, and the durable global continuation budget remain in force. Repeating a completion claim does not renew that budget. Unknown/error projection does not label missing coverage or executor failure as a source counterexample.

Completed same-runtime views may display an existing current authenticated observation. They cannot mint a new project observation or reserve independent execution for a terminal task. New tool results invalidate the prior observation, including results after completion. Restart still requires an actual project-verifier refresh before durable independent evidence can be admitted again.

## Host approval and operational limits

`piagent approve-verification` previews a plan by default. Only explicit `--approve` creates a new private authority directory outside the project, containing an authenticated approval, a random host key, and the evidence database. It never overwrites an existing authority and never executes a project, starts a worker, or calls a model provider. Missing keys are not automatically recreated. The supported schemas are [host contract plan](../../schemas/host-contract-plan.schema.json) and [approved payload](../../schemas/approved-host-contracts.schema.json).

The approval binds canonical project identity, exact operator-request digest, criterion IDs/hashes, source/export, expected checks, installed verifier fingerprint, pinned container image, local socket, timeout, and finite attempt limit. Schema conformance is not approval: the runtime additionally validates signature, private ownership/permissions, canonical paths, semantic check constraints, and current bindings. The operator must review expected results independently of candidate output.

Activation is opt-in through `PIAGENT_INDEPENDENT_VERIFICATION_CONFIG` before runtime startup. This checkpoint does not automatically infer an oracle from arbitrary natural language, select broad reusable adapters, or import benchmark hidden graders. A configuration for another request does not claim coverage of the current task. A rejected configuration requires deliberate correction/restart, not silent re-keying or an unsigned fallback.

The independent executor remains the closed synchronous ESM/primitive-and-Date backend. Object/array input graphs, imports, asynchronous contracts, and general stateful applications are not covered. Authorized native project tests and same-UID host code are outside the isolated guest trust boundary; private files/HMAC are not a sandbox against an already-compromised host authority.

## Executed evidence

- Actual completion integration: a valid implementation is accepted; an invalid implementation is blocked even though the shallow project test really passes; a guarded counterexample-backed source repair is independently reverified and completes. These are three bounded integration fixtures, not a general oracle-calibration result.
- The repeated-claim fixture schedules only one source-repair continuation and retains one independent attempt per criterion. The repair fixture consumes exactly two independent attempts per criterion: original failure and changed-source verification. Verification itself leaves source bytes unchanged.
- Host configuration and command-line tests: 22/22 pass, including preview without writes, explicit creation, no overwrite, schema checks, changed keys/config/verifier, private modes, symlinks/hard links, wrong project, and transplanted approval paths.
- Durable execution/admission: 8/8 pass with the actual isolated backend, including host death/reopen, newer pending work, real source drift/failure, case-count and identity corruption, absent counterexamples, copied results, and unbranded stores.
- Actual project observation/runtime suite: 9/9 pass, including the installed Pi bash tool, completed projection, post-completion invalidation, and refusal to execute for a completed task.
- Combined acceptance/runtime/session/binding/reuse regression: 266/266 pass, zero skips/failures, with actual Docker, installed Pi, and retained expiry replay enabled.
- Guard/recovery/product regression: all 184 non-packaging tests pass, including the three actual completion scenarios above. The combined run initially reported 195/196 because the separate clone had no built WebUI bundle. Building the unchanged WebUI produced the missing distribution artifact; the complete packaging suite then passed 12/12. The original failed log is retained, not rewritten.
- Projection stability tests: 4/4 pass for pass/fail/unknown/error, including no timestamp churn and no invented counterexample for unknown/error.
- Typecheck, architecture check (536 source files), documentation language checks, and diff whitespace check pass. These do not replace full offline release verification.

No production host authority, model-provider benchmark, release, push, or publish was performed. Test authorities are generated only in owned temporary fixtures and are removed after their tests.

## Remaining work toward the full update

1. Calibrate reusable contract selection and coverage across pure-function, temporal, configuration-precedence, and stateful-recovery domains, including an independently frozen held-out corpus. The small addition fixture must not be mistaken for broad behavioral coverage.
2. Preserve structured executor-error/unsupported reasons through recovery and expose the same independent verdict/counterexample detail in all operator views; current fail-closed unknown handling is not a complete diagnostic UX.
3. Finish interruption reconciliation and supported backend/dependency packaging, including minimum-Node verification. A persistent verifier store does not implement S0 benchmark resume.
4. Run the full offline, safety, architecture, runtime, WebUI, long-horizon, and calibration gates; then freeze a new candidate and run a new controlled 108-session campaign. No v5/v6 result may be merged or relabelled.

The full goal remains incomplete until these requirements and the existing release quality/efficiency gates are verified.
