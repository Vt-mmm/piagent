---
decision_id: WUI1-11
title: Independent WEBUI-1 ship gate
status: accepted
date: 2026-08-13
milestone: WEBUI-1
---

# WUI1-11 — Independent WEBUI-1 ship gate

## Decision

`WEBUI-1` is accepted for shipment with `P0=0` and `P1=0`.

The shipped surface is a local, read-only WebUI bound to the exact current Pi
session. Pi remains the sole session/runtime writer. The WebUI sidecar owns only
loopback HTTP/SSE and read-model transport; terminating it does not terminate or
replace the Pi runtime.

## Independently verified closures

1. The production launcher is reachable from both `/piagent-webui` and the
   `piagent-webui` package bin, binds the opaque current-session identity, and
   never starts a second Pi runtime. A real Pi 0.84.1 tool call completes after
   the sidecar receives `SIGTERM`.
2. Diff authority is the pair `{view, fileRef}`. A dirty-at-task-start file with
   a shared opaque ref returns Task-baseline content in Task Changes and HEAD
   content in Full Working Tree.
3. `resync-required` invalidates server projection/diff caches. The browser
   refreshes the canonical snapshot, reconnects from its new cursor, and then
   receives subsequent live events.
4. Executable Chromium coverage proves one-time bootstrap, owner cookie,
   three-tab navigation, exact-view diff, mobile containment, keyboard access,
   skip navigation and an axe accessibility scan.

## Evidence

- Independent focused launcher/diff/auth/SSE/isolation/zero-turn/package suites:
  `41/41`, no skip.
- Independent parity/control/security/accessibility suites: `36/36`.
- Chromium E2E: `2/2`.
- Full repository suite: `2158/2158`.
- Offline release verifier: `PASS: piagent-platform scaffold is complete`.
- Typecheck, architecture, docs, package distribution and dependency audit:
  pass; dependency audit reports zero vulnerabilities.
- Uncontended 10k/1k benchmark: cached snapshot p95 `0.01 ms`, exact source p95
  `739.14 ms`, small diff p95 `113.42 ms`, RSS `152.3 MiB`; all calibrated
  budgets pass.

The reviewer also observed one exact-source sample under external CPU contention
at `1429.55 ms`. The host simultaneously had unrelated processes consuming
approximately 103% and 44% CPU. The clean exact-tree run is the release evidence;
the contended sample is recorded as environmental noise, not discarded silently.

## Scope retained for WEBUI-2

Chat, lifecycle control, approval decisions, attachments and model/thinking
mutation remain capability-unavailable in WEBUI-1. WEBUI-2 may enable them only
through the same-process bridge and the durable control/approval contracts; the
read-only zero-turn path remains unchanged.

## Independent review identity

- Verdict: `accepted — P0=0, P1=0`
- Reviewed HEAD: `b0d29d4bc1784d721641800f4ceed260fc349ca1`
- Status inventory digest before/after review:
  `9c511a68984e74179cb92dc766dce36f999ef75a136e2ddf7ffe0953b3cee449`
- Reviewer performed no edits, staging or commit.
