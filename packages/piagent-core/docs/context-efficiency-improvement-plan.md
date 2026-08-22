# Context Efficiency Improvement Plan

## Status

- **Scope:** `packages/piagent-core`
- **Purpose:** Improve prompt-prefix stability, context reuse, delta injection, verification feedback, and adaptive context budgeting.
- **Verified against:** repository state on 2026-08-21.
- **Review disposition:** Approved for sequential implementation only after the PR-0A evidence-semantics foundation and the release non-regression gates below.
- **Implementation order:** PR-0A → PR-0 → PR-1 → PR-2 → PR-3B. PR-3A may start after PR-0A in recommend-only mode.
- **Implementation progress (2026-08-21):** PR-0A and PR-0 are implemented locally and verified. Before PR-1 changes runtime behavior, the Codex CLI comparison, token, performance, stability, and UI terminal-state gates must be enforceable. No residency or delta-injection claim is made yet.
- **Primary safety rule:** Never trade verification coverage or context correctness for token savings.

The implementation scope is primarily `packages/piagent-core`, but policy-backed configuration also requires coordinated changes to root `schemas/`, `adapters/`, capability catalogs/locks, and their tests. These are part of the delivery scope when a phase introduces `contextDeltaShadow`, `contextRuntime`, or `fastVerify` settings.

## Release contract

Token reduction is the optimization target. Capability, correctness, safety,
verification coverage, latency, and operation finality are hard constraints.
No context phase may be promoted merely because it uses fewer tokens.

The release comparison must:

- compare Piagent with Codex CLI, never Raw Pi, using the same authenticated
  Codex model, thinking level, prompt, repository tree, verifier, and repeat;
- run the complete declared suite on an exact clean candidate with seeded,
  randomized pair order and at least three repeats;
- require the family-clustered upper 95% fresh-token ratio to be at most `0.80`
  for the minimum claim (at least 20% reduction); `0.70` is the stretch target;
- reject a token claim when candidate quality, safety, reliability, workflow,
  resolved outcomes, or evidence completeness is worse than the Codex CLI
  baseline;
- require end-to-end duration to be non-inferior: point ratio at most `1.00`
  and upper 95% ratio at most `1.10`, with zero timeout, orphaned operation,
  or unknown terminal state in the release cohort;
- require stable system/tool prefix telemetry, with no unexplained prefix drift,
  while keeping model identity and reasoning effort outside the prefix hash;
- run the default `openai-codex/gpt-5.6-sol:high` release lane, the efficiency
  `openai-codex/gpt-5.6-luna:medium` lane, and compatibility smoke tests for
  every model returned by the authenticated `openai-codex` catalog.

Partial, dirty-tree, provider-free, subset, or retry-recovered runs may report
observations but may not produce a release token-saving claim. Web UI release
validation is a companion hard gate: every operation must reach one canonical
terminal settlement; only successful assistant output belongs in the chat;
drafts, retries, commands, and failures belong in Activity; reload/resync must
not strand a running indicator or remove Stop/recovery controls.

## 1. Current-state findings

The implementation already contains most of the required primitives, but several proposal assumptions need correction before source changes begin.

### 1.1 Existing telemetry

- `agent_prompt` already records `systemPromptHash` in `runtime/hooks/agent-start-hook.ts`.
- `context_pack` events that select items already include `selectedPaths`; a new `paths[]` field is not required.
- `buildContextEfficiencyReport()` already reads bounded telemetry and reports duplicate reads, duplicate output, tool-schema share, low-confidence packs, and positive-only retrieval utilization in `extensions/context-engine.js`.

The current `context_pack` event is emitted before the confidence gate decides whether the pack is actually injected. It therefore represents a built candidate pack, not necessarily an injection.

### 1.2 Active-task context behavior

Context packing is currently disabled for a pending task in two places:

- `runtime/hooks/agent-start-hook.ts`: `autoPackUseful` requires the active task not to be pending.
- `runtime/context/adaptive-planner.ts`: `shouldInject` is false when `activePendingTask` is true.

Replacing only `hasAutoPackedPrompt(packKey)` will not activate task-time delta injection.

### 1.3 Context manifest semantics

The current task `contextManifest` is a mixed-semantics structure containing only `{path, reason}`. Task start may seed it from criterion targets before any file content is delivered, while runtime read and pack paths also append observed or injected entries later.

