# Host-approved independent verification in benchmark sessions

This is an opt-in integration, not a release qualification or an efficiency
claim. It does not create a new paid campaign automatically.

## Operator contract

The benchmark runner accepts `--verification-plan FILE`. Its format is
[`benchmark-independent-verification-plan.schema.json`](../../schemas/benchmark-independent-verification-plan.schema.json).
The catalog is a private, owner-controlled, canonical regular file outside both
the candidate and suite trees. It binds the frozen suite digest, installed
verifier digest, scenario IDs and exact public operator-request digests.
Expected answers come from independently reviewed plans, not candidate output,
hidden graders, model-provided tests or a textual similarity heuristic.

Before authoring a catalog, run the same suite/surface configuration with
`--dry-run` and without `--verification-plan`. The `Frozen verification binding`
line supplies `suiteDigest` and `verifierDigest` from the actual frozen runtime,
with `approval: "not-granted"`. It starts no provider executable or model
session and creates no verification authority. Use that binding in the reviewed
catalog, then preview the catalog and approve it separately. A later source,
suite or executed-verifier change is still refused.

Do not calculate that binding from the live author checkout: a built checkout
can contain Git-ignored served browser assets that the source snapshot does not
execute. Those assets remain covered by live runtime integrity; they are not
removed from the digest to make live and frozen installations appear equal.
WebUI benchmark assets retain their separate exact build/measurement binding.

Each scenario can have up to 32 exact requests. Each request retains the existing
bounded host-contract format. Schema-version-2 host plan sets and authenticated
`approved-host-contract-set-v1` payloads support multiple requests; the existing
single-request formats remain supported. Duplicate request digests, nested sets,
mixed single/set approval and mismatched criterion IDs/hashes are refused.
The same criterion ID in different requests does not share expected results.

Dry run and preflight validate and expose digest/count/criterion identity only;
they create no session approval. Starting sessions requires the separate
`--approve-verification` flag. `--yes` confirms cost/run count only. A resume
requires explicit approval again and exactly the original catalog identity;
the printed resume command includes this requirement. Changing either source or
catalog cannot be merged into the original measurement configuration.

The authority is created once per Piagent scenario/repeat/infrastructure attempt,
outside that fixture, under the private run's `independent-verification/`
directory. Existing authority is never overwritten. Workspaces are retained for
audit whenever a catalog is configured. Only the Piagent process receives its
approval path, including WebUI journeys. Codex, raw Pi, preflight and graders do
not inherit it. The benchmark's existing environment isolation remains in force.

## Observation and accounting

`independentVerification` in each configured Piagent run is measurement data,
not a transferable completion capability:

- `not-configured`: this scenario has no catalog entry; never claim it was tested.
- `partial`: one or more approved requests/criteria have no matching settled,
  protocol-validated worker observation, or an attempt remains pending.
- `unavailable`: approval/store integrity or catalog/verifier freshness cannot
  be established; attempt counts are unknown, not zero.
- `observed`: all declared requests/criteria have matching durable observations.
  This is **not** a pass label. Individual verdicts may be pass/fail/unknown/error.

`attempts` sums the cumulative durable attempt number for each unique task and
criterion, including preceding failures. `workersObserved` counts validated
latest observations, not all historical worker invocations. Historical evidence
remains in the authenticated private store. These fields do not replace the
provider all-attempt token ledger.

Missing observations and any non-pass verdict prevent the benchmark session
from being scored resolved. They never promote a failed hidden grade to pass.
All collected provider usage is still retained. Ledger staging, interrupted
record recovery and finalization validate the observation shape, counters and
catalog/criterion bindings; a removed or altered verification field cannot
silently turn a configured record into a legacy one.

The observation reader revalidates the worker protocol and comparison against
the approved checks, but does not recreate current project-test authority or
claim old source snapshots are still current. Runtime authenticated completion
and independent project verification remain separate requirements.

## Qualification boundary

Focused coverage includes schema/parser refusal, explicit approval, exact
multi-request runtime selection with actual isolated pass/fail executions,
unknown requests, criterion mismatch, catalog drift and baseline isolation.
The frozen-runner regression uses fake provider executables to exercise pause,
resume, private authority retention, full ledger accounting and refusal to
score unexecuted verification as successful. Its synthetic tokens are test data,
not campaign results. Project-verifier state in the multi-request unit fixture
is controlled; actual project tool-hook E2E coverage is a separate test layer.

Still required: independently frozen held-out calibration across all required
domains, production request/criterion plans reviewed independently of solutions,
backend compatibility beyond synchronous approved ESM, full offline/browser
qualification and a newly frozen finite S0/S12/S18/S54/S108 campaign. The known
whole-process CPU-budget reliability finding remains unresolved by this bridge.
