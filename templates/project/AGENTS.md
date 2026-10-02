# Project Agent Instructions

<!-- piagent-managed:start -->
## Operating model

This project uses Pi Agent Platform.

For an ordinary source task:

1. Read the narrow target and nearest test. Use ordinary read/search/edit/bash tools and one writer.
2. Make the change, then run the project's checks. Rerun only after another change.
3. Do not call Piagent management/diagnostic tools unless runtime or the operator asks. Report changed files, verification, and residual risk concisely.

Runtime enforces protected paths, permissions, read-only paths, and external/destructive confirmation. Current source is authoritative; generated context is advisory. Use subagents only for independent read-only lanes.
<!-- piagent-managed:end -->

## Review

Use `REVIEW_GUIDELINES.md` when reviewing code in this project.

## Secrets

Do not commit OAuth tokens, API keys, `.env`, `auth.json`, session files, `.pi/memory/MEMORY.md`, `.pi/memory/memory_summary.md`, or `.pi/memory/local/`.
