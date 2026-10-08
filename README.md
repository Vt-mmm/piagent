# Pi Agent Platform

[Tiếng Việt](README.vi.md)

Reusable Pi package for freeform coding chat, guarded tools, project context and a managed main/research/review harness.

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
| WSL2 (Windows) | The way to run Piagent on Windows: company mode with the bubblewrap sandbox and Agent Watch for Windows, and personal mode. One PowerShell command installs everything; the Linux sandbox is checked in CI. See [Windows](docs/en/windows.md). |
| Native Windows | Preview of personal mode: the guard, path and dashboard tests run in CI on Windows; `piagent-update` does not run there yet. See [Windows](docs/en/windows.md). |

Pinned step-by-step rollouts, updates, rollback, and the fast-moving `--dev` channel are in [Release and install policy](docs/release-install-policy.md).

## Daily use

```bash
cd /path/to/project
pi
```

Send the request directly in plain language. Since 1.9.0 there is no `/task` or `/workflow` step, no task contract and no projected token-saving threshold.

For the local macOS team harness, import a managed key through Agent Watch and run `piagent studio` or `piagent studio --web`. Studio chooses the main/research/review routes; the member chooses thinking. Managed sessions have isolated tools and per-run authority. Personal sessions keep their own OAuth and model picker under `pi`.

See [local acceptance and remaining release gates](docs/managed-local-acceptance.md). Existing direct CLI keys remain compatible and do not gain managed harness enforcement.

## Uninstall

`piagent-uninstall` reports what it would remove and exits. It only acts with `--apply`, because it edits Pi settings that other tools also write to.

```bash
piagent-uninstall
piagent-uninstall --apply
```

That removes the Pi package this platform registered. Add-ons, the Pi host, a project's state, and the npm-global helper are each opt-in and separate — `piagent-uninstall --help` lists them.

Removal targets what is registered in Pi's settings rather than what the current version installs, so a package registered by an older release still comes out. Credentials, trust decisions, sessions, todos, and project memory are never removed, at any flag combination. Files written from a template and then edited — `AGENTS.md`, `.pi/settings.json`, `.pi/project-context.md` and the like — are listed for review rather than deleted.

## What it provides

- Global Pi package with runtime commands, skills, guard extensions, and piagent subagents.
- Freeform turns: a request in plain language is the whole interface. Scouting, planning, review, commits and pull requests are ordinary requests.
- Project onboarding on request: ask the agent to inspect the project read-only and record its context, and it writes `.pi/project-context.md`.
- Runtime profile selection via `/profile`, plus select-style tech stack setup via `/profile setup` and `/profile tech`.
- Runtime usage controls via `/usage`, plus Pi native `/name`, `/new` and `/session`.
- Explicit project memory via `/memory` or `/memory-policy` and `piagent_memory_*` tools.
- Local Context Engine controls via `/context`: incremental code index, hybrid search, token-budgeted packs, bounded current-turn source/test snapshots for automatic tasks, test impact, efficiency telemetry, and semantic compaction. Index storage is owner-only and securely purged when exclusion policy changes; manual packs remain advisory, while current-turn snapshots are freshness-checked and exact edits fail closed on a later mismatch.
- MCP setup helpers for Context7, Chrome DevTools, GitHub, Playwright, and Figma.
- Subagent setup helpers for read-only scouting, planning, implementation, review, and risk challenge.
- Chat image-path intake: paste a screenshot path from the project or a granted `additionalReadRoots` directory and the guard attaches it as `[image1]` before the model sees the prompt.
- Trusted-run wrapper: `piagent-auto` launches Pi with `--approve` for the current run while keeping piagent guardrails active.
- Fresh-task capability routing: `piagent-route` explains a catalog-verified low/medium/high/ultra recommendation; provider execution requires explicit `--execute --yes`, while in-extension auto routing remains fail-closed.
- Runtime policy tools:
  - `piagent_permission_status`
  - `piagent_exec_policy_check`
  - `piagent_context_budget`
  - `piagent_tool_policy_check`
  - `piagent_usage_snapshot`
  - `piagent_context_preflight`
  - `piagent_orchestration_policy`
- Context7-ready tech stack manifest and concise `.pi/tech-context/*` snapshots for selected profile roles.
- Accident-brake guardrails for protected and read-only paths, destructive shell commands, external-provider actions, large-file edits, and edits made against a stale read.
- Task contracts and workflow commands were retired in 1.9.0: a session no longer
  creates a contract, scope, acceptance receipt or final gate. Task records left
  under `.pi/piagent-state/tasks` by earlier releases stay readable as history.
- Adaptive context planning uses Pi-reported model/thinking/context facts to set
  a bounded context budget; cited repository-memory hints never replace current
  source reads. The parent model stays operator-pinned—there is no automatic
  parent routing or solver in this stabilization baseline.