Several consumers currently treat any non-empty manifest as read-only evidence or lifecycle progress. Consequently, a criterion seed can be mistaken for observed context. This existing ambiguity must be corrected before manifest writes are tied to context injection.

`buildContextPack()` normally produces a navigation pack with symbols and bounded snippets. A selected path can therefore represent:

- a repository-map entry;
- one or more snippets;
- truncated content;
- or, in limited cases, a complete file.

Path-level presence alone is insufficient for a safe “already in context” decision.

### 1.3.1 Delivery acknowledgement

`before_agent_start` can return a hidden message, but returning a message object is not by itself proof that the host accepted it into the conversation. Tool results, slash-command runtime messages, criterion packs, and automatic hidden messages also have different delivery boundaries.

The design must therefore distinguish candidate construction, payload return, and confirmed delivery. If the Pi host exposes no confirmation event for a delivery surface, that surface may record only an offered/returned receipt and must not create durable acceptance evidence.

### 1.3.2 First-turn task attribution

`agent_prompt` is currently emitted before automatic intake creates a task. The first governed prompt can therefore have a session identity but no `taskRunId`. Metrics cannot safely partition that prompt by task without a turn/operation correlation identifier and a later task-binding event.

### 1.4 Schema compatibility

Task Contract schema v2 validates nested citation objects strictly. Unsupported citation fields are rejected and normalization strips unknown legacy fields.

A generic task schema mismatch is currently treated as legacy/untrusted working-tree evidence. A direct v2→v3 bump without an explicit compatible migration can invalidate proof state or force a new task attempt.

### 1.5 Compaction behavior

`session_compact` currently records only:

- reason;
- retry intent;
- whether compaction originated from an extension.

It does not identify which source excerpts remain in the compacted summary. Any path-level retention assumption after compaction would be unsafe.

### 1.6 Verification behavior

`buildTestImpact()` exists but is exposed only through diagnostic context tools and commands. It is not part of task verification planning.

The completion gate requires all exact commands persisted in `task.verifyCommands` to pass on the current proof-capable tree. Impact-based tests may be added as a fast feedback pass, but must not replace or satisfy the mandatory acceptance commands.

---

## 2. Architecture decision

Do not use one structure for both durable task evidence and live model-context residency.

### 2.1 Planned context and durable evidence

Do not store planned criterion seeds in `contextManifest`. Keep planned selection in the criterion graph or a versioned planning receipt.

Keep the current task contract representation:

```ts
type ContextManifestEntry = {
  path: string;
  reason: string;
};
```

This remains bounded and schema-compatible, but entries may be appended only for:

- a successful observed read; or
- a context payload whose delivery was confirmed by the host.

Reason strings must use stable runtime-owned categories rather than being interpreted as free-form proof. Read-only lifecycle and acceptance consumers must reject criterion/planned reasons and require observed-read or confirmed-delivery evidence. Existing v2 tasks with criterion-seeded entries fail safely to “evidence unknown” until a real read or confirmed delivery occurs.

### 2.2 Live context residency

Add a versioned private sidecar:

```ts
type ContextResidencyReceipt = {
  schemaVersion: 1;
  taskRunId: string;
  sessionId: string;
  generation: number;
  entries: Array<{
    path: string;
    source:
      | "auto-pack"
      | "criterion-seed"
      | "observed-read"
      | "model-recorded";
    fileContentHash?: string;
    payloadHash: string;
    representation: "full" | "snippets" | "map" | "diff" | "marker";
    ranges?: Array<{ start: number; end: number }>;
    truncated: boolean;
    offeredAt: string;
    deliveredAt?: string;
    injectedTurn?: number;
    contentRef?: string;
    pinned: boolean;
    lastUsedAt?: string;
    deliveryId: string;
    deliveryState: "offered" | "delivered";
  }>;
};
```

Store it under private Piagent state with mode `0600`, atomic writes, bounded retention, protected-path filtering, and no raw prompts.

If a task has no valid residency receipt, treat its residency as unknown and reinject bounded context when required. This is safer than assuming old context remains available.

`fileContentHash` is the hash of the complete stable file read, when a complete-file hash can be obtained safely. `payloadHash` is the hash of the exact rendered payload delivered to the model. A snippet payload must never be compared directly with a complete current file as though the two hashes represented the same bytes.

### 2.3 Delivery receipt lifecycle

