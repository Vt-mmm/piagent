---
plan_id: piagent-webui
decision_id: WUI5-03
title: Real Pi SDK persisted session runtime proof
status: accepted
date: 2026-08-14
---

# WUI5-03 — Real Pi SDK persisted session runtime proof

## Decision

Piagent Gateway will build its session supervisor on Pi `0.84.1` public SDK
surfaces rather than spawning a second terminal runtime or inventing a separate
agent engine.

The accepted composition is:

1. create cwd-bound services with `createAgentSessionServices`;
2. create sessions with `createAgentSessionFromServices`;
3. supervise each live session with `createAgentSessionRuntime`;
4. discover durable sessions with `SessionManager.list`/`listAll`;
5. restore with `SessionManager.open` and fork with `AgentSessionRuntime.fork`;
6. bind the same Piagent Guard extension stack after every runtime replacement.

## Executed proof

The integration proof uses the operator-installed, version-pinned Pi host. It:

- creates a real persisted `SessionManager` in an isolated session directory;
- creates services and a runtime through the public SDK;
- loads the production Piagent Guard plus a session-lifecycle proof extension;
- appends a user/assistant exchange and operator title;
- disposes the runtime to simulate Gateway shutdown;
- lists and reopens the same JSONL session from a fresh runtime;
- proves the original message, title and resume lifecycle entry remain exact;
- forks at a durable entry and proves a distinct child session, parent linkage,
  inherited history and the same extension stack;
- verifies both parent and fork are discoverable in the catalog.

No provider/model call is made by the proof.

## Persistence finding

Pi allocates a session path immediately but intentionally defers creating the
JSONL file until an assistant message exists. Therefore:

- a Gateway must not claim durable admission merely because `sessionFile` is
  non-null;
- accepted create/send commands require a Gateway-owned, fsync-backed intent
  and receipt journal before the Pi turn starts;
- a crash before the first assistant message restores the command as pending or
  uncertain from the journal, never as an invented settled session;
- forks taken before an assistant-bearing boundary can also have an allocated
  path that is not yet a durable file and need the same treatment.

The Pi JSONL remains authoritative for settled conversation history; the
Gateway journal is authoritative only for command admission, idempotency and
crash ambiguity.

## Replacement-safety remediation

The proof exposed a stale-context race in the Piagent Guard session-start hook:
the Inspector refresh promise was launched without being awaited, so session
replacement could invalidate its extension context while refresh was still
running. `afterStart` is now awaitable and the Guard waits for Inspector refresh
before `session_start` settles.

This is required for Gateway create/resume/fork and also improves terminal
replacement correctness.

## Follow-up

WUI5-04 must threat-model Gateway leases, the admission journal, missing
assistant-first files, stale terminal owners, PID reuse and crash ambiguity.
WUI5-05 may start the daemon only after those controls and negative cases are
frozen.
