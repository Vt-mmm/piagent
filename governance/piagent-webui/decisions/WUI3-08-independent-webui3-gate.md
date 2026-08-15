---
decision_id: WUI3-08
title: Independent WEBUI-3 ship gate
status: accepted
date: 2026-08-14
milestone: WEBUI-3
---

# WUI3-08 — Independent WEBUI-3 ship gate

## Decision

`WEBUI-3` is accepted with `P0=0` and `P1=0` on the reviewed working tree.

The release adds source review actions without turning Piagent into a code editor
or moving source authority into the browser. Pi remains the sole session writer,
the Pi guard remains the sole source/index mutation executor, and Git plus the
Task baseline and durable evidence remain the source of truth.

## Exit-gate result

1. Reviewed/unreviewed evidence binds the exact task, source view, file, patch,
   workspace and index preimage. A changed preimage becomes stale rather than
   inheriting the prior acknowledgement.
2. File and hunk Stage/Unstage accept only opaque refs, rederive the exact patch
   inside the runtime, preserve working-tree bytes and unrelated index entries,
   and reject stale, protected, conflicting or raced targets before mutation.
3. Revert requires a bounded exact preview and explicit confirmation, accepts
   only runtime-provenance worktree content, preserves the index and reports an
   unprovable postcondition as uncertain.
4. Open in VS Code resolves a safe opaque current-file target and uses only a
   verified VS Code CLI with fixed argv and `shell:false`; there is no generic
   editor or path/URI authority from the browser.
5. Deterministic commit summaries use only bounded staged metadata and zero
   model turns. The model rewrite path is visibly separate, warns about token
   usage and sends one ordinary message to the current Pi session. Neither path
   commits or pushes.
6. Every Stage, Unstage and Revert receipt resolves to matching owner-only
   requested/terminal audit evidence. Stage/Unstage stale index-bound review but
   preserve verifier content currency; Revert makes review non-current and
   reports exact verifier-stale files when a file snapshot exists.
7. The client refreshes the canonical snapshot after a settled mutation, with
   no automatic verifier run and no hidden model work.

## Verification evidence

- Focused WEBUI-3 authority, mutation, read-route, security and zero-turn tests:
  `53/53` passed.
- Real Chromium journeys: `8/8` passed, including exact review, file and hunk
  Stage/Unstage, confirmed Revert, VS Code handoff, deterministic/model summary,
  approval, lifecycle and current-session Chat.
- Root and WebUI TypeScript, all `16` browser contracts and the production Vite
  build passed.
- Architecture boundaries: `310` source files passed; capability catalog,
  package security audit and patch whitespace checks passed.
- The full offline repository verifier finished with
  `PASS: piagent-platform scaffold is complete`.
- Source audit found no production convenience path for Git checkout, reset,
  commit or push, and no browser HTML injection sink.

## Security and model-work result

The WEBUI-3 boundary is covered by `C-REVIEW-CAS`, `C-INDEX-TRANSACTION`,
`C-WORKTREE-REVERT`, `C-EDITOR-HANDOFF`, `C-COMMIT-SUMMARY-EXPLICIT` and
`C-MUTATION-AUDIT-INVALIDATION`. Browser intents carry opaque refs and exact
revisions only; protected paths and incomplete evidence remain fail closed.

Review, Stage, Unstage, Revert preview/execution, editor handoff and deterministic
summary are zero-model-turn actions. Only the separately confirmed model summary
creates an explicit current-session Pi operation.

## Rollback and retained limits

Disabling `reviewActions` removes all WEBUI-3 authority while retaining the
accepted WEBUI-2 Chat/Control product, WEBUI-1 read-only inspection and terminal
fallback. No action auto-stages, auto-commits, auto-pushes or opens arbitrary
paths. Verifiers captured without a per-file snapshot may report a stale tree
with invalidating files unknown; Piagent does not infer them.
