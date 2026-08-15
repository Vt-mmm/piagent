---
decision_id: WUI5-06
status: accepted
date: 2026-08-14
scope: bounded durable session catalog and metadata overlay
---

# WUI5-06 — Bounded session catalog and metadata overlay

## Decision

The Gateway projects Pi `SessionManager.listAll()` into opaque browser rows and
merges a separate owner-only metadata overlay. Pi JSONL remains canonical for
the conversation; the overlay may only add presentation metadata such as pin,
archive, unread and project group.

The catalog:

- returns at most 200 rows per page;
- redacts title, deterministic preview and project label;
- never sends raw session IDs, JSONL paths or project paths;
- uses HMAC references and revisions under a persistent profile key;
- sorts pinned rows first and otherwise preserves most-recent ordering;
- includes overlay revision in catalog and row CAS revisions;
- creates zero provider/model calls.

The overlay is an append-only JSONL chain under the Gateway owner-only state
root. Every record is size-bounded, sequence-bound and chained to the previous
session metadata revision. Writes use no-follow open, owner-only permissions and
fsync. Stale revision updates reject.

Any malformed, oversized, symlinked, discontinuous or partially written
overlay makes the whole overlay unavailable. The Gateway then projects the
canonical Pi sessions without metadata and marks the rows with
`metadata-overlay-unavailable`; it never changes or hides transcript truth to
make metadata appear valid.

The MUI shell exposes pinned/recent/archived navigation and searches title,
project label and bounded preview. Metadata mutation buttons remain unavailable
until the WUI5-10 command authority is implemented.
