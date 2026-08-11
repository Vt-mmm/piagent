# @piagent/core

Shared Pi package for reusable project workflows.

## Contents

- `extensions/piagent-guard.ts`: Pi extension composition root and registration order.
- `runtime/`: Pi-facing session, usage, log-compaction, and workflow input adapters. New command/tool/hook modules belong here.
- `extensions/*.js|ts`: legacy-location core services for policy, context, task lifecycle, state, and document intake; only `piagent-guard.ts` is loaded as an extension.
- `prompts/*.md`: workflow aliases that intentionally launch an agent turn.
- `skills/piagent-ops/SKILL.md`: operator-invoked reference for manual intake, recovery, and high-risk controls; routine runtime-managed tasks do not advertise or load it.
- `skills/piagent-source-cache/`: local cache for user-provided external source repositories.
- `subagents/*.md`: piagent roles for `pi-subagents`.
- `benchmark/benchmark-core.js`: deterministic suite validation, evidence scoring, and paired usage comparison for `piagent-benchmark`; `benchmark-report.js` renders the human/HTML reports.
- `policies/base-policy.json`: default runtime policy, including protected path and shell protected path defaults.
- input hook support for local screenshot/image paths pasted into chat; supported images are attached as `[image1]`, `[image2]`, ...
- compact tool-result rendering: oversized redacted output is previewed in Pi and captured under `.pi/piagent-state/tool-results/` for offline audit/reporting.
- local Context Engine v2: incremental FTS5/symbol/import index, hybrid retrieval, token-budgeted packs, bounded current-turn source/test snapshots, test-impact mapping, dynamic Piagent tools, and Agent Watch compatible telemetry.

Architecture boundaries and non-growth file budgets are enforced by `npm run architecture:check`. See [English architecture](../../docs/en/architecture.md), [kiến trúc tiếng Việt](../../docs/vi/architecture.md), and the paired maintainer guides before adding a new runtime surface.

The root package exposes `piagent-benchmark` for an automatic paired Piagent
steady-state benchmark against Raw Pi or the `codex-cli` surface. Treatment
onboarding/context preparation happens before measured model usage;
post-baseline mutations remain scope violations. Codex runs through a strict
streaming JSONL adapter and defaults to controlled ephemeral execution with an
isolated temporary Codex home. Run
`piagent-benchmark --dry-run` before starting billed model sessions; see
`docs/quality-benchmark.md` for score and verdict rules.

## Trusted run wrapper

The root package exposes `piagent-auto`:

```bash
piagent-auto
piagent-auto --read-only -p "Scout payment mapping. Do not edit source."
piagent-auto --full-access -p "Run the trusted local benchmark suite."
```

This is a wrapper for `pi --approve` on the current run. It loads trusted project-local resources without turning off Piagent guardrails.

For an explainable fresh-task model recommendation, use
`piagent-route --prompt "<task>" --json`. Provider-backed adaptive launch is a
separate explicit action: `piagent-route --prompt-file <file> --execute --yes`.
The in-extension router never changes models mid-conversation and remains
fail-closed when the user pin, catalog, provenance, or host boundary is unclear.

The wrapper can set `PIAGENT_PERMISSION_PROFILE` for one run:

- `read-only`: allow `read`, `grep`, `find`, `ls`, and piagent state tools; block shell/write/unknown tools.
- `workspace-write`: normal guarded implementation mode.
- `trusted-full-access`: trusted automation mode; protected paths, secret redaction, capability lock integrity, and destructive/external confirmations stay active.

Inside Pi, `/permission` can switch the current session without writing the project profile:

```text
/permission
/permission status
/permission read-only
/permission workspace-write
/permission full-access
/permission full-access Implement the requested trusted repo task.
```

Legacy aliases still work: `/permission-status`, `/read-only`, `/workspace-write`, and `/full-access`.

## Runtime quality tools

- `piagent_tools`
- `piagent_context_engine`
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
- `piagent_task_progress`
- `piagent_source_checkout`
- `piagent_document_read` — reads `.md`/`.txt`/`.csv`/`.json`/`.yaml`/`.pdf`/`.docx` from the project or a granted `additionalReadRoots` directory; read-only, and `protectedPaths` still wins
- `piagent_context_record`
- `piagent_verify_record` — records verify evidence only after matching an observed bash tool result after task start
- `piagent_trace_record`

These tools are registered capabilities, not a per-task call sequence. Runtime
starts bounded source tasks directly and exposes no Piagent management schema
to the model. Broad, high-risk, or ambiguous intake activates
`piagent_task_start`; lifecycle hooks still collect context, changes,
current-tree verification, trace and final-gate evidence. Diagnostic/recovery
groups load only when requested.

## Runtime commands and workflow recipes

