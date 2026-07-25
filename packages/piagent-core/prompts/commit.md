---
description: Create a guarded local Git commit for reviewed project changes
argument-hint: "[commit message or scope]"
---

Create a local Git commit for the current project changes.

Request:

```text
$ARGUMENTS
```

Rules:

1. This command creates a local commit only. Do not push, tag, publish, release, merge, or open external provider flows.
2. Use normal shell Git commands so the piagent guard, protected paths, redaction, and confirmation gates remain active.
3. Start with `git status --short` and `git diff --stat`. If there are no changes, stop with one short line.
4. Inspect the relevant diff before staging. Do not stage files that look unrelated to the requested commit.
5. Prefer explicit path staging such as `git add README.md packages/piagent-core/prompts/commit.md`.
6. Do not use broad staging (`git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/`) unless the human operator explicitly confirms that broad staging is intended.
7. Refuse to stage protected or local-secret material such as `.env`, `.env.*`, `auth.json`, `.pi/settings.json`, `.pi/piagent-profile.json`, `.pi/piagent-profile.lock.json`, session files, caches, keys, or credentials.
8. If `$ARGUMENTS` contains a usable commit message, use it. Otherwise derive a concise Conventional Commit message from the inspected diff.
9. Run a lightweight verification before committing. At minimum use `git diff --check`; if source, policy, prompts, or package metadata changed, run the relevant project verification command.
10. After committing, report only the commit hash, message, files committed, verification result, and whether anything remains uncommitted.

Output at most 8 short lines. Keep it action-first and avoid long explanations.