Use one state machine across every delivery surface:

```text
candidate → offered → delivered
                  ↘ failed/unknown
```

- `candidate`: selection completed; no model-context claim.
- `offered`: the extension returned a payload to the host.
- `delivered`: a host lifecycle event confirms the custom message or tool result.
- `failed/unknown`: no durable evidence or residency claim is created.

Stage manifest/residency updates under `deliveryId`. Commit them idempotently only at `delivered`. If a host version cannot acknowledge a surface, keep the receipt offered and rehydrate conservatively on later turns.

The delivery matrix must cover automatic hidden messages, criterion snapshots, explicit task-start tool results, `/context pack`, and `piagent_context_engine pack`.

### 2.4 Why use a sidecar first

- Avoids a high-risk Task Contract v2→v3 migration in the first rollout.
- Allows compaction to invalidate residency without deleting durable task evidence.
- Supports bounded content references needed for incremental diffs.
- Makes deletion or corruption fail safely to reinjection/default behavior.

If product requirements later require residency metadata inside the Task Contract, implement a dedicated lossless v2→v3 migration as a separate change.

---

## 3. Delivery plan

| Pull request | Scope | Dependency | Estimated effort |
|---|---|---|---|
| PR-0A | Evidence semantics and delivery receipts | None | 2–4 engineering days |
| PR-0 | Metrics and telemetry semantics | PR-0A | 1–2 engineering days |
| PR-1 | Task-start baseline and residency sidecar | PR-0A + PR-0 | 3–5 engineering days |
| PR-2 | Delta injection, compaction recovery, and eviction | PR-1 | 5–7 engineering days |
| PR-3A | Fast test-impact verification | PR-0A | 2–3 engineering days |
| PR-3B | Adaptive context-budget learning | PR-2 | 3–5 engineering days |

Each PR must be independently revertible. Metrics may default on; behavior-changing features must roll out behind policy modes and emergency kill switches.

### 3.1 PR-0A — Correct evidence semantics before optimization

1. Stop writing criterion-planned paths into `contextManifest` at task creation.
2. Preserve criterion seeds in the criterion graph/planning receipt.
3. Add staged delivery receipts and host-confirmed commit where supported.
4. Update read-only lifecycle, acceptance, exact-output inputs, trajectory, efficiency metrics, task views, recovery projections, and tests that currently equate `contextManifest.length > 0` with observed evidence.
5. Treat legacy criterion-only v2 manifests as evidence-unknown; do not invalidate the task schema and do not auto-complete them.
6. Add explicit automatic and manual task-start tests proving that planned paths alone cannot satisfy completion.

PR-0A changes evidence interpretation, not Task Contract schema version. It must not weaken exact verification, working-tree, protected-path, or authority invariants.

Primary files/consumers include:

- `runtime/registration/task-start-tool.ts`
- `extensions/task-contract-view.js`
- `extensions/acceptance-receipt.js`
- `runtime/hooks/completion-hook.ts`
- `runtime/trajectory/trajectory-runtime.ts`
- `runtime/quality/exact-output-contract.ts`
- `runtime/product/efficiency-metrics.ts`
- the delivery staging/confirmation module and focused regression tests

---

## 4. PR-0 — Measure before changing behavior

### 4.1 Prefix instrumentation

Extend `agent_prompt` with canonical hashes:

```ts
{
  event: "agent_prompt",
  systemPromptHash,
  toolSchemaHash,
  prefixSurfaceHash,
  activeToolCount,
  toolSchemaTokens,
  taskRunId,
  sessionId
}
```

Definitions:

```text
toolSchemaHash =
  hash(deep-canonical active tool metadata exactly matching the provider surface)

prefixSurfaceHash =
  hash(systemPromptHash + toolSchemaHash)
```

Tool names and all nested object keys must be sorted before hashing so object-order differences do not create false churn. Keep provider/model identity as a metric partition, not as bytes inside `prefixSurfaceHash`. Preserve the historical numeric `activeTools` field or version it explicitly; do not silently change its type.

Add `turnId` to `user_input`, `agent_prompt`, pack, delivery, and task-start telemetry. When automatic intake creates a task after `agent_prompt`, emit `turn_task_bound {turnId, taskRunId}` so the first prompt is attributable without rewriting append-only telemetry.

### 4.2 Separate pack construction from injection

Keep `context_pack` with the meaning “candidate pack was built.”

