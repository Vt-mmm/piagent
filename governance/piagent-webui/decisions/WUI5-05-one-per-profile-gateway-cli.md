---
decision_id: WUI5-05
status: accepted
date: 2026-08-14
scope: one-per-profile Gateway process, dashboard CLI, read-only catalog shell
---

# WUI5-05 — One-per-profile Gateway and dashboard CLI

## Decision

Piagent ships one local Gateway per canonical Pi agent profile. The supported
entrypoint is `piagent dashboard`; `piagent-dashboard` is an equivalent direct
binary. Both route through the package-root dispatcher.

The Gateway:

- binds WebUI HTTP only to an ephemeral `127.0.0.1` port;
- uses a short owner-only Unix socket because macOS limits socket path length;
- rejects a second process after a live health challenge;
- removes a stale socket only after failed challenge plus inode recheck;
- writes an owner-only, atomically replaced descriptor;
- creates a persistent owner-only HMAC key for opaque catalog references;
- mints a fresh Gateway instance identity and one-time browser bootstrap after
  every restart;
- serves a bounded, redacted, zero-model-turn Pi session catalog;
- exposes no raw session ID, session path, project path or credential literal.

The first UI slice is intentionally read-only. It proves the conversation-first MUI
sidebar, search, selection, VI/EN, light/dark and responsive shell without
opening a Pi runtime. New chat and Continue remain disabled until WUI5-08 owner
leases and admission recovery are accepted.

## CLI behavior

```text
piagent dashboard
piagent dashboard status
piagent dashboard stop
piagent dashboard restart
piagent dashboard doctor
```

`piagent dashboard` reuses a live Gateway or starts a detached process, waits
for health, obtains a new one-time launch URL and opens the browser. Viewing or
reopening the dashboard never sends a model request.

## Evidence

- real pinned Pi `0.84.1` `SessionManager.listAll()` catalog;
- duplicate-process rejection and restart authority test;
- schema-valid capability and catalog responses;
- package-tarball and global-bin help coverage;
- real Chromium desktop/mobile, VI/EN, light/dark and axe coverage;
- TypeScript, production build and architecture checks.

## Deferred authority

This decision does not authorize session create/open/resume, transcript writes,
model/thinking changes, terminal handoff, pin/archive mutation or WebSocket
control. Those remain fail-closed behind unavailable capabilities.
