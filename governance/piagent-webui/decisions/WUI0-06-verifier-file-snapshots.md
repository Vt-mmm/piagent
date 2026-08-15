---
plan_id: piagent-webui
work_item: WUI0-06
document: verifier-file-snapshot-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-06 — Verifier file snapshots and exact staleness

## 1. Decision

Existing Task Contract verifier evidence remains the sole completion authority:
exact configured command, observed result, exit code and whole-tree digest. WUI0-06
adds a private digest-only sidecar for each observed verifier attempt so read-only
projections can explain which files invalidated a previous pass.

The sidecar never upgrades, replaces or repairs Task Contract evidence. Missing,
legacy, corrupt, expired or unmatched sidecar produces `filesKnown: false`; it
must not guess paths from current Git status or command text.

## 2. Snapshot contract

Canonical schema is `schemas/verifier-file-snapshot.schema.json`; runtime closed
validator lives in `verifier-snapshot-contract.ts`. Each record binds:

- task/run and domain-separated hashed session/tool-call identity;
- SHA-256 command digest, observed/captured timestamps and retention;
- exact exit code/outcome and verifier whole-tree digest;
- bounded file carrier digest map;
- protected/unavailable path state and integrity digest.

Raw command, log, session ID, tool-call ID and file bytes are never persisted.
Exact safe path is retained only inside owner-only state because staleness must be
able to name a changed file; protected path keeps only `pathDigest` and carrier
digest. Browser receives safe display path or opaque path digest, never local
state paths.

## 3. Store and lifecycle

Immutable records live under the same task evidence boundary:

```text
.pi/piagent-state/source-evidence/run-<sha256(taskRunId)>/verifiers/
└── verifier.<sha256>.json
```

Directory/file permissions are `0700`/`0600`. Writer is create-only,
idempotent, no-follow and collision-detecting. Limits: 200 attempts/task, 2.000
files/attempt and 4 MiB/record. Retention follows Task Baseline Manifest or uses
a bounded 30-day fallback for compatible legacy tasks; expiry is read-only
`unknown`, never silent deletion.

Tool-result hook captures only after an exact configured verifier result has a
proof-capable post-event tree and is about to be appended to Task Contract. It
reuses the same immutable `workingTreeObservation` as task verification,
provenance and performance review. Persistence failure warns the operator but
does not change command outcome or fabricate evidence.

## 4. Matching and stale calculation

Sidecar matches Task Contract evidence by the complete tuple:

```text
commandDigest + observedAt + treeDigest + exitCode
```

No fuzzy or redacted command matching is allowed. For a matched passing attempt:

- identical whole-tree digest → `current` with empty invalidation list;
- different tree → union old/current path digests, compare carrier digests;
- exact safe path → include bounded display path;
- protected/unavailable/new path without an effective protection policy → keep
  opaque digest and set `filesKnown: false`;
- more than 300 visible paths → truncate explicitly and set files unknown;
- corrupt/expired/missing/unavailable current tree → `unknown`.

Resume state now exposes `invalidatedVerifierFiles` and
`invalidatedVerifierFilesKnown` alongside existing
`invalidatedVerifierCommands`. Legacy resume stays behavior-compatible except it
can explicitly say filenames are unknown.

## 5. Security and failure isolation

File names are attacker-controlled; display uses the same safe Git path
projection as source changes. A new current path is not exposed unless caller
provides the effective protected-path policy. Stored protected paths cannot be
recovered from the record.

Sidecar corruption does not invalidate a genuinely current Task Contract pass;
it only disables file-level explanation. It also does not affect Pi execution,
the terminal, Task Changes, diff, mutation provenance or journal replay. No
read-only UI action captures a verifier snapshot or creates a provider turn.

Rollback stops new sidecar capture and retains whole-tree staleness. Existing
files are not auto-deleted; projections return unknown for missing/unreadable
sidecars.

## 6. Acceptance evidence

WUI0-06 gate must prove:

- strict schema + runtime valid/invalid fixtures;
- owner-only immutable/idempotent digest records with no raw command/identity;
- exact current/stale calculation for modified, deleted and added files;
- protected/unknown/truncated/expired semantics never leak unsafe path names;
- exact attempt tuple matching; no cross-command/time/tree/result reuse;
- corrupt, unavailable and symlink cases fail closed;
- real guard verifier flow persists the sidecar bound to the Task Contract tree;
- resume reports exact files for current records and unknown files for legacy;
- package, integrity lock, type, architecture, docs, capabilities and full
  offline verification pass.