After confidence acceptance, emit an offered event. Emit the following only after host-confirmed delivery:

```ts
{
  event: "context_pack_injected",
  injectionId,
  queryHash,
  selectedPaths,
  selectedItems: Array<{ path: string; estimatedTokens: number }>,
  estimatedTokens,
  confidence
}
```

Do not count a rejected or empty pack as an injection.

Update both `buildContextEfficiencyReport()` and positive retrieval feedback to consume confirmed delivery events. Historical `context_pack` records remain candidate-only and must not be silently reclassified as injections.

### 4.3 Metrics

Calculate within `sessionId + taskRunId` partitions:

```text
prefixChangeRate =
  changed adjacent prefixSurfaceHash transitions
  / comparable prompt transitions

averageTurnsPerPrefixEpoch =
  prompt count
  / (1 + prefix changes)

duplicateInjectionRate =
  repeated equivalent payload occurrences in context_pack_injected
  / all injected path occurrences

duplicateInjectionTokenRate =
  estimated tokens of duplicate (path + fileContentHash + payloadHash + representation + ranges + generation)
  / total injected path tokens
```

Required post-compaction rehydration is not a duplicate injection. Task boundaries, explicit refresh, changed hashes, and newly required coverage must be reported separately.

Report both micro-averages and macro-averages so a long session cannot dominate the project result.

### 4.4 Shadow candidate measurement

Actual duplicate injection may be structurally low because active pending tasks currently suppress packing. Add a bounded shadow mode:

```text
contextDeltaShadow: off | sample | on
```

A shadow pass performs selection but never injects content. It records:

```ts
{
  event: "context_delta_shadow",
  candidatePaths,
  pathsAlreadyManifested,
  candidateTokens,
  duplicateCandidateTokens
}
```

Skip shadow work when the index is missing/stale, context pressure is high, or the task targets protected paths.

### 4.5 Report compatibility

Bump only the context-efficiency report schema to version 2. Existing event readers should continue to accept historical records with missing new fields.

### 4.6 Files

- `extensions/context-engine.js`
- `extensions/piagent-guard.ts`
- `runtime/hooks/input-hook.ts`
- `runtime/hooks/agent-start-hook.ts`
- `runtime/registration/task-start-tool.ts`
- `runtime/registration/context-commands.ts`
- `runtime/registration/policy-tools.ts`
- `tests/context-engine.test.mjs`
- `tests/piagent-guard-integration.test.mjs`

### 4.7 Acceptance tests

- Separate sessions and task runs do not share duplicate attribution.
- Tool-schema ordering does not change the canonical hash.
- Rejected packs do not increment injection metrics.
- Missing task IDs, hashes, or selected paths do not crash reporting.
- Zero denominators produce zero, not `NaN`.
- Protected paths never appear in telemetry.

### 4.8 Decision gate

For a smoke decision, collect at least:

- 20 task runs;
- 100 comparable prompt transitions;
- 5 task runs for every risk lane being evaluated.

These floors are not release proof for a 10% reduction claim. Canary decisions must use paired or matched control/treatment cohorts with the same model, thinking level, task class, repository state, and verifier; report variance/confidence intervals and minimum accepted-task counts per evaluated class.

Priority rules:

| Observation | Decision |
|---|---|
| `averageTurnsPerPrefixEpoch <= 1.2` | Freeze the prefix before delta work |
| Duplicate candidate/injection token rate ≥ 20% | Prioritize Phase 2 |
| High churn, low duplication | Stabilize system/tool prefix; postpone complex delta logic |
| Low churn, high duplication | Prioritize delta injection |
| Both low | Keep baseline work small and prioritize Phase 3A |

Hash churn is an invalidation proxy, not proof that cache reuse is zero. Correlate it with provider cache-read/cache-write usage when available.

---

## 5. PR-1 — Intentional task-start baseline

### 5.1 New residency modules

Add:

```text
runtime/context/context-residency-store.ts
runtime/context/context-residency-types.ts
```

Requirements:

- private local-state path resolution;
- symlink-safe access;
- mode `0600`;
- atomic writes;
- bounded entry and byte limits;
- no protected paths;
- corrupt/missing state falls back to unknown residency.

### 5.2 Extend context-pack results

For every selected item, return:

