---
plan_id: piagent-webui
decision_id: WUI5-02
title: Gateway wire, session catalog and authority contract
status: accepted
date: 2026-08-14
---

# WUI5-02 — Gateway wire, session catalog and authority contract

## Decision

Piagent Session Hub uses four versioned, schema-first contracts:

- `session-catalog-v1` is the bounded durable conversation index and session
  detail projection;
- `session-command-v1` is the only browser-facing session mutation language;
- `gateway-capabilities-v1` negotiates protocol and action availability;
- `gateway-protocol-v1` provides typed connect, request, response and event
  envelopes.

The Gateway validates every inbound command before authority checks or runtime
effects. Generated TypeScript declarations are conveniences for consumers; the
JSON Schemas remain the wire authority.

## Session identity and ownership

- Browser-visible session, project, runtime, Gateway, operation and evidence
  identifiers are opaque references.
- Raw session IDs, session files and arbitrary filesystem paths are not wire
  fields.
- Each catalog row states `gateway`, `terminal` or `none` ownership plus an
  owner epoch and continuity verdict.
- `offline`, `archived`, `gateway-owned` and `terminal-owned` states are bound
  to compatible liveness, composer and owner projections.
- Recovery and handoff ambiguity disables the composer and includes an exact
  reason code.

## Command authority

- Mutations bind to expected catalog and session revisions.
- Send commands bind follow-up and steer delivery to an exact active operation.
- Every command carries an idempotency key, request time and expiry.
- Settled receipts require evidence; rejected receipts cannot claim evidence;
  uncertain receipts can only report `effect-unknown`.
- Create commands use registered project/place references and cannot carry raw
  project paths.
- Unknown actions and unknown authority fields fail closed.

## Transport and compatibility

- Protocol v1 supports health, list, detail and command requests plus bounded
  catalog, session, runtime, message and tool events.
- Request method and response result shapes are discriminated and cannot be
  mixed.
- Event kind and payload shapes are discriminated and bounded.
- Sequence or catalog gaps require an explicit resync event.
- Incompatible or resync-required capability handshakes disable all session
  runtime mutations.

## Bounds

- Catalog pages contain at most 200 rows.
- Session previews contain at most 280 characters.
- User messages contain at most 32 KiB of text.
- Streaming deltas contain at most 16 KiB per event.
- Every collection and display string has a schema bound; decoded transport
  byte limits remain a server responsibility in WUI5-07.

## Verification

- strict Ajv draft 2020-12 compilation for the complete local catalog;
- valid and invalid golden fixtures for all four public documents;
- adversarial ownership, archive, operation, response and event mismatch tests;
- deterministic generated browser contracts;
- private WebUI package typecheck, production build and package inventory tests.

## Follow-up

WUI5-03 must prove that these contracts can be populated from real Pi `0.84.1`
SDK sessions across create, persisted resume and fork. WUI5-04 must threat-model
stale owners, PID reuse, terminal death, restart ambiguity and transport replay
before the Gateway accepts production mutation traffic.
