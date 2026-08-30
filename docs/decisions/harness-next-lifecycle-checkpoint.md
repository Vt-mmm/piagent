# Harness Next: cancellation-safe verification and bounded diagnostic recovery

Status: development checkpoint; not a frozen release or a new S0/108-session result.

This extends [authenticated admission](harness-next-authenticated-admission-checkpoint.md) and complements [restartable S0](harness-next-s0-checkpoint.md). Durable benchmark progress and safe verifier shutdown solve different problems: retaining completed work does not prove that an old worker has stopped, and stopping a worker does not prove source correctness.

## Design evidence and scope

The [Temporal TypeScript cancellation-scope reference](https://typescript.temporal.io/api/classes/workflow.CancellationScope) describes parent-to-child cancellation, refusal to start cancellable work within a cancelled scope, and separately protected cleanup. Piagent applies that ownership principle locally: retire the session, signal its worker, await settlement and cleanup, then close its evidence store. This is a design transfer, not a Temporal integration or a claim of Temporal's distributed durability guarantees.

The installed Pi host declares `session_start` for startup, reload and session replacement, and `session_shutdown` before runtime teardown. The integration follows that lifecycle rather than implicitly reopening a session when a completion arrives. An in-memory generation token belongs to one active session and task; a result prepared before shutdown cannot become current when the same session identifier is activated again. Invalidated host getters and malformed lifecycle fences cannot approve completion. The token is not acceptance evidence; all existing completion checks still apply.

## Implemented behavior

- Independent workers receive an abort signal owned by their session. Shutdown first invalidates completion, then waits for the pending operation before unregistering the provider or closing SQLite. Later criteria are not launched after cancellation. Concurrent teardown calls share the pending retirement.
- Automatic and manual completion both check the generation fence after awaiting verification. Late responses preserve their content as unapproved work and cannot mark the task complete or schedule a model continuation.
- Active session and verifier-entry maps each have a 100-entry bound. Closed session IDs do not accumulate in a permanent tombstone set. Tests exercise eviction and repeated open/close transitions; they do not measure heap usage or prove arbitrary SDK event interleavings.
- Admission recompiles the approved plan against the exact captured source, validates the signed raw worker observation against its request, and recomputes comparisons on the host. A signed but internally contradictory derived verdict, missing case, changed value, mismatched request, or absent completed observation cannot become an authenticated assessment.
- Authenticated error and unsupported observations retain closed diagnostic reason codes and cleanup status. They can explain why verification stopped, but cannot approve completion or fabricate a behavioral counterexample.
- Pending, interrupted, exhausted, unavailable and changed-approval states are private host-state diagnostics, not executed correctness results. They stop continuation before stale-verifier retry selection. Task JSON cannot supply these dispositions or renew an independent attempt budget.

## Recovery decisions

| Observed state | Permitted next action | Automatic source mutation |
| --- | --- | --- |
| Current authenticated behavioral mismatch | Existing bounded, authorized repair path | Only within the existing task authority and repair ceiling |
| Reserved attempt remains pending or cleanup is unconfirmed | Reconcile the exact previous execution | No |
| Session cancellation | Stop and hand off | No |
| Backend cannot represent the contract | Hand off for an independently approved validator | No |
| Backend unavailable or approval invalidated | Operator diagnosis/correction | No |
| Interrupted attempt or exhausted independent budget | Stop; no automatic new attempt | No |
| Bounded guest execution error with confirmed cleanup | Existing single non-mutating diagnostic continuation | No |

Protected-path restrictions retain priority. No continuation ceiling, quality gate or benchmark stopping rule is relaxed. A diagnostic retry is not permission to alter source, change the pinned backend, recreate authority or increase limits.

## Verification

The broad acceptance, durable execution, actual-project-verifier and workspace-binding regression passed **229/229**, with zero skipped tests. Actual Docker, the installed Pi bash implementation and the retained expiry failure source were enabled. This includes raw-observation contradiction checks, authenticated execution diagnostics and immutable source/baseline bindings.

The first wider runtime run reported **227/229**, with two failures: old lifecycle and read-only fixtures invoked completion without a `session_start` event. Both fixtures now execute the actual startup hook; their original completion expectations remain unchanged. The new real-worker shutdown, pending-attempt and exhausted-budget scenarios already passed in that first run. After the fixture corrections and added malformed-fence coverage, the complete runtime, guard, recovery, continuation, handoff and session regression passed **230/230**, with zero skipped tests (366.5 seconds).

The shutdown integration waits until the reserved container is actually running, sends session shutdown, observes a settled cancellation with confirmed cleanup, checks that the container is gone and that later criteria have no reservations, and refuses both automatic and manual late completion. Pending/exhausted integration uses explicitly seeded host reservations to test admission and recovery; those seeded records are not represented as worker executions. The synthetic uncertain-cleanup diagnostic test is likewise labelled as host-admission testing, distinct from real worker cleanup tests.

The separate operator-product, package-distribution, WebUI handoff and runtime-command regression passed **34/34**, with zero skipped tests. This checks existing projections and the local package contents; it is not a minimum-Node install proof or evidence that every independent diagnostic has a complete dedicated UI.

Typecheck, architecture (540 source files), documentation language and diff whitespace checks passed. Current command logs are retained privately outside the source checkout; they are not public package artifacts or production benchmark data.

## Remaining work

This checkpoint does not broaden the closed synchronous ESM/primitive-and-Date executor to general async, imported, object-graph or stateful applications. Reusable contract selection, independently frozen multi-domain held-out calibration, complete operator-view propagation, minimum-Node/dependency packaging and full offline release gates remain required. No new production authority or model-provider campaign has been created, and the v5/v6 campaigns remain closed.

Only after the remaining release gates pass should a new candidate be frozen and a fresh S0 followed by spend-controlled S12 → S18 → S54 → S108 be attempted. Old campaign numbers and the lost v5 `58/90` checkpoint cannot be added to that result.
