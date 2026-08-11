---
plan_id: codex-first-product
workstream: FS
document: full-source-productionization-roadmap
status: active
approved_direction: 2026-08-10
baseline_release: 1.2.17
target_release: 1.3.0
canonical_tracker: STATUS.md
---

# Full-source productionization roadmap

## 1. Decision and purpose

This roadmap is the authoritative execution plan for turning the complete current
Piagent source into a production release without deleting the capabilities built
in P0-P7 or BR1-BR6.

The product decision is **full-source, maturity-gated**:

- every capability is packaged, versioned, documented, tested, observable, and
  rollbackable;
- shipping a capability does not automatically give it authority to block every
  task or trigger additional model turns;
- each task snapshots one immutable policy manifest at intake;
- every capability-specific runtime value maps to one normalized authority:
  `off`, `observe`, `advise`, `enforce`, or `orchestrate`; values such as
  `shadow`, `advisory`, `recommend`, `assist`, `on`, and `strict` are configuration
  labels rather than a second authority vocabulary;
- the strict/high-risk profile exposes bounded enforcement without making that
  enforcement universal;
- no benchmark-specific recognizer, scenario name, fixture path, or hidden
  oracle may enter generic runtime policy.

This plan does not promise zero defects. It guarantees a finite process: defects
are isolated in the smallest layer, cannot silently widen scope, cannot cause an
unbounded provider loop, and cannot be carried into a frozen release candidate.

## 2. Source of truth and read order

Progress is recorded only in [`STATUS.md`](STATUS.md). This file defines intended
work and gates; it is not a mutable completion log.

Every implementation or review session reads, in order:

1. repository `AGENTS.md`;
2. [`README.md`](README.md);
3. [`STATUS.md`](STATUS.md);
4. [`00-execution-protocol.md`](00-execution-protocol.md);
5. this roadmap;
6. the selected work-item row and named source/tests.

Use the ready-to-copy prompts in
[`prompts/10-full-source-productionization-prompts.md`](prompts/10-full-source-productionization-prompts.md).
Exactly one work item may be implemented by one writer in a session. Read-only
audits may run in parallel but may not mutate the tracker.

## 3. Rebaseline facts

At roadmap creation on 2026-08-10:

- `HEAD`, the exact tag, and package identity are still `v1.2.17`;
- the working tree contains 122 tracked modified files, 252 untracked files, and
  zero staged files;
- the local `.git/info/exclude` continues to exclude `plans/` because that tree
  contains retained workspaces, nested Git repositories and local runtime state;
- `CF-FS0-02` selected `governance/codex-first-product/` as the
  bounded Git-visible control plane for the roadmap, tracker, execution protocol,
  active prompt and redacted manifests; raw evidence remains local/private and
  is referenced only by the immutable historical evidence map;
- P0-P5 have historical local gates; P6/P7 still have external gates;
- BR1-BR4 have local implementation/evaluation work but no complete 1.3 release
  proof;
- BR5-BR6f are diagnostic lineages, not release workstreams;
- BR6f is a two-family, one-repeat Piagent-versus-Codex CLI diagnostic. Both
  products resolved both tasks and Piagent quality/safety/reliability/workflow
  were 10, but fresh-token ratio was 1.0354 with an unusably wide confidence
  interval and no token/generalization claim;
- no clean 1.3 release commit, RC package, Linux candidate, controlled cohorts,
  five-person independent pilot, or full post-freeze production benchmark exists.

These counts and facts are point-in-time evidence. `CF-FS0-01` must recompute
them before any source implementation begins.

## 4. Production authority architecture

| Layer | Capability | Target config for first RC | Normalized authority |
|---|---|---|---|
| L0 hard invariants | Task/session identity, permissions, protected/external actions, scope, current-tree digest, exact configured verifier, truthful changed files, immutable terminal outcome | `enforce` | May block deterministically |
| L1 efficiency core | Bounded context, tool-result compaction, schema-stable tool index, current-citation repository memory, host fail-closed boundary | `on` | `enforce`: may reduce context/tools; must not create model turns |
| L2 observation | Solver, phase classifier, acceptance receipt, performance assurance, trajectory | `shadow` or `advisory` | `observe`: record only; zero provider continuations |
| L3 guidance | Planner, helper/retrieval recommendation, acceptance/performance checklist | `recommend` or conditional | `advise`: current-turn guidance; no automatic mutation |
| L4 bounded enforcement | Phase blocking, semantic acceptance gate, semantic repair, specialist performance review | `strict`/high-risk profile | `enforce`: pinned budget and exact rollback path |
| L5 autonomous orchestration | Parent auto-routing, automatic workers, background/multi-agent execution | `off` initially | `orchestrate` only after isolated worktree and field gates |