```ts
{
  path,
  fileContentHash: "context-file-v1:<sha256>",
  payloadHash: "context-payload-v1:<sha256>",
  representation,
  ranges,
  truncated,
  estimatedTokens
}
```

Calculate `fileContentHash` from a complete, stable, symlink-safe file read, not from possibly stale index metadata. Calculate `payloadHash` from the exact rendered item bytes offered for delivery. If a complete stable read is unavailable, omit `fileContentHash` and force coverage-aware refresh behavior.

Do not label snippet or repository-map output as a complete file.

Line ranges are 1-based and inclusive. Normalize, sort, and merge them before hashing or comparing coverage.

### 5.3 Task-start planner

Add a planner that does not inherit the active-task suppression rule:

```ts
planTaskStartContext({
  request,
  summary,
  acceptanceCriteria,
  scope,
  riskLane,
  classifierSignal,
  modelCapability
})
```

Use the stricter of the operator lane and classifier lane. Build a bounded retrieval query from task summary, criteria, canonical scope, criterion hints, and explicit paths. Do not persist the raw prompt.

### 5.4 Build once

Move baseline ownership to task start:

- Automatic intake creates the task and baseline pack once.
- `finishAgentStart()` receives and injects that result.
- Explicit `piagent_task_start` includes the baseline pack in its tool result.
- Remove or bypass the earlier duplicate auto-pack path when task start owns the baseline.

Persisting metadata without returning `pack.text` does not inject context and is insufficient.

### 5.5 Evidence and residency write order

After selection, stage a bounded receipt under `deliveryId`. Only after confirmed delivery:

1. append `{path, reason}` to the durable context manifest;
2. write source/hash/coverage metadata to residency state;
3. emit `context_pack_injected`.

A sidecar write failure must not block the model loop, but the runtime must then treat the path as nonresident on future turns. Manifest, sidecar, and telemetry are not one filesystem transaction, so all writes must be idempotent by `deliveryId`; partial state must fail safely to reinjection rather than claiming residency.

### 5.6 Prefix stability

Based on Phase 0 evidence:

- choose task tool groups once at task start;
- preserve canonical schema ordering;
- avoid adding/removing tool schemas within a task except explicit recovery transitions;
- emit a classified `prefix_transition` event when drift is intentional.

Do not hard-fail an agent turn solely because a prefix hash changed.

Recovery and explicit user-requested workflow changes may legitimately add a tool group. Preserve user control within a session; prefix stability must never freeze the task workflow or prevent a different request in the same session.

### 5.7 Fallbacks

| Condition | Behavior |
|---|---|
| Missing/stale index | Use criterion seeds; do not block task start |
| Low retrieval confidence | Do not claim full injected content |
| File read failure | Skip path and record degraded telemetry |
| Residency write failure | Allow current injection, force future refresh |
| Protected path | Do not read, hash, inject, or persist |

### 5.8 Tests

- Automatic and explicit task starts build exactly one baseline pack.
- Manifest paths correspond to content actually injected.
- Planned criterion paths alone never satisfy read-only completion.
- Offered-but-unconfirmed payloads never enter durable evidence.
- Every delivery surface produces the same staged/confirmed lifecycle.
- Snippets are not marked `full`.
- Content hashes change with file bytes.
- Missing/stale indexes degrade safely.
- Corrupt sidecars force reinjection.
- Protected paths never enter packs or sidecars.
- Prefix surface remains stable across normal turns in one task.

---

## 6. PR-2 — Delta-only task-time injection

### 6.1 Replace both active-task gates

Update both `agent-start-hook.ts` and `adaptive-planner.ts`. The new plan should support:

```ts
type ContextDeltaMode =
  | "skip"
  | "marker"
  | "coverage-delta"
  | "content-diff"
  | "refresh";
```

### 6.2 Per-path algorithm

#### New path

Inject query-relevant snippets, or a complete file only when size and budget allow. Record coverage and residency.

#### Same hash, sufficient coverage

Emit only a truthful marker:

```text
foo.ts: the relevant ranges are resident from task turn 3,
context generation 2.
```

Never claim the complete file is resident when only snippets were injected.

#### Same hash, missing coverage

Inject only query-relevant ranges not already covered. Merge normalized ranges after confirmed delivery.

#### Changed hash

- Load prior comparable bytes from `contentRef`.
- Compare full→full or the same normalized coverage only.
- Use the low-level `diffTextBuffers` primitive.
- Inject a bounded incremental diff.
- Update hash/content reference only after confirmed delivery.

