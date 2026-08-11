# Capability authority manifest

The capability authority manifest is the versioned policy source for Piagent
1.3 tasks. It includes every shipped capability without granting every
capability production authority.

The bundled manifest is
`packages/piagent-core/policy/authority-manifest.v1.json`. Its resolver and
snapshot validator are in
`packages/piagent-core/capabilities/authority-manifest.ts`; the former runtime
path remains a compatibility re-export.

## Authority vocabulary

The normalized authority values are closed and ordered:

- `off`: the capability is disabled.
- `observe`: the capability may compute and record bounded observations. It
  cannot spend an automatic continuation, dispatch, or review budget.
- `advise`: the capability may provide guidance inside an already authorized
  interaction. It cannot spend an automatic continuation, dispatch, or review
  budget.
- `enforce`: the capability may apply its declared mechanical boundary within
  the task snapshot and declared budget.
- `orchestrate`: the capability may dispatch bounded work and therefore must
  declare an automatic-dispatch budget.

Capability-specific configuration values such as `shadow`, `recommend`, `on`,
or `strict` are mapped to exactly one normalized authority in the manifest.
Unknown configuration values and unknown capability identifiers fail closed.

## Profiles and rollback

`authority-v1` provides three closed profiles:

- `broad-default`: hard invariants and mechanical efficiency remain active;
  advanced capability defaults are observed, advisory, recommend-first, or
  off according to the FS0 constitution.
- `mechanical-only`: keeps the mechanical core and operator/telemetry
  foundations while disabling advanced routing, semantic, recovery, and
  orchestration capabilities.
- `strict-high-risk`: opts phase enforcement and semantic review into their
  bounded strict modes.

The manifest declares a kill-switch mode for every capability. Selecting a
rollback profile creates a new task snapshot; it never rewrites the snapshot of
an active task.

`mechanical-only` is an authority ceiling as well as a profile. Launch-time
feature values may turn additional capabilities off, but they cannot re-enable
an advanced capability disabled by the mechanical profile. Explicit
per-feature off values are also kill switches for an already active task; they
do not mutate its pinned snapshot.

The acceptance and semantic layers have separate off-only switches:
`PIAGENT_ACCEPTANCE_ASSURANCE=off` disables CAP-11 and therefore CAP-13, while
`PIAGENT_SEMANTIC_REPAIR=off` disables only CAP-13. Non-off values cannot
promote either capability beyond the pinned profile. CAP-13 strict enforcement
is valid only with CAP-09 phase enforcement and CAP-12 recovery enforcement.
The sum of automatic dispatch budgets across helpers and parent routing may
never exceed the single task-global dispatch unit.

## Task snapshots

A task authority snapshot binds:

- manifest version, release version, canonical manifest digest, and profile;
- the closed resolution source (`profile`, `explicit-overrides`, or
  `legacy-feature-modes-v0`) and the exact ordered override map;
- task and task-run identity plus capture time;
- all 17 resolved capability modes, normalized authorities, dependencies, and
  budgets;
- the global continuation, dispatch, and review ceilings; and
- a domain-separated canonical snapshot digest.

Snapshots are deeply immutable in memory. Resume accepts only the exact known
snapshot and bundled manifest digest. Unknown versions, manifest drift, schema
errors, or tampering require a new task instead of silently migrating active
state.

Legacy mode migration is deliberately limited to a closed new-task input
surface. It recognizes solver, phase tools, recovery, helpers, parent routing,
and the host execution backend. It does not mutate active snapshots.

New runtime-created Task Contracts embed the complete snapshot as
`authoritySnapshot`. The snapshot identity and capture time must exactly match
the Task Contract `taskId`, `taskRunId`, and `createdAt`; runtime decisions read
that pinned value instead of re-reading a stronger process setting later.
Pre-snapshot tasks remain readable for compatibility, but only CAP-01..CAP-04
hard invariants retain authority. A pending pre-snapshot task cannot continue
advanced work: it receives a durable new-attempt disposition and handoff.

The project profile may select `authorityProfile` from the same three closed
profiles. `PIAGENT_AUTHORITY_PROFILE` is a launch-time fallback for new tasks.
Closed legacy feature environment values are captured as explicit overrides in
the new task snapshot. Later environment drift does not rewrite that snapshot.

## Active-task resume and rollback

Every pending task is checked at session start and again at the next user-input
boundary. Resume has three closed outcomes:

- `resume-pinned`: the exact known snapshot remains authoritative. Ordinary
  profile drift, including broad-to-strict or strict-to-broad configuration,
  does not upgrade or downgrade the active task.
- `new-attempt-required`: an explicit `mechanical-only` request, an explicit
  per-feature off switch, a missing snapshot, an unknown snapshot/manifest
  version, manifest drift, invalid content, or task identity mismatch writes
  one journal disposition and one deterministic handoff. The old Task Contract
  remains byte-unchanged and pending/historical. A replacement keeps the same
  model-attempt number, receives a fresh current authority snapshot, and
  inherits no changed-file or verifier proof.
- `blocked`: corrupt, duplicated, stale, cross-task, or otherwise invalid
  journal state cannot authorize either resume or replacement.

The disposition is append-only and task/run-bound. A crash after the journal
write but before the handoff write is recoverable: the next session or input
reconstructs the handoff before exposing the task-start tool. Once written, a
rollback receipt is sticky; restoring the old environment cannot reopen the old
task. A replacement is counted only when its snapshot actually satisfies the
requested mechanical profile or every recorded capability kill switch.

Terminal tasks remain immutable historical evidence. Policy changes do not
reopen them, relabel them, or create a replacement automatically.

## Runtime authority boundary

Runtime actions are normalized as observe, advise, block, mutate, model-turn,
or dispatch. `observe` can only record an observation. `advise` can only add
guidance inside an already authorized turn. Neither can block a call, mutate
state, dispatch work, or trigger another model turn. `enforce` can block or
mutate only within its declared task boundary; an automatic model turn also
requires a declared per-mode budget. Only `orchestrate` with a dispatch budget
may automatically dispatch work.

In `broad-default`, phase policy and acceptance/assurance remain observational,
semantic repair/review is off, and current-tree exact verification remains a
CAP-03 hard invariant. `strict-high-risk` is the explicit profile that promotes
phase and semantic enforcement. Acceptance receipts remain projections: all 12
Task Contract criteria are preserved, and missing/unsupported semantic evidence
is advisory unless CAP-13 strict enforcement is pinned for that task.

## Current implementation boundary

`CF-FS1-02` consumes the pinned snapshot for phase blocking, acceptance
enforcement, semantic repair/review, and automatic recovery eligibility.
`CF-FS1-03` adds one journal-backed continuation reservation shared by CAP-12
recovery and CAP-13 semantic review. The default absolute maximum is one
system-triggered model turn per task/run. A domain-separated progress signature
binds the authority snapshot, current tree, recovery class, missing evidence,
verifier commands, and bounded reason codes. Repeating the same signature or
requesting another continuation after the unit is consumed writes a
deterministic handoff instead of reopening repair or review. Provider/model,
infrastructure, verifier, source-repair, diagnostic, and policy-blocked cases
remain separately classified even though they share the same task-wide ceiling.

The ledger is append-only and locked across processes, so restart or resume
cannot reset the unit and concurrent schedulers cannot both win it. Advisory,
off, legacy, invalid-current-tree, corrupt-journal, and manual-lifecycle paths
cannot spend an automatic turn. Only the two completion-hook callsites that can
set `triggerTurn: true` are routed through this reservation.

`CF-FS3-05` closes the CAP-13 strict execution boundary. A specialist review is
available only to a task whose pinned `strict-high-risk` snapshot grants CAP-13
`enforce` authority and one review round. The review receives one current-tree
bounded diff and at most two targeted reads. Repair targets are the exact
conflicting source paths plus statically linked executable companion tests; a
directory sibling, unresolved test, denied carrier, failed call, or successful
no-op locks the opportunity and invalidates reusable review credit. A real
mutation must be followed by the task's exact verifier on the new tree before
completion. Retryable infrastructure failure may retry that verifier once on
the same digest, and a high-confidence in-scope failure may open one final
mutation-bound correction inside the already consumed continuation. Every
other failure, repeated signature, exhausted budget, stale/corrupt state, or
unsupported semantic shape produces a deterministic handoff rather than a new
model turn. Broad-default and advisory modes remain zero-turn and non-blocking.

`CF-FS1-04` adds the policy-safe resume and rollback contract above. Its journal
receipt, handoff, and replacement are local control evidence; they are not
provider or benchmark evidence.

No manifest profile authorizes an external provider operation. Provider and
release actions still require explicit operator approval.
