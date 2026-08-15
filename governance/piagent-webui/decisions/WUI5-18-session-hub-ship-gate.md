---
decision_id: WUI5-18
title: Session Hub independent ship gate
status: accepted
date: 2026-08-15
language: en
---

# WUI5-18 Session Hub independent ship gate

## Decision

The local Session Hub is accepted for the `v1.4.0` source candidate. The WebUI
remains a local projection and control surface for Pi; it is not a remote
multi-user runtime or a second source of session truth.

The executable release boundary is
[`wui5-18-acceptance-matrix.v1.json`](../wui5-18-acceptance-matrix.v1.json).
Every matrix entry names a test file and test case so a prose claim cannot pass
without executable evidence.

## Accepted product boundary

- One local Gateway per profile can create, reopen, resume, rename, pin,
  archive, unarchive, and fork durable Pi sessions.
- A Gateway runtime or a terminal owns a session through the same durable lease.
  The browser never becomes a session writer.
- Read-only navigation, dashboard refresh, source inspection, transcript replay,
  and settings views create zero model turns.
- Chat, model/thinking changes, lifecycle controls, source mutations, and
  approvals are explicit typed commands with revision or digest preconditions.
- Task Changes, Working Tree, and Staged Changes are separate projections.
  Protected paths are rejected before content reads.
- The client supports English and Vietnamese, light and dark themes, keyboard
  operation, responsive desktop/mobile layouts, and MUI dialogs for decisions.

## Verification evidence

The candidate passed these release gates on macOS Apple Silicon with Node.js
`>=22.19.0` and Pi host `0.84.1`:

- 2,350 Node tests across 173 suites, with zero failures and zero skips.
- 11 real Chromium end-to-end scenarios, including Session Hub desktop/mobile,
  chat, approvals, queueing, pause/resume/stop, source review, and accessibility.
- Root and WebUI TypeScript checks.
- Architecture boundaries across 362 source files.
- Package distribution, integrity inventory, release identity, JSON/schema,
  documentation-language, third-party-neutrality, and Git whitespace gates.
- Production dependency audit with zero known vulnerabilities.

The final source verification command remains `npm run verify`; a release
operator must run it against the exact commit before creating a tag or publishing.
This decision does not itself authorize a commit, tag, push, publish, or provider
call.

## Recovery and failure behavior

- Browser and Gateway restarts rebuild projections from persisted truth.
- Dead Gateway and terminal owners are recoverable only after process-death
  evidence; ambiguous live ownership fails closed.
- Malformed, stale, duplicate, corrupt, or partially persisted commands cannot
  be replayed as successful effects.
- `piagent dashboard doctor` is read-only. `doctor --repair` is the explicit
  local repair path for invalid stopped descriptors and sockets.
- Optional operating-system service installation is deferred. It is not needed
  to launch, recover, or verify `v1.4.0`.

## Remaining non-goals

- Internet-facing access and multi-user collaboration.
- A browser-owned agent runtime or a second writer for terminal sessions.
- A full browser code editor, automatic staging, automatic commits, or pushes.
- Automatic destructive or external-provider approvals.
- A generic model or connector marketplace independent of Pi.
