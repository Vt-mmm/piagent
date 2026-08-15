---
plan_id: piagent-webui
decision_id: WUI5-04
title: Gateway lease, handoff and crash threat model
status: accepted
date: 2026-08-14
---

# WUI5-04 — Gateway lease, handoff and crash threat model

## Decision

WEBUI-5 extends the existing local WebUI threat model with a distinct Gateway
supervisor boundary, a terminal adapter boundary, per-session owner epochs and a
durable command-admission journal. It does not turn the Gateway into a second
writer for terminal-owned sessions.

The machine-readable security contract and human threat model now agree on:

- one Gateway per canonical local Pi profile;
- one Pi runtime writer per session owner epoch;
- nonce challenge and atomic CAS instead of PID-only owner liveness;
- fail-closed terminal release/acquire handoff;
- fsync-backed create/send/fork intent before Pi effects;
- no automatic replay after a dispatched-but-unsettled crash;
- explicit handling for Pi session paths whose JSONL is deferred until the
  first assistant message;
- bounded, redacted, opaque session catalog projection;
- zero provider calls for offline catalog navigation.

## Critical threats

The following are release blockers:

- duplicate Gateway or duplicate SDK runtime for one session;
- stale owner theft caused by PID reuse, heartbeat loss or stale browser state;
- terminal late writes or old-epoch reconnect after handoff;
- create/send/fork replay or false settled receipts after crash.

Catalog leakage and first-turn phantom sessions are high severity and also
release blocking.

## Recovery stance

Unknown owner liveness is not proof of death. Unknown command effect is not
permission to retry. Both states route to `recovery-required` or `uncertain`
with an explicit operator decision. This can make recovery less automatic, but
preserves the single-writer and no-duplicate-effect guarantees.

## Gate for implementation

WUI5-05 may implement process lifecycle and read-only health only. Runtime
mutation stays disabled until the relevant WUI5-08/WUI5-09 lease and admission
journal fault-injection cases pass. WUI5-10 terminal handoff cannot ship until
late-write and old-epoch reconnect races are proven fail closed.
