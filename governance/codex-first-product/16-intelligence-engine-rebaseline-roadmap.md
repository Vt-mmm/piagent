# Intelligence engine rebaseline roadmap

## Objective

Turn the current full-source runtime into an effective-intelligence engine that
helps the model select the right context, execute a bounded dependency order,
and prove the requested outcome without adding speculative completion loops.
All existing capabilities remain packaged. Their production authority is
controlled by an immutable task policy rather than by deleting source.

The target flow is:

`Task -> criterion graph -> context selection -> bounded execution -> exact verifier -> terminal evidence`

This roadmap supersedes the exhausted FS6 provider plan. It does not relabel,
resume, or promote any RC.1/RC.2 benchmark evidence.

## Frozen principles

1. Task Contract v2 remains the source of task truth. The graph is an additive,
   deterministic planning projection, never a second acceptance oracle.
2. Scope, permissions, protected paths, exact verifier, current-tree evidence,
   resume identity, and terminal truth remain hard invariants.
3. Acceptance parsing, phase classification, performance assurance, solver,
   helpers, and retrieval remain in the package. Broad release defaults use
   shadow/advisory/recommend modes until each capability earns promotion.
4. The runtime may trigger at most one continuation per task. A continuation is
   allowed only when it can obtain new verifier information; repeated semantic
   review without new evidence is prohibited.
5. Luna Medium is the primary efficiency lane. Luna High is diagnostic only.
6. Provider execution is prohibited until the provider-free causal gate passes.
7. One hypothesis receives one bounded canary. A repeated failure class returns
   to deterministic integration tests; it does not receive a third paid retry.

## Finite phase map

| Phase | Deliverable | Exit gate | Provider |
|---|---|---|---|
| IE0 Rebaseline | This roadmap, mutable tracker, exact branch/base identity, old evidence preserved | Tracker readback and clean dependency map | Forbidden |
| IE1 Criterion graph | Additive Task Contract v2 graph, deterministic compiler, schema/type/state validation, migration compatibility | Unit/adversarial graph tests; every criterion mapped exactly once; no parser-as-truth | Forbidden |
| IE2 Context and execution | Graph-derived bounded context hints, dependency order, resume projection and checkpoint integration | Integration/resume/long-task tests; no context outside scope; stable task policy | Forbidden |
| IE3 Production critical path | Release-default policy separates hard mechanical truth from shadow/advisory capabilities; global continuation budget remains one | Mode matrix proves shadow adds zero model turns and strict remains opt-in | Forbidden |
| IE4 Local causal gate | Mechanical-core versus intelligence-engine deterministic fixtures and replay | Equal correctness; less or equal context/tool churn; zero new loop; exact verifier stable | Forbidden |
| IE5 Bounded Medium canary | Piagent versus Codex CLI, Luna Medium, one exact pair per approved family | Grade/scope/safety/workflow 10; no retry/unknown usage; finite engineering ceilings | Explicit operator authority already granted only after IE4 pass |
| IE6 Statistical release evidence | Frozen candidate, representative families and repeats, field/platform gates | Release policy confidence, cohort, package and rollback gates all pass | Bounded chunks only |

## Work-item checklist

Allowed states: `not-started`, `in-progress`, `blocked`, `implemented`,
`verified`, `complete`.

