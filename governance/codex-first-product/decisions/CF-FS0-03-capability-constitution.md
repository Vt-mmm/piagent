# CF-FS0-03 — Full-source product constitution

Date: 2026-08-10
Status: accepted for planning; runtime activation deferred to FS1
Scope: all current product, packaging, schema, profile, template, benchmark, and evaluation source

## Decision

Piagent 1.3 will productionize the complete source tree through maturity gates. No
capability is deleted merely because it is not ready for production authority.
The package may contain the implementation while the versioned policy chooses
`off`, `shadow`, `recommend`, `advisory`, `on`, or `strict` and independently
limits authority to `off`, `observe`, `advise`, `enforce`, or `orchestrate`.

The Task Contract remains the only task truth. Receipts, acceptance analysis,
performance assurance, trajectories, benchmark reports, and operator views are
projections. They may add evidence or abstain, but they may not silently shorten,
rewrite, or override the contract.

This decision does not activate any new default. `CF-FS1-01` must implement the
versioned policy manifest and snapshot it into each task. Existing task state is
resumed under its pinned policy or explicitly handed off; a mode change must not
be smuggled into a running task.

## Production layers

| Layer | Production role | Broad RC default | Model-turn authority |
|---|---|---|---|
| L0 hard invariants | identity, authority, tree/verifier truth, resume | enforce | none beyond the user/model's normal task flow |
| L1 mechanical efficiency | context, stable tools, bounded recovery, operator package | on/enforce | recovery shares one global continuation budget |
| L2 observation | solver, phases, trajectory, evaluation | shadow/observe | zero |
| L3 guidance | retrieval, acceptance/performance advice, helpers | recommend/advisory | zero automatic continuations or dispatch |
| L4 bounded enforcement | semantic repair, future parent/worker routing | strict opt-in or off | only explicit bounded policy |

Hard invariants do not expose a normal feature-off escape. Their rollback is an
explicit runtime/package rollback that preserves evidence and never widens
permissions. Other capabilities can move down their authority ladder without
removing source or erasing state.

## Capability authority map

| ID | Capability | Target mode / authority | Fixed production boundary | Owner |
|---|---|---|---|---|
| CAP-01 | Task Contract/intake | on / enforce | sole truth; <=12 criteria; no projection truncation | task-contract-maintainer |
| CAP-02 | permission/scope/external guards | on / enforce | deny before unsafe mutation; approval never inferred | security-policy-maintainer |
| CAP-03 | current-tree/verifier/terminal truth | on / enforce | latest stable verifier evidence on current `wt-content-v2` tree | verification-truth-maintainer |
| CAP-04 | journal/checkpoint/resume/handoff | on / enforce | corrupt, stale, or cross-session state fails closed | long-task-state-maintainer |
| CAP-05 | context/compaction | on / enforce | bounded context; L0 evidence cannot disappear silently | context-efficiency-maintainer |
| CAP-06 | schema-stable tool runtime | on / enforce | provider-visible schemas do not change with phase | tool-surface-maintainer |
| CAP-07 | repository memory/retrieval | recommend / advise | current cited context; no automatic dispatch | retrieval-memory-maintainer |
| CAP-08 | solver/model/effort | shadow / observe | operator-selected model/effort is preserved | solver-runtime-maintainer |
| CAP-09 | phase classifier/tools | shadow / observe | no valid-call blocking in broad profile | phase-policy-maintainer |
| CAP-10 | trajectory/long-task observability | shadow / observe | bounded durable events; no steering by itself | trajectory-observability-maintainer |
| CAP-11 | acceptance/performance assurance | advisory / observe | projection only; abstain on unsupported proof; no continuation | assurance-maintainer |
| CAP-12 | recovery | on / enforce | one system-triggered continuation total per task | recovery-maintainer |
| CAP-13 | semantic review/repair | strict / enforce | high-risk opt-in, exact paths/current digest/bounded revision | semantic-enforcement-maintainer |
| CAP-14 | helpers/subagents/Oracle | recommend / advise | no automatic dispatch; one-writer and owned-work budgets | orchestration-maintainer |
| CAP-15 | parent routing/workers | off / off | source retained, no automatic parent replacement or worker | parent-routing-maintainer |
| CAP-16 | operator/package/install/rollback | on / enforce | exact artifact identity and explicit external-action approval | release-operator-experience-maintainer |
| CAP-17 | benchmark/telemetry/claims | on / observe | finite provider gates; Piagent vs Codex CLI for release | evaluation-claims-maintainer |

The complete machine-readable contract—including trigger, authority, current
budgets, failure policy, telemetry, kill switch, owner, source anchors, ordered
module ownership, and deviations—is
[`capability-constitution.v1.json`](../evidence/fs0/capability-constitution.v1.json).

## Source ownership result

The bounded module scope is every regular file under `packages/piagent-core`,
`scripts`, `schemas`, `adapters`, `templates`, `architecture`, `catalog`,
`benchmarks`, `evals`, `packs`, and `types`, plus root `package.json` and
`package-lock.json`.
Tests, docs, generated docs, governance, and ignored raw evidence are governed by
their own validation/release controls and are not production-module owners.

On the exact current tree:

- 431/431 scoped files resolve to exactly one primary capability;
- 0 files are unowned and 0 files have multiple primary owners;
- all 17 capabilities have a named maintainer role and at least one source anchor;
- path-list digest is `94b65390…b2a1b`;
- content+mode+ownership manifest digest is `14b486f8…81d72`.

This is an ownership constitution, not a candidate freeze. The module hashes will
change during FS1–FS3 and must be regenerated against the exact RC boundary.

## Known release-blocking deviations

1. Continuation authority is currently split between two completion-recovery
   attempts, three performance-review attempts, and per-class recovery ceilings.
   `CF-FS1-03` must replace this with one global system-triggered continuation in
   the broad profile.
2. Intake can preserve 12 criteria while acceptance receipt currently processes
   at most 8. `CF-FS1-02` must make the projection non-truncating and keep
   unsupported evidence advisory/unknown.
3. Eight runtime-referenced extension modules are not listed in the runtime
   integrity inventory. `CF-FS0-04` must bind them to the candidate.
4. `extensions/core-services.js` is a test-only barrel in package source.
   `CF-FS0-04` must exclude it from the release package unless it gains a real
   production import and integrity binding. It is not deleted here.
5. Earlier capability canaries exercised stricter phase/review settings than the
   intended broad release defaults. FS5 benchmarks must bind the exact policy
   manifest rather than reusing those results as release evidence.

## Consequences

- Work inspired by Amp, Cursor, Windsurf, Codex, and Claude remains in the
  product. Maturity controls authority; they do not discard implementation.
- Broad defaults prioritize mechanical token/context savings and long-task truth.
  Semantic intelligence first observes/advises; it earns enforcement separately.
- A benchmark cannot silently choose a stricter treatment than the release.
- Each later work item has one accountable owner and one promotion/rollback path.
- `CF-FS0-04` is next. It must define the clean candidate/package/integrity
  boundary; this decision deliberately stops before doing so.
