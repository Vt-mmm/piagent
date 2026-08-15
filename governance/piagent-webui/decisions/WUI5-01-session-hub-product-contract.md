---
plan_id: piagent-webui
decision_id: WUI5-01
title: Gateway-owned Session Hub product contract
status: accepted
date: 2026-08-14
---

# WUI5-01 — Gateway-owned Session Hub product contract

## Decision

Piagent WebUI's primary product mode is now a local Session Hub. A long-lived
Piagent Gateway owns session admission and Gateway-created Pi runtimes. The
existing same-process bridge remains a compatibility adapter for sessions whose
sole writer is a live Pi terminal.

This decision supersedes only the old product assumption that WebUI requires one
already-running active Pi session. It does not weaken any single-writer,
authority, redaction, zero-turn, Git, Task Contract or confirmation invariant.

## Normative outcomes

- `piagent dashboard` can open without a Pi terminal.
- Existing durable Pi sessions appear in a bounded local catalog.
- WebUI can create, resume and fork sessions through Pi's public SDK.
- A session has one exact owner epoch and never two writers.
- Browser close never stops Gateway-owned work.
- Gateway restart restores catalog and settled transcript truth.
- In-flight work without a terminal receipt is `uncertain`, never replayed.
- Terminal-owned sessions are proxied, not reopened by the Gateway.
- A terminal session can become Gateway-owned only after exact release or safe
  stale-owner reconciliation.
- Conversation-first navigation becomes the primary shell; existing
  task/source/activity/verifier views become a contextual inspector.

## Rejected alternatives

### Keep one sidecar per terminal session

Rejected because it cannot start sessions from WebUI, cannot maintain a global
catalog and disappears when the owning terminal exits.

### Spawn `pi --session` for each browser request

Rejected because retries and concurrent tabs can create multiple writers and
because child process stdout/RPC is not a durable ownership contract.

### Let the browser own session selection and runtime state

Rejected because refresh, local storage corruption or XSS could fabricate
authority. Browser state remains presentation-only.

### Reuse one mutable AgentSessionRuntime for every conversation

Rejected because switching one browser's session would tear down another live
session. Gateway supervises independently leased runtimes per live session.

### Pixel-copy another product

Rejected. Piagent adopts familiar information architecture and interaction
patterns using its own identity, docs palette, accessibility and task inspector.

## Follow-up requirements

- WUI5-02 must version the Gateway protocol and session catalog schemas.
- WUI5-03 must prove real SDK create/resume/fork with the same extension guard.
- WUI5-04 must add stale lease, PID reuse, terminal death and crash ambiguity to
  the security threat model before mutation endpoints ship.
- No WUI5 mutation can ship while terminal/Gateway ownership arbitration is
  mocked or browser-enforced.

## Evidence

- Established local control-plane patterns use a single long-lived Gateway with
  typed clients and Gateway-owned sessions.
- Pi `0.84.1` exposes `SessionManager.listAll/create/open`,
  `createAgentSessionRuntime`, runtime replacement APIs and full event streaming.
- Current Piagent launcher explicitly only opens a WebUI already owned by a
  running Pi process, proving the product gap this decision closes.
