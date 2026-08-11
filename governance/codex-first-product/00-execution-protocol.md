---
plan_id: codex-first-product
document: execution-protocol
status: active
---

# Execution protocol for implementation agents

This protocol makes the phase files executable across multiple agents and sessions without turning the plan into prompt-only enforcement.

## 1. Select exactly one work item

At the start of a session:

1. Read `STATUS.md` and identify `current_phase`.
2. When `current_workstream` is `FS`, open
   `15-full-source-productionization-roadmap.md`; otherwise open the historical
   phase file.
3. Select the first unblocked work item whose dependencies are complete.
4. Inspect the named source and test files.
5. Confirm that the working tree does not contain overlapping user-owned edits.
6. Implement only that work item unless the phase file explicitly groups items into one atomic change.

Do not opportunistically begin the next phase. Do not mark a work item complete because a similarly named module already exists; compare its acceptance criteria against current behavior.

## 2. Work item states

Use only these states in `STATUS.md`:

- `not-started`
- `in-progress`
- `blocked`
- `implemented`
- `verified`
- `complete`

`implemented` means code or documentation exists. `verified` means the work-item verification passed. `complete` means verification, evidence, documentation, and handoff are all present.

For FS work, track implementation and release evidence separately. Historical
local implementation may justify `implemented`; it cannot justify `verified` or
`complete` for a new candidate unless the roadmap explicitly accepts that
evidence level. A provider diagnostic is not a release gate.

Only one work item may be `in-progress` for a single writer. Parallel agents may
own read-only audits, but the active FS program has one mutable tracker and one
writer. `STATUS.md` must name the owner/session and scope before any edit.

## 3. Before editing

Record in the active task or journal:

- Work item ID.
- Objective.
- Files expected to change.
- Files explicitly out of scope.
- Verification commands.
- Current Git status for overlapping files.
- Feature mode or rollout behavior affected.

Preserve user-owned dirty files. If a required target has overlapping edits that cannot be isolated safely, stop that work item and report the exact overlap.

## 4. Change design rules

- Keep source and identifiers in English.
- Long-form operator documentation may be Vietnamese.
- Reuse existing local-state, redaction, capability, task, verification, and retention services.
- Prefer pure deterministic functions for feature extraction and solver policy.
- Keep provider-specific facts out of generic core policy. Store them as versioned profiles or runtime snapshots.
- Do not infer hosted/API features from a model ID.
- Do not add another task state machine when Task Contract v2 already owns task truth.
- Do not write new product logic in `piagent-guard.ts`; add a bounded module and wire it from the entrypoint.
- Do not add a custom read/write lock to lifecycle hooks. Use Pi tool execution semantics, phase tool visibility, the one-writer rule, and the host per-file mutation queue.
- Do not claim account-wide coordination when a controller can see only Piagent-owned child work.
- Do not label a same-process hash chain as independent audit evidence.

## 5. Required tests per work item

Run the narrowest relevant tests while iterating, then the phase gate before marking the phase complete.

Minimum final gate for source changes:

```bash
npm test
npm run typecheck
npm run architecture:check
npm run docs:check
npm run capabilities:check
npm run verify -- --offline
```

Run authenticated model/doctor tests only when the work item requires them and the local Pi login is available. A missing login must be reported as environment evidence, not converted into a source change.

Changes affecting installation, distribution, or release must also run the package-distribution, install/update/rollback, release-identity, and supported-platform smoke checks named in the phase file.

Changes affecting policy must add or update golden, adversarial, and differential tests. A happy-path unit test is insufficient.

Changes affecting routing or model policy must run paired benchmark variants with the same model and effort. Compare the existing effort and one lower level before promoting a default.

## 6. Evidence required before completion

For every completed work item, `STATUS.md` must record:

- Exact files changed.
- Exact verification commands and results.
- Feature mode used during verification.
- New or changed schemas.
- Migration impact.
- Rollback method.
- Benchmark/report path when the item changes behavior.
- Known limitations or deferred work.

Do not paste full logs into the tracker. Link to bounded local evidence or summarize exact failures and outcomes.

## 7. Phase gate procedure

When all work items in a phase are verified:

1. Run the full phase verification matrix.
2. Compare metrics with the frozen P0 baseline.
3. Review privacy and security invariants.
4. Exercise the feature-off rollback.
5. Update docs and release notes required by the phase.
6. Mark the phase-gate work item `in-progress` in `STATUS.md` and stop source
   implementation.
7. A separate read-only maintainer/reviewer audits the evidence and writes one
   immutable audit artifact bound to the reviewed tree/candidate/policy digest.
8. The sole tracker writer verifies the audit artifact and digest against current
   state. Only then may that writer mark the phase-gate work item and phase
   `complete`, advance `current_phase`, select the first next item, and stop.

A phase is not complete merely because code is merged.

## 8. Handoff and resume format

End every implementation session with this compact record in `STATUS.md`:

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

On resume, verify the current working-tree state and evidence rather than trusting the handoff text alone.

## 9. Approval boundaries

The plan authorizes local implementation and non-destructive verification only after the user requests implementation. It does not authorize:

- Publishing packages.
- Creating or pushing tags.
- Pushing branches.
- Opening or modifying pull requests.
- Changing external provider configuration.
- Deleting project/user state.
- Installing experimental execution backends.
- Enabling a wider project permission profile.

Each of those actions requires the normal explicit operator confirmation.

## 10. Plan maintenance

If implementation evidence invalidates a plan assumption:

1. Do not silently work around it.
2. Record the evidence in `STATUS.md`.
3. Update the affected phase file and its acceptance gate.
4. Preserve the original safety/product boundary unless a reviewed ADR changes it.
5. Note whether timeline, schema, compatibility, or release scope changed.

Plans may evolve; completion evidence may not be rewritten after the fact.

## 11. FS candidate and benchmark rules

These rules apply whenever `current_workstream` is `FS`:

1. The candidate has one state: `unfrozen`, `frozen`, or `invalidated`.
2. Any source, policy, package, suite, prompt, grader, runtime, or benchmark
   identity change after freeze invalidates the candidate. Preserve the ledger;
   never resume or relabel it as comparable evidence.
3. Provider execution requires separate explicit operator confirmation for the
   exact stage. A plan row or local green test is not authorization.
4. Run the benchmark ladder in order. A failed smaller gate prohibits the larger
   gate.
5. One hypothesis receives at most one paid canary and one confirmation pair
   after a source change. The same failure class a second time stops the lane.
6. Quality 10 with workflow below 10 is classified first as a runtime/harness
   defect, not a reason to weaken the grader.
7. Shadow/advisory behavior must trigger zero additional provider turns. The
   broad default permits at most one system-triggered continuation, and only
   after a new progress/evidence signature.
8. Unknown semantic syntax abstains. Do not add a public scenario/API/file-name
   matcher to generic runtime policy.
9. Product comparison is Piagent versus Codex CLI with exact model/thinking
   parity. Internal causal analysis changes one Piagent feature at a time; Raw Pi
   is not the release baseline.
10. Full production execution is chunked at pair boundaries and may start only
    from the exact frozen RC named by FS6.

## 12. Controlled-session rule

The historical P0-P7 unattended autopilot is not valid for FS0-FS7. One session
may complete one implementation work item and its narrow verification, then must
write a handoff and stop. Phase gates use an independent read-only session.
Provider, cohort, package publication, tag, push, and release stages retain their
explicit approval boundaries.
