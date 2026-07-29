# @piagent/core

Shared Pi package for reusable project workflows.

## Contents

- `extensions/piagent-guard.ts`: runtime guard tools and policy hooks.
- `prompts/*.md`: slash-command workflows.
- `skills/piagent-ops/SKILL.md`: operating guidance for implementation tasks.
- `skills/piagent-source-cache/`: local cache for user-provided external source repositories.
- `subagents/*.md`: piagent roles for `pi-subagents`.
- `policies/base-policy.json`: default runtime policy, including protected path and shell protected path defaults.
- input hook support for local screenshot/image paths pasted into chat; supported images are attached as `[image1]`, `[image2]`, ...
- compact tool-result rendering: oversized redacted output is previewed in Pi and captured under `.pi/piagent-state/tool-results/` for offline audit/reporting.

## Trusted run wrapper

The root package exposes `piagent-auto`:

```bash
piagent-auto
piagent-auto --read-only -p "Scout payment mapping. Do not edit source."
piagent-auto --full-access -p "Run the trusted local benchmark suite."
```

This is a wrapper for `pi --approve` on the current run. It loads trusted project-local resources without turning off Piagent guardrails.

The wrapper can set `PIAGENT_PERMISSION_PROFILE` for one run:

- `read-only`: allow `read`, `grep`, `find`, `ls`, and piagent state tools; block shell/write/unknown tools.
- `workspace-write`: normal guarded implementation mode.
- `trusted-full-access`: trusted automation mode; protected paths, secret redaction, capability lock integrity, and destructive/external confirmations stay active.

Inside Pi, slash commands can switch the current session without writing the project profile:

```text
/permission-status
/read-only
/workspace-write
/full-access
/full-access Implement the requested trusted repo task.
```

## Runtime quality tools

- `piagent_permission_status`
- `piagent_exec_policy_check`
- `piagent_context_budget`
- `piagent_tool_policy_check`
- `piagent_task_gate_check`
- `piagent_usage_snapshot`
- `piagent_context_preflight`
- `piagent_memory_status`
- `piagent_memory_note`
- `piagent_memory_search`
- `piagent_memory_citation_record`
- `piagent_context_index_status`
- `piagent_context_index_record`
- `piagent_context_index_search`
- `piagent_profile_options`
- `piagent_profile_apply`
- `piagent_profile_tech_options`
- `piagent_profile_tech_apply`
- `piagent_profile_tech_context_record`
- `piagent_project_onboarding_record`
- `piagent_task_start`
- `piagent_source_checkout`
- `piagent_document_read` — reads `.md`/`.txt`/`.csv`/`.json`/`.yaml`/`.pdf`/`.docx` from the project or a granted `additionalReadRoots` directory; read-only, and `protectedPaths` still wins
- `piagent_context_record`
- `piagent_verify_record` — records verify evidence only after matching an observed bash tool result after task start
- `piagent_trace_record`

## Prompt recipes

- `/piagent-commands`: explain terminal, Pi, MCP, model, memory, and subagent commands in Vietnamese.
- `/permission-status`, `/read-only`, `/workspace-write`, `/full-access`: inspect or switch the current session permission profile.
- `/onboard-project`: first-run project context snapshot after login/model selection.
- `/context-index`: inspect or search the compact project context index without a model follow-up.
- `/profile`: show a short profile status, list options, apply a profile directly, or run select-style profile/tech setup without a model follow-up. Short aliases include `fe`, `be`, `full`, and `be-fe`.
- `/profile tech`: show/select/apply the project tech stack for the active profile; fullstack setup selects frontend, backend, and database tech.
- `/memory-policy`: inspect project memory policy and explicit remember workflow.
- `/model-options`: explain model selector, scoped models, thinking levels, and benchmark discipline.
- `/platform-improve`: improve package setup, runtime policy, docs, MCP, model, memory, or subagent workflows.
- `/be-to-fe`: scout backend/spec read-only, then implement frontend only.
- `/scout`: governed read-only scout/audit workflow.
- `/task`: governed implementation lifecycle.
- `/task-preflight`: check whether the active session should run, compact, or start fresh before large work.
- `/piagent-logs`: show compact-log policy and recent oversized tool-output captures.
- `/fresh-task`, `/fresh-scout`, `/fresh-be-to-fe`: start a fresh governed session and replay the compact workflow prompt.
- `/commit`: create a guarded local commit from reviewed files only; no push.
- `/pr`: prepare a pull request; push/PR creation still requires explicit operator confirmation.
- `/plan`: bounded implementation plan.
- `/discuss`: clarify a rough request before planning or editing.
- `/review`: review source/diff with scope and verification checks.