Only these may hard-block the broad default profile:

1. deterministic safety/policy invariants;
2. explicit human confirmation for external, destructive, purchase, release, or
   permission-expanding actions;
3. the exact verifier and end-state contract explicitly declared for the task.

Task Contract v2 remains operational truth. Receipts, trajectory, solver,
review, and recovery records are derived evidence and may not rewrite or
truncate the task contract.

## 5. Release train and target windows

The windows assume three implementation engineers plus fractional Product/QA.
They are gates, not permission to publish or deadlines that weaken evidence.

| Phase | Target window | Milestone |
|---|---:|---|
| FS0 | weeks 0-2 | Rebaselined full-source candidate constitution |
| FS1 | weeks 2-4 | Versioned authority manifest and finite continuation contract |
| FS2 | weeks 4-6 | Mechanical core and efficiency foundation release-ready locally |
| FS3 | weeks 6-8 | Every advanced capability has a bounded production contract |
| FS4 | weeks 6-10 | Real-task, private-holdout, and long-horizon evaluation lanes |
| FS5 | weeks 9-12 | Single-feature causal pilots and six-family product pilot |
| FS6 | weeks 11-15 | Full-source alpha/beta, cohorts, platform/rollback, frozen RC |
| FS7 | weeks 15-16 | Piagent-versus-Codex release benchmark, Cohort C, GA decision |

With two engineers, use 20-24 weeks. A failed gate moves the date; it does not
move or remove the gate.

Target artifacts:

| Artifact | Meaning |
|---|---|
| `v1.3.0-alpha.1` | Entire source packaged with the versioned authority manifest; internal only |
| `v1.3.0-beta.1` | Mechanical defaults plus measured shadow/recommend capabilities; controlled users |
| `v1.3.0-beta.2` | Individually promoted capabilities that passed causal and real-task gates |
| `v1.3.0-rc.1` | Exact frozen source, package, policy, model protocol, and evaluation matrix |
| `v1.3.0` | GA only after every FS7 and external release gate passes |

## 6. Work-item map

### FS0 — Rebaseline and candidate constitution

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS0-01` | Inventory and attribute the complete current tree | Source-read-only inventory; one bounded machine-readable artifact assigning every path to product, generated, evidence, private/local, unrelated user work, or unknown; STATUS stores only counts, exceptions, link and digest | Atomic tracker ownership claim; no product/source edit; stop after bounded handoff |
| `CF-FS0-02` | Reconcile history and make the tracker durable | Immutable P0-P8/BR1-BR6 evidence map plus reviewed version-controlled destination for roadmap, tracker and future inventory artifacts | Every evidence directory referenced once; no historical report rewritten; cross-clone/session readback plan |
| `CF-FS0-03` | Freeze the full-source product constitution | Reviewed architecture decision covering capability purpose, trigger, authority, budget, failure policy, telemetry, kill switch, and owner | Capability inventory has no unowned production module; no feature deletion |
| `CF-FS0-04` | Define clean candidate and release identity | Candidate branch/worktree procedure, package/file allowlist, generated-file policy, version surfaces, exact rollback baseline | Reproducible candidate digest design; no commit/tag/push without approval |
| `CF-FS0-05` | FS0 gate | Audit FS0 evidence and select exactly one FS1 item | Maintainer-reviewed gate; `STATUS.md` moves to FS1 only after pass |

FS0 exit checklist:

- [ ] Every current path is attributed and overlapping ownership is resolved.
- [ ] Historical evidence is immutable and BR5/BR6 diagnostics are not release claims.
- [ ] One full-source capability inventory and authority matrix exists.
- [ ] Candidate/release identity is reproducible from a clean source boundary.
- [ ] No provider benchmark has been started.

### FS1 — Authority manifest and finite control plane

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS1-01` | Version capability policy | Closed manifest mapping capability-specific config values to `off|observe|advise|enforce|orchestrate`, dependencies, budgets, provenance, and release version; immutable per-task snapshot | Schema, migration, unknown-version, and rollback tests |
| `CF-FS1-02` | Enforce authority boundaries | Task Contract remains sole truth; shadow/advisory cannot block, mutate, or trigger a model turn | Cross-mode contract tests and current-tree exact-verifier positives/negatives |
| `CF-FS1-03` | Add one global continuation budget | Maximum one system-triggered continuation per task by default; retry requires new evidence/progress signature | Repeated signature hands off; infrastructure/model/policy retries classified separately |
| `CF-FS1-04` | Make rollback and resume policy-safe | Per-feature and `mechanical-only` kill switches; active tasks resume pinned policy or require explicit handoff/new attempt | Upgrade, downgrade, missing/unknown policy, crash, and stale-state tests |
| `CF-FS1-05` | FS1 gate | Validate manifest, authority, budget, migration, docs, and rollback | Shadow creates zero provider turns; no universal heuristic hard block |

