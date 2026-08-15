---
plan_id: piagent-webui
work_item: WUI0-10
document: zero-model-turn-conformance-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-10 — Zero-model-turn conformance

## 1. Decision

`zero-turn-conformance.ts` is the transport-neutral before/action/after harness
for every WebUI route or control advertised as zero-model-turn. It consumes
exact opaque observations supplied by a host/server adapter; it does not read a
raw prompt or session file and does not add runtime instrumentation that can
itself dispatch model work.

Unknown measurement or attribution is a failure for a claimed zero-turn path.
The harness is internal conformance evidence, not a browser wire contract.

## 2. Captured facts

Each observation includes exact cumulative counts for provider requests,
user/assistant messages, token/cache/cost usage, continuation consumption and
turn triggers; exact session/leaf/message-set identity; and digests for Task
Contract, journal head, prompt and provider-visible tool schema.

Provider-visible tool schema digest uses only sorted name, description and
parameter schema. UI layout, filters, selection, internal source metadata and
other presentation state never enter the digest or provider input.

## 3. Quiescent and concurrent rules

A quiescent read requires every monitored global counter and authoritative
digest to remain unchanged. Snapshot, source, diff, replay, status-like and
Inspector paths are exercised in this mode.

A concurrent read may observe an already-running operation settle. Every global
delta must be exactly reconciled by monotonic causal events attributed to an
unrelated operation. UI-command attribution, command correlation, unknown
attribution or an unreconciled delta fails. Concurrent unrelated transcript
settlement may move leaf/message identity, but session, prompt, tool schema,
Task Contract and journal constraints remain enforced.

## 4. View and control mutation classes

View actions cannot allow Task Contract or journal mutation. The harness
supports an explicit digest allowlist for future control-zero-turn tests, but a
view that supplies an allowlist fails by construction. WUI2 must add the exact
Stop/Pause/Resume/model-thinking action-specific mutation assertions before
advertising those controls.

Send chat, Resume & continue and model-backed commit summary are never passed to
this zero-turn harness as view/control-zero-turn actions; their UI must disclose
model work.

## 5. Acceptance evidence

WUI0-10 requires:

- real canonical snapshot, Source Changes, selected-file diff, event replay and
  Inspector equality paths pass quiescent observation;
- unrelated concurrent settlement passes only with exact causal reconciliation;
- UI-attributed, unknown and unreconciled provider work fails;
- transcript, continuation, turn trigger, prompt, provider tool schema, Task
  Contract and journal mutations fail on views;
- unknown observations and action failure fail closed;
- tool-schema digest is canonical and ignores non-provider metadata;
- type, architecture, package, capability and full offline verification pass.

WUI1 must run the same harness around actual HTTP handlers with its real provider
counter/causal adapter. WUI0 acceptance proves the contract and current read
projection paths, not a server that has not yet been built.
