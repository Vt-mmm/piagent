---
name: piagent-source-cache
description: Cache and inspect user-provided external Git repositories.
---

# Piagent Source Cache

Use this skill when the user provides a GitHub/GitLab/Bitbucket repository as source context for a task.

## Goal

Keep external source repositories:

- stable: predictable cache path;
- fresh: throttled fetch;
- cheap: no repeated clone;
- safe: never edit the shared cache directly.

## Workflow

1. Prefer the runtime tool if available:

   ```text
   piagent_source_checkout(repoRef="owner/repo")
   ```

2. If the runtime tool is unavailable, resolve the repo into a local checkout from a platform clone:

   ```bash
   PIAGENT_PLATFORM_HOME=/path/to/piagent-platform
   bash "$PIAGENT_PLATFORM_HOME/packages/piagent-core/skills/piagent-source-cache/checkout-source-repo.sh" <repo-ref> --path-only
   ```

3. Use the printed path for targeted `rg`, `sed`, and file reads.
4. Read only files relevant to the user request.
5. If edits are needed, create a separate project/worktree; do not edit the cache.
6. Cite the source URL in reports when needed.

## Supported refs

- `owner/repo`
- `github.com/owner/repo`
- `https://github.com/owner/repo`
- `git@github.com:owner/repo.git`

## Cache location

Default:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/piagent-platform/checkouts/<host>/<owner>/<repo>
```

Override:

```bash
PIAGENT_PLATFORM_HOME=/path/to/piagent-platform
PIAGENT_CHECKOUT_CACHE=/path/to/cache bash "$PIAGENT_PLATFORM_HOME/packages/piagent-core/skills/piagent-source-cache/checkout-source-repo.sh" owner/repo --path-only
```
