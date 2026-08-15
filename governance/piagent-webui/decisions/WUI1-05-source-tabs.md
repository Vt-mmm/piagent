---
plan_id: piagent-webui
work_item: WUI1-05
status: accepted
decision: source-tabs
date: 2026-08-13
---

# WUI1-05 source-change tabs

## Decision

The source workspace exposes exactly three independent read models: Task
Changes, Full Working Tree and Staged Changes. Selecting a tab lazily fetches its
accepted `source-change-v1` projection. Snapshot counts are navigation hints;
the fetched view remains the authority for rows and availability.

File rows keep Git status (`A/M/D/R/U/C`), health, line statistics, content
access, provenance and evidence links on separate axes. The UI describes
`runtime-observed-agent` as a runtime touch, not proof that every byte was agent
authored. File selection retains only its opaque `fileRef` as server authority.

## Acceptance evidence

- Tests fix the exact three-view vocabulary and independent unavailable state.
- Git status, line counts, provenance and health are asserted separately.
- Source routes remain authenticated zero-turn reads and the package build and
  architecture checks pass.
