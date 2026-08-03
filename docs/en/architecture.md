# Pi Agent Platform architecture

[Tiếng Việt](../vi/architecture.md)

## Goals

The platform is a reusable Pi harness, not a project-specific application. Its architecture must keep four properties visible in code:

1. Policy decisions are testable without starting Pi.
2. Pi lifecycle hooks compose features; they do not own every feature implementation.
3. Local state, MCP, process, and filesystem access stay behind explicit adapters.
4. Project-specific business rules remain in project profiles and adapters, outside core.

## Dependency direction

```text
entrypoints/scripts
        |
        v
composition: extensions/piagent-guard.ts
        |
        +--------------------+
        v                    v
runtime adapters        integrations
        |                MCP / capabilities
        v                    |
core services <-------------+
policy / task / context / security
```

Dependencies point downward. Core services never import the Pi composition root or runtime adapters. Runtime adapters may call core services and integrations. Only the composition root registers the complete Pi extension.

The machine-readable rule is `architecture/layers.json`; `npm run architecture:check` enforces it.

## Physical layers

| Layer | Current location | Owns | Must not own |
|---|---|---|---|
| Composition | `packages/piagent-core/extensions/piagent-guard.ts` | Wiring, dependency construction, registration order | Feature algorithms, mutable state implementations, large formatters |
| Runtime adapters | `packages/piagent-core/runtime/` | Pi lifecycle hooks, shared session state, command/tool registration, input routing | Reusable policy decisions |
| Core services | `packages/piagent-core/extensions/` except the entrypoint | Policy, context, task lifecycle, state services | Pi command menus and UI text |
| MCP integration | `packages/piagent-core/mcp/` | MCP config layers, readiness, approval, command actions | Task and context policy |
| Capabilities | `packages/piagent-core/capabilities/` | Profile resolution, pack validation, locks, source roots | Pi session lifecycle |
| Security foundation | `packages/piagent-core/security/` | Sensitive-data primitives | Workflow behavior |
| Benchmark | `packages/piagent-core/benchmark/`, `benchmarks/` | Suite validation, scoring, evidence | Runtime enforcement |
| Entrypoints | `scripts/` | CLI arguments and use-case invocation | Duplicate domain logic |
| Product assets | `prompts/`, `skills/`, `subagents/`, `adapters/`, `packs/`, `schemas/` | Declarative behavior and contracts | Hidden runtime state |

`extensions/` still contains several historical service modules. The name is legacy; only `piagent-guard.ts` is loaded as a Pi extension. Services move by cohesive feature, with compatibility preserved until the migration is complete.

## Runtime flow

1. Pi loads the single extension entrypoint.
2. Composition resolves base policy, project profile, capability lock, and local session state.
3. Runtime hooks normalize input and collect session evidence through one session-scoped state owner.
4. Core services decide path, shell, MCP, task, context, and final-gate policy.
5. Runtime adapters register concise tools and slash commands.
6. Owner-only local state records evidence; prompts remain guidance rather than the enforcement boundary.

## State ownership

| State | Owner | Location | Commit |
|---|---|---|---:|
| OAuth and provider auth | Pi/provider | user config | No |
| Platform install config | Piagent installer | global Pi settings | No |
| Project profile and lock | Project | `.pi/piagent-profile*.json` | Yes |
| Task, trace, telemetry, captures | Runtime | `.pi/piagent-state/` | No |
| Session history | Pi | Pi session store | No |
| Shared project instructions | Project | `AGENTS.md`, project docs | Yes |

No feature may create a second authoritative representation of the same state. Derived indexes carry a policy digest and must be rebuildable from their source of truth.

## File boundaries

- New runtime modules: at most 500 lines.
- New core modules: at most 1,000 lines.
- CLI entrypoints: at most 800 lines; move use cases into package modules.
- Existing larger files have explicit non-growth budgets in `architecture/layers.json`.
- Tests mirror the feature path and test public behavior, not private implementation order.

The current split queue and ownership rules are in the [maintainer guide](maintainer-guide.md).
