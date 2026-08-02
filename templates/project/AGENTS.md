# Project Agent Instructions

<!-- piagent-managed:start -->
## Operating model

This project uses Pi Agent Platform.

For an ordinary source task:

1. Runtime binds bounded source work to this Pi session before the model starts. If intake pauses for broad/high-risk/ambiguous scope, call `piagent_task_start` exactly once with project-relative path/glob scope and reuse the contract.
2. Read the narrow target and nearest test. Use ordinary read/search/edit/bash tools and one writer.
3. Complete intended source and focused regression-test edits, then run each exact runtime verifier. Rerun only after another mutation.
4. Do not call Piagent management/diagnostic tools unless runtime or the operator asks. Report changed files, verification, and residual risk concisely.

Runtime enforces protected paths, permissions, external/destructive confirmation, scope, current-tree evidence, and the final gate. Current source is authoritative; generated context is advisory. Use subagents only for independent read-only lanes.
<!-- piagent-managed:end -->

## Review

Use `REVIEW_GUIDELINES.md` when reviewing code in this project.

## Secrets

Do not commit OAuth tokens, API keys, `.env`, `auth.json`, session files, `.pi/memory/MEMORY.md`, `.pi/memory/memory_summary.md`, or `.pi/memory/local/`.
