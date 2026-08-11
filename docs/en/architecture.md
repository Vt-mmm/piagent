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
4. Core services decide path, shell, MCP, task, context, recovery, memory, verification, and final-gate policy.
5. Runtime adapters register concise tools and slash commands.
6. Owner-only local state records evidence; prompts remain guidance rather than the enforcement boundary.

## Adaptive durable runtime

The current runtime has six operational/derived state layers:

| Layer | Source of truth | Derived state |
|---|---|---|
| Task contract | `.pi/piagent-state/tasks/*.json` | Session binding, final gate projection |
| Task journal | `.pi/piagent-state/task-journal/events.jsonl` | Replay snapshot, checkpoint resume view |
| Trajectory | Task Contract v2 plus observed lifecycle/tool evidence | `.pi/piagent-state/trajectory/*.json` current phase and bounded transition replay |
| Recovery handoff | Contract, verified journal, trajectory, current tree, and exact-verifier evidence | `.pi/piagent-state/handoffs/*.json` bounded reconstruction projection |
| Context index | Repository files plus resolved exclusion policy digest | SQLite FTS/search pack, context efficiency report |
| Repository memory | Cited facts/decisions with file digests and expiry | Advisory retrieval hints only |

The task journal is owner-readable, hash chained, and sequence numbered. Runtime
records task start/progress, observed mutation, verifier, and completion
checkpoints. Writes are append-only between bounded retention compactions; each
compaction re-hashes the retained chain and stores the removed-prefix and prior
head hashes as retention anchors. A normal task write does not trust the journal
as operational state. Resume decisions use the current task contract first and
the verified journal second; corruption blocks automatic resume for review.
The journal hash chain and acceptance receipts are same-runtime operational
evidence, not independent attestation or a separate audit authority.

Recovery is classification-driven and bounded across task attempts. Only an
in-scope source-owned failure may receive one repair pass; transient verifier or
provider failures receive at most one exact retry and never source-mutation
authority. Environment, permission, policy, scope, and unknown failures stay
non-mutating. `PIAGENT_AUTO_RECOVERY=off` restores ordinary P3 handoff behavior
without migrating state. Every final path writes a redacted Handoff v1
projection from operational truth. Resume binds task/session identity, journal
integrity, trajectory phase, current-tree digest, and exact verifier evidence;
a post-verify edit invalidates the old pass, while corrupt or symlink-unsafe
state blocks mutation. Acceptance criteria remain the completion truth; an
optional runtime-observed provenance block only distinguishes first-pass,
repaired, blocked, partial, and failed outcomes using bounded references.

Semantic specialist review is a separate strict-high-risk CAP-13 path, not a
universal parser-driven recovery path. It is pinned to one shared continuation,
one current-tree diff, two targeted reads, exact eligible source/test paths, and
the configured verifier after any mutation. Denied, failed, no-op, stale,
out-of-scope, unsupported, or exhausted work locks the opportunity and hands
off. Broad-default observation/advice never schedules this review or blocks a
tool call.

The Adaptive Context Planner runs before auto context injection. It uses the
classified workflow phase, risk lane, explicit paths, current context pressure,
Pi-reported model identity, and thinking level to choose a hard token budget and
file limit. It never switches model/provider. No local semantic reranker is
shipped yet, so the plan reports `reranker: off` even if a legacy environment
flag is present. Each injected pack carries a receipt so reports can explain why
those paths entered context.

Task Contract v2 also carries an additive Criterion Graph v1 planning
projection. It maps every operator criterion exactly once to a closed planning
kind, scoped target hints, proof kinds, and dependency order. The graph has no
`satisfied` state and cannot override acceptance or exact-verifier truth. It
selects relevant in-scope context before older observations, survives
compaction/resume by digest, and adds no tool-schema change or provider follow-up
turn. `PIAGENT_INTELLIGENCE_ENGINE=off` selects the mechanical control for
causal tests and emergency rollback; new tasks otherwise use the criterion
engine and pin its mode/digest in the task contract.

Completed tasks may add a short-lived, cited retrieval fact. A later turn can
inject at most the memory hints that fit inside the context plan's unused token
budget; current repository files remain authoritative.

Trajectory is phase evidence, never a second completion outcome. The solver may
recommend a path, while observed Task Contract and tool evidence own transitions
through `intake`, `scout`, `plan`, `execute`, `verify`, `repair`, `review`,
`handoff`, and `terminal`. `/piagent-status` and `/task-preflight` expose the
current phase. Corrupt or symlink-unsafe trajectory state disables phase-tool
enforcement and reports recovery instead of guessing.

`PIAGENT_PHASE_TOOLS=off|shadow|on` controls phase enforcement. `shadow` is the
default and records intended differences without changing behavior; `on` keeps
one cache-stable provider-visible tool schema and enforces the current phase at
the tool-call guard; `off` disables that phase decision even when sidecars
exist. Automatic source tasks enter `execute` only when their runtime-owned
contract has a dependency-ready `single-writer` step, exact verifier, bounded
scope, and acceptance receipt. Manual and high-risk tasks remain discovery-only
through their plan/challenge checkpoints. Tool visibility is not authorization:
scope, read-only, protected-path, destructive, and external-action guards remain
active in every mode and for every mutation path. Piagent state/project mutators
use Pi 0.84.1 native sequential execution metadata, pure reads remain
parallel-safe, and Pi retains its native per-file mutation queue. No custom
runtime lock is acquired in authorization hooks.

