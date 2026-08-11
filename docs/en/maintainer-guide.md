# Maintainer guide

[Tiếng Việt](../vi/maintainer-guide.md)

## Placement rule

Before adding code, answer one ownership question:

| Question | Destination |
|---|---|
| Does it register a Pi hook, command, tool, or session UI? | `packages/piagent-core/runtime/` |
| Is it a deterministic policy or scoring decision? | A focused core service module; no Pi API or direct UI output |
| Does it persist local runtime evidence? | State service with owner-only mode and bounded retention |
| Does it integrate MCP? | `packages/piagent-core/mcp/` |
| Does it resolve profiles, packs, or locks? | `packages/piagent-core/capabilities/` |
| Is it a CLI command? | Thin `scripts/` entrypoint calling a package service |
| Is it project-specific? | Project profile/adapter, never `piagent-core` |

Do not create a `utils` dumping ground. Name a module after the capability it owns.

## Current split queue

### P0: composition root

`packages/piagent-core/extensions/piagent-guard.ts` remains the main architecture debt. It is 8,290 lines after the lifecycle extraction and may only shrink under the architecture gate.

Already extracted:

- `runtime/session/message-signals.ts`
- `runtime/session/runtime-state.ts`
- `runtime/session/system-prompt.ts`
- `runtime/session/usage.ts`
- `runtime/session/tool-result-compaction.ts`
- `runtime/input/chat-images.ts`
- `runtime/hooks/session-start-hook.ts`
- `runtime/hooks/session-hooks.ts`
- `runtime/hooks/input-hook.ts`
- `runtime/hooks/agent-start-hook.ts`
- `runtime/hooks/completion-hook.ts`
- `runtime/hooks/tool-call-hook.ts`
- `runtime/hooks/tool-result-hook.ts`
- `runtime/context/adaptive-planner.ts`
- `runtime/context/retrieval-route-policy.ts`
- `runtime/model/capabilities.ts`
- `runtime/model/model-route-types.ts`
- `runtime/model/model-route-policy.ts`
- `runtime/model/model-route-runtime.ts`
- `runtime/model/model-selection-provenance.ts`
- `runtime/tools/tool-groups.ts`
- `runtime/workflows/input-routing.ts`
- `runtime/workflows/task-intake.ts`
- `runtime/runtime-limits.ts`
- `extensions/task-journal.js`
- `extensions/task-runtime-audit.js`
- `extensions/repository-memory.js`
- `extensions/verification-intelligence.js`
- `extensions/execution-backend.js`

Next cohesive extractions:

1. Move the policy decision body now wired through `runtime/hooks/tool-call-hook.ts` into focused core services.
2. `runtime/tools/`: policy, task, context, memory, onboarding, profile, document, and source tools.
3. `runtime/commands/`: workflow, session, permission, context, MCP, profile, onboarding, and compatibility aliases.
4. Continue moving context, policy, onboarding, profile, and source-cache call sites behind their owning services; task audit and verifier selection already leave the composition root through focused services.

Target: the composition root stays below 500 lines and contains registration order plus a small shared runtime state object.

### P1: policy engine

Split `extensions/policy-core.js` by decision boundary:

- `policy/shell/tokenize.js`
- `policy/shell/expansion.js`
- `policy/path/match.js`
- `policy/path/candidates.js`
- `policy/exec/evaluate.js`

Keep one compatibility barrel until all internal imports move. Differential shell tests remain attached to the parser/matcher boundary.

### P1: Context Engine

Split `extensions/context-engine.js` into:

- `context/index/store.js`
- `context/index/policy.js`
- `context/retrieval/search.js`
- `context/retrieval/pack.js`
- `context/telemetry.js`
- `context/test-impact.js`

The index store owns SQLite and secure deletion. Retrieval never opens policy on its own; it receives an explicit resolved exclusion policy.

### P2: capability resolver

Split `capabilities/capability-core.js` into manifest validation, dependency resolution, permission projection, and lock integrity. Atomic file writes belong in an infrastructure module rather than the resolver.

### P2: benchmark runner

Split `scripts/benchmark-runner.mjs` into a thin CLI plus package modules for suite materialization, surface execution, evidence collection, grading, and report rendering. The CLI must not calculate a second version of a benchmark metric.

### P2: long documentation and tests

- Split the operator manual by install, daily workflow, session/usage, MCP, recovery, and reporting; keep an index at its stable path.
- Split `piagent-guard-integration.test.mjs` by runtime hook family while retaining shared harness helpers.
- Mirror each extracted source feature with one focused test file.

## Runtime composition rules

- Registration functions receive an explicit dependency object. They do not import mutable state from the composition root.
- Shared session state has one typed owner and is passed to hook/tool/command registrars.
- Tool and command aliases call the same handler; aliases do not duplicate behavior.
- UI formatting stays in runtime adapters. Policy services return structured decisions.
- Every file under `packages/piagent-core/runtime/` is listed in
  `capabilities/runtime-integrity.js`; the capability lock must pin executable
  runtime code before a release can pass.
- Every filesystem write declares path, mode, retention, and source of truth.
- Every derived metric names its inputs and has a unit test with a hand-computed example.
- Adaptive context changes must record the plan receipt, phase, lane, budget,
  model, thinking level, and confidence threshold in telemetry.
- Task recovery changes must keep task contract as operational truth and task
  journal as audit/replay truth; never let a derived checkpoint silently replace
  a valid contract.
- Recovery ceilings are cross-attempt invariants. New classifiers cannot grant
  mutation; policy must separately require source ownership, task scope, and
  hook authorization. Handoff/receipt state stores bounded references, never
  raw verifier logs or source.
- Resume changes must compare the actual current tree with exact-verifier
  evidence and fail closed on identity, journal, trajectory, handoff, or symlink
  integrity errors. Terminal Task Contract bytes remain immutable.
- Helper changes must preserve the pinned parent, one-writer invariant, strict
  RolePolicy/HelperRequest scope intersection, cross-process owned budget, and
  digest-only usage receipts. `on` may dispatch only read-only roles for GA;
  automatic worker delegation remains disabled.
- Operator projections must read persisted/observed truth, remain usable when
  old sidecars are missing, hash session identity, and leave unavailable
  timing/token/cost facts null. Formatting changes must preserve the structured
  schema/version and the explicit host-not-a-sandbox boundary.

## Change checklist

1. Put code in the owning layer.
2. Add or update the EN/VI pair for normative behavior.
3. Run `npm run architecture:check` before broad tests.
4. Run focused tests for the changed feature.
5. Run `npm run verify` before release.
6. Update both language files in the same commit when semantics change.

## Definition of done for the migration

- Composition root is at most 500 lines.
- No non-growth exception remains in `architecture/layers.json`.
- Core policy modules do not import runtime or CLI code.
- Every normative maintainer topic has an EN/VI pair.
- Full verification, package distribution, benchmark schema, and published docs gates remain green.