- Execution backends are explicit and fail closed: host execution is the
  default, while a requested isolation backend without an installed adapter
  blocks mutation instead of silently using the host.
- Bounded owner-only local state with cross-process JSONL rotation and a shared
  symlink-safe boundary for task evidence, telemetry, traces, and captures.
- Two-tier one-command benchmark: `core-v1` is a fast paired smoke gate, while
  `production-v1` runs 18 generated scenario families across backend, frontend,
  data, platform, reliability, and security. It compares Piagent with Raw Pi or
  controlled `codex-cli`, grades hidden acceptance/safety/workflow evidence,
  reports category/lifecycle/profile bands and 95% token-ratio confidence, and
  reads exact JSONL usage plus privacy-safe tool histograms. Production claims
  require zero retries; diagnostic retry overrides remain visible and fail the gate.
- `deep-logic-v1` adds seven large, generated-variant families for interacting
  state, orchestration, policy, context-graph, stream-recovery,
  transactional-config, and exact temporal-billing invariants. It locks
  Piagent/`codex-cli` to Luna/medium and uses three repeats (42 paired sessions) with token, duration,
  full-suite, and zero-retry gates. A separate provider-free WebUI
  parity gate proves the 31 runtime-control paths before any model quota is
  used (workflow ingress was retired in 1.9.0).
