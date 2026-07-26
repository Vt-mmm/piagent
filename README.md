# Pi Agent Platform

Reusable Pi package for project onboarding, profile-based coding workflows, guarded tool usage, multi-agent orchestration, MCP setup, memory policy, and task verification.

Public docs: [piagent.io.vn](https://piagent.io.vn)

## Install

Node.js `>=22.19.0`. Two commands, run from the project you want to set up:

```bash
npm install -g @piagent/platform
piagent-setup
```

`piagent-setup` installs the exact Pi Coding Agent host this release pins, installs the Pi package, initializes the current directory, and runs the doctor. It also installs the MCP baseline, the subagents, and — when `herdr` is already on `PATH` — the Herdr Pi integration; pass `--no-mcp`, `--no-subagents`, `--no-herdr`, or `--global-only` to skip those.

If you want [Herdr](https://herdr.dev/docs/install/), install it *before* `piagent-setup`:

```bash
brew install herdr                            # macOS
curl -fsSL https://herdr.dev/install.sh | sh  # macOS or Linux
```

The integration step is skipped with a warning when `herdr` is not on `PATH`, so installing Herdr afterwards means running `piagent-setup --global-only` again. The `curl` form runs a script fetched at install time; `brew` and the [GitHub releases](https://github.com/ogulcancelik/herdr/releases) are the reviewable alternatives. Stable Herdr covers macOS and Linux — Windows builds are preview only, which is outside this platform's rollout matrix either way.

Because it runs from an installed package, the source it writes into `.pi/settings.json` is `npm:@piagent/platform@<version>` — which means the same thing on a teammate's machine, so the file can be committed.

| Runtime surface | Team rollout status |
|---|---|
| macOS Apple Silicon (`darwin/arm64`) + Bash | Verified for this release. |
| Linux x64 + Bash | Verified in CI for this release. |
| macOS Intel (`darwin/x64`) + Bash | Supported target, but run `piagent-doctor` and project smoke tests before wide rollout. |
| Linux ARM64 + Bash | Supported target, but run `piagent-doctor` and project smoke tests before wide rollout. |
| Native Windows | Not a team-rollout target yet; terminal helpers and shell policy rely on Bash/POSIX semantics. |
| WSL2 | Experimental and not release-gated yet. |

Pinned step-by-step rollouts, updates, rollback, and the fast-moving `--dev` channel are in [Release and install policy](docs/release-install-policy.md).

## Daily use

```bash
cd /path/to/project
pi
```

That is the daily flow. Pi onboards the project, selects an operating profile, uses the right tools, records task evidence, and hands off verified implementation work.

Running several agents side by side — one implementing, one reviewing read-only, one verifying — start `herdr` from the project instead of `pi` and open a Pi pane per role. Herdr orchestrates terminals and sessions; it is not a security boundary, so every gate still lives in the Pi extension and OAuth is still a `/login` inside Pi. See [Herdr workflow](docs/herdr-workflow.md).

First run in a new project, type `/onboard-project`. It inspects the repository with bounded context, recommends a profile, explains the tradeoffs, asks before applying, then writes `.pi/piagent-profile.json`, its lock, `.pi/tech-stack.json`, `.pi/tech-context/*`, `.pi/project-context.md`, and `.pi/memory/*`.

`/piagent-commands` lists everything else. For trusted local runs, `piagent-auto` wraps `pi --approve` and sets a permission profile for that run — it does not bypass protected-path checks, destructive shell checks, task gates, or verification evidence. See the [command reference](docs/command-reference-vietnamese.md).

## Uninstall

`piagent-uninstall` reports what it would remove and exits. It only acts with `--apply`, because it edits Pi settings that other tools also write to.

```bash
piagent-uninstall
piagent-uninstall --apply
```

That removes the Pi package this platform registered. Add-ons, the Pi host, a project's state, and the npm-global helper are each opt-in and separate — `piagent-uninstall --help` lists them.

Removal targets what is registered in Pi's settings rather than what the current version installs, so a package registered by an older release still comes out. Credentials, trust decisions, sessions, todos, and project memory are never removed, at any flag combination. Files written from a template and then edited — `AGENTS.md`, `.pi/settings.json`, `.pi/project-context.md` and the like — are listed for review rather than deleted.

## What it provides

- Global Pi package with prompts, skills, guard extensions, and piagent subagents.
- Runtime onboarding via `/onboard-project`.
- Runtime profile selection via `/profile`, plus select-style tech stack setup via `/profile setup` and `/profile tech`.
- Explicit project memory via `/memory-policy` and `piagent_memory_*` tools.
- Compact project context index via `/context-index` and `piagent_context_index_*` tools. This is an advisory navigation graph, not a security boundary or source of truth.
- MCP setup helpers for Context7, Chrome DevTools, GitHub, Playwright, and Figma.
- Subagent setup helpers for read-only scouting, planning, implementation, review, and risk challenge.
- Chat image-path intake: paste a local screenshot path into the Pi chat box and the guard attaches it as `[image1]` before the model sees the prompt.
- Trusted-run wrapper: `piagent-auto` launches Pi with `--approve` for the current run while keeping piagent guardrails active.
- Runtime policy tools:
  - `piagent_permission_status`
  - `piagent_exec_policy_check`
  - `piagent_context_budget`
  - `piagent_tool_policy_check`
  - `piagent_task_gate_check`
  - `piagent_usage_snapshot`
  - `piagent_context_preflight`
  - `piagent_orchestration_policy`
- Context7-ready tech stack manifest and concise `.pi/tech-context/*` snapshots for selected profile roles.
- Accident-brake guardrails for protected paths, destructive shell commands, task contracts, context manifests, observed verification evidence, and trace records.
- Quality benchmark recorder for comparing approved agent surfaces, models, and workflow presets on the same task scenarios.
- Built-in profiles for frontend, backend, fullstack, BE-readonly/FE-write, data, DevOps, mobile, docs, Python, and Node TypeScript.
- Versioned capability packs with deterministic catalog, profile resolution, integrity lock, and permission checks.

## Permission profiles

Project profiles can declare a runtime `permissionProfile`:

| Profile | Use when | Guard behavior |
|---|---|---|
| `read-only` | Scout, audit, review | Allows `read`, `grep`, `find`, `ls`, and piagent state tools; blocks shell, write/edit, and unknown tools. |
| `workspace-write` | Normal implementation | Default profile. Keeps current protected-path, shell, capability, task, and verify gates. |
| `trusted-full-access` | Trusted local automation | Expands workspace tool/scope autonomy, but still enforces protected paths, secret redaction, capability lock integrity, and destructive/external confirmation. |

For one run, set `PIAGENT_PERMISSION_PROFILE=read-only|workspace-write|trusted-full-access`, or use `piagent-auto --read-only`, `--workspace-write`, or `--full-access`.

Inside an active Pi session, use slash commands for a session-local switch:

```text
/permission-status
/read-only
/workspace-write
/full-access
/full-access Implement the requested trusted repo task.
```

`/full-access` also accepts a task after the command. The guard switches the current session to `trusted-full-access`, then forwards the remaining text as the next user request.

## Solo-first orchestration

Pi Agent Platform supports subagents, but the default operating model is solo-first: one parent agent owns the task contract, uses explicit review lenses, and only calls bounded subagents when scout/planning/review work is independent enough to justify the extra token/tool cost.

Inside Pi:

```text
/piagent-orchestration
```

This shows the active mode, max subagents, review lenses, Field Guide path, and writer policy without triggering a model follow-up.

## Profiles

Switching profile is one command inside Pi:

```text
/profile             # status
/profile fullstack   # apply
/profile setup       # select profile, then select the tech for each role
```

`/profile list` shows every profile and its aliases. The setup flow prefers a native select UI; where the Pi host has no select control, it falls back to a compact options card and an exact `/profile tech apply ...` line rather than asking the model to explain every option.

## Capability packs

Capability packs group governed prompts, skills, subagents, policies, adapters, recipes, and eval scenarios behind a declarative manifest. Project profiles select exact pack versions and explicitly grant owner, lifecycle, filesystem, network, and external-action boundaries. The generated lock is deterministic and records profile, pack, artifact, and permission digests.

Commands and lock format: [Capability packs](docs/capability-packs.md).

## Built-in profiles

| Profile | Use when |
|---|---|
| `generic` | Unknown or low-structure repository |
| `web-frontend` | Frontend-only work |
| `backend-api` | Backend/API work |
| `be-readonly-fe` | Backend is source-of-truth/read-only; frontend is write target |
| `fullstack` | Frontend and backend may both be changed when the task allows |
| `node-typescript` | Node/TypeScript library or tooling |
| `python` | Python app/library |
| `data` | ETL, dbt, DVC, notebook, or data pipeline |
| `devops` | Docker, Terraform, Kubernetes, Helm, GitHub Actions |
| `mobile` | React Native or Flutter |
| `docs` | Documentation portal/manual |

## Main workflows

Everything below is typed inside a Pi session. `/piagent-commands` lists the full set; [command reference](docs/command-reference-vietnamese.md) explains each one.

| Command | Use when |
|---|---|
| `/task <request>` | The requirement is clear enough to implement. |
| `/scout <request>` | Read-only investigation — payment, auth, data, or backend-contract mapping — before deciding whether to implement. |
| `/discuss <rough request>` | The requirement is not clear yet. |
| `/plan <goal>` | You want a plan before any edit. |
| `/review current diff` | Reviewing work already done. |
| `/commit <message>` | Governed local commit: inspect status and diff, stage only the intended files, run verification, commit. Never pushes. |
| `/pr <title>` | Governed pull request: confirms before any `git push` or GitHub write. Draft by default. |
| `/be-to-fe <request>` | Backend or spec is read-only and the implementation target is frontend. Pair with `/profile be-readonly-fe`. |
| `/platform-improve <request>` | Package-level work: setup, MCP, model scope, memory, runtime policy, prompts, skills, subagents. |
| `/fresh-task`, `/fresh-scout`, `/fresh-be-to-fe` | The current session is already heavy. Opens a new governed session and replays the compact workflow prompt. |

Git stays a capability rather than a `/git-*` namespace, so natural language works too. Broad staging — `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/` — requires confirmation, so unrelated or private files are not swept into a commit silently.

Paste a local screenshot path straight into a task and the guard attaches it as `[image1]` before the model sees the prompt: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, up to 4 images at 8 MB each. The guard also collapses pasted mandatory-flow boilerplate, so there is no need to paste a checklist into every task.

A spec that lives outside the project — the one just downloaded to `~/Downloads` — is read with `piagent_document_read` once its directory is listed in the profile's `additionalReadRoots`. The grant is read-only, covers `.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.pdf`, and `.docx` only, and does not open anything `protectedPaths` covers. See [command reference](docs/command-reference-vietnamese.md).

## Model selection

Handled by Pi's native UI: `/model` or `Ctrl+L` to pick, `Ctrl+P` to cycle the scoped set, `Shift+Tab` to cycle thinking level where the model supports it. Global setup seeds `enabledModels`; see [Model options](docs/model-options.md) to inspect or re-apply it.

## MCP setup

`piagent-setup` and `piagent-install` both install `pi-mcp-adapter` and seed the `core` preset. Pass `--no-mcp` to skip it.

| Preset | Includes |
|---|---|
| `core` | Context7, Chrome DevTools, GitHub |
| `popular` | core + Playwright + Figma remote |
| `all` | popular + Figma desktop/local |

Seeding writes server definitions; it does not start or authenticate anything. Servers connect lazily, so each one needs its own prerequisite before its first call: Chrome DevTools needs a local Chrome, and GitHub needs Docker running plus `GITHUB_PERSONAL_ACCESS_TOKEN` exported. `piagent-mcp --list` prints what each server requires. Project-scope `.mcp.json` files ship empty on purpose — the shared baseline is the global config, not the project one.

Keep provider keys in environment variables, never in committed config. Switching presets and per-project scoping: [MCP and tools](docs/mcp-and-tools.md).

## Subagents

`piagent-setup` installs `pi-subagents` with the `safe` preset unless disabled. Daily task prompts stay solo-first: they delegate bounded scout, planning, and review work only when it is independent enough to be worth the cost, and the final handoff states whether subagents were used and why.

`/subagents-doctor` runs a health check; `/run piagent-scout "…"` and its planner, worker, and reviewer counterparts dispatch work. See [Subagents and multi-agent](docs/subagents-and-multiagent.md).

## Repository layout

```text
piagent/
├─ adapters/                         reusable project profiles
├─ catalog/                          deterministic capability index
├─ docs/                             Vietnamese documentation and operating notes
├─ evals/                            governed evaluation scenarios
├─ packs/                            versioned capability manifests and recipes
├─ packages/
│  └─ piagent-core/               Pi package: extensions, prompts, skills
├─ schemas/                          JSON schemas
├─ scripts/                          setup, doctor, verification helpers
└─ templates/                        project/global templates
```

## Verification

One command runs the full local gate — typecheck, tests, capability catalog, doctor, and the scaffold check:

```bash
npm run verify
```

Individual checks and the contributor flow are in [CONTRIBUTING.md](CONTRIBUTING.md). Token and session follow-up is `/piagent-usage` inside Pi; see [Usage observability](docs/usage-observability.md). Comparing agent surfaces and models on the same scenarios: [Quality benchmark guide](docs/quality-benchmark.md).

## Public safety

This repository intentionally excludes:

- OAuth tokens and `auth.json`;
- `.env` files;
- MCP API keys and provider tokens;
- Pi sessions, todos, caches, and local trust files;
- project-private data dumps;
- local machine paths.

## Documentation

- [Public docs site](https://piagent.io.vn)
- [Static team docs site](docs-site/index.html)
- [Changelog](CHANGELOG.md)
- [Vercel docs site deploy](docs/vercel-docs-site.md)
- [Operator manual tiếng Việt](docs/operator-manual-vietnamese.md)
- [Quickstart tiếng Việt](docs/quickstart-vietnamese.md)
- [Command reference tiếng Việt](docs/command-reference-vietnamese.md)
- [Team onboarding](docs/team-onboarding.md)
- [Project onboarding](docs/project-onboarding.md)
- [Workflow recipes](docs/workflow-recipes.md)
- [Project adapters](docs/project-adapters.md)
- [Architecture](docs/architecture.md)
- [Distribution standard](docs/distribution-standard.md)
- [Release and install policy](docs/release-install-policy.md)
- [Publishing for teams](docs/publishing-for-teams.md)
- [OAuth providers](docs/oauth-providers.md)
- [Herdr workflow](docs/herdr-workflow.md)
- [MCP and tools](docs/mcp-and-tools.md)
- [Subagents and multi-agent](docs/subagents-and-multiagent.md)
- [Auto-delegation policy](docs/auto-delegation-policy.md)
- [Subagent orchestration capabilities](docs/subagent-orchestration-capabilities.md)
- [Context-window policy](docs/context-window-policy.md)
- [Memory policy](docs/memory-policy.md)
- [Task lifecycle tiếng Việt](docs/task-lifecycle-vietnamese.md)
- [Task implementation contract](docs/task-implementation-contract.md)
- [Runtime quality baseline](docs/runtime-quality-baseline.md)
- [Usage observability](docs/usage-observability.md)
- [Model options](docs/model-options.md)
- [Quality benchmark guide](docs/quality-benchmark.md)
- [Sensitive-data redaction benchmark](docs/security-redaction-benchmark.md)
- [Runtime policy design](docs/runtime-policy-design.md)
- [Security threat model](docs/security-threat-model.md)
- [Package architecture notes](docs/package-architecture-notes.md)

## Maturity

The current package version is read from package metadata and release tags. Personal machines may follow the unpinned package source when accepting ongoing updates; production/team quickstarts and committed project settings should pin an explicit tag such as `v1.1.2` or a reviewed commit.

Ready for:

- global Pi setup;
- project onboarding;
- profile-driven guarded implementation tasks;
- read-only scouting and planning;
- backend-readonly/frontend-write workflows;
- bounded subagent scouting, planning, implementation, and review;
- runtime checks for exec policy, context budget, context preflight, tool policy, task gate, and usage snapshot;
- project-level quality/token/cost benchmarking.

Application-level policy layer:

- The guard extension is an accident-prevention layer for agent mistakes and common prompt-injection patterns.
- Raw path-like tool access to protected paths is blocked before execution. This covers Pi built-ins such as `read`, `write`, `edit`, `grep`, `find`, `ls`, and custom/MCP tools when their input contains path-like strings, including nested objects, arrays, and `file://` URIs.
- The default MCP proxy carrier is decoded only from bounded object-shaped JSON. Provider/action confirmation and protected/read-only path checks then apply to the effective MCP tool; malformed, oversized, scalar, array, or excessively nested proxy payloads fail closed.
- Runtime permission profiles control autonomy: `read-only`, `workspace-write`, and `trusted-full-access`. The full-access profile is explicit and auditable; it does not disable protected-path checks, secret redaction, capability lock integrity, or destructive/external confirmations.
- Protected paths are matched case-insensitively, existing aliases are resolved to their canonical repository path, and scope-aware filesystem tools reject repository escape or symbolic-link traversal.
- Path-like strings are percent-decoded once before matching. Excessively nested tool input fails closed instead of being silently skipped.
- Known content fields such as `content`, `query`, `pattern`, `text`, and `command` are excluded from generic path extraction to preserve normal search/edit behavior. Tool-specific checks still validate `grep.glob` and `find.pattern` when they explicitly target protected paths.
- The ambiguous `source` field remains metadata for configured external providers and piagent tools, but is treated as a filesystem path for file-oriented tools and unknown/local tools; protected-path and read-scope checks then apply before execution.
- Broad `grep`, `find`, and `ls` sweeps get result-filter backstops: protected file content lines or protected path metadata are redacted before the model sees output. Text tool results and JSON-like result details also pass through shared sensitive-data redaction; image, audio, and resource payloads are left intact.
- The redaction release gate is a synthetic/internal benchmark for contextual recall, benign preservation, structured fields, and bounded large output. The public security threat model maps current assumptions, attack vectors, controls, and residual risks; it is not an independent audit. Stronger assurance still requires a broader OS/shell matrix, more parser fuzzing, continued symlink/path-traversal testing, third-party review, and an LTS/backport policy. Opaque entropy without a credential-bearing context and transformed output such as base64-encoded content remain outside the redaction guarantee.
- Raw `bash` access to protected paths is blocked through shell operand extraction. The guard covers partial shell globs, bare filenames, canonical symbolic-link aliases, and attached input/output redirections. `.pi/piagent-state/**` and `.pi/piagent-profile.json` are self-protected; use `piagent_context` and piagent task tools instead.
- External writes launched through guarded shell tools are confirmation-gated as well as direct provider tools. This includes GitHub CLI write actions and non-read-only `curl`/`wget` forms, including common execution wrappers; known read/list/GET forms remain non-interactive.
- Verify evidence is accepted only when it matches an observed Pi bash tool result after task start. The observed ledger is persisted under `.pi/piagent-state/observed-bash.jsonl`, so parent agents can validate bash results produced by guarded subagent processes.
- Observed command identity is retained as a SHA-256 hash while sensitive command text is redacted at both the in-memory and persisted evidence boundaries.
- Passing final gates require an observed exit `0` command that exactly matches one of the task/profile `verifyCommands`; ad-hoc commands such as `true`, `echo ok`, or `npm test || true` are advisory only.
- Project memory files are private-by-default in generated projects; opt in to shared memory only after review/redaction.
- It is not an OS sandbox or complete security boundary. It depends on the controlled tool paths and shell parsing that the platform observes, and it cannot stop another process with the same OS permissions from reading or writing outside the guard. For untrusted code, untrusted prompts, or adversarial workloads, run Pi inside an isolated container/VM with filesystem, process, network, and credential boundaries.
- Release verification audits the small helper dependency tree separately from the exact Pi host and pinned optional add-ons at the high-severity gate. Upstream lower-severity findings are still reported and tracked; a green helper-only audit is not treated as proof that the deployed runtime tree is clean.

Still requires project-specific validation for:

- high-risk production changes;
- provider/model changes with materially different behavior;
- complex parallel writer workflows;
- environments requiring hard filesystem, network, or process sandboxing outside Pi.

## Security reports

Report suspected vulnerabilities privately using the process in [SECURITY.md](SECURITY.md). Do not put live credentials, OAuth sessions, customer data, or exploit details in a public issue.

## License

MIT License. See [LICENSE](LICENSE).
