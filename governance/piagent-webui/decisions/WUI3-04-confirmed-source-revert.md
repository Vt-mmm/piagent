---
decision_id: WUI3-04
title: Confirmed exact source revert
status: accepted
date: 2026-08-14
owners:
  - codex:/root
---

# WUI3-04 — Confirmed exact source revert

## Decision

`source.revert` is an explicitly destructive, guard-owned Working Tree action.
It discards only the exact unstaged file or hunk delta between the current Git
index and current worktree. It never resets the index, HEAD, Task baseline or
another file; existing staged changes remain byte-for-byte unchanged.

“Reject” is presentation language for declining the currently reviewed change.
It does not silently mutate source or invent a provenance decision. The only
content-changing action is the separately named `Revert file` / `Revert hunk`
confirmation flow.

Initial eligibility is deliberately narrow:

- one ordinary safe path, exact complete unredacted text, status `M`, no rename,
  conflict, binary, symlink or submodule;
- exact current mutation provenance attributable to the runtime, without mixed
  or post-baseline-unattributed content;
- the index entry and selected worktree carrier are both exact and bounded;
- whole-file revert or one exact advertised hunk per confirmation. Multi-hunk
  batch revert remains unavailable until its review UX is separately proven.

## Preview and confirmation authority

Opening a revert preview is read-only and consumes zero model turns. The runtime
rebuilds the exact index-to-working-tree delta and issues an expiring preview
containing bounded text lines, opaque refs, safe counts, effect wording and exact
revision/preimage digests. This preview remains exact even when the broader Full
Working Tree diff also contains staged content. Raw Git patch syntax/bytes remain
runtime-only and no preview lines enter durable evidence.

The browser cannot manufacture a confirmation digest because the commitment is
HMAC-bound with a per-Pi-runtime secret that is never projected. It sends the exact
server-issued `fileRef`, ordered `hunkRefs`, `previewRef`,
`confirmedPreviewDigest` and `contentDigest` through the closed reserved
`source.revert` payload. The action digest also binds runtime/session/task,
control/workspace/index/view/file authority and that confirmation material.

Any refresh, source/index/task/control transition, expiry, replay, foreign ref,
changed selection or confirmation mismatch rejects before mutation. A preview
is one-command authority: a terminal settled/rejected/uncertain receipt is
durable and the same command cannot execute twice.

## Guarded worktree transaction

The existing exact-session Pi source-mutation guard is the sole executor. Under
an owned operation lock it:

1. rechecks active/idle task, exact session/control authority, protected paths,
   provenance and current preview/preimages;
2. reconstructs the exact current index-to-worktree patch internally;
3. for a hunk, applies only the exact reverse hunk with fixed no-shell Git argv;
   for a file, materializes the exact current index blob into a private sibling
   temporary file and atomically replaces the regular worktree file;
4. disables clean/smudge filters, hooks, pager, external diff/textconv and
   submodule recursion; bounds bytes, output and time;
5. rechecks immediately before commit and verifies after-state, unchanged index
   and untouched non-selected hunks;
6. records bounded requested/terminal evidence without patch or source text.

A race or failure before commit leaves the original file unchanged. If the
replace/apply may have committed but the exact postcondition cannot be proven,
the result is `uncertain`; it is never reported as reverted. Non-cooperating
same-account writers remain outside OS isolation, so postcondition drift is
surfaced rather than overwritten again.

## UX

`Revert file` and eligible `Revert hunk` first open a modal that states exactly:

- unstaged content will be discarded;
- staged content and other hunks/files will remain;
- the action cannot be recovered by Piagent unless Git or another backup holds
  the content;
- the exact file/hunk count and preview expiry.

The destructive button is visually distinct and names the effect. Closing or
pressing Cancel has no side effect. The button is disabled while pending. Stale
or rejected receipts keep the diff visible and require a fresh preview; an
uncertain receipt directs the operator to inspect all three source tabs.

## Acceptance conditions

1. File revert restores exactly the current index image while preserving staged
   content, unrelated worktree/index entries and executable mode.
2. Hunk revert removes only that unstaged hunk; other unstaged/staged hunks stay.
3. No command can execute without a current server-issued preview and explicit
   digest-bound confirmation.
4. Stale, expired, replayed, duplicate, reordered, foreign or cross-file refs
   cannot mutate.
5. Mixed/unattributed provenance, conflict, rename, add/delete/untracked,
   protected, incomplete, redacted or non-text content fails closed.
6. Clean filters, hooks, pager, external diff/textconv and shell do not run.
7. Before/after evidence is durable, bounded and contains no patch/source text.
8. Preview, Cancel and confirmed revert consume zero model turns; there is no
   auto-revert, broad checkout/reset, commit or push.

## Gate evidence

Accepted on 2026-08-14.

- Whole-file revert restores the exact current index blob and executable mode,
  while preserving staged content and leaving the index preimage unchanged.
- One-hunk revert removes only the selected unstaged hunk; the other unstaged
  hunk and all index bytes remain unchanged.
- Confirmation uses a per-runtime HMAC that is stable across exact
  revalidation but changes with runtime authority. Browser payloads bind the
  preview/file/hunk/content and task/control/workspace/index preimages.
- Exact `index-to-working-tree` preview lines remain distinct from Full Working
  Tree content when staged changes coexist. Protected, redacted, mixed,
  control-character and stale previews fail closed.
- Pi guard is the sole executor. Owned path locking, final preimage checks,
  fixed no-shell Git argv, disabled filters/hooks/pager/external diff and
  postconditions prevent a settled claim on ambiguous effects.
- Requested/terminal receipts use a namespace separate from provenance records,
  are owner-only and contain no source or patch text. Retry is deduplicated.
- The production Chromium flow opens the destructive modal, renders exact
  lines, confirms once, receives `reverted`, and verifies worktree/index bytes.
  The complete Chromium suite passes 8/8 with accessibility coverage.
- Root/WebUI TypeScript, strict schemas, generated-contract drift, production
  build, package/security tests, architecture, zero-turn conformance and the
  repository-wide `verify-local` gate pass.