- `/commands`: runtime menu/help for terminal, Pi, MCP, model, memory, session, context, permission, and subagent commands.
- `/workflow`: one launcher for task, scout, BE-to-FE, discuss, plan, review, commit, PR, platform-improve, and onboarding workflows.
- `/usage`: runtime usage namespace for live snapshot, history hint, preflight, compact, compact-log captures, and context efficiency.
- Pi native `/name`: set the current session name for Agent Watch/report mapping; Piagent observes the native rename event and keeps `/setname` as a compatibility alias.
- `/fresh`: open a fresh governed session for `task`, `scout`, or `be-to-fe`.
- `/context`: runtime context namespace for index/rebuild/search/pack/test-impact/efficiency, task preflight, and semantic compact.
- `/permission`: runtime permission namespace for status/read-only/workspace-write/full-access.
- `/onboard`: runtime onboarding namespace; `run` launches the first-read onboarding workflow.
- `/context-index`: legacy alias for `/context index/search`.
- `/profile`: show a short profile status, list options, apply a profile directly, or run select-style profile/tech setup without a model follow-up. Short aliases include `fe`, `be`, `full`, and `be-fe`.
- `/profile tech`: show/select/apply the project tech stack for the active profile; fullstack setup selects frontend, backend, and database tech.
- `/memory` or `/memory-policy`: inspect project memory policy and explicit remember workflow.
- `/model-options`: show model selector, scoped models, thinking levels, and benchmark discipline without a model follow-up.
- `/logs`: short alias for `/usage logs`.
- `/task-preflight`: legacy alias for `/context preflight`.
- `/fresh-task`, `/fresh-scout`, `/fresh-be-to-fe`: legacy aliases for `/fresh ...`.
- `/task`, `/scout`, `/be-to-fe`, `/platform-improve`, `/commit`, `/pr`, `/plan`, `/discuss`, `/review`: workflow aliases kept for power users; team docs should teach `/workflow ...` first.

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
- `.pi/piagent-state/session-tasks/*.json`
- `.pi/project-context.md`
- `.pi/tech-stack.json`
- `.pi/tech-context/*.json`
- `.pi/piagent-state/project-onboarding.json`
- `.pi/memory/MEMORY.md` when the user explicitly asks Pi to remember durable information; generated projects ignore this file by default
- `.pi/piagent-state/observed-bash.jsonl`
- `.pi/piagent-state/traces.jsonl`
- `.pi/piagent-state/context-engine/context-v2.sqlite`
- `.pi/piagent-state/context-engine/events.jsonl`
- `.pi/piagent-state/context-engine/efficiency-report.json`
- `.pi/task-inbox/*.md` for oversized local task intake; generated projects ignore this directory by default
- Pi custom session entry `piagent-task-trace`

Project-local state belongs in `.pi/.gitignore`.

Task files use schema v2 and bind one unique `taskRunId` to one Pi `sessionId`.
They record attempt/max-attempt history, dependency-safe work-plan progress,
Git baseline/final digests, observed changes, all exact verify results and final
trace. A terminal task is immutable; retry starts in a fresh session and carries
the prior failure/ruled-out evidence. Legacy v1 state is migrated and archived
without requiring project onboarding again.

Local state directories are owner-only. Task state, context telemetry, trace,
bash evidence and captures refuse ancestor symlinks out of the project. JSONL
files rotate under a cross-process lock; compacted tool captures are pruned by
age, count and aggregate bytes.

The Context Engine SQLite index contains allowed source bodies. Its directory is
kept at mode `0700`, with database/WAL/SHM at `0600`; core and FTS5 secure-delete
cover normal refreshes, while exclusion-policy changes trigger a retryable FTS
rebuild and database vacuum before the new policy is considered clean.

Passing source final gates require an observed exit `0` result for every
meaningful entry in `task.verifyCommands`. Other observed commands are traceable
but advisory. Declared changed files must also differ from the task baseline,
match observed tool results and remain inside `task.scope`.

Raw path-like tool access to protected paths is blocked before execution. This includes Pi built-ins (`read`, `write`, `edit`, `grep`, `find`, `ls`) and custom/MCP tools with nested path-like strings, arrays, or `file://` URIs. Path-like strings are percent-decoded once, and input nesting above `MAX_TOOL_INPUT_INSPECTION_DEPTH=32` fails closed. Known content fields such as `content`, `query`, `pattern`, `text`, and `command` are excluded from generic extraction. `grep.glob` and `find.pattern` are checked when they explicitly target protected paths, while broad `grep`, `find`, and `ls` results are filtered so protected content lines or path metadata are redacted before reaching the model.

Raw `bash` access to protected paths is blocked through shell path extraction. `.pi/piagent-state/**` and `.pi/piagent-profile.json` are self-protected; use `piagent_context` and piagent task tools for governed access.

The input hook also detects local image paths in chat prompts. Supported formats are `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.bmp`. The canonical target must be inside the project or a directory granted through `additionalReadRoots`/`PIAGENT_ADDITIONAL_READ_ROOTS`; protected paths and project files outside the resolved filesystem read scope remain blocked. File bytes are sniffed before attachment, and the checked file identity must still match when opened. Up to 4 images are attached per input, with an 8 MB per-image cap. Oversized images should be read through Pi's `read` tool so Pi can resize them.
