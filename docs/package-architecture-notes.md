# Package architecture notes
<!-- language: en -->

This path is retained for stable links. The maintained architecture documents are:

- [Architecture (English)](en/architecture.md)
- [Architecture (Tiếng Việt)](vi/architecture.md)
- [Maintainer guide (English)](en/maintainer-guide.md)
- [Maintainer guide (Tiếng Việt)](vi/maintainer-guide.md)

The remaining notes below describe historical package decisions and should not be used as the current file-placement map.

## Mục tiêu

Pi Agent Platform được đóng gói như một reusable Pi package để dùng cho nhiều project mà không kéo theo rule nghiệp vụ của một repo cụ thể.

## Package shape

```text
packages/piagent-core/
├─ benchmark/
│  └─ benchmark-core.js    ← suite validation, scoring, reports
├─ capabilities/
│  └─ capability-core.js
├─ extensions/
│  ├─ piagent-guard.ts      ← extension entry point
│  ├─ guard-shell-analysis.ts
│  ├─ guard-types.ts
│  ├─ guard-io.js
│  ├─ policy-core.js
│  ├─ redaction-core.js
│  └─ runtime-evidence.js
├─ prompts/
├─ skills/
├─ subagents/
├─ policies/
└─ package.json
```

Root `package.json` expose:

- `pi.extensions`
- `pi.skills`
- `pi.prompts`
- `pi.subagents.agents`

`pi.extensions` names `piagent-guard.ts` explicitly instead of globbing the
directory. Pi loads every path the field matches and calls its default export as
an extension factory, so a glob would sweep in the modules the guard imports —
they export helpers, not a factory, and would fail to load. Anything added to
`extensions/` is a library module until it is named in the manifest.

Root CLI additionally exposes `piagent-capabilities` for catalog validation, profile resolution, lock verification, and dry-run action proposal validation.

## Design decisions

### 1. Prompts stay short

Workflow prompts define phase, required tools, output contract, and verification. Project-specific detail lives in `.pi/piagent-profile.json`, `.pi/project-context.md`, memory, and required context files.

### 2. Profile is the project adapter

Profiles hold protected paths, required context, verify commands, MCP capabilities, and hard gates. This keeps the core package reusable across frontend, backend, fullstack, data, DevOps, mobile, and docs projects.

### 3. Runtime state is local and auditable

Task state is stored under `.pi/piagent-state/` and also mirrored into Pi session custom entries when possible. This gives a file-based audit trail without requiring a database.

### 4. Source cache is read-only shared state

`piagent-source-cache` stores user-provided external repositories in a stable local cache. Agents read targeted files from the cache and never edit it directly.

### 5. Review guidance is project-local

`templates/project/REVIEW_GUIDELINES.md` gives each project a place to define review rules without changing the package.

### 6. Tool policy belongs in runtime

Prompt instructions are not enough for safety. The extension layer provides exec policy, tool policy, protected path checks, context budget checks, and final gates.

### 7. Benchmarking is scenario-based

Token/cost/quality improvements must be measured on repeatable project scenarios, not assumed from setup shape.

### 8. Capability selection is deterministic

Capability packs declare exact dependencies, owners, lifecycle, artifacts, permissions, activation, and eval identifiers. Project profiles grant the allowed boundary. Resolver output is stored in `piagent-profile.lock.json` with profile, pack, and artifact digests.

Manifest data never executes code. Invalid paths, symbolic links, dependency cycles, stale locks, and permission expansion fail validation.

## Adopted capabilities

| Capability | Implementation |
|---|---|
| Project onboarding | `/onboard run` + `piagent_project_onboarding_record` |
| Project context index | `/context` + `piagent_context_index_*` |
| Profile switching | `/profile` + `piagent_profile_options` / `piagent_profile_apply` |
| Explicit memory | `/memory` + `piagent_memory_*` |
| Task lifecycle | `/workflow task` + task/context/verify/trace tools |
| Platform workflow | `/workflow platform-improve` |
| Backend-readonly to frontend | `/workflow be-to-fe` |
| Source cache | `piagent-source-cache` + `piagent_source_checkout` |
| Subagent roles | `piagent-scout`, `piagent-planner`, `piagent-worker`, `piagent-reviewer`, `piagent-oracle` |
| Quality benchmark | `scripts/benchmark-runner.mjs` + `benchmark/benchmark-core.js`; legacy recorder: `scripts/quality-benchmark.sh` |
| Capability catalog | `packs/*/pack.json` + `catalog/capabilities.json` |
| Capability resolver | `capability-core.js` + `piagent-capabilities` |

## Deferred capabilities

- Hard final assistant hook if Pi exposes a stable extension hook.
- Project-specific worktree policy for parallel writer agents.
- Optional stronger sandbox layer for strict enterprise environments.
- Rich TUI dashboard for long-running usage and benchmark summaries.
