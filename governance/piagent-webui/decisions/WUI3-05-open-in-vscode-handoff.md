---
decision_id: WUI3-05
title: Opaque Open in VS Code handoff
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-05 — Opaque Open in VS Code handoff

## Decision

`source.open-in-vscode` is an explicit local handoff from one currently selected
Piagent source record to the operator's installed Visual Studio Code. It is not
an embedded editor, source mutation, remote URI launcher or generic application
executor. Cursor and other editors are not implicit fallbacks.

The browser sends only a server-issued `fileRef` and bounded nullable line/
column. It never sends a filesystem path, URI, CLI name, executable path,
workspace arguments or environment. Pi runtime re-resolves that opaque ref from
the current canonical Working Tree projection and requires one ordinary,
existing, unprotected, exact-safe regular file below the current project and Git
root. Rename, deletion, conflict, symlink, submodule, protected, ambiguous or
stale targets fail closed.

## CLI authority

Runtime discovery accepts only a local executable named `code` from bounded
platform candidates: fixed official macOS application paths or executable
entries in the runtime PATH after realpath and regular-file validation. It does
not use a shell, `which`, browser input, repository config or an arbitrary
environment override. Discovery exposes only available/unavailable capability;
the executable path never enters a browser response.

Execution uses fixed argv equivalent to `code --reuse-window --goto
<absolute-file[:line[:column]]>`, `shell:false`, a minimal environment, bounded
stderr and a short launcher timeout. A zero exit means the local editor accepted
the handoff, not that the file was edited or saved.

## Identity, idempotency and evidence

The command binds runtime/session/task identity plus current task/workspace
revisions. A fresh server-side resolution must match before spawn. The user click
is the explicit launch intent; opening the button does not require a destructive
confirmation because no project bytes are changed by Piagent.

Before spawn, runtime writes an owner-only bounded requested record containing
only opaque refs/digests and nullable line/column. Settled/rejected/uncertain
terminal evidence contains no path or CLI output. A retry of a settled command
returns its receipt without opening another window. A crash after requested but
before terminal evidence becomes `effect-unknown` and is never retried
automatically.

## UX

An `Mở trong VS Code` button appears only when the capability is available for
the selected current file. Success states only that VS Code accepted the open
request. Failure keeps the diff visible and reports unavailable/stale without
trying another editor. The handoff consumes zero model turns, user messages or
continuation budget.

## Acceptance conditions

1. One opaque current file opens through fixed no-shell VS Code argv.
2. Browser path/URI/executable injection is structurally impossible.
3. Protected, symlink, deleted, conflict, ambiguous and stale refs do not spawn.
4. Missing/non-executable/failed CLI disables or rejects without fallback.
5. Retry is durable and never opens the same command twice.
6. Evidence contains no path, source, CLI output or secret environment value.
7. Handoff is zero-turn and cannot mutate source, index, task or prompt.
8. Chromium proves the visible action and truthful success/failure state.

## Gate evidence

- Opaque-target tests prove exact current ordinary-file resolution and deny
  protected, symlink, deleted, traversal and stale targets before spawn.
- Process tests prove one verified `code` executable receives fixed
  `--reuse-window --goto` argv under `shell:false`; missing CLI has no Cursor or
  generic-editor fallback.
- Controller tests prove schema-valid CAS, owner-only path-free evidence,
  durable deduplication, crash-to-uncertain semantics and zero model turns.
- Authenticated loopback routing, WebUI/root TypeScript, generated contracts,
  architecture (308 files), security/package suites and `git diff --check`
  passed.
- Real Chromium passed 8/8 including the visible handoff action, truthful
  accepted status, responsive layout and accessibility checks.
- `scripts/verify-local.sh` completed with `PASS: piagent-platform scaffold is
  complete` on the final WUI3-05 tree.
