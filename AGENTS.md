# Pi Agent Platform — Agent Instructions

## Mission

This repository builds reusable Pi agent infrastructure for multiple projects and teams.

## Non-negotiables

- Do not commit OAuth tokens, API keys, `auth.json`, sessions, caches, or local trust files.
- Keep project-specific business logic out of `packages/piagent-core`.
- Put reusable profile families in `adapters/<profile>/profile.json`.
- Keep project-specific/private examples out of public commits; put them in the target project's own repo or `examples/private/`.
- Prefer docs and policy schemas over prompt-only enforcement.
- Any destructive or external-provider action must be explicitly confirmed by the human operator.
- Treat Pi project trust as code execution trust, not as a sandbox.

## File ownership

- Core Pi package: `packages/piagent-core/`
- Global docs: `docs/`
- Reusable profiles: `adapters/`
- Project-specific examples: `examples/`
- Project bootstrap templates: `templates/`
- Local scripts: `scripts/`

## Engineering style

- Keep code small, boring, and auditable.
- Avoid hidden magic in prompts. If behavior must be enforced, put it in extension/tool-call guard.
- Source code and identifiers: English.
- Human-facing long-form docs may be Vietnamese; reusable workflow prompts and command names stay English.
