# Memory Policy

Use this workflow to inspect or configure project memory for a Pi Agent Platform project.

## Goals

- Keep durable project knowledge across sessions without forcing the model to re-scout the whole repo.
- Keep memory explicit, compact, inspectable, and safe.
- Avoid storing secrets, credentials, raw private data, or large source excerpts.

## Workflow

1. Call `piagent_context` with `detail=full`.
2. Call `piagent_memory_status` with `detail=full`.
3. If memory files are missing, explain that project memory can be initialized by project init/setup or by saving the first explicit note.
4. If the user asks to remember a stable fact, call `piagent_memory_note`.
5. If the user asks what is remembered, call `piagent_memory_search` or inspect the memory files.
6. If the user asks about automatic/background memory, explain the tradeoff:
   - default platform memory is explicit-only and project-scoped;
   - external Pi memory packages can be installed separately after source review;
   - background extraction should be benchmarked before being enabled for teams.

## Rules

- Memory is advisory. Current repo files, task contracts, and user instructions are authoritative.
- Do not rely on memory alone for implementation decisions.
- Cite memory use visibly in the response when it materially affects a decision: `Memory cited: <file/path>`.
- Do not hand-edit generated memory state, SQLite catalogs, snapshots, or runtime cache files.
- Keep reusable workflow names and prompts in English.

## Recommended outputs

For status:

```text
Memory mode: manual
Scope: project
Summary: .pi/memory/memory_summary.md
Handbook: .pi/memory/MEMORY.md
Write policy: explicit-only
External packages: optional, review before install
```

For a remember request:

```text
Saved memory:
- category:
- title:
- path:
- redacted:
```