If the prior representation is a map, truncated payload, or snippets whose coverage cannot be compared with the current representation, use `refresh` or `coverage-delta`; do not manufacture a full-file diff.

The high-level WebUI diff projection should not be used as the delta engine because it is based on task/Git baseline semantics rather than the last injected revision.

#### Missing previous content

If the previous blob was removed, oversized, binary, or unreadable, inject a bounded current snapshot and reset residency. Never silently skip based only on a hash.

#### Delete or rename

Inject a structured delete marker and update residency accordingly. Record a rename only when exact Git/task-delta evidence identifies both endpoints; otherwise treat it as delete plus new path.

### 6.3 Content retention

Store bounded prior content under a private residency blob directory.

Suggested limits:

- 512 KiB per file;
- 8 MiB per task;
- LRU cleanup;
- mode `0600`;
- no protected, binary, or sensitive content.

A retained hash without a readable content blob is insufficient to generate an incremental diff.

Run the repository sensitive-data detector before hashing or persisting raw context. If redaction would change the content, do not persist the raw blob and do not store a guessable raw-content hash; retain only a safe degraded receipt and force later bounded refresh. Use private directories with mode `0700`, `O_NOFOLLOW` reads, strict pre-read byte limits, atomic `0600` publication, and bounded corruption handling.

### 6.4 Compaction recovery

For every `session_compact` event:

```text
generation += 1
mark all residency entries stale
clear in-memory injected-pack assumptions
```

Do not attempt path-specific invalidation because the event does not report retained paths.

Persist generation updates with a lock or compare-and-swap rule. A delayed pre-compaction delivery commit must not overwrite a newer generation or resurrect stale residency.

After compaction, the next relevant prompt performs bounded rehydration. Durable manifest entries remain intact.

On process restart or uncertain resume state, prefer stale residency and bounded reinjection over a false skip.

Close or expire residency on task completion/replacement and session shutdown. Retention cleanup must be task-bound and must not delete durable task evidence.

### 6.5 Capacity and eviction

Add a separate policy:

```json
{
  "contextRuntime": {
    "maxResidentFiles": 12,
    "maxTrackedInjectedTokens": 6000,
    "maxResidencyBlobBytes": 8388608
  }
}
```

Do not reuse `maxManifestFiles=80` as the live-context LRU.

Treat the following as high-priority soft pins unless a security rule requires a hard pin:

- explicit user paths;
- required context;
- current changed files;
- criterion-critical targets.

Before adding a path:

1. choose an unpinned least-recently-used entry;
2. invalidate its residency and content blob;
3. emit `context_residency_evicted`;
4. preserve durable observed-read evidence.

Current explicit user paths outrank older soft-pinned entries. If every entry is hard-pinned, skip/degrade the new pack instead of allowing unbounded growth. `maxTrackedInjectedTokens` is an accounting estimate, not a claim about the provider's true resident-token state.

Add `contextRuntime` and `contextDeltaShadow` through the typed base policy and capability-lock path. Update the fallback policy copy, policy inspection, profile/schema/catalog ownership, and drift tests in the same PR; do not introduce an untracked environment-only behavior switch.

### 6.6 Tests

- Pending tasks enter the delta planner.
- Same hash and coverage emits a marker only.
- Missing coverage injects only new ranges.
- Changed content produces an incremental diff without repeated old hunks.
- Missing blobs cause refresh.
- Compaction invalidates all residency.
- Resume cannot cause false skips.
- LRU never removes pinned entries.
- File/token/blob limits are enforced.
- Delete, rename, symlink, binary, and oversized cases degrade safely.
- Protected paths are never diffed or persisted.

Phase 2 is not releasable without passing compaction, restart, generation-race, sensitive-content, and missing-blob tests.

---

## 7. PR-3A — Fast test-impact verification

This PR can proceed after PR-0A and must begin in recommend-only mode.

### 7.1 Keep fast and acceptance plans separate

Mandatory acceptance remains:

```ts
task.verifyCommands
```

Add a separate advisory representation:

```ts
{
  impactedPaths,
  tests,
  commands,
  generatedForTreeDigest,
  advisory: true
}
```

It may live in a versioned sidecar or runtime receipt to avoid an immediate Task Contract schema bump.

### 7.2 Trigger

