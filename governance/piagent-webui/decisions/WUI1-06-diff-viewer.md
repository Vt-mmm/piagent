---
plan_id: piagent-webui
work_item: WUI1-06
status: accepted
decision: bounded-diff-viewer
date: 2026-08-13
---

# WUI1-06 bounded diff viewer

## Decision

Selecting a file loads its revision-bound `diff-v1` projection by opaque ref.
The viewer provides inline and two-column modes, green added lines, red deleted
lines, old/new line numbers, hunk headers, collapsed unchanged-region markers,
exact `+/-` counts and related criterion/verifier counts.

Binary, symlink, submodule, protected, oversized, conflict, stale and
unavailable responses stay explicit fallback cards. The browser never computes
a replacement diff, resolves a repository path, or renders server text as HTML.

## Acceptance evidence

- Fixture tests cover added/deleted line kinds, evidence links, fallback and
  unchanged-region surfaces.
- Client source requires accessible view/mode controls and encoded opaque refs.
- Generated contract drift, strict typecheck, production build and architecture
  checks pass.