Acceptance assurance and semantic repair have independent off-only rollback
switches. Turning acceptance assurance off also turns dependent semantic repair
off; turning semantic repair off leaves phase, acceptance observation, and
recovery intact. Strict semantic repair requires enforced phase and recovery
authority, and combined automatic dispatch authority is capped at one unit per
task. These interaction checks are snapshot-bound and cannot change the
provider-visible tool schema.

Piagent-owned helpers use RolePolicy v1 and HelperRequest v1. The request binds
a hashed session/task identity, bounded objective, read/write scope, exact tool
allowlist, authenticated model/effort source, context/time/call ceilings, output
schema, stopping rule, approval restrictions, and deduplication key. Read-only
roles cannot receive mutation tools. Worker remains disabled by default and
requires an explicit single-writer lease. `PIAGENT_HELPERS_MODE=off|recommend|on`
defaults to `recommend`; `on` permits only read-only dispatch through an
installed provider adapter. CAP-14 permits at most one automatic helper dispatch
per task/run; the lower-level owner budget still caps two concurrent and three
total explicitly owned helper reservations, deduplicates equivalent work, recovers
expired reservations without adding budget, and cancels late work when the
parent Task Contract becomes terminal. It does not claim control over unrelated
Pi sessions or account usage, and never changes the user-pinned parent model.
Dispatch enforces the request's time, call, and token ceilings at result merge:
timeout, overflow, cancellation, or stale results cannot contribute output.
Successful helpers expose only a redacted bounded summary with the parent as
the sole merge owner; raw child output is represented by a digest in durable
usage evidence and is never merged automatically.

The product-facing runtime view is a deterministic projection over these same
facts. `/task-preflight` separates observed runtime facts, solver
recommendations, active policy mode, approvals, and blockers; it never grants
implementation authority to read-only, plan, review, protected, destructive,
or external work. `/piagent-status` joins Task Contract, journal, trajectory,
resume, recovery, helper, and runtime-model evidence without a model turn.
Terminal output embeds a bounded completion receipt and task-efficiency view.
Task/session/run identity is joinable through a hashed session id; raw task text
and helper output are not retained. Phase time comes only from persisted
transitions, while unmeasurable edit timing, token totals, and cost remain null.
Same-runtime evidence is operational assurance, never an independent audit.

Until controlled beta cohorts and the independent usability/platform gates are
complete, the frozen safe defaults remain criterion engine `on`, solver `shadow`, phase tools
`shadow`, recovery `on`, helpers `recommend`, parent routing `off`, automatic
workers `off`, and host execution. Implementation completion alone cannot
promote a mode. Feature-off reads existing sidecars without deleting them.

Parent routing now has a versioned `low|medium|high|ultra` capability contract,
selection provenance, exact authenticated-catalog matching, and
`intelligence|balance|cost` objectives. It classifies before a fresh task call,
never switches models mid-conversation, preserves `/model` and CLI pins, and
fails closed when provenance or host capability is unknown. Pi 0.84.1's
extension model switch also updates user default state, so extension `auto`
remains recommendation-only; enforcement is limited to the explicit
`piagent-route --execute --yes` prelaunch adapter. The default remains `off`
until authenticated G1/G2 evidence passes every >=9.5 aggregate gate and every
individual outcome is strictly above 9.5.

Retrieval routing similarly remains conservative: a low-confidence or broad
search can recommend a read-only retriever restricted to grep/find/read with at
most two parallel searches over two rounds. Automatic dispatch stays false.

The execution backend contract is fail-closed. Host execution remains the
default and Pi owns OAuth/session credentials. Requesting docker, devcontainer,
or sandbox without an installed adapter blocks mutation instead of silently
falling back to host execution. Mixed frontend/backend task scope selects the
comprehensive `source` verifier group; docs plus source scope combines both
relevant verifier groups without dropping either command set.

## State ownership

| State | Owner | Location | Commit |
|---|---|---|---:|
| OAuth and provider auth | Pi/provider | user config | No |
| Platform install config | Piagent installer | global Pi settings | No |
| Project profile and lock | Project | `.pi/piagent-profile*.json` | Yes |
| Task, trace, telemetry, captures | Runtime | `.pi/piagent-state/` | No |
| Task journal and checkpoints | Runtime audit | `.pi/piagent-state/task-journal/` | No |
| Trajectory phase/events | Runtime derived state | `.pi/piagent-state/trajectory/` | No |
| Recovery handoff projections | Runtime derived state | `.pi/piagent-state/handoffs/` | No |
| Piagent-owned helper budgets | Runtime owned state | `.pi/piagent-state/helper-budgets/` | No |
| Repository memory facts | Runtime advisory memory | `.pi/piagent-state/repository-memory/` | No |
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