After the first successful mutation, or whenever the exact task delta changes:

1. calculate the current task delta;
2. call `buildTestImpact(changedFiles)`;
3. create a fast verification plan;
4. inject one short plan message on the next turn;
5. in recommend mode, present fast commands without executing them automatically;
6. in a separately authorized execution mode, run fast commands before the mandatory full verifier.

Do not recompute impact when the tree digest is unchanged.

### 7.3 Runner mapping

Do not infer shell commands only from filenames. Add explicit profile adapters using executable/argv templates rather than shell strings, for example:

```json
{
  "fastVerify": {
    "mode": "recommend",
    "adapters": [
      {
        "patterns": ["tests/**/*.test.mjs"],
        "executable": "node",
        "args": ["--test", "{files}"]
      }
    ]
  }
}
```

Validate every project-relative path and expand `{files}` into individual argv elements. If no adapter applies, present impacted test paths without generating a command.

Every fast command must pass the normal execution policy, filesystem scope, protected-path checks, external/destructive confirmation policy, timeout/output limits, and current task authority. Record tree digests before and after execution; a fast command that mutates the tree invalidates its own evidence and is surfaced as a verifier-side effect.

### 7.4 Security invariants

Fast verification:

- never sets `matchedProfileCommand=true`;
- never satisfies completion;
- never changes `task.verifyCommands`;
- never bypasses stable-tree verification.
- never bypasses execution/approval policy.

After the final mutation, all exact acceptance commands must pass on the same final tree digest.

### 7.5 Tests

- Fast success does not complete a task.
- Full verifier remains mandatory.
- A later mutation invalidates fast and full evidence.
- Fast failure leads to repair guidance.
- Missing/stale indexes produce degraded recommendations.
- Traversal/test caps are visible in the receipt.
- Mixed frontend/backend impact never removes the general acceptance group.

---

## 8. PR-3B — Adaptive budget learning

### 8.1 Deterministic task classes

Do not key learning by raw prompt. Use a versioned class:

```text
context-task-class-v1:
  workflow
  effective risk lane
  explicit-path yes/no
  scope band: 1 | 2-5 | 6+
  dominant language family
  change mode
```

### 8.2 Completion metrics

Evaluate baseline sources separately (`auto-pack`, confirmed `criterion-seed`, and explicit task-start baseline). Do not combine them into one precision value until cohort-specific metrics are available.

```text
precision =
  auto-pack paths used
  / auto-pack paths injected

coverage =
  final structured-used paths present in baseline
  / final structured-used paths

tokenPrecision =
  tokens of used injected items
  / total injected tokens
```

Strong positive usage evidence includes structured mutation, verification impact, and structured citation events bound to the same content revision. A read/grep after injection is ambiguous: it may indicate use, but it may also indicate missing coverage or lack of trust. Report it separately as fallback reread and do not automatically reward it as positive precision. Free-form final-response path parsing is advisory only.

### 8.3 Quality filter

Update learning state only when:

- task completion succeeded;
- acceptance passed;
- exact verifier passed on the final tree;
- no scope/protected-path violation occurred;
- telemetry and residency state are valid.

Failed, partial, blocked, or corrupt tasks may contribute diagnostics but must not adjust budgets.

### 8.4 Learning policy

| Valid samples | Behavior |
|---|---|
| 0–4 | Deterministic cold-start default |
| 5–19 | Shadow/recommend only |
| 20+ | Eligible for a canary evaluation only when the class is not sparse and quality confidence is sufficient |

Controls:

- EMA alpha around `0.2`;
- maximum 10–15% adjustment per update window;
- hard planner minimum and maximum remain authoritative;
- use p75 utilized tokens plus a safety margin, backed by a bounded deterministic histogram/reservoir or another explicitly mergeable quantile structure;
- low precision with high coverage may shrink slightly;
- low coverage must not shrink the budget;
- retain an exploration floor.

### 8.5 Persistence

Add:

```text
runtime/context/context-learning-store.ts
```

Store only versioned aggregates:

- classifier version;
- class key;
- valid sample count;
- EMA/p50/p75;
- quality counters;
- last update.

Define atomic concurrent updates, corruption recovery, and classifier-version migration. High-dimensional task classes require hierarchical fallback to a coarser class/global prior; a sparse exact class must not enforce a learned budget merely because a global sample count reached 20.