| Work item | State | Required output | Stop condition |
|---|---|---|---|
| CF-IE0-01 | `complete` | Branch/base identity plus this durable roadmap and tracker handoff | Tracker or history cannot be read back exactly |
| CF-IE1-01 | `complete` | Pure criterion/dependency graph compiler with closed node/proof kinds | Any operator criterion is dropped, duplicated, or inferred as satisfied |
| CF-IE1-02 | `complete` | Additive schema, types, normalization, persistence and legacy compatibility | Existing Task Contract v2 fixture cannot load safely |
| CF-IE1-03 | `complete` | Task-start integration and compact model-facing execution map | Prompt grows without a bounded graph/context replacement |
| CF-IE2-01 | `complete` | Graph-derived context hints constrained by task scope and real paths | Hint escapes scope or becomes semantic proof |
| CF-IE2-02 | `complete` | Dependency-aware work plan, checkpoint and resume projection | Restart changes graph/policy identity or reuses stale verifier evidence |
| CF-IE2-03 | `complete` | Long-task state/compaction regression with bounded graph growth | State or prompt budget exceeds frozen limits |
| CF-IE3-01 | `complete` | Versioned production policy: mechanical truth enforce, intelligence planning on, speculative features shadow/advisory | Broad default creates a semantic-review/repair model turn |
| CF-IE3-02 | `complete` | One global continuation invariant across recovery/review/repair | More than one system-triggered continuation can occur |
| CF-IE3-03 | `complete` | Strict opt-in profile retains all advanced capability enforcement | Strict profile silently weakens safety/scope/current-tree truth |
| CF-IE4-01 | `complete` | Provider-free causal fixtures comparing mechanical-only and intelligence-engine | Any correctness regression or new loop |
| CF-IE4-02 | `complete` | Full local/type/package/install/migration/rollback gate on exact tree | Any required local gate fails |
| CF-IE5-01 | `in-progress` | One Fullstack Luna Medium Piagent/Codex pair | Any finite canary gate fails |
| CF-IE5-02 | `blocked` | One Migration Luna Medium Piagent/Codex pair | IE5-01 fails or IE4 incomplete |
| CF-IE6-01 | `blocked` | Frozen statistical protocol and exact release candidate | IE5 incomplete |
| CF-IE6-02 | `blocked` | Chunked paired benchmark, cohorts, platforms and release dossier | Upstream release gate incomplete |

## Promotion map

| Layer | Broad release default | Promotion evidence |
|---|---|---|
| Mechanical truth: scope, permission, current tree, verifier, terminal evidence | `enforce` | Existing safety/integrity gates plus exact candidate revalidation |
| Criterion graph and bounded context selection | `on` | Deterministic coverage, resume and causal context gates |
| Solver | `shadow` | Regret/quality-neutral causal corpus before `recommend` |
| Phase tools | `shadow` | Valid-call precision and zero false hard blocks before `enforce` |
| Acceptance/performance assurance | `advisory` | Framework coverage and false-block calibration before any gate |
| Semantic repair/review | `off` broad, `strict` opt-in | One-turn canary with net benefit and no false recovery loop |
| Helpers/retrieval | `recommend`, no automatic mutation | Ownership, merge, relevance and token evidence before auto-dispatch |
| Parent routing | `off` | Isolated-worktree and field evidence after initial release |

## Evidence and stop rules

- Every phase records exact source identity, commands, counts, and unresolved
  risks in `STATUS.md`; a later session resumes from the first non-complete item.
- Local failures are fixed only when they violate the phase contract. Syntax
  novelty outside the closed conformance corpus is recorded as unsupported and
  cannot extend the critical path indefinitely.
- Benchmark evidence is diagnostic until the exact candidate, treatment,
  repeats, confidence, platform and cohort gates are all satisfied.
- RC.1/RC.2 evidence remains historical and immutable. No new result may be
  appended to or described as a continuation of those runs.

## IE4 exit evidence — 2026-08-11

- `npm run verify`: PASS on the frozen local tree; the repository suite is
  `1958/1958`, including package/install/migration/rollback coverage.
- Criterion graph, causal arm, FS5 binding and Pi 0.82 focused slice: `24/24`.
- Full guard plus durable resume slice: `108/108`.
- Architecture: PASS for 202 source files and all declared line budgets.
- Capability catalog/lock: current at
  `sha256:bf449ec9ca2734a8d59513d761ac6fa5708ce79264d2933751306b0de08c166b`.
- All four capability-shaped runtime intake messages remain below 2,600
  characters. Mechanical control emits no criterion-map text; the intelligence
  arm changes only `PIAGENT_INTELLIGENCE_ENGINE`, preserves task truth and tool
  schemas, and adds no provider follow-up turn.
- No provider session or benchmark evidence was created during IE0-IE4.
