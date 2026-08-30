# Harness Next: independent evidence and bounded recovery

Status: accepted implementation direction; production migration is not complete.

Research basis: [evidence review](../research/harness-next-evidence-review.md).

## Implementation checkpoint (2026-08-30)

- Isolated branch: `codex/harness-next`, based on frozen v6 `db4bbca147bb9c6a181a4758239035e95d41504b`. The main workspace and closed campaigns are preserved.
- Added `acceptance-assessment.js`: bounded contract/observation validation, live host-owned receipt capabilities, distinct pass/fail/unknown/error outcomes, snapshot and verifier binding, explicit coverage, and counterexample-directed repair eligibility. It never grants source mutation authority or executes project code.
- Foundation tests: 13/13 pass, including 128 status/order combinations, stale/forged/cross-session receipts, partial checks, executor faults, one-shot observation, sparse arrays, and accessor rejection.
- Complete existing-plus-new acceptance suite: 130/130 pass. Typecheck and architecture checks pass (514 source files); diff whitespace check passes.
- The new kernel is intentionally not wired into completion gates yet. Synthetic unit observations are not production verifier receipts and do not solve the retained expiry failure by themselves.
- Subsequent implementation added an actual isolated QuickJS-WASM/Docker executor, a host-only expected-result plan, typed comparison, and captured counterexamples. See the [executor checkpoint](harness-next-executor-checkpoint.md). The preserved expiry source passes 194 independent cases; four deliberately reintroduced defects fail the same plan. This is a diagnostic replay, not a promoted campaign result.
- After executor implementation, the complete acceptance suite passed 151/151 with no skips, including real container tests and the retained replay. Typecheck and architecture checks passed (519 source files). Full offline release verification has not yet been rerun for this new foundation.
- Next work: complete contract/backend calibration, authenticate durable receipt admission, and integrate approved contract selection, snapshot binding, verification/recovery, and checkpoints. The new executor and comparison remain unwired from production completion.
- No new provider benchmark, release, or publish occurred. The separate worker dependencies were installed with scripts disabled; no main-workspace source or shared dependencies were modified.

## Decision

Replace the coupling between source recognition and model repair with a layered contract-assessment protocol. Keep authorization and safety enforcement separate from functional correctness. A verifier's inability to prove a program is not evidence that the program is wrong.

This is a coherent harness update, not a new expiry-specific pattern. The reusable core owns evidence binding, verdicts, budgets, checkpointing, and recovery selection. Reusable contract adapters own domain-specific input generation/oracles. Project business logic and benchmark hidden answers do not enter the core.

## Data and authority boundaries

1. **Contract.** Task/criterion identity, declared input/output obligations, source targets, required check IDs, adapter identity, and verifier version are fixed before a verification run. Do not infer expected results from candidate output. Ambiguous contracts stay unknown.
2. **Snapshot.** Bind source closure and exact working-tree digest before and after execution. A successful run on an old or mutated tree is not current evidence.
3. **Executor.** Host-owned code selects an approved isolated backend. Candidate code receives no host credentials, arbitrary filesystem, network, child-process, or receipt-writer capability. Bounded execution occurs outside the UI/agent process. No `node:vm` security claim or unprotected fallback.
4. **Observation.** The host records actual check results, captured counterexample references, termination status, resource limits, and source/verifier bindings. Candidate stdout and model-authored JSON cannot mint observations. Durable receipts need authenticated admission, not just matching public digests.
5. **Assessment.** Pure bounded logic combines current observations. It neither executes candidate code nor repairs source. An optional static lane can prove supported invariants or abstain; it cannot transform missing coverage into a concrete test failure.
6. **Recovery.** Route on evidence class, with a persistent finite budget. Concrete counterexample → targeted repair; missing tests → verification work; unsupported verifier → another approved analysis lane or explicit unknown; timeout/environment → executor diagnosis; policy denial → blocked. Never grant source mutation solely because an analyzer abstained.
7. **Projection.** CLI and WebUI display the same assessment and remaining evidence. They do not create a new source of truth or convert unknown to complete.

## Verdict rules

| Evidence | Verdict | Next action |
| --- | --- | --- |
| Policy denied or not established | unknown/blocked | Resolve authority; no source repair or execution |
| Current source/verifier binding missing or mismatched | unknown | Reverify exact current snapshot |
| Trusted execution reports a failing required check with a counterexample reference | fail | Targeted repair, subject to existing mutation policy and budget |
| Execution crashes, times out, or returns incomplete checks | error/unknown | Diagnose executor/coverage; not a successful task and not an inferred source defect |
| Static analysis abstains, project tests pass, independent contract run missing | unknown | Run independent contract validation; do not rewrite to match analyzer syntax |
| All required independent checks pass, provenance/current verifier/policy hold | pass, bounded contract-tested assurance | Complete only the obligations actually covered |

Any contradictory check or malformed observation invalidates that observation. Passing static analysis cannot override a trusted behavioral failure. A reported counterexample is a reference to host-captured evidence, not a model claim. A finite passing execution must never be labelled universal proof.

## Migration sequence and non-goals

- First implement and test the observation/assessment kernel without wiring it into release decisions. This prevents an unfinished verifier backend from granting passes.
- Build an isolated execution adapter and deterministic contract builders; audit their oracle independently of the candidate implementation.
- Replay retained correct and incorrect artifacts in a new diagnostic lane. Never rewrite their old benchmark outcomes.
- Integrate host-observed receipts into verification hooks, recovery routing, journal persistence, and shared UI projections. Enforce verification-only transitions in tool-call policy, not merely prompts.
- Add interrupted-run recovery keyed by source, verifier, contract, and backend identities. Partial writes are not completed receipts; paid-attempt accounting remains append-only.
- Run differential/mutation/held-out, architecture, runtime, WebUI, and long-horizon gates before freezing a new candidate. Only then run a new controlled release campaign.

Not in scope: replacing Pi, adding a multi-agent hierarchy by default, changing the model mid-campaign, importing hidden benchmark graders into production, claiming static proof for arbitrary JavaScript, or using a passing diagnostic replay as a benchmark pass.

## Completion requirements

The update is not done until (a) valid equivalent implementations no longer require source rewrites merely to appease syntax recognition; (b) bad implementations and forged/stale evidence remain rejected; (c) real counterexamples drive bounded repair; (d) verification checkpoints survive interruption without accounting drift; (e) the required full release campaign and safety/quality/efficiency gates are verified. Foundation unit tests alone cannot satisfy these requirements.