- The public `v1.6.0` production-v1 run
  `production-v1-20260824T040017Z-05b7cf`, on exact commit
  `3bba8f0b3ff521bc2a355e1f6bef6d1bbdc09511` with GPT-5.6 Luna Medium,
  measured 108 sessions. Piagent resolved 54/54 tasks versus 48/54 for
  `codex-cli`. Its primary fixed-workload family fresh-token ratio was `0.3857`
  (61.43% lower), with a 95% interval of `0.3073..0.4840`; the upper bound
  supports the conservative statement of at least 51.60% fewer fresh tokens on
  this predeclared workload and exact release. Usage was exact for all 108
  sessions and no retry occurred. See the
  [benchmark evidence](https://piagent.io.vn/benchmark) and
  [methodology](docs/quality-benchmark.md).
- Built-in profiles for frontend, backend, fullstack, BE-readonly/FE-write, data, DevOps, mobile, docs, Python, and Node TypeScript.
- Versioned capability packs with deterministic catalog, profile resolution, integrity lock, and permission checks.

## Permission profiles

Project profiles can declare a runtime `permissionProfile`:

| Profile | Use when | Guard behavior |
|---|---|---|
| `read-only` | Scout, audit, review | Allows `read`, `grep`, `find`, `ls`, and piagent state tools; blocks shell, `write`/`edit`/`apply_patch`, and unknown tools. |
| `workspace-write` | Normal implementation | Default profile. Keeps protected-path, read-only-path, shell and capability checks, and asks before destructive or external actions. |
| `trusted-full-access` | Trusted local automation | Expands workspace tool/scope autonomy, but still enforces protected paths, secret redaction, capability lock integrity, and destructive/external confirmation. |

For one run, set `PIAGENT_PERMISSION_PROFILE=read-only|workspace-write|trusted-full-access`, or use `piagent-auto --read-only`, `--workspace-write`, or `--full-access`.

Inside an active Pi session, use `/permission` for the menu or a session-local switch:

```text
/permission
/permission status
/permission read-only
/permission workspace-write
/permission full-access
/permission full-access Implement the requested trusted repo task.
```

Legacy aliases still work: `/permission-status`, `/read-only`, `/workspace-write`, and `/full-access`. Full-access also accepts a task after the command. The guard switches the current session to `trusted-full-access`, then forwards the remaining text as the next user request.

## Parent-direct orchestration

The parent model owns reasoning, implementation, and verification. When helpers are enabled it may delegate up to two fresh read-only helpers, such as an independent research question or a review of its patch. Token-saving estimates are telemetry, not an admission requirement. Helpers never implement, inherit parent history, spawn nested helpers, or retry a deterministic failure.

Inside Pi:

```text
/piagent-orchestration
```

This shows the active mode, helper ceiling, review lenses, Field Guide path, writer policy, and dispatch/skip evidence without triggering a model follow-up.

Source work is freeform: the model reads, edits and runs the project's checks
directly, with no contract, declared scope or final gate. The guard still
enforces protected and read-only paths, the permission profile, the context
budget for large files and stale read-to-edit snapshots, and asks before
destructive or external actions. In the managed company harness the plan,
check and review steps per turn are set by the team's Harness in Studio.

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

Work is requested in plain language; the commands below are settings and read-only views typed inside a Pi session, and none of them starts a model turn. [Command reference](docs/command-reference-vietnamese.md) explains each one.

| Command | Use when |
|---|---|
| `/profile` | Show or apply the project profile; `/profile setup` selects the tech for each role. |
| `/permission` | Show or switch the session permission profile. |
| `/context` | Context Engine index, search, packs, test impact and compaction. |
| `/usage` | Session, model, thinking and context usage; `/usage logs` shows compacted tool output. |
| `/memory` | Explicit project memory. |
| `/piagent-mcp` | MCP servers, scopes and approvals. |
| `/piagent-status` | Profile, guard, runtime and authenticated model state. |
| `/piagent-inspector` | One read-only menu for the session diff, commands and failures, safety warnings, and context budget. A four-row panel is always shown beside Pi's native footer and can be hidden for the session with `toggle`. |

The workflow commands (`/workflow`, `/task`, `/scout`, `/fresh`, `/onboard`, `/commands`, `/model-options`) were retired in 1.9.0. Say what you want instead — "scout the payment flow read-only, do not edit", "review the current diff", "commit these two files". For a heavy session, start a new one with Pi's `/new`.

Git stays a capability rather than a `/git-*` namespace, so natural language works. `git push`, GitHub writes and publishing ask for confirmation first. Broad staging — `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/` — requires confirmation, so unrelated or private files are not swept into a commit silently.

Paste a screenshot path straight into a task and the guard attaches it as `[image1]` before the model sees the prompt: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, up to 4 images at 8 MB each. The target must be inside the project or a directory listed in `additionalReadRoots`; protected paths, paths outside the resolved filesystem read scope, symlink escapes, and extension-only fake images are refused. Pasted text reaches the model as typed; there is no checklist to paste.

Web research and image understanding remain separate capabilities. The pinned `pi-web-access` integration uses the authenticated `openai-codex` route first when it is available and keeps its automatic search fallback; it never copies provider credentials into project or browser state. Images are passed as native image input to the selected session model rather than through a Piagent-owned OCR service. The dashboard reports both effective facts under **Settings → Providers & models**: `Codex Web Search` when that route is ready, and `Codex Vision` only when the current Codex model advertises image input.

The Session Hub can attach browser-selected images and documents to a new or existing conversation. Markdown, text, PDF and DOCX files use bounded local extraction; the chat keeps a compact file card while the project **Documents** workspace provides a readable preview without starting a model turn. Files over the direct-send limit stay in the project workspace instead of being copied into a prompt, and protected paths, redaction, session binding and one-shot attachment references remain enforced by the runtime.

A spec that lives outside the project — the one just downloaded to `~/Downloads` — is read with `piagent_document_read` once its directory is listed in the profile's `additionalReadRoots`. The grant is read-only, covers `.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.pdf`, and `.docx` only, and does not open anything `protectedPaths` covers. See [command reference](docs/command-reference-vietnamese.md).

## Model selection

Handled by Pi's native UI: `/model` or `Ctrl+L` to pick, `Ctrl+P` to cycle the scoped set, `Shift+Tab` to cycle thinking level where the model supports it. Global setup seeds `enabledModels`; see [Model options](docs/model-options.md) to inspect or re-apply it.

## MCP setup

`piagent-setup` and `piagent-install` both install `pi-mcp-adapter` and seed the `core` preset. Pass `--no-mcp` to skip it.

| Preset | Includes |
|---|---|
| `core` | Context7, Chrome DevTools, GitHub |
| `popular` | core + Playwright + Figma desktop/local |
| `all` | popular + Figma remote (requires an approved Figma MCP client) |

Seeding writes server definitions; it does not start or authenticate anything. Servers connect lazily, so each one needs its own prerequisite before its first call: Chrome DevTools needs a local Chrome, and GitHub needs Docker running plus `GITHUB_PERSONAL_ACCESS_TOKEN` exported. `piagent-mcp --list` prints what each server requires. Project-scope `.mcp.json` files ship empty on purpose — the shared baseline is the global config, not the project one.

Keep provider keys in environment variables, never in committed config. Switching presets and per-project scoping: [MCP and tools](docs/mcp-and-tools.md).

## Subagents

`piagent-setup` installs the optional `pi-subagents` compatibility runtime with a clamped `safe` preset. Daily tasks stay parent-direct; builtin agents and workers are disabled, and helper mode allows up to two read-only helpers. The inspector states dispatch/skip reasons.

`/subagents-doctor` runs a health check. See [Subagents and multi-agent](docs/subagents-and-multiagent.md) for the read-only helper opt-in contract.

## Repository layout

```text
piagent/
├─ architecture/                      machine-readable layer and file budgets
├─ adapters/                         reusable project profiles
├─ catalog/                          deterministic capability index
├─ docs/                             EN/VI canonical docs plus stable operating guides
├─ evals/                            governed evaluation scenarios
├─ packs/                            versioned capability manifests and recipes
├─ packages/
│  ├─ piagent-core/                  Pi package: extensions, runtime, skills, managed harness
│  └─ piagent-webui/                 dashboard: contracts, client, server, gateway, ownership
├─ schemas/                          JSON schemas
├─ scripts/                          setup, doctor, verification helpers
└─ templates/                        project/global templates
```

`piagent-core` is the Pi extension and runs headless on its own. `piagent-webui` is the
`piagent dashboard` surface — a separate dependency spine that reads the platform but is
never read by it, so the runtime keeps working with the dashboard absent. Both layer maps
are enforced by `npm run architecture:check`; see [Architecture](docs/en/architecture.md).

## Verification

One command runs the full local gate — typecheck, tests, capability catalog, doctor, and the scaffold check:

```bash
npm run verify
```

Individual checks and the contributor flow are in [CONTRIBUTING.md](CONTRIBUTING.md). Token and session follow-up is `/usage` inside Pi; see [Usage observability](docs/usage-observability.md). Run the zero-provider WebUI/Terminal gate with `npm run benchmark:webui-parity`; preview the deeper Piagent/`codex-cli` Luna-medium suite with `npm run benchmark:deep -- --dry-run`. Preview the smoke benchmark with `piagent-benchmark --dry-run`; preview the 108-session production gate with `piagent-benchmark --production --dry-run`. Scoring, isolation, confidence, and quota details are in the [Quality benchmark guide](docs/quality-benchmark.md).

## Public safety

This repository intentionally excludes:

- OAuth tokens and `auth.json`;
- `.env` files;
- MCP API keys and provider tokens;
- Pi sessions, todos, caches, and local trust files;
- project-private data dumps;
- local machine paths.

## Documentation

- [Documentation language index](docs/README.md)
- [Architecture (English)](docs/en/architecture.md)
- [Architecture (Tiếng Việt)](docs/vi/architecture.md)
- [Maintainer guide (English)](docs/en/maintainer-guide.md)
- [Maintainer guide (Tiếng Việt)](docs/vi/maintainer-guide.md)
- [Public docs site (VI/EN)](https://piagent.io.vn)
- [Static team docs site](docs-site/index.html) — bilingual output generated from `docs-site/content/`, preview with `npm run site:preview`
- [Changelog](CHANGELOG.md)
- [Vercel docs site deploy](docs/vercel-docs-site.md)
- [Operator manual tiếng Việt](docs/operator-manual-vietnamese.md)
- [Quickstart tiếng Việt](docs/quickstart-vietnamese.md)
- [Command reference tiếng Việt](docs/command-reference-vietnamese.md)
- [Pi Context Engine](docs/context-engine.md)
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
- [Task lifecycle tiếng Việt](docs/task-lifecycle-vietnamese.md) (historical, before 1.9.0)
- [Task implementation contract](docs/task-implementation-contract.md) (historical, before 1.9.0)
- [Runtime quality baseline](docs/runtime-quality-baseline.md)
- [Usage observability](docs/usage-observability.md)
- [Model options](docs/model-options.md)
- [Quality benchmark guide](docs/quality-benchmark.md)
- [Sensitive-data redaction benchmark](docs/security-redaction-benchmark.md)
- [Runtime policy design](docs/runtime-policy-design.md)
- [Security threat model](docs/security-threat-model.md)
- [Package architecture notes](docs/package-architecture-notes.md)

## Maturity

The current package version is read from package metadata and release tags. Personal machines may follow the unpinned package source when accepting ongoing updates; production/team quickstarts and committed project settings should pin an explicit tag such as `v1.19.0` or a reviewed commit.

Ready for:

- global Pi setup;
- project onboarding;
- profile-driven guarded implementation tasks;
- read-only scouting and planning;
- backend-readonly/frontend-write workflows;
- bounded subagent scouting, planning, implementation, and review;
- runtime checks for exec policy, context budget, context preflight, tool policy, and usage snapshot;
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
- Raw `bash` access to protected paths is blocked through shell operand extraction. The guard covers partial shell globs, bare filenames, canonical symbolic-link aliases, and attached input/output redirections. `.pi/piagent-state/**` and `.pi/piagent-profile.json` are self-protected; use `piagent_context` and the piagent tools instead.
- External writes launched through guarded shell tools are confirmation-gated as well as direct provider tools. This includes GitHub CLI write actions and non-read-only `curl`/`wget` forms, including common execution wrappers; known read/list/GET forms remain non-interactive.
- Observed bash results are persisted under `.pi/piagent-state/observed-bash.jsonl`, so parent agents can check results produced by guarded subagent processes. Command identity is kept as a SHA-256 hash while sensitive command text is redacted at both the in-memory and persisted boundaries.
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