## Subagents

When `pi-subagents` is installed, this package exposes:

- `piagent-scout`
- `piagent-planner`
- `piagent-worker`
- `piagent-reviewer`
- `piagent-oracle`

## Install

```bash
pi install git:github.com/Vt-mmm/piagent
```

Use `git:github.com/Vt-mmm/piagent@vX.Y.Z` when pinning a reproducible project package source.

Runtime support follows the root release matrix: Node.js `>=22.19.0`, Pi Coding Agent `0.82.0`, verified rollout on macOS Apple Silicon + Bash and Linux x64 + Bash, supported-target smoke verification for macOS Intel/Linux ARM64, no native Windows team rollout target yet, and WSL2 experimental.

## Project profile

The extension reads profile data in this order:

1. env `PIAGENT_PROFILE`
2. `<project>/.pi/piagent-profile.json` when project-local trust is active in Pi

If no trusted profile is available, the extension still applies baseline secret and destructive-command guards.

`permissionProfile` defaults to `workspace-write` when omitted. `PIAGENT_PERMISSION_PROFILE` can override it for a single trusted run; invalid values fail closed to `read-only`.

## Task state

Runtime task tools write local state to:

- `.pi/piagent-state/tasks/*.json`
- `.pi/project-context.md`
- `.pi/tech-stack.json`
- `.pi/tech-context/*.json`
- `.pi/piagent-state/project-onboarding.json`
- `.pi/memory/MEMORY.md` when the user explicitly asks Pi to remember durable information; generated projects ignore this file by default
- `.pi/piagent-state/observed-bash.jsonl`
- `.pi/piagent-state/traces.jsonl`
- `.pi/task-inbox/*.md` for oversized local task intake; generated projects ignore this directory by default
- Pi custom session entry `piagent-task-trace`

Project-local state belongs in `.pi/.gitignore`.

Passing final gates require an observed exit `0` command that exactly matches one entry in `task.verifyCommands`. Other observed commands are traceable but advisory.

Raw path-like tool access to protected paths is blocked before execution. This includes Pi built-ins (`read`, `write`, `edit`, `grep`, `find`, `ls`) and custom/MCP tools with nested path-like strings, arrays, or `file://` URIs. Path-like strings are percent-decoded once, and input nesting above `MAX_TOOL_INPUT_INSPECTION_DEPTH=32` fails closed. Known content fields such as `content`, `query`, `pattern`, `text`, and `command` are excluded from generic extraction. `grep.glob` and `find.pattern` are checked when they explicitly target protected paths, while broad `grep`, `find`, and `ls` results are filtered so protected content lines or path metadata are redacted before reaching the model.

Raw `bash` access to protected paths is blocked through shell path extraction. `.pi/piagent-state/**` and `.pi/piagent-profile.json` are self-protected; use `piagent_context` and piagent task tools for governed access.

The input hook also detects local image paths in chat prompts. Supported formats are `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.bmp`, including macOS screenshot paths under `/var/folders/...`. Up to 4 images are attached per input, with an 8 MB per-image cap. Oversized images should be read through Pi's `read` tool so Pi can resize them.
