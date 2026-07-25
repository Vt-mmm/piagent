# Pi Agent Platform

Reusable Pi package for project onboarding, profile-based coding workflows, guarded tool usage, multi-agent orchestration, MCP setup, memory policy, and task verification.

Public docs: [piagent.io.vn](https://piagent.io.vn)

The goal is a simple daily flow:

```bash
cd /path/to/project
pi
```

From there, Pi can onboard the project, select an operating profile, use the right tools, record task evidence, and hand off verified implementation work.

For a trusted project where you want Pi to load project-local `.pi` resources without another trust prompt on that run:

```bash
cd /path/to/project
piagent-auto
```

Read-only scout mode:

```bash
piagent-auto --read-only -p "Scout payment mapping. Do not edit source."
```

Trusted full-access style run:

```bash
piagent-auto --full-access -p "Run the trusted local benchmark suite."
```

`piagent-auto` is a convenience wrapper for Pi project trust (`pi --approve`). It does not bypass protected-path checks, destructive shell checks, task gates, or verification evidence.

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

## Install

Supported for this release:

| Runtime surface | Team rollout status |
|---|---|
| macOS Apple Silicon (`darwin/arm64`) + Bash | Verified for this release. |
| Linux x64 + Bash | Verified in CI for this release. |
| macOS Intel (`darwin/x64`) + Bash | Supported target, but run `piagent-doctor` and project smoke tests before wide rollout. |
| Linux ARM64 + Bash | Supported target, but run `piagent-doctor` and project smoke tests before wide rollout. |
| Native Windows | Not a team-rollout target yet; terminal helpers and shell policy rely on Bash/POSIX semantics. |
| WSL2 | Experimental and not release-gated yet. |

Node.js `>=22.19.0` is required. Two commands:

```bash
npm install -g @piagent/platform
piagent-setup
```

`piagent-setup` installs the exact Pi Coding Agent host this release pins, installs the Pi package, initializes the current directory, and runs the doctor. Run it from the project you want to set up. It also installs the MCP baseline and subagents; pass `--no-mcp` and `--no-subagents` to skip them, or `--global-only` to install nothing into a project.

Because it is running from an installed package, the source it writes into `.pi/settings.json` is `npm:@piagent/platform@<version>`, which means the same thing on a teammate's machine.

To install each component explicitly instead — for a pinned team rollout where every step is reviewed:

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@1.0.1
piagent-install --stable --dry-run
piagent-install --stable
```

`piagent-install --stable` resolves the helper's release tag to a commit SHA and installs the matching Pi package. In its output, `currentRelease` is the version of the terminal helper currently executing. The project release matrix above defines which OS/CPU surfaces this platform has verified.

If you only need to install the Pi package and do not need the `piagent-*` terminal commands, pin the current release tag or a reviewed commit directly:

```bash
pi install git:github.com/Vt-mmm/piagent@v1.0.1
```

From a checked-out platform repo, the same helper is available as a script:

```bash
bash scripts/install-global.sh --stable --dry-run
bash scripts/install-global.sh --stable
```

For a full update, update the exact Pi host first, then the npm-global helper, then apply its matching stable Pi package:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@X.Y.Z
piagent-install --stable --dry-run
piagent-install --stable
```

For rollback, read the target release's compatibility section and install its exact Pi host before changing the helper to `vPREVIOUS`; older hosts may reintroduce known dependency findings. If you intentionally want to change only the Pi package while keeping the terminal helper at its current version:

```bash
piagent-install --version vX.Y.Z --resolve-tag --dry-run
piagent-install --version vX.Y.Z --resolve-tag
```

Use latest only for a personal machine or sandbox where fast updates are acceptable:

```bash
bash scripts/install-global.sh --dev --dry-run
bash scripts/install-global.sh --dev
```

Optional Herdr integration:

```bash
herdr integration install pi
```

## Uninstall

`piagent-uninstall` reports what it would remove and exits. It only acts with `--apply`, because it edits Pi settings that other tools also write to.

```bash
piagent-uninstall
piagent-uninstall --apply
```

That removes the Pi package this platform registered. Everything beyond it is opt-in:

```bash
piagent-uninstall --apply --with-addons              # pi-mcp-adapter, pi-subagents, pi-web-access
piagent-uninstall --apply --with-host                # the Pi Coding Agent host
piagent-uninstall --apply --project /path/to/project # a project's profile, lock, and runtime state
npm uninstall -g @piagent/platform                   # the npm-global helper, removed separately
```

Removal targets what is registered in Pi's settings rather than what the current version installs, so a package registered by an older release still comes out.

Credentials, trust decisions, sessions, todos, and project memory are never removed, at any flag combination. Files written from a template and then edited — `AGENTS.md`, `.pi/settings.json`, `.pi/project-context.md` and the like — are listed for review rather than deleted. A project's `.pi/settings.json` keeps every setting except the package entry pointing at this platform.

## Daily use

```bash
cd /path/to/project
pi
```

First run inside a project:

```text
/login
/model
/scoped-models      # optional: customize Ctrl+P model cycle
/piagent-commands
/mcp                # inspect MCP servers
/subagents-doctor   # health check
/onboard-project
/memory-policy
```

`/onboard-project` will inspect the repository with bounded context, recommend a profile, explain tradeoffs, ask before applying, then write:

- `.pi/piagent-profile.json`
- `.pi/piagent-profile.lock.json`
- `.pi/tech-stack.json`
- `.pi/tech-context/*`
- `.pi/project-context.md`
- `.pi/memory/*`

Switch profiles later:

```text
/profile                 # short status, no model follow-up
/profile list            # compact profile list
/profile fullstack       # apply immediately
/profile be-readonly-fe  # apply immediately
/profile web-frontend    # apply immediately
/profile backend-api     # apply immediately
/profile auto            # apply detected recommendation
/profile fe              # alias for web-frontend
/profile be-fe           # alias for be-readonly-fe
/profile setup           # select profile, then select role tech
/profile setup fullstack # select FE, BE, and database tech
/profile tech            # short tech stack status
/profile tech setup fullstack
/profile tech apply fullstack frontend=nextjs backend=nestjs database=prisma
```

The setup flow prefers native select UI. If the Pi host does not expose a select control yet, it falls back to a compact options card and an exact `/profile tech apply ...` command instead of asking the model to explain every option.

## Capability packs

Capability packs group governed prompts, skills, subagents, policies, adapters, recipes, and eval scenarios behind a declarative manifest. Project profiles select exact pack versions and explicitly grant owner, lifecycle, filesystem, network, and external-action boundaries.

```bash
piagent-capabilities catalog --check
piagent-capabilities doctor \
  --profile .pi/piagent-profile.json \
  --lock .pi/piagent-profile.lock.json
piagent-capabilities resolve \
  --profile .pi/piagent-profile.json \
  --output .pi/piagent-profile.lock.json \
  --package-source ../
```

The generated lock is deterministic and records profile, pack, artifact, and permission digests. See [Capability packs](docs/capability-packs.md).

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

### General implementation

```text
/task Implement <bounded task>. Follow profile, required context, protected paths, verify commands, and trace.
```

Use `/task` when the requirement is clear enough to implement.

### Guarded Git workflows

Pi Agent intentionally keeps Git as a capability instead of adding a `/git-*` namespace. Use short workflow commands or natural language:

```text
/commit docs: update onboarding notes
/pr Add guarded git workflow
```

`/commit` starts a governed local-commit workflow: inspect status/diff, stage only the intended files, run relevant verification, then commit locally. It does not push.

`/pr` starts a governed pull-request workflow: inspect branch/status/commits, handle uncommitted changes explicitly, then ask for confirmation before any `git push` or GitHub PR create/update action. Draft PRs are the default unless the user asks for ready-for-review.

Broad staging commands such as `git add .`, `git add -A`, `git add --all`, `git add -- .`, and `git add :/` require confirmation so unrelated or private files are not swept into a commit silently.

For read-only investigation:

```text
/scout Scout <module/spec/contract/risk>. Do not edit source.
```

Use `/scout` for payment/auth/data/BE-contract mapping before deciding whether to implement.

When the current session is already heavy, use the fresh workflow commands. They open a new governed Pi session and replay the compact workflow prompt automatically:

```text
/fresh-task <request>
/fresh-scout <read-only request>
/fresh-be-to-fe <backend-readonly/frontend request>
```

The input guard also collapses pasted mandatory-flow boilerplate automatically. Users should not paste the full piagent checklist into every task.

### Screenshots and local images

If a chat box paste or screen capture produces a local image path instead of a native Pi image attachment, paste the path directly in the task:

```text
/scout Check this UI state from screenshot /var/folders/.../screenshot.png
```

The input guard converts supported local image paths (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`) into Pi image attachments and rewrites the prompt to:

```text
/scout Check this UI state from screenshot [image1]
```

Limits: up to 4 chat images, 8 MB each. For oversized images, use Pi's `read` tool on the file so Pi can resize it.

### Project improvement

```text
/platform-improve Improve <platform/setup/workflow behavior>. Update docs and verification.
```

Use `/platform-improve` for package-level work such as setup, MCP, model scope, memory, runtime policy, prompts, skills, or subagent workflows.

### Backend spec to frontend

```text
/profile be-readonly-fe
/be-to-fe Implement frontend support for <backend endpoint/spec>. Backend is read-only.
```

Use `/be-to-fe` when the backend/spec must be inspected read-only and the implementation target is frontend.

### Planning and clarification

```text
/discuss <rough request>
/plan <goal>
/review current diff
```

## Model selection

Model selection is handled by Pi’s native UI.

```text
/model          # selector
Ctrl+L          # selector hotkey
/scoped-models  # edit model cycle scope
Ctrl+P          # cycle scoped models
Shift+Tab       # cycle thinking level when supported by the selected model
```

Global setup can seed `enabledModels`. To inspect or re-apply:

```bash
piagent-models
piagent-model-scope --preset full
```

## MCP setup

Global setup installs `pi-mcp-adapter` and seeds the `core` MCP preset unless disabled.

```bash
piagent-mcp --preset core --scope global --replace
piagent-mcp --preset popular --scope global --replace
piagent-mcp --preset design --scope project --project /path/to/project
piagent-mcp --list
```

If the repo is cloned from Git and npm bins are not linked yet:

```bash
bash /path/to/piagent/scripts/configure-mcp.sh --preset core --scope global --replace
```

Preset summary:

| Preset | Includes |
|---|---|
| `core` | Context7, Chrome DevTools, GitHub |
| `popular` | core + Playwright + Figma remote |
| `all` | popular + Figma desktop/local |

Keep secrets in environment variables, never in committed config:

```bash
export CONTEXT7_API_KEY=ctx7sk_...
export GITHUB_PERSONAL_ACCESS_TOKEN=<github-token>
```

## Subagents

Global setup installs `pi-subagents` and applies the `safe` preset unless disabled.

```bash
piagent-subagents --preset safe
```

Fallback when cloned from Git without npm bins:

```bash
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

Common Pi commands:

```text
/subagents-doctor
/subagents-models
/subagents-fleet
/subagent-cost
/run piagent-scout "Map the auth flow. Read-only."
/run piagent-planner "Plan implementation from context.md."
/run piagent-worker "Implement the approved plan."
/run piagent-reviewer "Review current diff."
```

Daily task prompts are solo-first: they can delegate bounded scout/planning/review work when useful, and the final handoff should state whether subagents were used and why.

Optional web/docs research support:

```bash
pi install npm:pi-web-access@0.13.0
```

## Optional preseed setup

Most projects do not need shell init. Use this only when you want to pre-create `.pi` files in a repo or bootstrap team templates:

```bash
bash /path/to/piagent/scripts/setup.sh /path/to/project \
  --profile be-readonly-fe \
  --package-source git:github.com/Vt-mmm/piagent@v1.0.1 \
  --mcp-preset core \
  --subagents-preset safe
```

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

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run typecheck
npm test
npm run benchmark:redaction
bash scripts/verify-local.sh
bash scripts/team-doctor.sh . --strict-share
pi list --approve
```

Quality benchmark:

```bash
bash scripts/quality-benchmark.sh /path/to/project --init
bash scripts/quality-benchmark.sh /path/to/project --record \
  --scenario bounded-source-fix \
  --surface pi \
  --result pass \
  --tokens 12345 \
  --verify "npm test"
```

Sensitive-data redaction benchmark:

```bash
npm run benchmark:redaction
```

Usage / token follow-up:

```text
/task-preflight
/task-preflight compact
/piagent-usage
/session
```

From another terminal:

```bash
piagent-usage /path/to/project
bash scripts/pi-session-stats.sh /path/to/project
```

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

The current package version is read from package metadata and release tags. Personal machines may follow the unpinned package source when accepting ongoing updates; production/team quickstarts and committed project settings should pin an explicit tag such as `v1.0.1` or a reviewed commit.

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