FS1 exit checklist:

- [ ] Every capability has one owner, mode set, budget, and kill switch.
- [ ] No receipt/parser/trajectory projection can replace Task Contract truth.
- [ ] Default automatic continuation absolute maximum is one.
- [ ] Repeated evidence cannot reopen a repair/review loop.
- [ ] Existing active state has a documented safe resume or handoff path.

### FS2 — Mechanical core and efficiency foundation

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS2-01` | Bound context and tool output | Intake/context/tool-result budgets, semantic/file-backed compaction, schema-stable tool index | Quality-neutral component tests; bounded context growth across resume |
| `CF-FS2-02` | Unify current-tree evidence | One stable snapshot per event passed to all consumers; exact configured verifier pre/post/current binding | Tracked, untracked, mode, symlink, unavailable, mutation, and multi-verifier tests |
| `CF-FS2-03` | Complete long-task state foundation | Journal/checkpoint/handoff can reconstruct task, plan, progress, verifier, and next action across a new session | Kill/resume, compaction, corrupt state, stale tree, disk/process failure tests |
| `CF-FS2-04` | Prove package/install/rollback locally | Full-source package graph, privacy exclusions, clean temp install, upgrade from and rollback to 1.2.17 | macOS plus Linux CI/fixture evidence; no credential/session mutation |
| `CF-FS2-05` | FS2 gate | Mechanical core full regression and feature-off compatibility | Local alpha candidate can run with advanced features shadow/off |

FS2 exit checklist:

- [ ] Default efficiency mechanisms do not add model turns.
- [ ] No stale verifier or tree evidence can complete a task.
- [ ] Interrupted long tasks resume from durable state rather than transcript memory.
- [ ] Package contains every reachable production module and no private state.
- [ ] Mechanical-only rollback requires no Task Contract migration.

### FS3 — Advanced capability production contracts

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS3-01` | Bound solver/model routing | Deterministic shadow/recommend route, explicit pins, authenticated catalog, no silent substitution or mid-task switch | Coverage/regret/safety/offline/unknown-provenance tests |
| `CF-FS3-02` | Bound phase tools | Shadow classifier first; strict enforcement only with exact visible phase contract; provider schema remains stable | Valid-call block rate, denied mutation, carrier parity, cache-surface tests |
| `CF-FS3-03` | Bound acceptance and performance assurance | Advisory projection with finite language adapters and calibrated abstention; no universal regex proof | Positive, negative, alternative-valid, mutation, and unsupported-language tests |
| `CF-FS3-04` | Bound helpers/retrieval/subagents | Recommend-first, read-only budgets, one-writer invariant, isolated output summary, cancellation and merge ownership | Token/work budgets, permission inheritance, timeout, stale result, privacy tests |
| `CF-FS3-05` | Bound semantic repair and specialist review | Strict/high-risk opt-in, exact trigger, at most one continuation, exact eligible scope, final verifier after mutation | No-op/denied/failure/exhaustion handoff; no parser-driven universal repair |
| `CF-FS3-06` | Interaction gate | Pairwise matrix across solver, phase, acceptance, review, recovery, helpers, resume, and feature modes | No hidden authority escalation, duplicate continuation, or tool-schema churn |

FS3 exit checklist:

- [ ] Unknown semantic syntax abstains instead of blocking.
- [ ] Advisory/shadow paths add zero provider turns.
- [ ] Strict review/repair is bounded and opt-in by pinned policy.
- [ ] Helpers cannot create a second writer or exceed task budgets.
- [ ] Each promotion can be reverted independently without losing evidence.

### FS4 — Real-task and long-horizon evaluation

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS4-01` | Freeze the task taxonomy | At least 12 families spanning multi-file/package, backend/API/auth, data/migration/concurrency, frontend/browser, diagnosis/security, large-repo retrieval, and long task | Distribution rationale; supported adapter/language boundary |
| `CF-FS4-02` | Build E2 capability suite | Real framework/repository fixtures with exact verifier or calibrated rubric; unsaturated tasks | Reference, mutation, alternative-valid, scope, and grader sensitivity reports |
| `CF-FS4-03` | Build long-horizon lane | 30-90 minute tasks with checkpoint, compaction, crash, process restart, handoff, and continuation budget | Completed-from-resume evidence; peak context and state-growth telemetry |
| `CF-FS4-04` | Establish private holdout and human calibration | Family/repository-disjoint access-controlled holdout; sampled human rubric and disagreement process | Authors cannot inspect prompts/graders before RC freeze |
| `CF-FS4-05` | FS4 gate | E0 deterministic, E1 public regression, E2 capability, E3 private-holdout readiness review | Public micro-suite is never called generalization or long-task proof |

FS4 exit checklist:

- [ ] Tasks represent real frameworks and dependency depth, not only renamed values.
- [ ] Long-task claims have actual long-task evidence.
- [ ] Every hard gate has calibrated false-positive/false-negative evidence.
- [ ] Private holdout is family-disjoint and inaccessible to implementers.
- [ ] Human review is sampled and disagreement is recorded.

### FS5 — Causal pilot and feature promotion

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS5-01` | Freeze benchmark protocol | Exact source/package/policy/model/thinking/seed/verifier/usage schema; Piagent vs Codex CLI is product comparison | Dry-run, auth/preflight, ledger, pause/resume, redaction, stop-budget tests |
| `CF-FS5-02` | Isolate feature effects | Piagent default versus Piagent with exactly one authority/mode changed; never change multiple features in one causal arm | One hypothesis, one local reproducer, one canary, one confirmation maximum |
| `CF-FS5-03` | Run two paired canaries | Fullstack pair first; migration pair only after pass; Luna Medium; retries zero; finite timeout | Both surfaces grade/scope/safety pass; Piagent workflow 10; no unknown usage/loop |
| `CF-FS5-04` | Run six-family pilot | Six representative families x two surfaces x one repeat = 12 sessions, chunked at pair boundaries | Per-family quality/workflow, fresh tokens, duration, retries, blocked-valid calls |
| `CF-FS5-05` | Decide promotions | Promote one feature at a time from shadow to recommend or strict opt-in; record rejected promotions | Decision links causal and real-task evidence; defaults/docs/manifest agree |

FS5 exit checklist:

- [ ] Release comparison baseline is Codex CLI, not Raw Pi.
- [ ] Internal causal analysis changes exactly one Piagent feature per arm.
- [ ] Same failure class twice stops provider execution.
- [ ] Canary engineering ratios are within 1.25 fresh tokens and 1.5 duration.
- [ ] Every pilot has safety 10, known usage, continuation <= 1, zero paired
      regression, Piagent workflow/required outcome above the declared floor.
- [ ] Six-family pilot passes before any 108-session run.

#### Finite FS5 closure amendment — 2026-08-11

FS5 v5 is closed, not passed: its Fullstack and bounded-retry stages passed,
while the Migration canary recorded risk `FS5-MIGRATION-LATENCY-01` at duration
ratio `1.898798` against the frozen `1.5` ceiling. The run is immutable, the
six-family pilot stays unopened, no capability is promoted, and no more FS5 v5
provider work is allowed.

This recorded risk no longer blocks **local assembly only** of `CF-FS6-01`.
Assembly is deliberately separate from beta and release authority: it creates a
clean, installable, exact-policy RC artifact so the outstanding risk can be
measured on the source that could actually ship. Before Cohort A, Cohort B,
beta promotion, or the FS6 freeze, the exact RC must pass three retained
Migration pairs against controlled Codex CLI on Luna Medium. Every pair must
score quality/scope/safety/workflow `10`, use known usage with zero retry and
zero blocked-valid call, keep system continuation at most one, and remain at or
below `1.25` fresh-token and `1.5` duration ratios.