Corrupt or missing state falls back to deterministic defaults and never blocks the task.

### 8.6 Rollout

```text
off → shadow → recommend → 10% canary → 50% canary → default
```

An emergency kill switch must immediately restore deterministic budgets.

### 8.7 Tests

- No learning from failed or partial tasks.
- No cross-task attribution in one session.
- Sample floor and hysteresis work as specified.
- Hard budget bounds cannot be exceeded.
- Corrupt state falls back safely.
- Classifier-version changes do not reuse incompatible history.
- Low coverage cannot trigger shrinking.
- Same inputs and store state produce deterministic plans.

---

## 9. Verification matrix

### 9.1 Focused suites

```bash
node --test tests/context-engine.test.mjs
node --test tests/task-state.test.mjs
node --test tests/runtime-session-modules.test.mjs
node --test tests/adaptive-runtime-services.test.mjs
node --test tests/piagent-guard-integration.test.mjs
```

Suggested new suites:

```text
tests/context-residency.test.mjs
tests/context-delta-injection.test.mjs
tests/context-learning.test.mjs
tests/fast-verification-plan.test.mjs
```

PR-0A must also update/add focused coverage for:

```text
tests/context-evidence-semantics.test.mjs
tests/context-delivery-receipt.test.mjs
tests/acceptance-receipt.test.mjs
tests/exact-output-contract.test.mjs
```

### 9.2 Exact verifier

After every PR and after the latest mutation:

```bash
bash scripts/verify-local.sh
```

### 9.3 Security review

Every behavior-changing PR must verify:

- protected-path filtering;
- secret redaction;
- sidecar permissions and symlink defense;
- no acceptance-verifier bypass;
- no cross-session/task attribution;
- safe fallback for missing/corrupt state.
- offered payloads are not acceptance evidence;
- secret-bearing source bytes and hashes are not persisted;
- generated verifier commands pass normal execution and approval policy.

---

## 10. Rollout gates

### Phase 1

- Baseline is injected exactly once.
- Manifest and residency match actual injected content.
- Criterion plans and offered-only payloads cannot satisfy completion.
- Old task/session state degrades safely.
- Prefix churn does not increase beyond intentional task-boundary transitions.

### Phase 2

- No silent context loss after compaction or restart.
- Duplicate injected token rate falls by at least 50% in the canary cohort.
- An internal canary may use 10% as a diagnostic milestone, but it cannot make a
  product claim. Promotion requires the complete release cohort to meet the
  upper-95% ratio `<= 0.80` (at least 20% reduction); `<= 0.70` is the stretch
  target for repetitive work classes.
- Verification retry/failure and partial/blocked rates do not regress.
- End-to-end duration point estimate does not regress and its paired upper-95%
  ratio stays within the declared non-inferiority margin.

The reduction claim requires a matched control/treatment comparison with the same model, thinking level, task class, repository starting tree, and verifier. Report sample sizes and uncertainty; post-compaction rehydration is classified separately from avoidable duplicate injection.

### Phase 3A

- Time to first test feedback improves.
- Exact verifier execution remains mandatory before completion.
- Zero acceptance bypasses.

### Phase 3B

- Learned budgets remain within deterministic hard bounds.
- No quality or security regression.
- Failed/corrupt evidence never updates the learner.
- Kill switch restores defaults immediately.

---

## 11. Final dependency order

```text
PR-0A Evidence semantics + delivery receipts
   ↓
PR-0 Metrics
   ↓
PR-1 Baseline + residency sidecar
   ↓
PR-2 Delta + compaction + eviction
   ↓
PR-3B Learning shadow/recommend/enforce

PR-3A Fast verification can start after PR-0A and remains recommend-only until its execution-policy path is verified.
```

Recommended execution sequence:

1. Implement PR-0A and prove planned context cannot satisfy completion.
2. Implement PR-0; make the Codex CLI quality/token/performance/stability gates
   enforceable; start PR-3A in recommend-only mode after PR-0A.
3. Collect Phase 0 telemetry while preparing PR-1, but do not enable PR-1
   behavior until those gates and canonical Web UI operation settlement pass.
4. Decide prefix-freeze scope using measured churn.
5. Release PR-1 behind a canary policy.
6. Do not canary PR-2 until compaction, restart, race, secret-content, and missing-blob tests pass.
7. Run PR-3B in shadow/recommend mode before any learned budget is enforced.
