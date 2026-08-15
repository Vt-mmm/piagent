---
plan_id: piagent-webui
work_item: WUI0-07
document: criteria-links-inspector-v2-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-07 — Criteria links, canonical snapshot and Inspector v2

## 1. Decision

`buildWebUiInspectionProjection()` is the single read-only assembler for the
canonical WebUI snapshot, linked Task/Working Tree/Staged source documents and
verifier attempts. Activity Inspector v2 is a compatibility formatter over that
assembler; it no longer maintains a second Git/task-delta calculation.

The projector is local and deterministic for one supplied fact bundle. It does
not append a Pi message, consume continuation budget, change tool schemas or
call a model/provider.

## 2. Criterion truth and relations

Criterion state comes only from the Task Contract Acceptance Receipt:

- runtime receipt → `observed` evidence;
- model receipt → `derived` evidence;
- missing receipt → `unknown`/`unavailable`, never inferred;
- target hints, changed files or a passing verifier never change criterion
  state.

Allowed relation sources are closed to:

- `target-hint`: versioned Criterion Graph hint matched by the shared path
  matcher;
- `explicit-evidence`: receipt-declared path or verifier command;
- `verifier-declaration`: Criterion Graph explicitly requires an exact
  verifier and the command belongs to the Task Contract verify plan.

Relations populate `criterionIds` and `verifierAttemptIds` on every matching
canonical source file. UI text must say “related”, not “proved” or “satisfied”.

## 3. Verifier projection

Verifier attempts join Task Contract evidence to WUI0-06 sidecars by exact
command digest, observed timestamp, tree digest and exit code. Current state
requires an observed configured verifier against the current whole-tree digest.
When several commands are configured, `current` requires a current exact pass
for every command; one pass cannot stand in for the rest.

Stale attempts use the sidecar path map to expose bounded safe paths and file
refs. Missing/legacy/corrupt sidecars preserve whole-tree staleness but report
unknown stale files. A relation to a verifier is informational and does not
satisfy a criterion.

## 4. Canonical snapshot boundary

The assembler emits `snapshot-v1` and returns the linked full source documents
beside it. It projects:

- task identity, receipt criteria, work plan and truthful progress;
- summaries for Task, Working Tree and Staged views;
- bounded activity/command state from observed telemetry;
- exact verifier/current/stale state and stale paths;
- context/session usage only where the host reports it;
- continuation budget and persisted handoff where authoritative state exists;
- explicit unavailable state for approval, model, thinking, permission and
  queue facts that the current ExtensionContext cannot prove.

Inspect-only capability handshake advertises zero retained events and fresh
snapshot resync. Durable cursor/replay behavior remains WUI0-08; control remains
unavailable until the same-process bridge and control gates pass.

## 5. Inspector compatibility

`/piagent-inspector` keeps its summary/files/commands/security/context views and
terminal panel. Its JSON contains the same canonical snapshot used by WebUI.
File output now includes canonical A/M/D/R/U/C status, exact task-baseline line
stats, criterion IDs, verifier attempt IDs and provenance. Legacy digest-only
tasks show task source unavailable instead of reconstructing a mixed HEAD diff.

The projector is asynchronous because safe Git collection is bounded and
process-isolated. UI refresh is fail-soft: projection failure shows state
unavailable and cannot interrupt Pi execution.

## 6. Security and performance

- Git and baseline reads reuse WUI0-03/WUI0-04 safe collectors.
- Effective protected-path policy is passed into source and verifier
  projections.
- Display strings are redacted, control characters removed and wire lengths
  bounded.
- Raw filesystem roots and session identifiers are converted to opaque refs.
- Activity/log previews are bounded; no raw captured log is embedded.
- Source calculation is cached per session by the Inspector and never polls in
  the model/runtime loop.
- Missing facts stay unavailable; no placeholder becomes completion authority.

## 7. Acceptance evidence

WUI0-07 gate must prove:

- criterion state is receipt-derived and relation alone leaves pending state;
- exact target-hint, explicit evidence and verifier-declaration links;
- every configured verifier is required before projecting `current`;
- exact stale file paths/refs and unknown legacy/corrupt behavior;
- canonical snapshot validates against strict `snapshot-v1`;
- Inspector JSON snapshot deep-equals the direct projector result for the same
  fact bundle;
- legacy Inspector source calculations are removed from the active path;
- package, integrity lock, type, architecture, docs, capability and full offline
  verification gates pass.
