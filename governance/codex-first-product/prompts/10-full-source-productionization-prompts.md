---
plan_id: codex-first-product
workstream: FS
document: full-source-productionization-prompts
status: active
---

# Full-source productionization session prompts

These prompts execute the active FS0-FS7 roadmap without recreating the
zero-feedback P0-P7 autopilot. One implementation session owns exactly one work
item. A separate read-only session reviews a phase gate.

## Required read order

Every prompt below requires this order:

1. `AGENTS.md`
2. `plans/codex-first-product/README.md`
3. `plans/codex-first-product/STATUS.md`
4. `plans/codex-first-product/00-execution-protocol.md`
5. `plans/codex-first-product/15-full-source-productionization-roadmap.md`
6. the selected work-item definition and named source/tests

The working tree and persisted evidence are truth. Handoff prose is only a
pointer and must be verified.

## A. Select the next executable work item

```text
Act as the read-only controller for the Piagent full-source productionization
program.

Read the required files in the documented order. Inspect current Git status and
the active control block, FS phase map, detailed FS checklist, blockers, and
latest handoff in STATUS.md.

Do not edit any file and do not call a provider.

Return exactly one of:

1. One selected work item:
   - ID and title;
   - why every dependency is complete;
   - implementation evidence already reusable from P0-P8/BR1-BR6;
   - release evidence still required;
   - exact session name;
   - expected source/test files and explicit out-of-scope files;
   - required verification and stop rules.

2. One blocker:
   - the exact unmet dependency, ownership overlap, stale candidate, missing
     authority, or corrupt evidence;
   - the smallest safe read-only next action.

Never select a later work item, start a benchmark, or treat historical/local
evidence as exact-candidate evidence.
```

## B. Execute one selected work item

```text
Execute exactly the active full-source productionization work item recorded in
STATUS.md. Do not start or pre-implement the next item.

Read the required files in order. Before editing:

- verify the active work-item ID, dependencies, owner/session, and state;
- inspect current Git status and overlapping user changes;
- record baseline tree/status, expected files, out-of-scope files, capability
  modes, authority, budgets, kill switch, exact verification, and stop rule;
- reuse verified historical implementation where valid, but require current
  evidence before crediting the exact candidate.

Implementation rules:

- preserve every current capability; change authority or activation through the
  versioned policy rather than deleting a feature;
- keep Task Contract v2 as operational truth;
- shadow/advisory paths must not block, mutate, or trigger model turns;
- broad-default automatic continuation is globally bounded to one and requires
  a new progress/evidence signature;
- unknown semantic syntax abstains instead of granting repair or blocking;
- do not add a public benchmark scenario/API/file-specific recognizer;
- do not weaken safety, scope, verifier, evidence, privacy, approval, or release
  gates to make a test pass;
- do not call a provider or perform an external/destructive/release action unless
  the operator separately and explicitly authorized that exact action.

Run the narrow work-item checks, the required interaction/rollback checks, and
the named final gate. Update only the canonical tracker with actual evidence.
End with one exact next action and stop.
```

## C. Resume an interrupted work item

```text
Resume the one in-progress full-source productionization work item; do not start
a new item.

Read the required files in order. Recompute current Git status and verify:

- active work-item ID and owner/session;
- expected and actual changed files;
- candidate state/digest and policy manifest version;
- persisted test/evidence digests;
- whether a prior provider run was invalidated by any source, policy, suite,
  prompt, grader, runtime, or package change.

If state matches, continue from Next exact action. If it does not match, stop
implementation, mark the mismatch/blocker in STATUS.md, and propose the smallest
safe recovery. Never relabel or resume an invalidated benchmark ledger.

Before ending, verify the work-item gate, update the handoff fields, record the
stop-rule audit, and leave exactly one next action.
```

## D. Independent phase-gate audit

```text
Perform an independent source/tracker-read-only, audit-evidence-write-only review
of the active FS phase gate.

Read the required files, the entire active phase work-item map, current Git
status, evidence summaries, candidate/policy identity, and rollback records.
Do not edit product source, tests, schemas, docs, STATUS, existing evidence, or
release state, and do not call a provider. The only allowed write is one bounded
immutable audit artifact under
`plans/codex-first-product/evidence/productionization/<phase>/gate-audit/`, bound
to the reviewed tree/candidate/policy digest.

For each work item report independently:

- implementation state;
- local verification state;
- exact frozen-candidate evidence state;
- field/external evidence state;
- stale or historical evidence that cannot be promoted;
- missing acceptance, interaction, migration, rollback, privacy, or stop-rule
  evidence.

Return PASS only when every phase exit checkbox is supported by current evidence.
Otherwise return one bounded list of blockers and the first exact remediation
item. Do not advance current_phase or rewrite historical reports.
```

## D2. Record an independently reviewed phase gate

