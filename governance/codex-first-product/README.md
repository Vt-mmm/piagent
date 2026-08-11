---
plan_id: codex-first-product
document: durable-control-plane
status: active
canonical_tracker: STATUS.md
raw_evidence_root: plans/codex-first-product/evidence
---

# Piagent full-source productionization control plane

This directory is the version-control-eligible, cross-clone control plane for
the Piagent 1.3 full-source productionization program. It contains bounded
planning and evidence metadata only. It must never contain provider transcripts,
retained workspaces, nested Git repositories, runtime state, credentials,
sessions, caches, or raw private evidence.

## Required read order

1. Repository `AGENTS.md`.
2. Repository `README.md`.
3. [`STATUS.md`](STATUS.md).
4. [`00-execution-protocol.md`](00-execution-protocol.md).
5. [`15-full-source-productionization-roadmap.md`](15-full-source-productionization-roadmap.md).
6. [`prompts/10-full-source-productionization-prompts.md`](prompts/10-full-source-productionization-prompts.md).
7. The selected work-item sources and tests.

`STATUS.md` is the only mutable program tracker. The roadmap and protocol define
intent and gates; they do not prove completion. One implementation session owns
exactly one work item.

## Storage boundary

| Data class | Canonical location | Git/package rule |
|---|---|---|
| Roadmap, protocol, active prompt and tracker | This directory | Git-visible; excluded from both root and core package allowlists because `governance/` is not shipped |
| Bounded redacted manifests and gate summaries | `evidence/` below this directory | Git-visible after review; no raw prompts, source, credentials or workspaces |
| Historical/provider diagnostic evidence | Local `plans/codex-first-product/evidence/` or a future private archive | Immutable, Git-excluded, package-excluded, never promoted to exact-candidate release evidence |
| Provider credentials, sessions, caches and local Pi state | Existing secret/local-state roots | Never copied here, committed, or packaged |

The broad local `plans/` exclusion remains intentional because that tree contains
retained diagnostic workspaces and local state. Do not remove it to make this
control plane durable.

## Evidence readback

- [`evidence/fs0/current-tree-inventory.v1.json`](evidence/fs0/current-tree-inventory.v1.json)
  binds the FS0 source inventory.
- [`evidence/fs0/historical-evidence-map.v1.json`](evidence/fs0/historical-evidence-map.v1.json)
  references every local raw evidence root exactly once and records its tree
  digest, claim tier, privacy boundary and fresh-clone availability.
- A fresh clone is expected to have this bounded control plane and no raw
  diagnostic workspaces. Historical roots that are absent remain unavailable;
  they must not be recreated or treated as release proof.
- Same-workspace forensic reads must verify the recorded tree digest first and
  remain read-only.

## Update and rollback rules

- Future sessions update this tracker, not the ignored local mirror.
- Future evidence adds a bounded redacted artifact and its digest; existing
  artifacts are immutable.
- Product, provider, candidate, suite or policy changes do not rewrite historical
  results.
- Removing this directory is a control-plane rollback only; it does not delete
  or alter raw evidence. A release candidate cannot proceed without restoring an
  equivalent reviewed version-controlled control plane.