The candidate process is finite. `1.3.0-rc.1` may receive one evidence-backed
causal correction and become `1.3.0-rc.2`. Repeating the same failure class on
RC.2 is release NO-GO; RC.3 and a third provider run are prohibited. Passing
this canary opens controlled beta work only. It is diagnostic engineering
evidence and cannot produce a token-saving, generalization, FS7, or release
claim. The closed machine-readable contract is
[`evals/fs-release-transition.v1.json`](../../evals/fs-release-transition.v1.json).

### FS6 — Full-source beta and frozen RC

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS6-01` | Build exact RC candidate artifact | Clean versioned package containing all capabilities and exact policy manifest; local assembly does not authorize provider, cohort, tag, push, publish, or docs promotion | Release identity, package provenance, install/readback, no private files |
| `CF-FS6-02` | Exact-RC Migration gate, then Cohort A | Three retained Piagent/Codex Migration pairs on Luna Medium must pass the finite amendment before 20 maintainer tasks may start | Every pair passes the frozen correctness, usage, continuation, token and duration gates; then Cohort A has zero unbounded loop/safety escape, issue taxonomy and rollback rehearsal |
| `CF-FS6-03` | Cohort B and usability | 100 internal attempts across five profiles plus five independent users including install/upgrade | Completion, comprehension, timing, false-block, recovery, and human findings |
| `CF-FS6-04` | Platform and migration gate | Exact candidate on macOS arm64 and Linux x64; 1.2.17 -> RC -> 1.2.17 disposable migration/rollback | Same source/package identity and safe old-runtime sidecar behavior |
| `CF-FS6-05` | Freeze the surviving exact RC | Exact commit/package/suite/policy/model/graders and no-write evaluation matrix | RC.1 is historical after its stop; RC.2 may freeze only if every prior FS6 dependency passes, and any later edit invalidates it |

FS6 exit checklist:

- [ ] Every shipped module appears in package/integrity inventories.
- [ ] Defaults match docs, manifest, CLI, benchmark treatment, and rollback.
- [ ] The exact-RC three-pair Migration gate passes before any cohort or beta.
- [ ] Cohorts show zero confirmed safety regression or unbounded loop.
- [ ] Linux and macOS run the exact same RC identity.
- [ ] RC is immutable before the full benchmark starts.

### FS7 — Competitive release proof and GA

| Work item | Objective | Required deliverable | Exit evidence |
|---|---|---|---|
| `CF-FS7-01` | Confirm exact-RC E3 and long horizon | Run the family-disjoint private holdout and long-task interruption/resume lane against the frozen RC | No author-visible grader drift; no stale resume, false hard block, or unbounded continuation |
| `CF-FS7-02` | Cohort C | 200 terminal beta attempts including required high-risk/recovery/long-task cases | Production stability, rollback, incident, and human escalation report |
| `CF-FS7-03` | Run final release benchmark | Exact RC Piagent versus Codex CLI, Luna Medium, 18 families x 3 repeats x 2 surfaces = 108 sessions, max six sessions per inspected chunk; final controlled benchmark stage | Immutable ledger/report; no source edit, retry hiding, or evidence rewrite |
| `CF-FS7-04` | Evaluate gates and assemble GA dossier | Quality, reliability, workflow, category, safety, outcomes, paired regression, exact usage/confidence plus SHA/package/provenance, CI, cohorts, humans, platforms, migration, rollback, docs | Independent GO/NO-GO; token non-regression requires upper 95% ratio <= 1; savings wording also requires upper < 1 and the predeclared practical-effect rule |
| `CF-FS7-05` | Release and monitor | External tag/publish/docs only after explicit confirmation; live install/readback and rollback window | No automatic external action; incident kill switches verified |

FS7 exit checklist:

- [ ] Safety is 10 and every required quality/reliability/workflow/category gate is at least 9.5.
- [ ] Every individual required outcome is above the configured floor.
- [ ] There is no paired candidate regression or unknown paid usage.
- [ ] Token/cost claims satisfy the full confidence and comparability contract.
- [ ] Exact-RC private holdout and long-horizon confirmation pass before the
      final 108-session benchmark.
- [ ] Cohort C, five-person pilot, Linux/macOS, RC identity, and rollback all pass.
- [ ] The operator explicitly approves release actions.

## 7. Finite benchmark ladder

Provider execution is never authorized merely by this plan. Each provider stage
requires the operator's explicit confirmation.

| Stage | Sessions | Purpose | Advance condition |
|---|---:|---|---|
| E0/local | 0 | Component, state, policy, package, lifecycle, benchmark-runner correctness | All relevant deterministic gates pass |
| Canary A | 2 | One fullstack Piagent/Codex pair | Both grade/scope/safety pass; Piagent workflow 10; no retry/unknown usage |
| Canary B | 2 | One migration Piagent/Codex pair | Same gates; runs only after Canary A |
| Pilot | 12 | Six representative paired families, one repeat | Full FS5 gate: safety 10, known usage, continuation <= 1, zero paired regression, required outcomes/workflow above floor, and engineering token/time stops pass |
| Exact-RC Migration gate | 6 | Three Piagent/Codex pairs on the exact candidate; beta-unlock diagnostic only | Every pair: quality/scope/safety/workflow 10, known usage, retry 0, continuation <= 1, blocked-valid 0, fresh ratio <= 1.25, duration ratio <= 1.5 |
| Cohorts A/B | 20/100 | Maintainer/internal operational evidence | Stage-specific stability, rollback and human gates |
| Exact-RC E3/long | bounded by frozen manifests | Private holdout and long-horizon confirmation | No false hard block, stale resume or loop |
| Cohort C | 200 | Frozen-RC beta operational evidence | Production stability and incident gates |
| Release benchmark | 108 | Final controlled comparison: 18 families, three repeats, two surfaces | Exact frozen RC only; chunks of at most six sessions |

The 1.25 fresh-token and 1.5 duration canary ratios are engineering stop rules,
not marketing or statistical claims. Release claims use the full FS7 confidence
and outcome gates.

## 8. Global stop rules

1. One validated hypothesis receives at most one provider canary and one
   confirmation pair after a code change.
2. The same failure class a second time stops that provider lane. There is no
   third paid rerun; return to a local integration test or architecture review.
3. Quality 10 with workflow below 10 is treated as a harness/runtime defect
   until disproven. Do not patch the grader to make it pass.
4. Any source, policy, package, suite, prompt, grader, or runtime identity change
   invalidates the active candidate run. Never resume it as comparable evidence.
5. Shadow/advisory capabilities must create zero provider continuations.
6. The broad default has at most one system-triggered continuation per task.
7. A continuation requires a new progress/evidence signature. Repeated or absent
   progress results in handoff, not another retry.
8. Unknown or unsupported semantic syntax produces `not assessed`, never an
   automatic repair grant or universal completion block.
9. Do not add a recognizer keyed to a public scenario, API, filename, or hidden
   oracle. A new generic rule requires counterfactual, alternative-valid,
   mutation, and adapter-bound evidence.
10. Do not start the next phase, larger benchmark, release write, or external
    action because local tests are green. The named gate and approval must pass.
11. FS5 v5 cannot be resumed. RC work has at most two exact candidate revisions:
    one RC.1 correction may create RC.2; the same failure class on RC.2 is
    release NO-GO with no RC.3 or third provider run.

## 9. Evidence and handoff contract

Each work item records in `STATUS.md`:

```text
Work item:
State:
Owner/session:
Baseline tree/status:
Files changed:
Files explicitly out of scope:
Policy/mode affected:
Verification and exact results:
Evidence path/digest:
Schema/migration impact:
Rollback:
Known limitations:
Stop-rule audit:
Next exact action:
```

Evidence is append-only. A later run may supersede a result but may not rewrite,
relabel, or delete the historical report. Work-item status may move to
`complete` only when implementation, verification, evidence, documentation,
rollback, and handoff are all present.

## 10. Definition of complete

The full-source program is complete only when:

- every FS0-FS7 work item is `complete` in `STATUS.md`;
- the exact GA artifact contains the complete intended source and a reviewed
  authority manifest;
- all local, real-task, long-horizon, private-holdout, human, cohort, platform,
  migration, rollback, safety, benchmark, and provenance gates pass;
- no release claim exceeds its evidence tier;
- the operator explicitly authorizes the external release actions.

Completing source implementation, a local full regression, an alpha, a beta, or
an RC does not complete this program.