```text
Act as the sole tracker writer after an independent FS phase-gate audit.

Read the required files, the immutable audit artifact, its digest, and the exact
tree/candidate/policy identity reviewed by the auditor. Do not edit product
source and do not rerun or reinterpret the audit.

If the audit digest and reviewed identities match current state, record the audit
path/digest, mark the phase-gate work item and phase complete, select only the
first next-phase item, update the active handoff, and stop. If anything differs,
leave the phase unchanged and record one blocker. A reviewer message without a
persisted matching artifact cannot advance the phase.
```

## E. First work item — `CF-FS0-01`

```text
Execute CF-FS0-01 as a source-read-only, plan-tracker/evidence-write-only
rebaseline inventory.

Read AGENTS.md, the master README, STATUS.md, the execution protocol, and the
full-source roadmap. Inspect the complete current working tree without editing
source, tests, schemas, docs, pre-existing evidence, package metadata, or release
state. Exactly one new FS0 inventory artifact and the bounded STATUS update are
the only allowed writes.

First atomically claim CF-FS0-01 ownership in STATUS.md. Then produce an exact
inventory of every tracked modification and untracked file.
Assign each path to exactly one class:

- reusable production capability and its CAP/layer owner;
- generated public artifact;
- benchmark/evaluation implementation;
- immutable diagnostic evidence;
- local/private/secret-risk state that must never ship;
- unrelated user-owned change;
- unknown/overlap requiring operator decision.

Write the full path map as one bounded machine-readable artifact under
`plans/codex-first-product/evidence/productionization/fs0/`. Record exact counts,
artifact digest/link, current HEAD/tag/package identity, file ownership
exceptions, reachable/unreachable production modules, duplicated/generated
sources, and the minimum clean candidate boundary. Compare the current inventory
to the P0 baseline and BR1-BR6 evidence map without relabeling old results.

Keep STATUS.md bounded: store only counts, exceptions, evidence link/digest,
blockers, and one next exact action. Apart from the inventory artifact and
STATUS.md, do not modify any file. Do not run a provider, modify product code,
create a branch/commit/tag, clean files, or start CF-FS0-02.
```

## F. Operator-authorized paired canary

Use only for `CF-FS5-03` after FS5-01/02 pass and the operator explicitly
authorizes the exact provider run.

```text
Run exactly one authorized Piagent-versus-Codex CLI paired canary against the
frozen candidate recorded in STATUS.md.

Before any provider call, verify and print for readback:

- candidate source/package/policy/suite/runtime digest;
- model Luna and thinking medium on both surfaces;
- exact scenario, seed, repeat=1, timeout, surfaces, and verifier;
- infrastructure retries=0 and hard session cap=2;
- clean pair-boundary pause behavior;
- operator authorization recorded for this run only.

Abort before the provider if any identity differs or the preflight/auth/usage
path is unavailable. Preserve the immutable ledger.

After the pair, stop unconditionally and report grade, scope, safety, workflow,
fresh tokens, duration, retries, unknown usage, blocked-valid calls, and evidence
paths. Do not auto-run a second scenario. The next canary requires the named gate
and a separate controller decision.
```

## G. Benchmark failure triage

```text
Triage one failed full-source benchmark stage without editing product code,
grader, suite, or historical evidence.

Classify the failure as exactly one primary class:

- product output/quality;
- runtime/harness workflow;
- safety/policy;
- benchmark/grader validity;
- provider/infrastructure;
- measurement/accounting;
- candidate identity/provenance;
- unknown.

Prove the class from retained evidence. Map the failure to the responsible
capability layer and state whether it is reproducible locally. If quality is 10
but workflow is below 10, start with runtime/harness as the working hypothesis.

Enforce the stop rules: a repeated failure class receives no third provider run;
candidate edits invalidate the active run; no scenario-specific recognizer may
be proposed. Return the smallest local reproducer or one explicit blocker.
```

## H. RC/GA readiness controller

```text
Audit the exact v1.3 RC/GA readiness without performing external writes.

Require the current full-source STATUS map, frozen RC identity, package/readback,
macOS and Linux results, migration/rollback, real-task and long-horizon evidence,
private holdout, five-person pilot, Cohorts A-C, 108-session Piagent-versus-Codex
report, safety/quality/workflow/reliability/category gates, token claim contract,
security/privacy/provenance checks, and explicit operator approval state.

Return GO only if every named artifact is exact-current and passing. Otherwise
return NO-GO with the first unmet gate. Do not stage, commit, push, tag, publish,
promote docs, configure providers, or alter external state.
```

## Mandatory status handoff

Every implementation/resume session ends with this exact shape in `STATUS.md`:

```text
Work item:
State:
Owner/session:
Baseline tree/status:
Candidate state/digest:
Policy manifest version:
Changed:
Out of scope:
Verified:
Evidence:
Feature modes/authority:
Schema/migration:
Rollback:
Decision:
Known limitation:
Stop-rule audit:
Blocker:
Next exact action:
```
