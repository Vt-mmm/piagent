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
| CF-IE5-01 | `complete` | One Fullstack Luna Medium Piagent/Codex pair plus at most one evidence-backed confirmation after a code change | Any confirmation finite gate fails |
| CF-IE5-02 | `complete` | One Migration Luna Medium Piagent/Codex pair | IE5-01 fails or IE4 incomplete |
| CF-IE6-01 | `implemented` | Frozen statistical protocol and exact release candidate | IE5 incomplete or freeze receipt does not bind the clean commit/package/preflight |
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
- Capability catalog/lock was current at the IE4 boundary. The subsequent
  bounded context-delivery correction is current at
  `sha256:bdc2b02dbb2731cf56f0e606bb8eb22fa17a253a5a11f392728558e09e00cb31`.
- Before the bounded source snapshot, all four capability-shaped runtime intake
  messages remained below 2,600 characters. The final source-delivery boundary
  is below 3,600 characters for the same fixtures and replaces later file reads
  with at most 900 tokens of current scoped source. Mechanical control emits no
  criterion-map text; the intelligence arm changes only
  `PIAGENT_INTELLIGENCE_ENGINE`, preserves task truth and tool schemas, and adds
  no provider follow-up turn.
- No provider session or benchmark evidence was created during IE0-IE4.

## IE5 Fullstack pair #1 and finite correction

- Exact source: commit `1d079da90412674678c6ab6cd714b1542aff3112`,
  candidate `38580c7c565ced6df2b052a461372eefef7552a731e7230bf396171b6a50b20c`,
  clean status, suite `bb2e97a83a8a3d06976bcc94259e60c3513626704bd463d87c9808e66fe5152c`.
- Both surfaces passed hidden grade, scope and safety at 10. Piagent workflow
  was 10 with 6/6 criteria, 3/3 critical, zero retry, zero continuation and
  zero blocked valid call.
- Piagent used 21,094 fresh tokens versus Codex CLI 20,108 (`1.0490`), inside
  the `1.25` engineering ceiling. Duration was 153.500 versus 86.664 seconds
  (`1.7712`), outside the `1.5` ceiling. Migration did not open.
- Evidence-backed hypothesis: graph selection was persisted and shown as paths
  but, when the optional repository index was absent, selected source bytes were
  not delivered in the current provider turn. The measured Pi session made 20
  tool calls and 33 messages versus Codex's 6 and 4; it had no semantic review,
  recovery or policy-block loop.
- The single allowed correction adds a 900-token current-file snapshot for
  graph-selected paths. It requires no index or model turn, rejects protected,
  secret, symlink, binary, oversized and unstable file carriers, and leaves the
  Task Contract/verifier as truth. Provider-free context/Pi/causal tests are
  `35/35`; the complete repository gate, typecheck and 203-file architecture
  gate pass.
- Exactly one newly preflighted Fullstack confirmation pair may now run. A
  repeated duration failure closes this hypothesis; no third Fullstack pair and
  no Migration pair is allowed.

## IE5 exit evidence — 2026-08-11

- Exact source: clean commit `effc58fca7582d0f12ea0fbd55452875a1ed1070`,
  candidate `073bbbc819a43247e4fd91602d7fffcf5363d615590dcee9b7c73b28da215f13`
  across 1,420 files, suite
  `bb2e97a83a8a3d06976bcc94259e60c3513626704bd463d87c9808e66fe5152c`.
- Fullstack confirmation: both surfaces passed grade, scope and safety at 10;
  Piagent workflow was 10 with 6/6 criteria, 3/3 critical, zero retry, zero
  continuation and zero blocked call. Piagent used 19,045 fresh tokens versus
  Codex CLI 39,016 (`0.4881`, 51.19% lower) and 114.134 versus 127.137 seconds
  (`0.8977`).
- Migration: both surfaces passed grade, scope and safety at 10; Piagent
  workflow was 10 with 8/8 criteria, 3/3 critical, zero retry, zero
  continuation and zero blocked call. Piagent used 18,335 fresh tokens versus
  Codex CLI 30,823 (`0.5948`, 40.52% lower) and 152.787 versus 165.214 seconds
  (`0.9248`).
- The two-family diagnostic total is 37,380 versus 69,839 fresh tokens and
  266.921 versus 292.351 seconds. This is engineering evidence that the
  criterion graph plus bounded current-source delivery recovered the intended
  efficiency on both steady-state and cold-start tasks; it is not a statistical
  release or generalization claim.
- Fullstack evidence: private run
  `/Users/vtamm/.pi/benchmarks/cf-ie5-fullstack-confirm-effc58f-v1`; report,
  runs and manifest SHA-256 are respectively
  `0d74b9cf7a37feb89a6df9e3e96e6f68799fa47606b74513d268aad997e4c03d`,
  `164071416b68bd1e64c475b44e6be637bff3fec689415ada0292768d36ff6b91`,
  and `64d18ca8d08f6a2a96aca7a3b17de27e0a886df2400ab5a5fc77210ec1b4ae4e`.
- Migration evidence: private run
  `/Users/vtamm/.pi/benchmarks/cf-ie5-migration-effc58f-v1`; report, runs and
  manifest SHA-256 are respectively
  `7e4fa7f4124d7c37613caf0b2b09bfd74fd1c7d26a0759099aea015338928b3b`,
  `be63cc233fd3db8316c188a5716bb2cb633d31640c1acdf914d54f5648dd2341`,
  and `ab706c20257c7465552543ff9e182648e419557f322b0b2320aec202b3b69830`.
- Both reports intentionally end at `repeat-gate-failed`: one repeat per family
  cannot authorize a token-saving, generalization or release claim. Provider
  work stops here. IE6 must first freeze the exact RC, representative family
  set, repeat/chunk protocol, platform/cohort gates and abort rules.

## IE6 protocol boundary — 2026-08-11

- `evals/ie6-release-protocol.v1.json` is the only active statistical release
  protocol. It does not rewrite the historical RC transition. The new package
  identity is `1.3.0-ie.1`; RC.1 and RC.2 remain immutable NO-GO history.
- The protocol fixes Piagent versus controlled `codex-cli`, Luna Medium,
  `intelligence-engine`, all 18 `production-v1` families, three repeats, two
  surfaces, 108 sessions, retry zero and 18 inspected chunks of at most six
  sessions.
- The release gate requires quality/reliability/workflow/category at least 9.5,
  safety 10, every outcome above 9.5, all 18 paired families, at least 12
  comparable efficiency families, no paired regression or unknown paid usage,
  and fresh-token ratio upper 95% confidence bound at most 1. Token-saving
  wording additionally requires the upper bound to be below 1.
- `scripts/ie6-release-freeze.mjs` is provider-free. On a clean commit it reruns
  the full local gate and release identity, builds and reads back the tarball,
  runs production preflight with zero provider sessions, and writes an exclusive
  private receipt outside the repository. Any artifact, source, version, suite,
  policy or configuration drift fails closed.
- Provider execution remains false until macOS arm64 and Linux x64 evidence,
  1.2.17 upgrade/rollback, Cohorts A/B/C (20/100/200), five independent people,
  private family-disjoint holdout, long-horizon interruption/resume and explicit
  operator chunk approval all exist.
- `CF-IE6-01` becomes complete only when the private freeze receipt at
  `/Users/vtamm/.pi/releases/ie6/1.3.0-ie.1/freeze-receipt.json` binds the clean
  candidate commit, materialized content digest, tarball SHA-512, suite/config
  digests and zero provider sessions. The receipt is deliberately outside the
  candidate; updating this roadmap after freeze would invalidate it.
