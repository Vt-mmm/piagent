---
plan_id: piagent-webui
work_item: WUI2-01
document: production-same-session-bridge
status: accepted
decision_date: 2026-08-13
host_version: 0.84.1
---

# WUI2-01 — Production same-session Pi bridge

## Decision

Piagent WebUI now has one production bridge object inside the Pi extension process
that owns the currently bound `ExtensionContext`. It does not create, attach or
fall back to another Pi runtime. Browser control remains disabled at this work
item; `WEBUI-1` stays independently shippable as a read-only product.

The bridge binds on `session_start`, refreshes from live event contexts, closes its
dispatch gate during session replacement, and discards the outgoing binding on
`session_shutdown`. A new session produces a new opaque session reference and
runtime revision. Raw session IDs and session paths never enter bridge snapshots,
events or receipts.

## Initial command surface

`WUI2-01` implements only the internal production path for
`chat.send + new-operation` while the exact session is idle. It deliberately does
not expose an HTTP mutation route or advertise `control.chat` yet.

The following remain unavailable until their own work items:

- follow-up queue and Interrupt & send (`WUI2-03`);
- model/thinking changes (`WUI2-04`);
- attachments (`WUI2-05`);
- approval resolution (`WUI2-06`);
- Stop/Pause/Resume (`WUI2-07`);
- browser control UX (`WUI2-08`).

## Authority and correlation

Every accepted command is a closed `control-command-v1` shape and binds:

- opaque project/runtime/session identity and current task identity when present;
- runtime, task, control and queue revisions;
- command ID, message request ID and one-time idempotency key;
- canonical content digest and exact action digest;
- a maximum five-minute request lifetime;
- an empty attachment list for this work item.

The bridge records `dispatch-requested` in the exact Pi session before calling
`ExtensionAPI.sendUserMessage()`. The custom entry is state-only and does not
participate in model context. It stores the idempotency-key digest, never the raw
key or message text.

`dispatch-observed` requires correlated Pi-native evidence: the pending command,
an extension-source input carrying the command's private in-process async context
and exact text, and either the exact new user session leaf or the Pi user
`message_start` event. The correlation token is never added to message text,
session state or model context. It survives awaited input handlers that run before
the WebUI extension without relying on handler registration order. An unrelated
input or operation cannot settle the command. Accepted operations get a stable
opaque operation reference.

## Idempotency and failure rules

- Same command/key/action returns the durable prior receipt with
  `deduplicated: true` and creates no second user message.
- Same command or key with a different payload is rejected.
- Reuse of an accepted message request ID is rejected as replay.
- A persisted requested receipt without proved settlement becomes
  `dispatch-unknown`; it is never resent automatically.
- A rehydrated terminal receipt must link to its requested custom-entry identity
  and, when observed, to the exact direct-child user entry and content digest.
  Corrupt, forged or unsupported audit evidence closes the bridge binding.
- If the session receipt store is unavailable before dispatch, the bridge rejects
  without calling Pi.
- If final settlement cannot be persisted after Pi dispatch, the result is
  uncertain and the requested receipt remains the replay barrier.
- Identity mismatch, stale revision, expiry, unknown fields and unsupported
  delivery fail closed.
- Bridge projection/observation failures are contained and never interrupt the Pi
  terminal or agent loop.

## Bounded observation

The bridge projects at most 256 metadata-only events. Events contain sequence,
time, opaque session/operation/command references and result code; no prompt,
message text, reasoning, tool payload, credentials or raw session identity.
Cursor gaps require resync.

## Verification

Focused evidence on the implementation tree:

- production bridge contract tests: exact identity, stale revision, closed input,
  unsupported delivery, durable dedupe, receipt-store failure and false
  correlation;
- real Pi `0.84.1` E2E: exactly one provider turn/user message in the current
  session and zero additional turns on replay, with an awaited input extension
  registered before the WebUI bridge;
- two-restart requested-only recovery and forged evidence/audit regressions;
- all produced terminal receipts validate against `control-command-v1`;
- prior bridge proof, control semantics, package distribution, TypeScript and
  architecture gates pass;
- no second-runtime production import path exists.

The public capability handshake remains `inspect-only` until transcript,
composer/queue, server mutation boundary and browser UX pass their later gates.

## Independent gate

Accepted on 2026-08-13 with `P0=0`, `P1=0`. The independent review reran the
focused bridge and pinned Pi `0.84.1` E2E (`15/15`), zero-turn/package/launcher,
TypeScript, architecture and diff gates. It also independently exercised awaited
handler ordering, prompt preservation, cross-producer/session evidence, corrupt
durable history, forged evidence/audit claims and requested-only recovery across
two restarts.
