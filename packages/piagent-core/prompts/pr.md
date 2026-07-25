---
description: Prepare a guarded pull request from the current branch
argument-hint: "[PR title or request]"
---

Prepare a pull request for the current branch.

Request:

```text
$ARGUMENTS
```

Rules:

1. Do not merge. Do not publish, release, deploy, or tag.
2. Use normal shell Git/GitHub commands so the piagent guard and confirmation gates remain active.
3. Start with `git status --short`, `git branch --show-current`, and `git remote -v`.
4. If there are uncommitted changes, stop and ask the operator to run `/commit` first, unless the operator explicitly asks this command to include a commit.
5. Run the relevant verification command before opening the PR. At minimum use `git diff --check`; for source or policy changes, run the project verify/test/typecheck commands that apply.
6. If the branch is not pushed, ask for explicit operator confirmation before `git push -u origin <branch>`.
7. Create the PR only after the operator explicitly confirms the external GitHub action. Prefer `gh pr create --draft` with a clear title/body derived from the current diff and commits, unless the operator explicitly asks for a ready-for-review PR.
8. Keep secrets and local trust files out of the PR body. Do not paste token-like values, `.env` content, `auth.json`, session paths, or private local config.
9. If confirmation is not available, hand off the exact safe command the operator can run.

Output at most 8 short lines: branch, status, verify result, push/PR status, PR URL if created, and next human action if needed.
