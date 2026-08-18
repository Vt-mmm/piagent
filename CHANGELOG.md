# Changelog

This file records release-facing changes for Pi Agent Platform. Copy the relevant version block into GitHub Releases when publishing a tag.

## Unreleased

## v1.5.2 - 2026-08-18

### Fixed

- The new-chat composer now accepts a dragged or pasted document, not only one
  chosen through the paperclip. The file picker already carried attachments into
  a new session; drag and drop was the one entry point that silently did
  nothing, so a document dropped on that screen was lost with no message.
- A dropped file that misses the composer no longer navigates the Gateway away
  from the page, matching the guard the session composer already had.

## v1.5.1 - 2026-08-17

### Release repair

- Supersedes v1.5.0, which was tagged but never published: its release matrix
  failed on macOS, so the publish job never ran and the registry stayed on
  v1.4.1. The content of this release is v1.5.0's, plus the fix below.
- Fixed a race in the WebUI composer end-to-end test. Changing the model right
  after changing thinking acknowledged the effect scope without waiting for the
  panel to clear it, so on a slower runner the reset landed afterwards and left
  the confirm button permanently disabled.

## v1.5.0 - 2026-08-17

### Document workspace and attachments

- Added a bounded document workspace to the Session Hub for project Markdown,
  text, PDF and DOCX material, including safe extraction, redaction,
  truncation, protected-path enforcement and readable in-browser previews.
- Added document and image attachment staging to New chat and active-session
  composers. Sent files remain visible as compact durable cards instead of
  dumping extracted document bodies into the conversation.
- Moved attachment storage and validation into the shared core runtime so the
  terminal package and WebUI use one authority boundary, one reservation
  protocol and the same session identity rules.

### Conversation and session experience

- Replaced large tool-result blocks in chat with a compact live activity
  timeline for file reads, image inspection, commands, edits, search, context
  optimization and verification. Raw tool labels remain available on demand in
  the Activity inspector.
- Added deterministic, zero-model-turn session titles and previews. Internal
  fresh-session routing commands are hidden from the transcript and catalog,
  while user-visible titles stay bounded and preserve redaction markers.
- Hid delegated runtime helper sessions from the user conversation catalog and
  kept attachment metadata, live events and resumed session projections bound
  to the exact public session.

### Project import and capability visibility

- Hardened native project-folder selection across macOS and Linux, including
  multi-folder import and fail-closed cancellation or unsupported-host results.
- Added exact Web search and image-input capability facts to Providers & models
  without copying provider credentials or adding a model turn to dashboard
  inspection.

### Contracts, security and release coverage

- Added the versioned document-workspace contract and extended attachment,
  transcript, session-command and capability contracts with bounded additive
  fields and generated TypeScript projections.
- Added regression coverage for large/invalid documents, attachment claim and
  retry, stale session revisions, Linux project import, hidden helper sessions,
  durable file cards and live tool activity.
- Kept every browser-facing file, title, provider fact and tool label behind the
  existing redaction, protected-path, schema and capability-integrity gates.

## v1.4.1 - 2026-08-17

- Local installs now synchronize the terminal helper and WebUI Gateway from the same checkout before registering the Pi package, preventing a stale global Gateway from enforcing older session/task lifecycle rules.

### Integrity boundary

- The runtime integrity graph skipped shell entrypoints entirely, so a pinned command could execute an unpinned program: `piagent-usage` ran a 567-line reader of `~/.pi/agent/sessions/**` that the lock had never seen, because the path was built from `$SCRIPT_DIR` and the repository-relative literal never appeared in the source. Shell sources are now scanned, and a sibling reached through a computed directory is followed.

- The published package ships the built browser bundle and not the sources it came from, so on an installed platform that 725 KB of JavaScript could not be regenerated or checked against anything — while it runs inside the origin that holds the session cookie and the CSRF token, with the authority to drive session commands, source mutation and provider auth. The server that serves it was pinned; what it served was not. The served bundle is now pinned, document included, because the document names which script runs.

- A TypeScript module imported by its emitted name — `./x.js` for `x.ts`, the ordinary TypeScript convention — resolved to nothing and was dropped in silence. No module was outside the lock because of it, but a module that decides what the guard enforces could have been, while the graph still claimed to be complete.

### Agent control

- Command-only test/build/typecheck/package requests now enter an execution-capable governed task even when the operator forbids source edits; read-only remains a strict inspection mode instead of failing halfway through the first verifier command.

- A terminal Task Contract used to terminate the conversation with it: WebUI swallowed the next operator message before Pi persisted it, the Gateway could only report `session-command-effect-unknown`, and `piagent_task_start` then demanded a fresh Pi session. Conversations may now bind sequential Task Contracts. The closed task remains immutable, paused/stopping tasks remain closed, and the terminal boundary admits only new conversation input plus the exact successor-task start transition.

- `OwnedWorkCeilings` advertised eight limits and six of them were never read: the per-role ceilings were real but fixed at one apiece, so raising `maxScoutPasses` in a profile did nothing while `maxTotalHelpers` beside it took effect. Half-honoured configuration reads as working configuration. The ceilings are now read from the object the caller passes; every default is one, so no shipped behaviour changes, and automatic mode is pinned against widening.

- A blocked tool call is the only conversation most operators have with this policy, and it was one-sided: of 43 distinct refusals, three said what to do next. Remedies are now attached at the single point every decision leaves through, so a refusal added later is answered without anyone remembering to. The refusal that stops the whole session says which command explains it.

- `piagent explain '<command>'` reports conclusive static refusals and the guard readers that found them. A static pass is now explicitly `indeterminate` until the live Pi runtime evaluates Task Contract, scope, permission, lifecycle, approval and budget state; the standalone CLI can no longer issue an "exact allow" that the real guard later blocks. `--scope` lists the static boundary in effect.

### Redaction and evidence

- An npm token was recognised only where something named it, so `//registry.npmjs.org/:_authToken=npm_…` — the whole of an `.npmrc`, and what a failing publish prints — went through unredacted. Every other provider here is matched by the shape of its token.

- Redaction runs before tool-result compaction, and that order was the only thing keeping a credential out of the capture written to project state. Nothing pinned it; reversing the two calls would have written credentials to disk and passed every test.

- An observation that states neither an exit code nor an error flag no longer satisfies a claim of success. It is unreachable through the recorded shapes, but a reader of the function that guards forged verification should not have to prove that.

### Cost and clarity

- `piagent-usage` reports fresh tokens and the cache hit rate, using the benchmark's own definition of a fresh token so the terminal and the published measurement cannot mean two different things. The rate is reported beside the count and never instead of it: in the published benchmark the baseline surface held the higher hit rate while spending more than twice the fresh tokens.

- Capability verification derived the ancestor set on every cache hit, which at 296 pinned files cost more than every `lstat` it performed put together. Deriving it once per snapshot took a hit from 4.28 ms to 1.61 ms with no loss of tamper detection.

- The WebUI opens in the language the browser asked for instead of always starting in Vietnamese; the confirmation for full access focuses the safe choice, so a reflex Enter dismisses it rather than granting it; and the file a diff shows is derived from the list that is loaded, so no later clear can leave the pane asking for a file beside a list holding one.

### Install and uninstall

- Running the documented two-command install downgraded the machine-wide Pi package to whatever pin the project being initialised happened to carry, including a project the operator only meant to open once. One resolved value served both scopes and read the project pin first, so a pin that is authority over its own project quietly became authority over the machine. The two scopes now resolve separately: the global install takes the running helper, the project keeps its pin, an explicit `--package-source` still beats both, and a divergence between them is printed instead of silently resolved.

- Uninstall removed nothing on any machine whose helper sits under a non-default npm prefix — the fallback the installer takes when the configured global root is not writable, and whatever `piagent-update --npm-prefix` was given. `npm uninstall -g` resolves against the configured prefix, so the run exited `0` and reported completion over an install that was still there. The prefix is now derived from where the running helper actually is, the same way the updater derives it, and the follow-up command printed for the operator to copy carries that prefix too. An npx cache root is still never claimed, because it owns no bin on anyone's PATH.

### Agent control coverage

- A stop request only counts as pending if its `commandId` is truthy, so an empty one records the stop and then reports nothing pending — the single outcome an operator pressing stop must never get. The journal writers never check the shape, and the only thing preventing it was a regex in the browser command validator that no test named. Malformed identifiers are now pinned as rejected at that boundary, together with the proof that a well-formed one still passes, so the guard cannot be loosened or widened into blanket refusal without a test failing.

### The dashboard starts without the MCP adapter

- `piagent dashboard` could not start on any machine where `pi-mcp-adapter` was not installed under the agent directory — an install run with `--no-mcp`, or anyone trying the package through `npx` before setting anything up. The gateway is spawned with `PIAGENT_PINNED_TS_TRANSFORM_ROOT` pointing at that adapter, and the TypeScript loader called `realpath` on it before deciding anything. That function answers one question — is the file being loaded inside the pinned adapter — and it threw instead of answering "no", so the throw escaped the loader on the first `.ts` file of any kind and killed the process. It now answers "no", which falls back to `strip`: the stricter of the two modes, so this can only ever refuse a transform, never grant one. The exception for the reviewed adapter, its exact version, and containment within its root are all unchanged.

- The failure was also unreadable. The gateway child was spawned with its stderr discarded, so a process that died on its first line looked exactly like a slow one: twelve seconds of waiting, then `gateway-start-timeout` and nothing else. The child's stderr is now kept, bounded, and reported, an early exit stops the wait instead of running out the clock, and the two cases are named differently — a process that died and a process that never answered are different problems.

### Bilingual documentation

- The language gate proved a Vietnamese peer existed, which is not the same as saying the same thing: editing the English side and forgetting the other passed every check in this repository, and left a reader with a document describing a design that had changed. Each pair now records the content digest of both sides as of the last time somebody confirmed them consistent, and a side that moves alone fails the gate naming the file that has to follow. A two-sided edit is reported separately, because it is probably a paired edit and calling it drift would teach people to skip the gate. What it cannot do is read the two documents and decide they agree; it records that a human looked.

### Google Workspace and document conversion

- Added Google's own remote MCP servers for Drive, Gmail, Docs and Sheets, one per product rather than a single server holding every scope, because that separation is the point: reading a spreadsheet should not cost a grant over Drive and every document in it, let alone the mailbox. Each has its own preset, so the narrowest useful grant is always available.
- Google Workspace MCP is Developer Preview and has no credentialed Pi OAuth E2E proof in this release. The four entries are marked experimental, print that status through catalog/preset output, and stay out of the generic `documents` preset as well as every default preset. Official endpoints and readonly scopes remain available through explicitly named Google presets for controlled testing.

- None of them appear in `core` or `popular`. `core` is what an install writes when nobody names a preset and `popular` is what people pick without reading the list, so an entry in either would hand an operator mail and file access they never chose. A test fails if one leaks in, if a catalog server exposes direct tools instead of going through the approval gate, or if a server that needs credentials ships without saying so.

- Connecting Gmail changes the threat model rather than extending it: until now the untrusted input reaching an agent was source code, and it becomes any mail anyone can send. The approval gate still stands between a message and an action, but the documentation now states plainly what the product cannot prevent, and recommends read-only scopes and the narrowest preset.

- Added MarkItDown for converting local `.docx`, `.xlsx`, `.pptx`, `.pdf` and `.html` to Markdown. It runs offline for `file:` URIs, which is the reason to prefer it: a document worth converting is usually one worth not uploading. It is pinned at its published alpha, and needs `uv`.

### Adoption measurement

- GitHub serves repository traffic as a rolling 14-day window and discards everything older, with no endpoint that returns it. `traffic-snapshot` archives clones, views, referrers and paths daily into growing CSV files on a separate `traffic-data` branch, so the history survives and the product branch is not buried under a row a day. A day still filling when the run happens is overwritten by the next run rather than frozen partial, and a gap under 14 days loses nothing. The traffic endpoints need push access, so a 403 names the exact fix — a fine-grained token with `Administration: read` stored as `TRAFFIC_TOKEN` — instead of leaving a nightly job red.

- The documentation site now carries Vercel Web Analytics, which is cookieless and stores no browser identifier, so the site still owes no consent banner. The snippet is emitted from the site shell rather than any page, so both locales and every future page inherit it, and a test fails if a generated page ships without it or if a script from another origin appears. The runtime remains free of any network call: `telemetry()` writes locally and the package has no install hook.

### Documentation parity

Four documents restated something the code already knew, and each had drifted. They are now checked against their source, so the next drift fails a test instead of reaching a reader.

- `install-global.sh --help` omitted `--default-model` and `--subagents-model-scope`, which had been accepted for four releases. The help text now carries every flag with its valid values, and the parity check reads the flag list out of the parser.

- The `piagent-usage --json` documentation described two of the six top-level keys. `scope`, `projects`, `tools` and `generatedAt` were undocumented, including the record of which filters produced the report — without which a saved report cannot explain itself. All six are documented with their fields, and compared against the emitted object in both directions.

- The architecture documents listed nine physical layers while `architecture/layers.json` enforced fifteen: every WebUI layer was enforced and undocumented, in both languages. The seven are now described with what they own and may not own, alongside why they form a second dependency spine rather than a branch of the first.

- The team release history stopped at `1.2.11` while releases continued to `1.4.0`, and `1.1.1` had been skipped earlier. Twelve entries were added, and the list is now checked against the changelog from its own oldest entry forward, so a gap anywhere in it fails.

- The repository layout in the README showed one package where there are two, leaving `piagent-webui` — the dashboard, its client, server, gateway and ownership layers — invisible to anyone reading the map before the tree.

## v1.4.0 - 2026-08-15

### Local Session Hub and WebUI

- Added a local, one-per-profile Gateway and `piagent dashboard` experience for
  creating, reopening, resuming, renaming, pinning, archiving, unarchiving, and
  forking durable Pi sessions without starting an extra model turn for views.
- Rebuilt the browser client as a conversation-first MUI application with a
  compact composer, project and model controls, light/dark themes, Vietnamese
  and English UI, responsive layouts, and an Agent Inspector for tasks, source
  changes, activity, verification, usage, and handoff evidence.
- Added exact Gateway-owned chat streaming, held-message queues, bounded
  attachments, model/thinking controls, lifecycle controls, and Pi-owned
  approval cards while preserving one authoritative writer per session.

### Source review, recovery, and security

- Added Task Changes, Working Tree, and Staged projections with bounded diffs,
  provenance, criterion/verifier links, protected-path enforcement, and guarded
  stage, unstage, revert, and editor handoff actions.
- Added durable session leases, terminal compatibility ownership, restart and
  stale-owner recovery, idempotent command receipts, replay/resync, doctor with
  explicit repair, and corrupt-state fail-closed behavior.
- Hardened the TypeScript loader, local control socket creation, runtime
  integrity inventory, browser authentication, redaction, event bounds, and
  provider/MCP credential handling.

### Documentation and release gates

- Classified every root operating document by language, retained canonical
  English/Vietnamese entry points, and added a gate that rejects unclassified
  or unindexed Vietnamese documentation.
- Added a provider-neutral product-language gate while retaining third-party
  names only where they describe real integrations, dependencies, or operator
  commands.
- Added the executable WUI5-18 release matrix covering durable sessions,
  ownership, recovery, approvals, protected data, transport validation,
  accessibility, themes, and zero-model-turn navigation.

## v1.3.1 - 2026-08-13

### Security and reliability hardening

- Extended the capability integrity inventory to include the TypeScript loader,
  CLI dispatcher, and the remaining task-state, verification, and backend
  decision modules that can affect runtime enforcement.
- Replaced repeated full-file capability hashing on every tool call with a
  fail-closed metadata cache. Session start may re-pin an unchanged grant to a
  new installed build; build drift discovered during a running session blocks
  that session until restart instead of silently rewriting its lock.
- Removed shell interpolation from the `pdftotext` availability probe while
  preserving the existing PDF extraction behavior.
- Made local JSONL state locks publish their complete owner atomically and
  recover a hard-killed normal writer without exposing an empty lock. Recovery
  ownership is deliberately fail-closed: if that recovery process itself is
  killed, an operator must remove its `.recovery` lock before writes resume.

## v1.3.0 - 2026-08-12

### Stable Intelligence Engine release

- Promoted the exact IE9 product tree to stable without changing model-facing
  runtime behavior. The Criterion Graph, bounded current-source context,
  stable tool surface, one-continuation ceiling, current-tree verification,
  durable resume/handoff and conservative broad defaults remain unchanged.
- Published the first stable package with Pi host `0.84.1` and installed-package
  parity for every terminal command. Stable installs use npm `latest` and the
  pinned Git tag `v1.3.0`; prerelease `next` remains historical.
- Preserved the completed 108-session Luna Medium IE7 run as exact
  public-regression evidence for the unchanged product runtime. It is not
  relabelled as an exact v1.3.0 measurement and does not prove private-holdout
  generalization, field stability or real-model long-horizon performance.
- Kept solver and phase tools in shadow, acceptance and performance assurance
  advisory, semantic repair off, helpers recommend-only, parent routing off,
  recovery on and a maximum of one system continuation for broad defaults.

## v1.3.0-ie.9 - 2026-08-12

### Installed-package runtime parity

- Added a package-owned TypeScript loader for terminal entry points so the npm
  installation can load the same audited TypeScript runtime that Pi loads,
  even when the package lives under `node_modules`.
- Made the global benchmark helper use the matching exact Pi package Git source
  installed by `piagent-install --stable`. It refuses to invent Git identity or
  run against a mismatched helper/package version.
- Replaced the symlink-only binary smoke with a real packed-and-installed test:
  all global commands print help from `node_modules`, and the installed benchmark
  completes a provider-free dry run from an exact temporary Git source.
- Preserved IE8 as the first successfully published package. Its helper,
  installer, doctor and capability commands work, but the route and benchmark
  binaries cannot load TypeScript from `node_modules`; IE9 supersedes it on the
  npm `next` channel. Product/model behavior remains unchanged from IE7/IE8.

## v1.3.0-ie.8 - 2026-08-12

### Reproducible prerelease publishing

- Made the tag-driven publish job fetch the complete Git/tag history required
  by rollback tests and install the same `ripgrep` prerequisite used by the
  native Ubuntu verification lane.
- Preserved `v1.3.0-ie.7` as immutable failed-before-publish evidence. Its
  workflow stopped during deterministic tests, before `npm publish`, so the
  registry was not modified.
- Kept the product runtime identical to IE7. The completed 108-session Luna
  Medium benchmark remains exact IE7 runtime evidence and is not relabelled as
  an exact IE8 benchmark; IE8 is a distribution-only correction.

## v1.3.0-ie.7 - 2026-08-12

### Source-derived public return-contract guidance

- Extended the bounded return-representation classifier to recognize helper
  parameters seeded from object properties, including stable graph traversals
  that call `visit(item.name)` and later push that name into the public result.
- Surfaces the existing names-versus-objects representation in the first model
  turn before mutation. This preserves the public API without enabling a hard
  semantic gate, adding a continuation, or changing the benchmark prompt,
  variant, grader, outcome floor, or measured IE6 evidence.
- Preserved the terminal IE6 production run as immutable NO-GO evidence. IE7
  uses a new candidate digest and production seed and must pass a single paired
  workspace-order canary before another full release benchmark is authorized.

## v1.3.0-ie.6 - 2026-08-12

### Candidate-only finite benchmark stop

- Aligned the paired terminal stop with the production evaluator: a Piagent
  outcome below the frozen floor stops after its pair, while a Codex-only miss
  remains candidate-only dominance and does not prevent later coverage.
- Kept helper wall-clock timing observational under parallel host load; exact
  retrieval, token reduction, lifecycle, writer and privacy invariants remain
  the release-gating properties.
- Preserved the terminal `v1.3.0-ie.5` canary as immutable evidence; it is not
  resumed or relabelled after this correction.

## v1.3.0-ie.5 - 2026-08-12

### Finite release benchmark and prerelease publishing

- Added a release-only paired outcome stop that finishes the current Piagent/Codex
  pair, records a terminal non-resumable receipt, and starts no later provider
  session after an outcome falls below the frozen suite floor.
- Bound prerelease packages to the npm `next` dist-tag in both package identity
  and the tag-driven publish workflow, preserving `latest` for stable releases.
- Preserved the failed `v1.3.0-ie.4` measurement as immutable evidence; no suite,
  grader, prompt, or measured result was rewritten for this candidate.

## v1.3.0-ie.4 - 2026-08-11

### Symmetric native CI prerequisites

- Installed the exact ripgrep test prerequisite on both Ubuntu and macOS CI.
  This keeps the helper evaluation identical across native platforms; no
  product gate, benchmark evaluator, or provider behavior was relaxed.
- Kept the integration waits finite while giving the full parallel suite room
  for native filesystem contention. The helper and immutable-snapshot product
  assertions remain unchanged; only their test-harness deadlines moved.

## v1.3.0-ie.3 - 2026-08-11

### Deterministic cross-platform helper gate

- Kept helper retrieval timing as an observational metric, but made the release
  gate depend on exact retrieval correctness, model-visible token reduction,
  lifecycle, budget, writer and privacy invariants. This removes filesystem and
  process-startup timing noise from native Linux CI without weakening the
  product property the helper is intended to provide.

## v1.3.0-ie.2 - 2026-08-11

### Runtime and release-gate refresh

- Raised the exact Pi Coding Agent and Pi AI host pin to `0.84.1` and TypeBox
  to `1.3.7`. The new host tree audits clean at moderate and above, replacing
  the expired `0.82.0` advisory exception; provider-free host compatibility,
  package lifecycle and release identity are re-gated on the new pin.
- Scoped CodeQL away from the byte-pinned Hono benchmark fixture while keeping
  all Piagent product and benchmark harness code analyzed, and made Ubuntu CI
  install the ripgrep dependency exercised by helper evaluation.

## v1.3.0-ie.1 - 2026-08-11

### Intelligence-engine candidate

- Added a deterministic Criterion Graph projection and bounded current-source
  context delivery so Luna Medium can plan against operator criteria without a
  repository-index dependency or an extra model turn. Mechanical task truth,
  exact verification, current-tree evidence and permissions remain unchanged.
- Kept every advanced capability in the package while broad defaults leave
  solver and phase tools in shadow, acceptance and performance assurance
  advisory, semantic repair off, helpers recommend-only and parent routing off.
- Added a fail-closed IE6 release protocol for Piagent versus controlled Codex
  CLI on Luna Medium: 18 production families, three repeats, two surfaces, 108
  sessions, six-session inspected chunks, retry zero and explicit platform,
  cohort, private-holdout, long-horizon and operator gates.
- Preserved RC.1 and RC.2 as immutable historical NO-GO evidence. The IE train
  uses its own prerelease identity and does not relabel or resume either RC.

## v1.3.0-rc.2 - 2026-08-11

### Finite FS6 correction

- Added one intake-only efficiency correction after the exact RC.1 Migration
  gate: map every operator criterion to implementation and focused-test
  coverage, batch independent operations, and perform one criterion review
  before the first exact verifier. No completion gate, continuation budget,
  capability mode, benchmark evaluator, or scenario behavior was relaxed.
- Bound the pinned Hono 4.13.1 zero-install E2 fixture into the clean source and
  package, excluded the test-only `core-services.js` barrel from distribution,
  and made the control-byte gate accept valid empty upstream JavaScript files
  without weakening checks for non-empty binary source.

## v1.3.0-rc.1 - 2026-08-11

### Operator product journey

- Added deterministic parent model routing with versioned
  `low|medium|high|ultra` capability bands, explicit pin/default provenance,
  intelligence/balance/cost objectives, exact authenticated-catalog matching,
  and fail-closed shadow/recommend/auto modes. `piagent-route` provides the only
  explicit prelaunch enforcement path; extension auto does not mutate the Pi
  user default or switch models mid-conversation.
- Added a bounded Windsurf-style retrieval route (read-only grep/find/read, up
  to eight parallel searches and four rounds, recommendation-only), a 240-case
  offline routing gate, and a resume-locked 144-session static-versus-adaptive
  protocol dry-run. No authenticated benchmark is implied by these local gates.

- Extended task preflight with stable human/JSON projections for intent, risk,
  scope, runtime provenance, solver route, phases, tools, helper budget,
  execution boundary, readiness, approvals, and blockers. Read-only and
  authorization-sensitive requests never display implementation permission.
- Extended `/piagent-status` with persisted task, trajectory, checkpoint,
  verifier, recovery, helper, resume, terminal receipt, and bounded efficiency
  evidence. Completion remains hard-gate dependent and same-runtime evidence is
  described as operational assurance, not independent audit.
- Added one `/piagent-inspector` namespace with an automatic compact status line
  below Pi's native TUI footer and
  menu views for task-versus-working-tree diff, test files and line counts,
  tool/command outcomes, safety warnings, verifier evidence, and context budget.
  It reuses existing lifecycle hooks, does not call a model, marks mixed dirty
  baselines explicitly, and never invents per-tool token attribution.
- Hardened terminal receipts to fail closed unless the current-tree completion
  gate passes, and hardened RC local readiness so every published routing,
  safety, helper/writer, recovery, phase-tool, and host-boundary gate is
  decisive. The RC matrix pins each P0-P6 evidence input by SHA-256 and the
  generated report records the verified bytes and composite input digest.
- Extended offline doctor readiness and `/usage efficiency` with install/update
  recovery guidance and exact-or-unavailable task metrics joined through hashed
  session/task/run identity. Raw task text and child output are not retained;
  unmeasurable time, tokens, cost, and invocation counts remain null.

### Durable runtime evidence

- Fixed automatic long-prompt intake, repository-aware scope resolution,
  idempotent bounded task IDs, runtime verifier defaults, and full-prompt
  acceptance extraction. Phase enforcement now uses dependency-ready work-plan
  evidence, keeps provider tool schemas cache-stable, treats `shell`/`exec` as
  `bash`, and applies one phase decision to direct, shell, patch, and MCP
  mutation carriers. Manual/high-risk planning and every read-only task remain
  mutation-free; exact verifiers and bounded repair retain their intended path.
- Recalibrated the public capability suite around explicit contracts and 47
  weighted critical atomic checks across 16 prompt clauses. Each clause has a
  named killed mutation and sensitivity rationale; independently shaped search
  and migration implementations pass without object-identity, module-provenance,
  fixture-name, or representation coupling. Historical benchmark evidence is
  retained unchanged and is not regraded as a new performance claim.
- Hardened Piagent-versus-Codex benchmarking with named, candidate-only runtime
  treatments preserved across dry-run, resume, replay, and reports. Token-saving
  claims now fail closed unless controlled Codex isolation, model/thinking pins,
  randomized paired order, and exact treatment provenance pass; reports expose
  paired resolved/quality/safety outcomes and token ratios by benchmark band.
- Stabilized Task Contract v2 with identity-bound journal checkpoints, strict
  acceptance receipts, current-tree verification evidence, bounded retries, and
  immutable terminal outcomes. Journal hashes and receipts are operational
  evidence produced by the same runtime, not independent attestation.
- Added adaptive context planning, cited repository-memory hints, model
  capability facts, verification intelligence, and a fail-closed execution
  backend descriptor. The parent model remains operator-pinned, no solver or
  automatic parent routing is shipped, and unavailable isolation adapters do
  not silently fall back to host mutation.
- Added benchmark measurement schema v1 with exact-or-unavailable context usage
  and bounded task/acceptance evidence. Route, phase, and helper measurements
  remain absent until their later schemas and runtime behavior are implemented.
- Extracted bounded registration adapters and operator catalogs from the Pi
  composition root, locked the root against growth, and extended runtime
  integrity/package coverage for the new modules.

### Controlled RC readiness

- Added a pinned RC evaluation matrix and local-only readiness evaluator across
  quality/routing, security/privacy, reliability/performance, and disposable
  install/migration/rollback gates. It records candidate content and catalog
  digests without storing credentials or gaining release-write capabilities.
- Added cross-process helper lock waiting/stale-lock recovery and synthetic
  disk-full/permission-denied state tests after the concurrency gate exposed an
  immediate-lock-failure race.
- Retained conservative defaults: solver and phase tools stay shadow, recovery
  stays on, helpers stay recommend, and parent routing/automatic workers stay
  off. GA remains blocked on controlled cohorts, human usability, Linux,
  candidate benchmark, RC package/identity, and explicit operator approval.

### Bounded recovery and handoff

- Added deterministic failure classification and a cross-attempt recovery
  matrix with one source repair or exact transient retry ceiling. Environment,
  provider, permission, policy, scope, and unknown failures never gain source
  mutation authority; `PIAGENT_AUTO_RECOVERY=off` preserves the prior handoff
  path.
- Added owner-only Handoff v1 projections and safe resume reconstruction bound
  to task/session identity, journal integrity, trajectory phase, the actual
  current tree, and exact verifier evidence. Stale passes are invalidated;
  corrupt or symlink-unsafe state blocks mutation.
- Extended acceptance receipts with optional runtime-observed recovery
  provenance. Criteria/status truth is unchanged and the receipt stores only
  bounded digests, counts, dispositions, and state references rather than raw
  logs or source.

### Role-bound helpers

- Added strict RolePolicy v1 and HelperRequest v1 contracts for retriever,
  scout, planner, worker, reviewer, Oracle, and researcher roles. Requests bind
  hashed parent identity, bounded scope/tools/model/effort/budgets/output/stops,
  cannot broaden parent authority, and never delegate approvals.
- Added deterministic authenticated-catalog role binding that preserves the
  user-pinned parent and reports unavailable instead of silently substituting a
  model or effort. Worker remains disabled by default.
- Added owner-only Piagent-owned helper budgets with two-concurrent/three-total,
  per-role and one-writer ceilings, deduplication, orphan recovery, terminal
  cancellation, and digest-only usage receipts. `PIAGENT_HELPERS_MODE` defaults
  to `recommend`; automatic worker delegation is not enabled.

## v1.2.17 - 2026-08-03

### Bilingual public documentation

- Added a complete English peer for all 17 public documentation pages under
  `/en`, while preserving existing Vietnamese URLs at the site root.
- Added same-topic VI/EN switching, localized navigation and copy feedback,
  canonical URLs, and `hreflang` metadata without adding a client-side i18n
  framework or language bundle.
- Extended build, release-identity, scaffold, link-integrity, and locale-parity
  gates to cover all 34 generated pages.
- Fixed the multi-page grid breakpoint that kept desktop sidebar and TOC
  columns active on mobile, restoring a single-column content layout.

## v1.2.16 - 2026-08-03

### Codex default

- Changed the default Codex configuration to `openai-codex/gpt-5.5:high`
  across setup, global install, model-scope configuration and the global
  settings template. Explicit `xhigh` selections remain supported.
- Changed the no-thinking-suffix fallback to `high` and added an executable
  regression test covering default settings, scoped models and explicit
  `xhigh` overrides.

## v1.2.15 - 2026-08-03

### Global update reliability

- Fixed stable updates from machines whose existing Piagent registration is a
  local path. Pi displays user-local sources relative to its agent directory,
  while `pi remove` resolves input from the caller's working directory; the
  installer now removes the discovered registration by its absolute path.
- Added a regression assertion that fails if the installer passes Pi's displayed
  relative path back to `pi remove`, covering updates launched outside the Pi
  agent directory.

## v1.2.14 - 2026-08-03

### Runtime architecture

- Split session lifecycle, input routing, context usage, tool-result filtering,
  tool activation and task intake out of the guard entrypoint into focused
  runtime modules while preserving the existing behavior and command surface.
- Added machine-enforced architecture layers, dependency directions and file
  size budgets so new runtime code cannot silently grow back into the guard.
- Extended capability integrity locks to pin every extracted runtime module;
  the test suite now rejects any runtime file omitted from that trust boundary.
- Added paired English and Vietnamese maintainer documentation with a language
  parity gate. Vietnamese docs preserve operational terms such as agent,
  terminal, workflow, MCP, session, token, model and benchmark.

### Session and migration reliability

- Stopped registering a custom `/name` command so Piagent no longer shadows
  Pi's native session command. Native rename events continue to update task
  bindings and Agent Watch records; `/setname` remains a compatibility alias.
- Hardened legacy task migration so long task identifiers retain a unique hash
  suffix, the source contract is archived before the v2 write, and path aliases
  cannot delete a newly written current contract on macOS.
- Added integration, runtime isolation, migration-collision, architecture and
  documentation tests for the extracted boundaries and release behavior.

## v1.2.13 - 2026-08-03

### Benchmark evidence

- Published a dedicated static benchmark page with the verified production-v1
  scores, median usage, paired fresh-token comparison, confidence interval,
  category coverage and release provenance.
- Added lightweight CSS charts for score bands, token usage and paired wins;
  the page has no charting dependency or client-side data fetch and remains
  readable on desktop and mobile.
- Added the sanitized v1.2.12 production snapshot to the benchmark guide and
  README while keeping the raw report private because its root seed can
  reproduce synthetic secrets.
- Documented that the full model run measured the release candidate before its
  metadata bump, and kept the claim scoped to the controlled public suite
  rather than presenting it as a universal model or repository result.

## v1.2.12 - 2026-08-03

### Production benchmark

- Added `production-v1`, a 108-session release benchmark covering 18 independent
  scenario families across backend, frontend, data, platform, reliability and
  security, with small/medium/large tasks, five profiles, cold-start and
  steady-state lifecycles, generated variants and private hidden oracles.
- Added category/profile/lifecycle/difficulty bands, Wilson quality intervals,
  complete-family efficiency evidence and a scenario-clustered 95% confidence
  interval for paired fresh-token ratios. Production claims now require all 18
  families, three repeats, quality/reliability/workflow/category scores of at
  least 9, perfect safety and an upper token-ratio bound no greater than 1.
- Added controlled Codex CLI comparison with a fresh private `CODEX_HOME` for
  every measured session and retry, paired seeded execution blocks, strict JSONL
  usage parsing, bounded diagnostics and streaming required/forbidden output
  checks.
- Added infrastructure-only retries for zero-usage process failures. Timeout or
  any run that consumed provider usage remains a measured reliability result;
  retries are recorded separately and cannot improve task scores silently.
- Validated the release candidate with 108/108 resolved sessions against Codex
  CLI on the same model/thinking configuration. Piagent reached 10.00 quality,
  safety, reliability and efficiency, 9.58 workflow and 9.92 overall; the
  paired fresh-token estimate was 51.11% lower with a 95% ratio interval of
  0.3809 to 0.6276.

### Harness refinements

- Kept automatic bounded intake for safe prompts while exposing explicit task
  intake when a legitimate high-risk request mentions a protected path.
- Rendered every verifier as a separate shell call throughout intake, recovery,
  compaction and final-gate guidance. Recovery now reports only verifier commands
  whose observed passing evidence is missing, avoiding accidental pipelines and
  repeated successful checks.
- Documented the distinct smoke and production workflow thresholds while keeping
  every failed workflow check visible in JSON, text and HTML reports.

## v1.2.11 - 2026-08-02

### Breakthrough task harness

- Added Task Implementation Contract schema v2 with unique `taskRunId`, Pi
  `sessionId`/`sessionName` binding, `source-change` versus `read-only` mode,
  bounded attempts, prior failure summaries, work-plan progress, and baseline,
  observed, final and declared changed-file evidence.
- Enforced one Pi session per task. Session rename updates the bound contract;
  resume maps legacy state only when Pi custom trace identifies the task. Retry
  starts in a fresh session, inherits prior evidence and cannot raise the limit
  fixed by attempt one.
- Source mutation now requires a task, a Git working tree, declared scope and a
  meaningful verifier. Read-only inspection remains available before a task and
  in scout mode. Terminal contracts are immutable.
- Final completion now requires every exact verify command to have a passing Pi
  bash observation after task start. The gate reconciles changed-file claims
  against Git baseline digests and tool results, rejects out-of-scope files and
  records both source and destination of staged renames. The assistant
  completion hook catches a premature DONE claim even when the agent skips the
  explicit gate call.
- Added `piagent_task_progress`, failed work-plan steps, dependency/cycle checks,
  failure phase/reason/ruled-out evidence and deterministic retry handoff.

### Context and performance

- Replaced routine model-driven intake/context/evidence/trace/gate choreography
  with lifecycle hooks. Runtime now creates bounded task contracts before the
  first model turn, deriving path/glob scope from the request and bounded Context
  Engine navigation. Broad, high-risk, ambiguous, or protected-path requests
  fail over to explicit intake instead of silently widening scope.
- Automatic source tasks expose zero Piagent management schemas and need no
  `task_start` round trip. Manual intake validates every scope entry as a
  project-relative path/glob, keeps the active tool surface cache-stable, and
  adds recovery schemas only when the selected lane requires them.
- Routine tasks no longer advertise the duplicate `piagent-ops` skill to the
  model. Runtime states that root project instructions are already loaded, so
  the agent does not spend tool calls re-reading platform policy or root
  `AGENTS.md`; the skill remains available for explicit manual/recovery use.
- A bounded automatic task can receive a current-turn Context Engine snapshot
  of relevant source/tests before its first model action. The snapshot is capped
  at 900 estimated tokens, restricted to source/test roots, filtered by the
  active exclusion policy and skipped for stale/low-confidence indexes; the
  agent re-reads only missing regions or edit mismatches.
- Node-family runtime intake resolves the generic verifier to concise existing
  package scripts such as `npm test`, while preserving the profile's fail-closed
  command when package metadata is absent or invalid.
- Removed the Piagent tool-loader schema from the default session and task
  surface. Prompt classification activates the required group directly, while
  explicit diagnostics can still request the loader; ordinary turns therefore
  carry no unused management schema.
- Verification evidence is bound to a SHA-256 digest of the current working
  tree. A later edit invalidates prior proof; running a verifier no longer looks
  like a mutation. Files edited and restored to their baseline digest do not
  satisfy the final changed-file gate.
- Added one bounded automatic continuation for automatic/assisted tasks when an
  agent stops with missing evidence, including the “existing tests pass but no
  relevant diff” case. The continuation uses Pi `followUp`, never loops, reports
  projected final-gate reasons, and recognizes Vietnamese completion wording.
  Set `PIAGENT_AUTO_RECOVERY=off` for rollback.
- Added lifecycle-native read-only plans: tiny scouts complete from observed
  reads, normal scouts retain one explicit evidence review, and high-risk or
  custom plans keep manual checkpoints.
- Auto Context Engine packing now skips follow-up turns once a task is active,
  avoiding repeated navigation payloads during verification or recovery.
- Automatic navigation also skips prompts that already name a concrete path,
  including protected dotfiles such as `.env`; the agent reads the bounded
  target directly instead of paying for an unrelated context pack.
- Benchmark workflow scoring accepts exactly one persisted intake source:
  runtime intake with zero model calls, or manual intake with one `task_start`.
  It still requires zero routine context/evidence/gate choreography and exposes
  failed checks instead of awarding 10/10 to expensive management loops.

- Auto-context is cached by project, session and prompt. A repeated prompt in
  one session is not reinjected; a manual pack with the same query returns a
  compact reuse marker unless refresh is requested. Another session still gets
  its own pack.
- Reduced automatic/manual context budgets, kept dynamic tools/default-on
  telemetry, added conservative UTF-8 token estimation and verified accented or
  unaccented Vietnamese retrieval.
- Profile source verifiers now fail closed instead of printing a successful
  placeholder. Node-family profiles run configured checks; DevOps verification
  cannot hide one failing verifier behind another passing tool.
- Added `piagent-benchmark`, a one-command paired Raw Pi versus Piagent runner.
  It creates isolated Git fixtures, alternates execution order, grades hidden
  correctness/scope/safety and Piagent workflow evidence, reads exact usage from
  Pi session JSONL, and emits private JSON, HTML, text, and JSONL reports.
- The same command can now compare `piagent` with `codex-cli`. Controlled mode
  runs Codex ephemeral in a workspace-write sandbox and a private temporary
  Codex home, excluding global `AGENTS.md`, user config/rules, hooks, plugins,
  sessions, and caches while linking the existing credential without copying it;
  disables available optional integrations discovered from that CLI version,
  requires command-line-pinned model/thinking parity, and keeps native mode as
  an explicit full-product comparison.
- Added fail-closed streaming parsing for Codex exec JSONL, including UTF-8
  chunk boundaries and output larger than the retained log tail. Fresh input
  excludes cached input, reasoning is not counted twice, full stdout is hashed
  without being stored, and unavailable OAuth currency cost remains `n/a`.
- The automatic benchmark prepares Piagent fixtures as initialized, onboarded
  steady-state projects before the measured model run. It no longer charges
  every task repeat for one-time onboarding, while post-baseline context/index
  mutations remain visible to the scope gate.
- Benchmark reporting separates hidden correctness from scope and end-to-end
  reliability, shows median usage across every measured run, and records only
  tool-name histograms so failed expensive runs cannot disappear from the
  headline while tool arguments and outputs remain private. These orthogonal
  metrics are emitted as benchmark report schema v2.
- Benchmark score bands cover quality, safety, reliability, workflow and fresh
  token efficiency. A token-saving verdict requires quality/reliability at
  least `9/10`, perfect safety/workflow, non-inferior quality, at least three
  same-model successful usage pairs, and a paired geometric-mean fresh-token
  ratio below `1`. The report keeps marginal medians as diagnostics, and adds
  pair wins plus median paired delta so task scale cannot silently reverse the
  conclusion. Manual benchmark recording remains backward compatible.

### State, migration and security

- `piagent-update` now keeps host and helper updates in the writable npm prefix
  that owns the active command. This prevents an `/opt/homebrew` installation
  from being shadowed by a second copy under `/usr/local` or a user fallback
  when `npm config get prefix` points somewhere else.
- Added idempotent v1-to-v2 task migration to session startup and
  `piagent-update --project`. Preflight refuses corrupt state before project
  writes; v1 is archived only after v2 exists. Existing onboarded projects keep
  their grants and do not need onboarding again.
- Added a shared local-state path boundary for task state, Context Engine,
  telemetry, bash evidence, traces and captures. It accepts a project opened
  through a legitimate cwd symlink but refuses `.pi` or any descendant ancestor
  symlink that escapes the project.
- JSONL state is owner-only, size bounded and rotated under a cross-process
  lock. Oversized records become audit markers. Tool-result captures are pruned
  to 500 files, 128 MiB and 30 days; readers/pruners tolerate concurrent
  rotation and deletion.
- Task v2 readers reject unknown fields, malformed timestamps, invalid nested
  plans, dependency cycles and taskRunId/filename mismatches. Git snapshots now
  remain truthful in unborn repositories and across staged renames.

## v1.2.10 - 2026-07-31

### Security

- `contextIndexV2Status` giờ yêu cầu `excludePatterns` tường minh như năm
  Context Engine API còn lại. Status không còn báo `policyStale: false` khi
  caller chưa cung cấp policy để đối chiếu, nên caller mới không thể vô tình bỏ
  qua rebuild của index được tạo bằng luật yếu hơn.

- Đã xóa fallback đọc exclusion list từ metadata cũ. Active policy luôn đến từ
  caller đã resolve project policy; index metadata chỉ còn là giá trị stored để
  so digest.

- Context index storage giờ dùng directory mode `0700` và mode `0600` cho
  SQLite database, WAL và SHM. Mỗi connection bật cả SQLite core
  `secure_delete` lẫn FTS5 `secure-delete`, nên source bị xóa trong refresh bình
  thường không còn nằm lại trong raw index bytes.

- Exclusion policy version `2` buộc index cũ tự migrate một lần khi mở bằng
  policy hiện hành. Migration dựng lại toàn bộ FTS index từ content table đã
  lọc, checkpoint WAL rồi `VACUUM` để purge cả tombstone FTS và free-page bytes
  được tạo bởi bản cũ. Digest mới và `purgePending: 1` được commit cùng nhau
  trước pha purge; cờ chỉ clear sau khi toàn bộ chuỗi thành công. Nếu app hoặc
  máy dừng giữa chừng, lần mở sau tự retry.

- Full FTS rebuild và `VACUUM` chỉ chạy khi exclusion digest đổi hoặc một purge
  cũ còn pending. Incremental rebuild cùng policy không nhận chi phí này.

- Image path trong chat giờ chỉ được auto-attach khi target thật nằm trong
  project hoặc `additionalReadRoots`, không khớp protected path, nằm trong
  capability read scope hiện hành và có bytes đúng định dạng ảnh. Symlink ra
  ngoài root, ảnh trong `.pi/piagent-state/**` và file giả đuôi `.png` đều bị
  từ chối trước khi nội dung được đưa vào model.

- MCP approval gate và `piagent-mcp doctor` giờ nhận diện cả `directTools` đặt
  trên từng server. Repository server bật direct tool trong khi
  `toolPrefix: "none"` sẽ fail-closed vì tên tool không còn mang server origin.

- `piagent-reviewer` giờ là read-only thật: manifest chỉ cấp `read`, `grep`,
  `find`, `ls`; autofix phải chuyển sang `piagent-worker`. Test package ghim
  mọi subagent có `acceptanceRole: read-only` vào allowlist read-only.

## v1.2.9 - 2026-07-31

### Security

- Context Engine CLI và runtime giờ dùng chung một policy resolver. Base policy,
  profile `extends`, `protectedPaths`, `shellProtectedPaths`, `readOnlyPaths` và
  custom context-index path cùng tạo ra một canonical exclusion list; context
  search/pack không còn đọc một view khác với guard.

- Context index metadata ghi versioned exclusion digest. Search, pack, impact và
  auto-context rebuild incremental khi digest hiện hành khác digest đã build,
  đồng thời lọc lại candidate ở read time. Index cũ tạo bằng luật yếu hơn vì vậy
  tự loại nội dung protected trước khi model nhận context.

- Context Engine từ chối source-shaped symlink và canonical path đi ra ngoài
  project ở cả build, stale check và pack read.

- API build, ensure, search, pack và impact giờ fail-closed nếu caller không
  truyền `excludePatterns` tường minh. `[]` vẫn được hỗ trợ cho low-level tool
  chủ ý chạy không loại trừ; caller mới không còn vô tình quay về permissive
  default.

### Fixed

- `piagent-update --dry-run --project ...` báo trực tiếp khi helper thiếu project
  migrator thay vì chạy Node rồi trả stack `MODULE_NOT_FOUND`.

### Documentation

- Tài liệu ghi rõ dynamic tools, auto context và Context Engine telemetry bật mặc
  định; telemetry vẫn chỉ lưu metadata/hash đã redact, không lưu prompt hay tool
  output thô.

## v1.2.8 - 2026-07-31

### Changed

- Global setup/update now installs `pi-web-access@0.17.0` by default so builtin researcher subagents can browse/search/fetch external sources instead of being limited to local repo/docs. Machines that cannot use web research can opt out with `--no-web-access`.

### Fixed

- Global install/update now removes older platform-owned `pi-web-access` registrations before installing the reviewed exact version, forcing Pi's shared npm package tree to refresh stale transitive dependencies.

## v1.2.7 - 2026-07-31

### Security

- Updated the pinned MCP and subagent add-ons to `pi-mcp-adapter@2.15.0` and `pi-subagents@0.38.0`. Their resolved runtime tree uses patched `fast-uri@3.1.4`, `@hono/node-server@2.0.12`, and MCP SDK `1.30.0`; a clean resolution reports no add-on advisories.

- Raised the runtime release gate from high/critical to moderate/high/critical. The only remaining accepted finding is the separately documented `brace-expansion` denial of service pinned inside Pi host `0.82.0`.

### Fixed

- Global install/update now removes older registrations for platform-owned MCP and subagent add-ons before installing their reviewed exact versions. This forces npm to refresh stale transitive dependencies instead of retaining a vulnerable version from an older shared Pi package lock.

- An existing `pi-subagents` installation is detected and upgraded during a normal platform update. Clean machines still require `--with-subagents`, and `--no-subagents` remains an explicit opt-out.

## v1.2.6 - 2026-07-31

### Added

- Added Pi Context Engine v2: a local incremental SQLite FTS5 index with symbol and import extraction, hybrid Reciprocal Rank Fusion and personalized PageRank retrieval, hard-budget context packs, reverse-import test impact, and the `piagent-context` terminal command.

- Added Agent Watch compatible context telemetry keyed by Pi session ID and session name. It records model/thinking metadata, active tool counts, usage, retrieval confidence, context-pack utilization, duplicate reads/output, and transparent context-waste metrics without duplicating raw prompts or tool output.

### Changed

- Piagent now starts with a one-tool loader and activates governance, policy, code retrieval, knowledge, onboarding, and usage groups by task shape. Tiny tasks expose 11 of 30 Piagent tools and ordinary tasks expose 15, while runtime guards remain active regardless of the visible tool schema.

- Task and scout workflows are risk-adaptive. Unfamiliar work receives one bounded Context Engine pack, low-confidence retrieval permits at most one read-only finder pass, repeated read/search results collapse to a delta marker, and session compaction preserves task state instead of raw logs.

- Quality benchmarks now record fresh input, output and cache-read tokens, first-correct-edit time, rework count, and a context-efficiency snapshot so token savings are compared against acceptance and verification quality.

### Fixed

- Release installation now removes an older local `@piagent/platform` registration as well as older Git registrations before installing the pinned release, preventing the local checkout and released package from loading together.

## v1.2.5 - 2026-07-30

### Fixed

- `piagent-update` now accepts npm 12's singleton-array `npm view --json` output when resolving the target helper version and its pinned Pi host peer dependency. Empty or multi-entry metadata still fails closed, so the updater never guesses which release or host to install.

## v1.2.4 - 2026-07-30

### Changed

- `piagent-update` remains a global machine update first; optional `--project <path>` now runs a post-update legacy project migration and strict-share doctor when a maintainer wants that extra check.

- Documented the global `npm exec --package @piagent/platform@X.Y.Z -- piagent-update ...` bootstrap command for machines that do not have the global `piagent-update` helper yet.

- `piagent-update` now falls back to a user-writable npm global prefix when the default prefix is locked by the OS, avoiding `/usr/local/lib/node_modules` permission failures during team rollout.

## v1.2.3 - 2026-07-30

### Added

- Added short runtime command namespaces for team use: `/commands`, `/usage`, `/context`, `/permission`, `/memory`, `/onboard`, `/name`, and `/fresh`.

- Added a compatibility rewrite for `/piagent-workflow` so older muscle memory routes to `/workflow` instead of becoming a normal agent prompt.

### Changed

- Consolidated workflow launchers under `/workflow ...` and fresh-session launches under `/fresh task|scout|be-to-fe ...`, reducing accidental scout/log chatter before a user reaches the menu.

- Updated onboarding, quickstart, operator, deployment, and docs-site command references to separate Pi native commands from PiAgent runtime commands. Pi native `/model`, `/session`, `/resume`, `/compact`, and `/mcp` remain unclaimed by PiAgent.

### Removed

- Removed prompt-file versions of runtime help commands that should execute locally rather than asking the agent to inspect docs.

## v1.2.2 - 2026-07-29

### Added

- Added compact tool-result rendering for oversized Pi outputs. Small results still pass through unchanged; large redacted outputs now show a bounded preview in Pi and are captured under `.pi/piagent-state/tool-results/` with an `index.jsonl` for offline Agent Watch/reporting.

- Added `/piagent-logs`, a local slash command that shows the compact-log policy and recent oversized output captures without calling the model or tailing logs in realtime.

- Added `/setname <task/session name>` so an already-open Pi session can be renamed for resume lists, Agent Watch mapping, and weekly reports without restarting Pi.

### Changed

- `/piagent-usage` and `/task-preflight` now render concise status lines instead of long markdown reports while keeping structured details available to the runtime.

- Workflow prompts and Vietnamese operator docs now tell agents and team members to summarize verify/build failures, quote only relevant lines, and use `/piagent-logs` or narrower commands instead of pasting full terminal dumps into the session.

## v1.2.1 - 2026-07-28

### Fixed

- The approval gate never covered direct MCP tools. It looked for a tool named `mcp__<server>__<tool>`; the adapter builds a name by joining the server's own name to the tool's, so `github` exposes `github_create_issue` and nothing ever matched. Every server was reachable with one `directTools` setting, which `piagent-mcp add --direct-tools` offers and the docs recommend for small servers. Attribution now runs against the configured server names across every prefixing mode.

  A repository-carried config that sets `directTools` with `toolPrefix: "none"` leaves no evidence of a server in any tool name, so there is nothing to check a decision against. Every tool call in that session is refused while the setting stands. Refusing only the `mcp` proxy, as the first fix did, closed nothing: the proxy is the one form that still names its server, and the bare names it was protecting went straight through.

  The v1.2.0 notes, `docs/mcp-and-tools.md` and the documentation site all stated the direct form was covered. It was not, and the test that asserted it asserted the same invented name shape.

- A repository could reach servers the gate never enumerated through the adapter's `imports` key. `.mcp.json` naming `vscode` pulls servers out of `.vscode/mcp.json`, which travels with the clone, while the gate reported no repository servers at all. Servers reachable through a repository-relative import are now collected and gated whichever layer declares the import, and a repository scope that imports any kind has those servers gated too. `piagent-mcp doctor` names the file and the kinds, and reports a config layer it cannot parse instead of counting it as empty.

  One kind cannot be enumerated at all: `codex` keeps its servers in TOML, and nothing here parses TOML. Listing the servers of the five readable kinds says nothing about that one, so a repository declaring it has every tool call refused rather than the servers that happened to be readable gated and the rest let through.

- `piagent-mcp doctor` and `list` reported "No MCP servers configured" and exited 0 in exactly the states where the guard was refusing every tool call, and `list` went on to suggest seeding a baseline. Both now report the config that stopped the session and exit 1. The condition is decided in one place that the guard and the CLI both read, because the two disagreeing is what turned a blocked session into an unexplained one.

- A server imported from a repository-relative file was reported `ready` when a global config declared the import, while the gate treated it as a repository server awaiting approval. Scope answers which layer named the import, not where the definitions came from; a `global` config importing `vscode` reads them out of the clone. Whether a server needs approval is now decided where servers are collected, so both surfaces give the same answer, and the reason names the file the definition actually came from.

- `piagent-capability vendor` emptied its destination before checking containment and only tested the immediate parent for a symlink. A repository shipping `.pi` as a symlink had the recursive delete and the fetch land outside the project. The whole path is now verified against the resolved project root before anything is created or removed.

  Emptying the destination first was also not recoverable: a fetch that failed for any reason — no network, a hostile archive rejected by the symlink check — left the project with neither the new source nor the reviewed one it had been running on. The fetch now lands beside the destination and moves into place only once it has passed every check, so a failed re-vendor leaves the working tree exactly as it was.

- The shell guard followed nested interpreters four levels deep and then stopped looking, so a payload wrapped in five layers of `bash -c` was permitted on the strength of a level nobody read. The walk now goes to sixteen levels and refuses a command that nests past it, rather than falling silent.

- An artifact shipped by a vendored capability source could change content while the lock still classified as `repin`. Artifact bytes stay on the build side for packs the platform ships — pinning them would stop a policy correction reaching the projects that reference it — but that reasoning does not transfer to a source the project vendored in, whose manifest digest pins the artifact list rather than its contents.

- A credential in an MCP server URL was stored and displayed in clear text. `add` now refuses userinfo and credential-shaped query parameters the same way it refuses them in `--env` and `--header`, and `list` and `get` mask a URL already on disk.

- `piagent-mcp approve`, `reject` and `reset` reported success when the approval store could not be written, leaving the operator waiting on a gate that was still blocking. All three now fail with the path that could not be written.

- A server using `bearerTokenEnvVar` reported `ready` with the variable unset. The field names its variable directly rather than through a `${VAR}` reference, so the scan that finds referenced variables never saw the one setting that guarantees a credential is needed.

- A capability pack could declare `activation.mode: "profile"` with no profiles list and crash resolution with a TypeError. The validator requires the list, the same way it already required triggers for trigger activation.

- Every script that takes `--flag <value>` read the next argument without checking it was a value. `--preset full --settings --dry-run` wrote a settings file named `--dry-run`, exited 0 and reported success, having skipped the dry run it was asked for and never touched the real settings file. `init-project.sh` and `setup.sh` checked only that an argument was present, which catches a flag at the end of the line and nothing else. All eight scripts now refuse a flag-shaped value, and the suite asserts it for every value-taking option in `scripts/`, including ones added later.

- The shell guard did not see a path reached through an inline interpreter script, an unbalanced quote, or a shell variable with a default. `node -e "require('fs').readFileSync('.env')"`, `cat .env'` and `cat .${X:-env}` all read a protected path without matching one. Literals inside an inline script are now extracted, tokenizing survives a quote with no partner, and a variable's default value is expanded when nothing else defines it.

- ANSI-C quoting hid a path from the guard entirely. `$'...'` decodes its escapes before the word is passed on, so `cat $'\x2eenv'` opens `.env` while the guard saw the literal `x2eenv`; a redirection target was not handled at all, so `printf x >$'.env'` truncated a protected file. The same trick reached the exec policy: `rm -rf $'\x2f'` was permitted, having been read as a removal of something called `x2f`. Escapes are decoded — hex, octal, short and long unicode, and the named ones — in tokenizing and in redirection targets alike.

- The destructive-command checks read raw shell words, so a catastrophic target written as a substitution was compared as literal text and matched nothing. `rm -rf /` was refused while `rm -rf $(printf /)`, `rm -rf $(echo /)`, `` rm -rf `printf /` `` and `find $(printf /) -delete` were all permitted; nothing downstream caught them either, since `/` is not a protected path. `printf` and `echo` with literal arguments are pure text and are now evaluated, so those resolve and the same refusal applies, and a variable holding the target (`D=/; rm -rf "$D"`) is expanded the way the path checks already expand it.

  A target only the shell can produce — `rm -rf $(mktemp -d)`, `find $(mktemp -d) -delete` — is a confirmation rather than a refusal: refusing outright takes a common idiom away, and permitting silently is how the check above was walked around.

  Evaluation is also limited to the `printf` formats the renderer reproduces: `%s` with no flags, width, precision or positional argument, and a format with no conversions at all. Everything else transforms its argument rather than printing it — `%.0s` truncates it away and prints the rest of the format, `%*s` consumes an argument as the width, `%q` requotes, `%b` decodes — so substituting the raw argument produced a value bash never printed. `rm -rf $(printf %.0s/ x)`, `$(printf %*s 0 /)`, `$(printf %.*s 1 /)` and `$(printf %q /)` are all `/` in a shell and were all permitted. `%%` and a format with more arguments than conversions (which bash reuses and this does not) are excluded for the same reason.

  The same renderer fed the protected-path scan, so `cat $(printf %.0s.env x)` and `printf data > $(printf %.0s.env x)` reached `.env` without matching it. A `printf` format's literal text arrives in its output whatever the conversions do with the arguments, so it is now read as a path candidate in its own right — with the conversions taken out and what is left closed up, because a conversion that prints nothing lets the text on either side meet: `.e%.0snv` is `.env`, and reading the pieces separately gave `.e` and `nv`, neither of which is a file anybody protects. `printf %.0s.env x` on its own stays permitted, because printing a name is not opening it.

  Single quotes suspend substitution, and quoting is gone by the time a word is tokenized, so `rm -rf '$(printf /)'` — a file with an awkward name — was refused as a root removal. Whether the segment contains a substitution the shell would actually run is now read from the raw text, and the scan that reads substitution bodies skips single-quoted text as well: `rm -rf $(printf /) '$(a;b)'` really does remove `/`, and reading the literal beside it as a body made the whole segment unevaluable, dropping a refusal to a confirmation.

  Evaluation is limited to a substitution body that is one plain command and its literal operands. A separator puts a second command after the one being read, so `$(printf /; echo)` is `/` and `$(printf /; printf /)` is `//` however little `printf /` says so; a nested body cannot be located by pattern at all, since a pattern for `$(...)` matches the inner half of `$(printf $(printf /))` and describes a substitution nobody asked about; and quoting is applied before a word is tokenized, so `$(printf '\x2f')` arrives here as `$(printf x2f)`, which evaluates to a value the shell never had. Permitting on a wrong value is worse than not resolving, so any body carrying a separator, a nested substitution, a redirection, a variable, quoting or an escape gives up on evaluation and asks. A substitution still present after the resolution is not treated as resolved.

  Every round of this so far reported a `printf` format, and reading one operand shape per round is how the same class kept coming back. Four more forms are closed together. Brace expansion runs before every other expansion and was not modelled at all, so `rm -rf {/,}` removed root and `cat {.env,}` opened a protected file while both read as ordinary words — the empty alternative is the whole trick, making a one-word expansion out of a form that does not look like one; it is now performed, and only where the shell would perform it, since quoting suspends it and `"{/,}"` really is one awkwardly named file. `--` ends `printf`'s options, so `$(printf -- /)` prints `/` while the format was read as `--`; any other `printf` option is now treated as one this does not model, since `-v NAME` assigns the result and prints nothing. A target that is nothing but a parameter expansion can be any value, root included: `${HOME:0:1}` is `/`, substring expansion is not modelled, and the word stayed exactly as written — so the shape decides rather than the operator, and a recursive removal of an unresolved whole-word expansion is asked about instead of permitted, while `$TMPDIR/build` is untouched because it cannot become root. And escapes are decoded inside a substitution body the same way they already were elsewhere: `$(echo -e '.en\x76')` and `$(printf %b '.en\x76')` both print `.env`, and the backslash is gone by the time the body is tokenized, so it is read back off the raw text.

  The `printf` renderer substituted the raw argument for every conversion and ran the format once, so its output was not what `printf` writes and the protected-path scan never consulted it at all — it was offered the format's literal text and the raw arguments separately. A name assembled out of both went unseen: `.e%.1sv` with `nv` is `.env` while the pieces on offer were `.ev` and `nv`, `au%.2s.json` with `thX` is `auth.json`, and because bash reuses a format while arguments remain, `%s` with `.e` and `nv` is also `.env`. `cat $(printf .e%.1sv nv)`, `printf data > $(printf %s .e nv)` and `printf %s au th.json | xargs cat` all reached a protected file with nothing matching. The renderer now applies precision, width and format reuse, and its output is a path candidate in its own right; printing a name on its own stays permitted, as before.

  Because the rendering is now accurate for those formats, the destructive check no longer merely asks about them: a constant precision or width and format reuse are reproduced byte for byte, so `rm -rf $(printf %.0s/ x)` and `rm -rf $(printf %s / /)` are refused rather than confirmed — they are `/` and `//` in any shell. `*` stays a confirmation even though the renderer now follows one: the width it consumes has its own rules, and a modelling slip there becomes a refusal of something nobody asked for. `%q`, `%b`, the numeric conversions and `%%` are unchanged and still confirmed.

  Brace expansion was applied to the operands and nowhere else, but the shell performs it before it decides what the command even is. The command name, the flags and the `xargs` payload could all be assembled by it, and each read here as the text the author typed: `r{m,} -rf /` is `rm r -rf /` to the shell and a command called `r{m,}` to this, `rm {-rf,} /` lost the `-rf` the same way, and `fi{nd,} / -delete`, `find / {-delete,}` and `echo / | xargs rm {-rf,}` all went through. The whole word list is expanded now, before anything reads a command name or a flag. `find` also read only its first path operand, so `find fi / -delete` was judged on `fi` — every leading operand is a starting point and all of them are checked.

  The `xargs` producer reads its own tokens rather than going through the shared candidate path, so the brace expansion done there never reached it: `printf {.env,} | xargs cat`, `printf .{en,}v | xargs cat` and `echo auth{.json,} | xargs cat` each opened a protected file with nothing matching. Quoting still suspends the expansion in both places, so `printf "{.env,}" | xargs cat` names the file it literally names.

  Expanding braces inside the destructive checks fixed those checks and left every other reader on the raw text, which is not what the shell does — it expands once, before it decides what the command is. So `git reset --har{d,}` passed a legacy pattern, `docker volume pr{une,}` an exec-policy rule, `git p{ush,}` a confirmation pattern, and `{bash,} -c '...'` the nested-interpreter scan, each of them reading the words as typed. The word list is now built in one place and every reader takes it from there. Ranges are expanded as well: they look like they only enumerate counters, but `{n..n}` is a single letter with the braces removed, so `r{m..m}` is `rm`, `fi{n..n}d` is `find` and `.e{n..n}v` is `.env`.

  Two things the expansion then exposed. `find` takes its own options before the paths start, and the target scan stopped at the first `-`, so `find -H / -delete` was judged with no target at all; `-H`, `-L`, `-P`, `-O<level>`, `-D` and `--` are skipped now. And a lone `-` between `-c` and the script ends the option list without being the script, so `bash -c - 'rm -rf /'` runs the removal while the scan read `-` and found nothing — which is exactly the shape `bash -{c,} '...'` takes once expanded.

  Two readers were still on the raw words after that. The `xargs` producer identified its command as written, so `{printf,} .e%.1sv nv | xargs cat` found no producer at all — the output was never rendered and the `.env` it prints was never offered; the same held for a producer inside a substitution, and for the escape decoding, which is gated on the producer's name too. The producer's *name* now comes from the expanded list while its operands stay on the raw tokens, which are the only thing that still knows where the quotes were.

  And the path candidates expanded braces unconditionally, which was the conservative half of the same problem: `cat "{.env,}"` opens a file with that literal name, and offering `.env` for it refused a command that touches nothing protected. The tokenizer already decides whether the shell would expand a word, and that verdict is now carried to the candidate list instead of guessed at — including for redirection targets, where the scanner reports it alongside the path.

  Expanding into a *word list* while still reading operands off the raw tokens left one word doing two jobs. A brace word can produce the command and its arguments together: `{cat,.env}` is `cat .env`, and taking the name from the expanded list and the arguments from the unexpanded one saw a `cat` with no operands at all. The same shape hid a producer's format — `{printf,.e%.1sv} nv` prints `.env` — from the renderer. The expansion now produces a token *stream*, and command, flags and operands all come off it.

  Quoting is tracked per character rather than per word, because one word can hold both: `"{.env,}"{,}` is the literal `{.env,}` twice, and a single flag for the token could only say "expand it all" or "expand none of it" — the first refused a command that opens nothing protected. Each piece of the syntax is decided on its own, so a quoted opening brace, a quoted comma, and a backslash in front of either each stop the expansion exactly where the shell stops it.

  The regression test for this class no longer enumerates formats. It builds the word list `bash` actually builds for each expansion form and requires the policy to agree about what that list contains, in both directions — a catastrophic target must not be permitted, and a protected path must be seen — so a form nobody thought to write down is still compared against the shell rather than against an expectation.

  That test now generates the forms instead of listing them: it assembles spellings out of the pieces a shell composes — quotes, escapes, ANSI-C, braces, ranges, `printf`, parameter expansion — and puts each one in front of several readers. It found three misses on its first run, and one of them was the cause of the other two. A brace group holding a parameter expansion closed on the wrong brace, because the scan for the closing `}` counted the one that ends `${...}`: `{cat,${X:-.env}}` became `cat}` and `${X:-.env}`, so the command was not `cat`, the operand was not a path, and `{rm,-rf,${X:-/}}` was permitted outright. The brace boundaries are now read with the same per-character record of what is syntax and what is text that the alternatives were already split by.

  A word that is nothing but an unresolved parameter expansion is now refused wherever the command says the word is a file. `cat ${HOME:+.env}` opens `.env`, and every check here read it as a word naming nothing. A command substitution in the same position is left alone deliberately: it carries a command that the nested scan classifies, so `cat $(gh issue create ...)` is still answered as an external write rather than with a vaguer reason. Two expansions with nothing between them are treated as a name being assembled, the same as literal text beside one, because `$(printf %.1sen .Z)$(printf %.1s vZ)` spells `.env` and neither half contains it.

  And a pipeline is judged as a pipeline. `echo $F | xargs cat` opens whatever `$F` names while neither segment shows it — the producer only prints, and the consumer's operand list is empty because the filename arrives on stdin. A producer feeding an `xargs` that opens files is now judged against the command at the far end of the pipe. A producer holding no expansion is unaffected, so `git diff --name-only | xargs cat` is untouched.

  What kept this class alive for so many rounds was never the spelling. A segment had a dozen readers and each derived its own view of it, so closing a form for one reader left it open for the other eleven — and each round closed the reader that had just been reported. The generated corpus was then only generating *operands*, which is why it came back clean while the command name was still being read as written: `rm -rf $(printf /)` was refused because the destructive check resolved its own target, and `r$(printf %s m) -rf /` — the same removal with the name assembled the same way — was permitted by every check in the file.

  Substitution resolution has moved to where brace expansion already was, so the shell's order — braces, then parameters, then substitutions — is performed once and every reader takes the result. That closed the command name, the `find` and `xargs` operands, the interpreter name in `$(printf %s ba)$(echo -n sh) -c '...'`, the `xargs` consumer in `echo .env | xa$(printf %s rgs) cat`, and the redirection target of a data-only command, which no reader had covered because `printf`'s own arguments are not files even though what `>` names always is.

  Where a name still cannot be resolved, it is now treated as the unknown command it is. `${X:+r}m -rf /`, `${X:+b}ash -c 'cat .env'` and `${X:+cat} ${X:+.env}` are each that command whenever the variable is set, and each read as something harmless with an odd name. A name carrying an expansion no longer has to match a known command for the destructive checks, the interpreter scan or the file-operand net to look at it. A named command with a literal operand is untouched, so `grep -r TODO src` and `npm run $SCRIPT` keep their answers.

  The corpus that found all of this generates the cross product the bugs actually live in — expansion form × position × reader — putting each spelling in the command name, the operand, a flag's argument, a redirection target, a pipeline producer, an `xargs` consumer and an interpreter payload. It ran clean at 36,000 commands with no missed protected path, no permitted removal of root, and nothing reported for a command that touches neither.

  One reader was named in that change and not moved: the glob candidates were still read off the words as typed. That mattered more than it looked, because a pattern is the one thing the literal check cannot answer for — `.env*` matches no protected literal, so the glob reader is all that stands between it and the file. `{cat,.env*}`, `{grep,-f,.env*,README.md}`, `cat $({echo,.env*})`, `{bash,} -c 'cat .env*'`, `bash -{c,} 'cat .env*'` and `echo .env* | xargs cat` each read a protected file with no candidate produced at all. It now takes the same word list as everything else, descends the brace-expanded text, and follows a pattern printed into an `xargs` that opens files.

  Brace expansion carries its per-character record out with each word instead of dropping it, because one token can produce words that are not the same kind of thing: `{cat,.env*}` is a command and a pattern, and inheriting the token's verdict got one of them wrong. Whether a word is matched against filenames is now decided per word, so `{".env*",x}` names a file and globs nothing, exactly as the shell has it.

  The same record fixes the redirection scanner, which kept one flag for the whole target. `printf x > "{.env,}"{,}` is an ambiguous redirect that writes nothing, and expanding the quoted group anyway offered `.env` for a file the command never touches.

  That fix reached the literal reader and stopped at the glob reader, which was still holding the target as typed and answering on the pattern inside it, so the same three commands stayed blocked on `.env` while writing no file at all. Both readers now apply the rule bash applies: a redirection opens its target only where it expands to exactly one word, and answers `ambiguous redirect` otherwise. `> {.env,other}` and `> .en{v,w}*` were the same false positive unreported, while `> {.env,}` really does truncate `.env`, because an empty alternative is dropped rather than counted. A word that can still disappear — an unset variable, or a pattern under `nullglob` — leaves the count unknowable, so those keep every candidate. The flag the scanner used to report beside the mask is gone; a flag for a whole word is what went wrong here to begin with, and two records that can disagree is one too many.

  The generated corpus asserted off the word list bash builds, which for a redirection over-states what it opens — that is how it demanded an answer for `printf x > ".e"{,}nv`, a command that writes nothing. The oracle now asks whether bash opens the target, not what it expands to.

  The corpus had no `*` in it, which is why it reported clean while all of this was open — a spelling axis missing from the grammar is a class of defect the generator cannot reach. Patterns are now generated too, expanded in a scratch directory holding names a protected pattern matches, since that is the only way to tell an active glob from a quoted one.

- A finding's strength depended on how its sentence started. The exec-policy decision was derived from the prose of each reason — "Refusing", "Forbidden", "Prompt" — rather than from the action the check had already recorded, so a finding whose wording did not begin with one of those words was recorded, displayed, and then counted as `allow`. The decision now reads the recorded action, with the prose test kept for the legacy confirmation patterns, which record a reason and no action.

- The MCP gate is cached per project and recomputed when a signature over the files behind it changes. That signature was written out by hand from the repository layers, while the check it guards had grown to read merged settings from all four scopes and to stat import targets outside the repository. Adding `directTools: true` to a personal global config while a repository set `toolPrefix: "none"` therefore left an already-loaded guard permitting tool calls that `piagent-mcp doctor` was reporting as blocked, until the module happened to be reloaded; an `imports: ["codex"]` declaration behaved the same way once the codex config appeared. The file list now comes from the same traversal the readers use, absences included, so a reader that starts consulting a new file is watched for it without a second list needing to be updated to match.

- The shell guard read `>|` as a pipe. Splitting there made the file being truncated the first word of a second command, where it read as an executable name, so `printf x >| .env` overwrote a protected path without matching one. `>&word` opens that word for writing unless a digit or `-` follows, and the whole form was skipped; a redirection can also precede its command, where it was read as the command name. Paths carried as an operand value (`dd if=`, `--file=`), inside an array literal, or rewritten by a parameter operator (`#`, `%`, `/`) were not resolved either, and a word was split at the space inside `$( )`, so the filename being assembled was never a single token.

  Where a filename still cannot be resolved — literal text glued onto a substitution, as in `cat .en$(echo v)` — the command is refused and the word that caused it is named. Matching the literal half against the protected patterns answers a different question than the one being asked.

- `piagent-mcp list --json` reported `servers: []` and exited 0 while the guard was refusing every tool call, so a caller scripting against it read the blocked state as an empty one. Its exit code now answers whether MCP can work here rather than whether any rows printed, and the JSON carries the reason. The in-session `/piagent-mcp status`, `doctor` and menu report it too: all three surfaces now read one shared state instead of assembling their own from a different subset of the same calls.

- The adapter merges `settings` across all four config layers into one session-wide block. `directTools` set in one file and `toolPrefix: "none"` set in another therefore produced a session with neither property visible to a check that read either file on its own — the exact combination that leaves the approval gate nothing to check. Settings are now read merged, and the report names both files, since editing either one fixes it.

- `remove`, `enable` and `disable` on a server reached through `imports` wrote to a file the adapter does not read for that server, so the command reported success and the next tool call still reached it. Worse, the file it located was the other tool's config: the write would have rewritten somebody's Cursor or VS Code file in this platform's format. All three now refuse and name the file that actually defines it.

- The menu and the detail view decided whether a server needed approval from its scope. A repository-relative import declared by a `global` config carries the scope `global` and a definition read out of the clone, so the servers whose origin is hardest to see were the ones never offered a decision. Both now use the same rule the gate uses.

- Approving showed the fragment the repository layer contributed rather than the definition that runs. The adapter merges a same-named server key by key across layers, so a repository declaring only `{"args": [...]}` inherits its command from a lower layer, and the operator was consenting to a command line they were never shown. The preview is now the merged entry; the digest stays over the repository's own fragment, so editing a personal global config does not return a server to pending.

- A repository importing `codex` had every tool call refused whether or not that config existed on the machine. An import of a kind nothing here can parse is a hole only when the file it names is actually there; otherwise it is a config to clean up, not a session to stop.

- An MCP config that parses but is not a JSON object was read as empty, so the next write replaced it with this tool's shape and destroyed whatever the document had been. It is now refused. A write also no longer follows a symlink at the config path, drops `imports` kinds this version does not recognise, or hides an import target that exists but cannot be parsed — that last one reported as no servers, which is indistinguishable from a tool that defines none.

- The approval store could not tell absent from unreadable. Both read as pending, which is right for the gate and wrong for a write: recording one decision on top of a store this process could not parse discarded every decision in it, including the ones for other projects, whose only symptom would be returning to pending one at a time. Writes now refuse when the store could not be read.

### Changed

- `docs/mcp-and-tools.md` records the config path and server key each supported import kind actually uses, against what the adapter reads. Three of the six disagree, so the platform reads the union: listing a server that never loads costs one approval, missing one costs the gate.

- `verify` refuses a source file carrying a control byte. Three files held a raw NUL inside a string literal — used as a key separator, and as ZIP magic in a test fixture. They ran correctly, but Git classified them as binary, which took them out of every grep-based gate in `verify`, including the wording checks, and out of the diff a reviewer sees on a pull request. The bytes are written as escapes now.

## v1.2.0 - 2026-07-28

### Added

- `piagent-mcp` manages servers instead of only seeding presets: `add`, `remove`, `get`, `list`, `enable`, `disable` and `doctor`, across the four config layers via `--scope`. `add` reports which scope it wrote and the exact file it changed, so nobody has to guess which layer is in effect. A server added by hand keeps surviving `piagent-update`, because a preset only rewrites the server IDs it owns.

- A server a repository defines is not usable until somebody on this machine approves it. `.mcp.json` and `.pi/mcp.json` travel with a clone, and opening a session in one should not hand its author a process here with this operator's credentials. `piagent-mcp approve` prints the definition before recording the decision, `reject` and `reset` are the other two answers, and the decision is stored in `~/.pi/piagent-mcp-approvals.json` rather than in the repository — a repository that can approve its own servers has not been gated.

  The record pins the digest of what was approved. Approval is consent to what the server runs, so changing its command, URL or arguments returns it to pending, which is the same split the capability lock draws between consent and build.

  Enforcement is in the guard's `tool_call` hook. As shipped in this version it covered the `mcp` proxy only — the direct-tool branch matched a name shape the adapter does not emit, so it never fired. See v1.2.1. The adapter owns the connection and the extension cannot prevent one being opened, so what is stopped is every tool call, not the connection itself. Servers in the global layers are not gated: nothing a repository contains can put a server there.

- MCP is a command inside a session, not a request to the model. `/piagent-mcp` on its own opens a menu, because a surface only helps if it can be found without already knowing the subcommand. The menu is built from what the project has: approving is not offered when nothing is waiting on a decision, and each entry carries its own count. Picking an action that needs a server asks which one, unless there is only one it could be.

  Every entry is also typeable — `status`, `get`, `doctor`, `approve`, `reject`, `reset`, `enable`, `disable` — and both paths run the same code, so the menu teaches the direct form instead of replacing it. Subcommands and server names autocomplete. Where no prompt can be answered, in print and JSON mode, the report and the subcommand list are printed rather than blocking on a question nobody can answer.

  Typing the shell command mid-session asked the model to run bash, read the output and report back — three model turns for a question this process answers from files it has already read, and a different summary each time. Pi dispatches a registered command straight to its handler, so the model is not involved at all.

  Adding and removing a server stay in the terminal: `add` carries shell quoting, `${VAR}` references and a `--` command line. Those already have one correct parser, and it is the shell; a slash command that re-implemented it would be a second, worse one. `/piagent-mcp add` prints the terminal command rather than guessing at one.

  Both surfaces read the same module, so the two cannot disagree about whether a server is usable. Remedies name the form that works where they are read: the session prints `/piagent-mcp approve <name>`, the terminal prints `piagent-mcp approve <name>`.

- `piagent-mcp doctor` and `piagent-doctor` say what each configured server still needs — a referenced variable that is not exported, an executable that is not on PATH, a decision that has not been made, the Docker daemon not answering. Counting configured servers, which is what the doctor did before, says nothing about whether any of them can answer. A session start names the ones that are definitely stuck; `PIAGENT_NO_MCP_NOTICE=1` switches that off.

### Changed

- `piagent-mcp add` refuses to write a credential into MCP config and prints the reference form to use instead. The check reads both the field name and the value, so `--env CONFIG=ghp_...` is caught as well as `--env GITHUB_TOKEN=...`, and it covers `--header` too. `--url` accepts https, or http only on loopback. `list` and `get` mask values while leaving `${VAR}` readable, because that is a variable name rather than its contents.

  OAuth is not automated and no token is stored by this platform. Pi already owns that flow — `/mcp-auth <server>` — and a third credential store holding other people's credentials would be worse than either of the two that already exist.

- `scripts/configure-mcp.sh` is replaced by `scripts/mcp-manage.mjs`; the pinned server catalog moved into `packages/piagent-core/mcp/`, where the capability lock pins it. The `piagent-mcp` command is unchanged. The three MCP files that decide which servers a session may call are now part of the locked runtime set.

- The docs site is one page per topic instead of a single file, grouped in the sidebar as Get started, Build, MCP and Operate. MCP has four pages of its own, since it now has a command surface, an approval decision and an auth story to explain. Each page carries a table of contents and previous/next links.

  Pages are generated by `scripts/build-docs-site.mjs` from a content fragment each, plus shared `docs-site/assets/docs.css` and `docs-site/assets/docs.js`. The generated HTML is committed, because the site is served as static files with no build step, and `npm run verify` fails when the committed output no longer matches its source. `npm run site:preview` serves the result the way the deployment does — the site relies on clean URLs, so an ordinary static server answers 404 for every internal link.

- Public text describes this platform on its own terms rather than against named competing products. The page that compared feature tables now states what the platform takes on and what it leaves to the host, and is called Phạm vi platform rather than carrying two other products' names in the sidebar of every page. The same wording pass covers the MCP pages, `docs/mcp-and-tools.md` and a design-rationale comment in `document-intake.ts`.

  Where "Codex" and "Claude" mean model families they are now labelled as such, with their provider ids, so a reader cannot mistake a model choice for a different tool. `--model-scope` and `--preset` say "model families" in their help text for the same reason.

  The wording gate in `npm run verify` only read `README.md`, `docs/`, the prompts and the project template, which is why the site and the runtime strings were never checked. It now also reads `docs-site/content`, the site builder — navigation labels live there, not in a fragment — and the `mcp` and `extensions` directories that print to an operator.

## v1.1.9 - 2026-07-28

### Fixed

- The update notice reaches the install path people actually use. v1.1.8 decided a platform tree was a maintainer's working copy when it found a `.git` directory in it — but `pi install git:...` clones the repository, so an ordinary install carries a `.git` and every other file a working copy carries. There is no mark inside the tree that separates them, which meant the notice never appeared for anyone who installed the documented way.

  What separates them is where they sit: Pi puts packages it installed under its own agent directory, and npm puts the global helper under `node_modules`. A tree anywhere else is a working copy and is still told nothing. `PI_CODING_AGENT_DIR` is honoured, and both paths are resolved before comparison, because a home reached through a symlink is ordinary — macOS reaches `/var` that way — and comparing a real path against a symlinked one made an install look like it was somewhere else.

## v1.1.8 - 2026-07-28

### Added

- Pi says when a release is out, and names the command that takes it. The notice appears in the session-start line as `Piagent update available: 1.1.7 -> 1.1.8. Run \`piagent-update\` to move this machine to it.` Nobody has to remember to go and check, which until now was the only way to find out.

  It costs the session nothing. The session reads a cache and, when that cache is older than a day, leaves a detached `npm view` behind to refresh it — so the first session after a release may still be quiet and the next one carries the notice. This is the only network traffic the guard originates, it sends nothing about the project, and the registry's answer reaches the terminal only if it is exactly `MAJOR.MINOR.PATCH`, so neither a hostile registry nor an edited cache can put chosen text in front of an operator. A checkout is never told to update. `PIAGENT_NO_UPDATE_CHECK=1` switches it off.

## v1.1.7 - 2026-07-28

A platform update is one global install. It was not behaving like one: every project that selected capability packs stopped working after a release until its profile was reapplied by hand, and the policy a release corrected never reached a project that had already onboarded.

### Changed

- A capability lock that is behind the installed platform is re-pinned instead of refusing the session. The lock pinned two different things and gave them one answer. What the project consented to — which packs, from where, and how far they may reach — still blocks: a grant that widens, a protection that disappears, a pack that changes identity. Which build produced the resolution — package version, runtime file digests, artifact content — moves on every release, and blocking on it put a per-project chore behind a global update while not defending against the case it resembles, since the code that verifies the lock is itself one of the files the lock pins. A build move with an unchanged grant is recorded and reported.

- Artifact content is part of the build, not part of consent. Adapter policy files, base policy, prompts, skills, subagents and recipes all ship as pack artifacts, so pinning their bytes meant a corrected policy could never reach a project referencing it. Nothing is given up: which artifacts a pack provides is declared in its manifest and the manifest digest is still pinned, so an artifact that appears, disappears or moves still blocks — and a policy artifact that weakens still blocks, because the permissions it resolves to are compared directionally.

- A project profile can name the adapter it takes its policy from instead of copying it. `{"extends": "web-frontend", "projectId": ..., "displayName": ...}` keeps the project's identity and overrides in the project, and resolves the rest from the installed platform at runtime. Any key the project states replaces the adapter's key whole; a profile without `extends` keeps working exactly as before, self-contained. `init-project.sh` and `/onboard-project` write this form when the profile comes from a built-in adapter, so onboarding stays the one per-project step and updating stays global.

  A profile naming an adapter that is not installed refuses rather than falling back to something weaker.

## v1.1.6 - 2026-07-27

Monorepo fixes found auditing how the platform scopes itself to a project. Every case was reproduced against a real directory tree before it was changed.

### Fixed

- `be-readonly-fe` keeps the backend read-only in a monorepo. Its `readOnlyPaths` and `shellProtectedPaths` were anchored at the repository root, so `backend/**` and `apps/api/**` covered a backend sitting at the top of the tree and nothing else. Choosing the profile on a repository whose backend lives in `packages/api`, `apps/backend` or `services/payments` produced a profile that announced the backend was read-only while leaving every file in it writable — the one guarantee the profile exists to make. The backend directories under `apps/`, `packages/` and all of `services/*` are covered now.

  They are enumerated rather than matched with `**/api/**`, which would have swept in `packages/web/src/api/` — the frontend's own HTTP client — and frozen the half of the repository the profile is meant to leave writable.

- The frontend verify command finds a frontend that is not at `frontend/` or `apps/web/`. It fell through to the repository root, where a workspace root has no `type-check` script, so verification reported success having run nothing. `apps/frontend`, `packages/web`, `packages/frontend` and `client` are looked at too.

- `apps/backend` is read as a backend. `apps/frontend` counted as a frontend marker while only `apps/api` and `apps/server` counted as backend ones, so a repository that named both halves symmetrically was detected as frontend-only and offered `web-frontend`. `client/` and `server/` at the root were not markers either.

- Frontend and backend are detected inside declared workspaces. Nothing read the `workspaces` field or `pnpm-workspace.yaml`, and nothing looked under `packages/`, so a pnpm monorepo fell through every marker to `generic`. Each declared package is now read through its own manifest and layout, which is what identifies `packages/storefront` and `packages/gateway` as the two halves of a fullstack repository. Only a trailing wildcard is expanded, absolute and `..` patterns are refused, and at most 64 packages are read.

### Changed

- Profile detection lives in `packages/piagent-core/extensions/project-shape.js`. `piagent_profile_options` and `scripts/init-project.sh` each carried their own copy of the rules and had drifted; the `apps/backend` gap above was present in both, and a fix to either would have left the other wrong. The file is covered by the capability lock, because steering which profile a project is offered is a way to choose what the guard ends up enforcing.

## v1.1.5 - 2026-07-27

### Added

- `piagent-update` moves a machine from one release to the next in one command. A release is three independently versioned things — the Pi host, the npm-global terminal helper, and the Pi package — and they have to move in that order, because `piagent-install` refuses to run against a host that does not match the version its own package.json pins and does not install one itself. Doing it by hand is three commands and one ordering rule that fails late when it is got wrong.

  Every version the run needs is resolved from the registry before anything is installed, including the host version taken from the *target* helper's published metadata rather than the running one, so `--check` and `--dry-run` describe exactly what a real run would do. After the helper replaces itself the run confirms that the version on disk is the one it asked for, and stops before touching the Pi package if it is not. Running it from a git checkout is refused rather than replacing that checkout's commands with a published build.

  `--check`, `--dry-run`, `--version X.Y.Z`, `--force`, `--project <path>`, `--no-host`, `--no-package`, and pass-through to `piagent-install` after `--`.

### Fixed

- `docs/release-install-policy.md`, `docs/team-onboarding.md` and `docs/command-reference-vietnamese.md` described the manual update sequence without saying why its order is mandatory. `piagent-install` fails on a host mismatch; the auto-install of a matching host lives in `setup.sh` and does not apply to that flow.

## v1.1.4 - 2026-07-27

### Fixed

- A credential passed as a command-line option is recognised as one. `--token=abc123`, `--token abc123`, `--password`, `--api-key`, `--client-secret` and the rest went unrecognised because the assignment patterns require a key that starts with a letter, and `-` is not one. v1.1.3 made the redactor's verdict the gate that decides whether a command may serve as verify evidence, so anything it missed was stored in the clear *and* accepted as proof — the same invariant v1.1.3 was written to enforce, defeated by the syntax most command-line tools actually use. Env-style assignments were the only shape covered.
- An `Authorization` header is redacted wherever it sits among the arguments. The value ran to the end of the line, so the same credential survived or not depending on how much text happened to follow it: `curl URL -H "Authorization: Token abc123"` left the header value one character under the length bar, while moving the header ahead of the URL swept the URL into the value and pushed it over. The value is now the single whitespace-free token that follows the scheme, and under a known authentication scheme its length is not consulted at all. Prose such as `Authorization: not required for local runs` is still left alone.

## v1.1.3 - 2026-07-27

Fixes for defects found reviewing v1.1.2 after it shipped, including two introduced by v1.1.2 itself. Every fix was reproduced first.

### Fixed

- Verify evidence identifies the command exactly again. v1.1.2 moved the digest onto the redacted text to stop it confirming guesses at a secret, and in doing so gave every secret the same identity: an observation of `DATABASE_PASSWORD=CorrectHorse42 npm test` satisfied a claim about `DATABASE_PASSWORD=DifferentHorse99 npm test`, so a run against one database could be recorded as proof for another. That contradicts the exact-match rule the gate is built on. Neither text is safe to hash, so a command with anything to redact now gets no digest at all and cannot be evidence; the gate says so instead of matching loosely. Commands with no secret in them — every legitimate verify command — are identified by their own text as before.
- A document replaced by a named pipe is refused instead of hanging. The identity check that would have rejected it runs after the file is opened, and opening a pipe waits for a writer, so the substitution did not have to defeat the check — it only had to stop it from running. The read blocked indefinitely. The file is now opened without blocking and without following a symbolic link at the final component.
- Short credentials are redacted. Values under a key that names a secret outright were kept in the clear below eight or twelve characters, so `TOKEN=hunter2` was stored verbatim in the evidence ledger. Length is only ambiguous after a bare `:`, where English uses the same shape — `password: short` is prose, and `Authorization: Token abc` puts a scheme name where a value would go. Under `=`, inside quotes, in a query string, or as a field in a structure, any value that is not a placeholder is now redacted at any length.
- A redirect must land on the page being verified. `npm run site:check` compared the hostname, scheme, port and credentials of the redirect target but not its path, so `/missing` or `/?release=old` passed while the run only ever fetched `/`.
- `piagent-install` reports a missing Node runtime as a missing Node runtime. Validating the MCP preset early, added in v1.1.2, put a Node script ahead of the Node version check, so on a machine without Node the installer failed with `node: command not found` and blamed the preset.

### Changed

- `docs/release-install-policy.md` named the wrong release for the code-scanning gap. A pull request last merged with a failing CodeQL check and an open high alert on `v1.1.0`; on `v1.1.2` the results gate blocked the pull request until the alerts were cleared.

## v1.1.2 - 2026-07-26

Security and release-gating fixes found reviewing v1.1.1 after it shipped. Every fix in this release was reproduced as a working exploit or failure first.

### Fixed

- `piagent_document_read` no longer re-opens the file by name after checking it. Containment in a granted root, the extension, the size limit, and the guard's protected-path check were all decided from one `realpath` and `stat`, and then `readFileSync` resolved the name a second time. Replacing the checked file with a symbolic link in between returned the contents of a file outside every granted root — reproduced end to end. The file is now opened once and read from the descriptor, and the descriptor's device and inode must equal the file that passed the checks or nothing is read. `pdftotext` is handed the same descriptor on standard input instead of a path, so the converter cannot be pointed elsewhere either.
- The evidence ledger no longer stores a digest of the unredacted command. It wrote a redacted command such as `export TOKEN= [REDACTED_SECRET] && npm test` beside a SHA-256 of the real line, so the redaction published the template and the hash confirmed guesses against it: the only unknown left was the secret, and SHA-256 is fast enough to walk a candidate list offline. A three-candidate list recovered the test secret. The digest now covers the redacted text, which is exactly what the file already shows, and command matching is unaffected because both sides redact before hashing. The CodeQL alert covering this line was dismissed as a false positive in v1.1.1; that dismissal was wrong and has been reversed.
- `npm run site:check` no longer waits indefinitely on a peer that answers slowly. The request timeout measures socket inactivity, not elapsed time, so a server sending one byte per second reset it forever — a probe was still pending after 40 seconds and would have held the release gate open indefinitely. There is now a wall-clock deadline for the whole request.
- A redirect that keeps the hostname is no longer accepted whatever else it changes. Only the hostname was compared, so a redirect to plaintext HTTP, to another port, or to a URL carrying credentials passed as if it were the site being verified.
- A document path containing a control character is refused. Refusal messages and the read header quote the path back outside the data region, so a file named with an embedded newline wrote its own lines there, at instruction level. Paths in the header are additionally escaped when printed.
- `.docx` text is decoded strictly. The strict decoding added in v1.1.1 covered plain text only, so a `.docx` whose `word/document.xml` was not valid UTF-8 still returned `ok` with replacement characters in the extracted prose.

### Changed

- Publishing now waits for the full release matrix. `publish.yml` and `verify.yml` were independent workflows triggered by the same tag and raced: v1.1.1 finished publishing at 08:03:43Z while the Ubuntu verify job ran to 08:03:48Z and macOS to 08:03:54Z. A macOS-only failure, a runtime audit finding, or a release-identity mismatch would have been reported after the version was already on the registry, where it cannot be withdrawn. `verify.yml` is now a reusable workflow that `publish.yml` calls and depends on.
- An unknown `--mcp-preset` is rejected before anything is installed. The preset was read only at the final configuration step, so a typo failed after the platform package and the MCP adapter had already been installed, leaving a half-configured machine — and the dry run exited `0` because it never reached the check.
- `piagent-setup --no-mcp --mcp-preset <name>` fails instead of succeeding with the preset dropped. `piagent-install` already rejected that pair, but setup never forwarded both flags, so the check could not see it.

## v1.1.1 - 2026-07-26

Fixes for defects found reviewing v1.1.0 after it shipped.

### Fixed

- `piagent-setup --no-mcp` installs no MCP again. Setup only ever appended `--with-mcp` and relied on the installer defaulting MCP off; v1.1.0 changed that default to on, so the opt-out reached the installer as silence and the installer's default overrode the operator's explicit choice. It now passes `--no-mcp` through. The other install flags stay one-sided because the installer still defaults them off, which is the condition that made the pattern safe in the first place.
- `npm run site:check` no longer hangs when a response exceeds the 4 MB body cap. Hitting the cap destroys the response, and a destroyed response emits neither `end` nor `error` — it goes to `aborted` and `close` — so the promise stayed pending forever, and the request timeout could not rescue it because the socket was already gone. A release gate that hangs is worse than one that fails, because nothing reports it. A body cut short is also now reported as cut short rather than as a page that does not mention the version, which is a different claim.
- `npm run site:check` no longer exits `0` when it could not check an address. Unreachable addresses were printed as `UNVERIFIED` and then the run still ended in `PASS`, so a gate that verified fewer addresses than it resolved reported that it had verified them all. An unchecked address now ends the run; `--allow-unverified` accepts the gap deliberately and names it in the summary.
- `piagent_document_read` refuses bytes that are not valid UTF-8 or UTF-16 instead of decoding them into replacement characters. The binary check was a scan for a NUL byte, which plenty of binary formats do not carry in their first bytes, and everything past it was decoded leniently — so a binary file renamed to `.txt` came back as content-shaped garbage and was handed to the model. Decoding is now strict in both encodings, which is what the surrounding code already claimed to do.
- Two CodeQL high alerts came from building a regular expression out of a version string and escaping only `.`. Those assertions were comparing literal text, so they are substring checks now and need no escaping at all. Two further alerts were reviewed and dismissed with written reasons: extracting `&lt;script&gt;` from a document as `<script>` is the required result and the sink is a terminal tool result, not HTML; and the SHA-256 over a normalised shell command is a content identifier, not a password hash.

### Changed

- The release checklist now requires the **Code scanning results** check on the `main` ruleset, separately from the `analyze (...)` jobs. Requiring those jobs proves only that the analysis ran and uploaded its results — they succeed just as well when the analysis found new high-severity alerts, which is how v1.1.0 merged green with open ones.

## v1.1.0 - 2026-07-26

A document downloaded outside the repository can now be read by the agent, and the two documented install commands stop disagreeing about MCP.

### Added

- Added `piagent_document_read`, which reads a document from a directory outside the project. Downloading a spec to `~/Downloads` and then having no way to hand it to the agent was a dead end with no workaround short of copying the file into the repository. A directory is granted through `additionalReadRoots` in the project profile or the `PIAGENT_ADDITIONAL_READ_ROOTS` environment variable, and the grant widens only where documents may come from. It is read-only. It accepts `.md`, `.markdown`, `.txt`, `.text`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.pdf`, and `.docx`, and refuses every other extension sitting in the same directory. `protectedPaths` still wins over it, matched against both the absolute and the project-relative form of the path so that root-anchored patterns are not silently skipped, and a capability pack that narrows filesystem read scope still narrows it for documents inside the project. Both the containment check and the extension check are made against the canonical path, so a link named `notes.md` cannot hand over the key file it points at.
- `.docx` is read without a dependency, from a bounds-checked archive reader that names what was wrong with a malformed file rather than reporting every failure as a missing document. Text struck out by an unaccepted tracked change is dropped instead of being spliced onto its replacement, tab-stop declarations no longer emit tab characters, field instruction codes are not read as prose, and a character reference outside the Unicode range is left as written rather than ending the read. `.pdf` goes through `pdftotext`, under a timeout, and a missing binary is reported as missing rather than as an empty document. Byte-order-marked UTF-16 is decoded rather than rejected as binary. Returned text is redacted and enclosed in a data region delimited by a marker the document cannot predict, because a downloaded document is exactly the kind of file that carries both a pasted key and a sentence addressed to an agent.
- Added `npm run site:check`, which verifies the published documentation site at every address it resolves to instead of once through whichever address a browser happened to pick. It requires each address to return the released version, reports a redirect from an address back to its own host as a loop rather than following it, and reports an address the machine cannot route to as unverified rather than as a pass. Release checklist step 8 was a manual look, and a manual look cannot see a partial outage.

### Changed

- Raised the pinned Pi Coding Agent and Pi AI host from `0.81.1` to `0.82.0`. `typebox` stays exactly `1.1.38` across both, so the pin moves without a compatibility change. `npm run audit:runtime` on the `0.82.0` tree reports one high advisory, the same already-accepted `GHSA-mh99-v99m-4gvg` under review by 2026-08-25, and no critical. Verified against a real `0.82.0` host: runtime policy smoke and `team-doctor --strict-share` both pass with no warnings.
- `piagent-install` now installs the MCP baseline by default, the same as `piagent-setup` already did, and both accept `--no-mcp` to skip it. The two documented entry points disagreed: `piagent-setup` defaulted to installing MCP and `piagent-install` defaulted to not installing it, so a newcomer who followed the team onboarding document ended up with no MCP at all — and was then told to run `/mcp`, because the installer printed that next step whether or not it had installed anything. That next step is now printed only when MCP was installed, and `--mcp-preset` combined with `--no-mcp` fails instead of being accepted and quietly dropped.
- Cut the command count in the three places a new user actually lands. The README went from 28 shell blocks to 4 and now opens with install rather than four variants of a wrapper for software the reader has not installed yet; the Vietnamese quickstart went from 23 to 7 and its install step from 120 lines to 28; the documentation site's onboarding flow went from eight install command cards to one. Pinned rollouts, updates, rollback, the `--dev` channel, and per-tool command lists were not deleted — every one of them already had a dedicated document, and each is now linked from where it used to be inlined.

### Fixed

- Writing MCP server definitions now says what each server still needs before it can connect: Chrome for the Chrome DevTools server, Docker plus `GITHUB_PERSONAL_ACCESS_TOKEN` for the GitHub server. Servers connect lazily, so a successful install proved nothing about whether they would work, and the Docker requirement existed only in a description string visible under `piagent-mcp --list`. The note goes to stderr so the report on stdout stays machine-readable, and `--list` now carries the same requirements as data.
- An advisory tool-registry verdict is now shown. `toolRegistry` defaults to `advisory` and the evaluation returned a `warn` decision, but the hook acted only on `block`, so the verdict was computed and discarded — advisory mode was indistinguishable from off, and the documentation said the agent received a warning. The notice is emitted once per tool per session, because one on every call would be noise rather than a warning.
- `piagent-uninstall --with-addons` now reports the MCP baseline file that install actually writes. It named the Pi-global override path while install writes the shared global path, so an operator following the printed advice inspected the wrong file — usually an empty one, which reads as "already clean".
- Project onboarding now says that the `.mcp.json` files it writes are empty on purpose and that the shared baseline lives in the global config. An empty file in a fresh project reads as a failed install.
- Documented that `mcpCapabilities` in a project profile, the `github` key in the policy tool registry, and the `github` MCP server are three unrelated things that share a name. No code maps a capability name to an MCP server, so declaring `github` in a profile does not enable the GitHub server and never did.
- `piagent-init` running from an installed package now writes `npm:@piagent/platform@<version>` into project settings, matching what `piagent-setup` already did. It is the second way a project gets its settings written, and it still wrote the directory the platform happened to be installed in — a value that means nothing on a teammate's machine, in a file meant to be committed.
- Documentation-coverage checks in the local gate now name the term that went missing and the files searched. They were bare `grep >/dev/null` calls under `set -e`, so dropping a term from a document failed the gate with exit 1 and no output at all. The gate's `npm test` and `npm run typecheck` steps had the same defect from the other direction — their output went to `/dev/null` on every run, so a failing test ended the gate with no indication of which test failed. Both now stay quiet on success and print what they captured on failure.
- Documented that `piagent-setup` installs the Herdr Pi integration when `herdr` is on `PATH`, and that installing Herdr afterwards needs `piagent-setup --global-only` to pick it up. The behaviour has always been the default and the skip is only a warning on stderr, so the ordering was discoverable only by reading the installer. Herdr is also now named as the way to run several Pi panes at once in the README, the quickstart, and the documentation site, none of which mentioned it, and every one of those places now carries the install command itself rather than a link to go find it. The `brew` form is listed beside the `curl` form that herdr.dev leads with, because piping a fetched script to a shell is worth an alternative in a project that pins everything else it installs.
- Folded a stale `Unreleased` section into v1.0.0, where its contents actually shipped. It had been left behind by the namespace rename and still described tools as `company_orchestration_policy`, `company_profile_tech_options`, `company_profile_tech_apply`, `company_profile_tech_context_record`, and `/company-orchestration`, none of which exist.

## v1.0.2 - 2026-07-25

Install and uninstall become two commands each. The five-command sequence was never the shortest path; it was the only one that produced a project configuration a teammate could use.

### Added

- Added `piagent-uninstall`, which removes the Pi package this platform registered and nothing else. It reports by default and only acts on `--apply`, matching how install and migration already work. `--with-addons` also removes the pinned add-ons, `--with-host` the Pi host, and `--project <path>` a project's profile, lock, and runtime state. It recognises every source shape the platform has been installed as, including installs from before the namespace rename, so an old registration still comes out. Credentials, trust decisions, sessions, todos, and project memory are never removed at any flag combination; files written from templates and then edited are reported rather than deleted, and only the entry pointing at this platform is dropped from a project's `.pi/settings.json`.

### Fixed

- `piagent-setup` running from an installed package now writes `npm:@piagent/platform@<version>` into project settings instead of the directory it happens to be installed in. Project settings are meant to be committed, and an install path means nothing on a teammate's machine. A working checkout has no published identity to point at, so it still falls back to the local path and still says so.

### Changed

- Documentation now leads with `npm install -g @piagent/platform` followed by `piagent-setup`, which installs the pinned Pi host itself. The five-command sequence remains, described as the explicit path for a reviewed team rollout rather than as the only way in.

## v1.0.1 - 2026-07-25

Documentation release. v1.0.0 reached the npm registry but no document told anyone it was there, so every install instruction still pointed at the Git source.

### Changed

- The terminal helper now installs from the registry: `npm install -g --ignore-scripts @piagent/platform@1.0.1`. This replaces the `github:Vt-mmm/piagent#vX.Y.Z` form in the README, the docs site, and every install, update, and rollback flow. Installing from Git still works and produces the same files; the registry path additionally carries a provenance attestation npm can verify.
- Added an `npm` release channel with a real source, and narrowed `enterprise-npm` to what it actually describes: a fork published under a different scope.
- Recorded why `stable` still resolves the Pi package to a commit SHA rather than an npm version. Tag-to-SHA resolution is checked against `PIAGENT_EXPECTED_RELEASE_COMMIT`, and a registry version range cannot express that check, so pointing `stable` at npm would remove it rather than replace it.
- Aligned `repository.url` in both manifests with the form npm stores. Publishing rewrote the field and warned, which left the manifest in the repository disagreeing with the manifest on the registry.

## v1.0.0 - 2026-07-25

Breaking release. The `company` namespace is replaced by `piagent` with no alias layer, and `apiVersion` becomes a stable contract. Existing projects convert their local state with one migration command; both names never work at once.

### Added

- Added `capabilitySources` to project profiles so a project can use capability packs it does not own without forking the platform. A source is either a directory inside the project or an exact npm or git release vendored into it.
- Added `piagent-capabilities vendor`, the only command that reaches the network. It fetches a declared remote source into `.pi/capability-vendor/`, refuses a tree containing symbolic links or no packs, and reports digests for review before the result is committed.
- Added `piagent-migrate` to convert `.pi/company-profile.json`, its lock, and `.pi/company-state/` to the new names. Dry-run by default, with an explicit flag to write and a separate flag to remove the old files.
- Added `piagent-import-instructions` to import `CLAUDE.md`, `.claude/rules/`, `.cursor/rules/`, and `.github/copilot-instructions.md` into `AGENTS.md`. Dry-run by default, with a deterministic conflict report; imported text is quoted as data and never alters protected paths, permission profile, or verify commands.
- Added skill wiring for `.claude/skills` and `.codex/skills` at project scope and their home-directory equivalents at global scope, plus doctor checks that report skill directories present on disk but not declared, and instruction files written for other agents.
- Added a golden enforcement suite covering protected paths, protected paths reached through the shell, destructive shell decisions, verification evidence, context budget ceilings, and secret redaction, with a valid and an invalid fixture for every shipped schema.
- Added contributor documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, pull-request and issue templates.
- Added a tag-driven publish workflow with npm provenance and pinned action revisions.
- Added a solo-first orchestration policy covering bounded subagent usage, review lenses, Field Guide status, and model-role guidance, surfaced by `piagent_orchestration_policy` and `/piagent-orchestration` so status reads without a model follow-up. Task contracts gained `workPlan`, `reviewLenses`, and `orchestration` snapshots to record it.
- Added select-style profile tech setup through `/profile setup` and `/profile tech setup`, including fullstack frontend, backend, and database selections. `piagent_profile_tech_options`, `piagent_profile_tech_apply`, and `piagent_profile_tech_context_record` produce Context7-ready stack manifests and per-tech snapshots.

### Changed

- **Breaking.** Renamed the namespace to `piagent` throughout: tools `company_*` to `piagent_*`, commands `pi-company-*` to `piagent-*`, package `pi-agent-platform` to `@piagent/platform`, `packages/pi-company-core/` to `packages/piagent-core/`, environment variables `PI_COMPANY_*` to `PIAGENT_*`, and project state to `.pi/piagent-profile.json`, `.pi/piagent-profile.lock.json`, and `.pi/piagent-state/`. There is no alias layer; a session started against unconverted state warns and names the migration command.
- **Breaking.** Promoted the manifest `apiVersion` from `piagent/v1alpha1` to `piagent/v1`. This is the point at which external packs can pin it, so it is a contract from here on.
- The capability lock now records where each pack came from, so a pack that moves between sources reads as a substitution rather than an update.
- The package is now published rather than private, scoped as `@piagent/platform` with public access and provenance.
- Split shell and external-action classification, shared types, and filesystem helpers out of the guard into their own modules. Behaviour is unchanged.
- Onboarding now names instruction files written for other agents, states plainly that their rules are not in effect, and offers the import; anything inside them is treated as data.
- `/task`, `/plan`, `/review`, the subagent prompts, and the team docs now prefer one parent agent plus bounded scout, planner, and reviewer usage instead of broad swarm-style delegation.
- Onboarding and docs treat profile family and project tech stack as explicit operator selections rather than long model explanations, and `/profile` status and list output stay compact around the single namespace and the next exact command.
- Runtime support is stated across macOS Apple Silicon, macOS Intel, Linux x64 and ARM64, native Windows, and WSL2, and the installer and doctor report the runtime surface they are actually on.

### Fixed

- Fixed a capability policy that declares only some of its allow-lists: the missing lists now deny, instead of failing with an internal error.
- Fixed capability source resolution under a symlinked project parent, where a contained directory could be misread as escaping the project.
- Excluded maintainer working notes from the published tarball. The `files` allowlist takes precedence over `.npmignore`, so the exclusions live in `files`.
- Fixed the package manifest declaring its extension entry points as a directory glob. Pi calls the default export of every path the field matches, so once the guard's helpers moved into modules beside it, the glob offered Pi two modules that export helpers and no extension factory. The manifest now names the guard, and the package still carried the old `@pi-agent/core` name the namespace rename was meant to retire.
- Fixed the verify workflow, which had been unparseable since the runtime-platform step was added and so had not run at all. A single-line `run:` value containing `": "` ends the YAML scalar early; GitHub reports that as an instant failure with no job, so the gate was absent while still appearing present. The local gate now refuses that shape.
- Fixed orchestration config normalization so a malformed numeric setting falls back to a safe value instead of producing invalid policy state.
- Fixed tag CI verification, which checked tag object type and peeled commit identity without first fetching the annotated release tag ref.
- Profile doctor and team doctor now warn on entries that appear only in `shellProtectedPaths`. Those paths block shell access alone; write protection requires `protectedPaths` or `readOnlyPaths`, and the warning names the move.

### Security

- The runtime host audit now names the one advisory it accepts instead of running at a blanket severity threshold. `GHSA-mh99-v99m-4gvg` (`brace-expansion`, denial of service) is accepted with its reasoning recorded in `scripts/check-runtime-advisories.mjs`: the Pi host publishes an `npm-shrinkwrap.json` that pins the affected version, a published shrinkwrap takes precedence over consumer overrides, and every released host carries a high `brace-expansion` advisory, so no host version and no change in this repository can resolve it. Every other high or critical advisory still fails the audit, the entry expires on a review date, and it fails once the advisory stops being reported so it cannot outlive the problem.

## v0.4.8 - 2026-07-22

### Added

- Added release/install policy docs covering stable, exact, dev, local, update, and rollback flows.
- Added `pi-company-install` channel options and dry-run preview for stable, exact, dev, and local installs.
- Added a package-root dispatcher for global `pi-company-*` terminal commands.
- Added `readOnlyPaths` to project profiles for read-only contract areas such as backend code in `be-readonly-fe`.
- Added regression tests for untrusted project profiles, profile-apply confirmation, shell/exec aliases, external-provider write confirmation, BE-readonly/FE-write paths, package distribution, and installer edge cases.
- Added tag-triggered CI verification with immutable GitHub Action revisions on both Ubuntu and macOS.
- Added release identity verification across root/core manifests, package lock, capability lock, changelog, docs badge, tag, and checked-out commit.
- Added a separate high-severity dependency audit for the exact Pi host and pinned optional add-ons instead of relying only on the helper package lock.
- Added a public threat model and `SECURITY.md` with private vulnerability reporting, supported-version, disclosure, and scope guidance.
- Added weekly Dependabot checks for npm and GitHub Actions plus pinned CodeQL v4 analysis for JavaScript/TypeScript and workflow code.
- Added a fail-closed Vercel project-link preflight so a stale local `.vercel` link cannot silently deploy docs to the wrong project.

### Changed

- Clarified in the public docs where this platform sits relative to a general agent coding CLI: Pi Company Platform brings similar governance concepts into Pi and packages them for team workflows.
- Reworded security docs to describe the guard as an application-level policy enforcement layer, not a complete security boundary or OS sandbox.
- Split install guidance so production/team setup uses pinned `v0.4.8` or resolved commit sources, while latest is reserved for personal/sandbox use.
- Clarified that redaction benchmarks and internal review are not equivalent to an external security audit.
- Raised the supported Node.js runtime contract to `>=22.19.0`.
- Raised the pinned Pi Coding Agent and Pi AI compatibility from `0.80.10` to `0.81.1`, retaining exact `typebox` compatibility and removing the known high-severity transitive finding present in the previous host tree.
- Updated CI to verify on Ubuntu and macOS with Node.js 22.19.0.
- Documented the three-component Pi-host/helper/Pi-package lifecycle, exact rollback flow, supported operating systems, and post-tag Vercel promotion gate.
- Made setup install or upgrade to the exact Pi host required by the release and made package installation reject an incompatible host version.
- Expanded runtime dependency verification from the Pi host alone to the exact host plus all pinned optional add-ons.

### Fixed

- Hardened local profile loading so `.pi/company-profile.json` is ignored until the project is trusted, unless an operator explicitly sets `PI_COMPANY_PROFILE`.
- Hardened `pi-company-install --stable` so it resolves the release tag to a commit SHA before install and fails closed when resolution is unavailable.
- Bound the deterministic capability lock to `packages/pi-company-core/policies/base-policy.json`.
- Fixed `be-readonly-fe` so backend paths are readable through safe path tools but remain blocked for writes and shell access.
- Applied shell protected-path checks consistently to `bash`, `shell`, and `exec` tool aliases.
- Inspected complete structured shell invocations, including `command`/`cmd` plus `args`, and rejected conflicting, malformed, oversized, or unbounded carriers before execution.
- Added a generic human confirmation gate for external-provider write or ambiguous tools while preserving known safe reads such as `get_release`.
- Rejected conflicting installer package selectors before any install command can run; the first explicit CLI selector now cleanly overrides environment defaults.
- Routed global commands through a package-root dispatcher and converted missing shell-runner failures into controlled errors.
- Isolated runtime-evidence test ledgers so test runs no longer leave new `pi-ledger-*` temporary directories.
- Decoded the extension module URL before locating its package policy so installs under paths containing spaces or other URL-encoded characters load the intended policy.
- Made project init resilient to npm package tarballs that omit its `.pi/.gitignore` dotfile by shipping an explicit fallback template.
- Prevented project init from creating `.pi/.npmignore`, which could override repository ignore rules and re-include local Pi auth, trust, ledger, or database state in an npm package.
- Applied provider confirmation and path policy to the default serialized MCP proxy carrier, including bounded JSON parsing and fail-closed malformed/deep payload handling.
- Closed MCP path-policy bypasses across common aliases such as `filename`, `rootPath`, `source`, `cwd`, and `workingDirectory`; copy sources now use read scope while destinations use write/read-only scope, without treating provider metadata as a local path.
- Applied protected-path checks to camelCase patch carriers and shell proxy variants such as `run`, `execute_process`, and command-bearing aliases before an operator confirmation can allow execution.
- Added confirmation gates for shell-launched GitHub CLI writes and non-read-only HTTP client operations, including wrappers, executable aliases, line continuations, dynamic command construction, `xargs`, and FTP/SFTP quote commands, while keeping recognized reads and argument-only substitutions non-interactive.
- Made every packaged `pi-company-* --help` command succeed without requiring a project path or creating project state.

### Security

- Project-local profiles are not trusted before Pi project trust is active.
- Capability locks now detect base policy tampering, not only runtime source-file changes.
- Tool-based profile apply requires operator confirmation before writing `.pi/company-profile.json` and `.pi/company-profile.lock.json`.
- External provider writes are treated as human-gated actions even under `trusted-full-access`.
- Unknown MCP/provider actions fail closed to operator confirmation; explicit safe reads remain non-interactive.
- Release tags are verified in CI, installer stable channels resolve tags to commit SHAs, and dependency setup actions are pinned by commit SHA.
- Tag CI binds stable resolution to the exact release commit and rejects environment attempts to substitute the helper's package-derived release tag.
- Tag CI now requires an annotated tag whose peeled commit is the exact verified release commit; repository ruleset requirements are documented for immutable `v*` tags.
- Release CI includes redaction, release identity, dependency, CodeQL, package-content, and cross-platform policy gates; Actions are pinned to reviewed commit SHAs.

### Verification

- `npm run verify`: pass.
- `npm test`: 224/224 pass.
- `npm run typecheck`: pass.
- `npm run smoke`: pass.
- Helper dependency audit (`npm audit --audit-level=high`): 0 vulnerabilities.
- Exact Pi 0.81.1 host + pinned add-on audit (`npm run audit:runtime`): 0 high/critical findings; npm reports 11 moderate dependency paths across two upstream advisory families (`@hono/node-server` encoded-backslash traversal on Windows and `protobufjs` parser DoS).
- `npm run benchmark:redaction`: pass.
- `npm pack --dry-run --json`: 144 packaged files; required runtime files present and local trust/secret state excluded; all 12 installed terminal binaries pass `--help` from the built artifact.
- Docs browser/runtime check: 0 duplicate IDs, broken anchors, broken images, unsafe blank targets, or console errors; mobile viewport has no horizontal overflow.

## v0.4.7 - 2026-07-22

### Added

- Added `/commit` as a guarded local commit workflow:
  - inspect status and diff before staging;
  - stage explicit reviewed files only;
  - run relevant verification before commit;
  - never push from `/commit`.
- Added `/pr` as a guarded pull request preparation workflow:
  - inspect branch, status, upstream, and remote;
  - require a clean committed branch before PR work;
  - require explicit operator confirmation before `git push` or GitHub write actions.
- Added an exec-policy confirmation rule for broad Git staging, including `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/`, and `git -C <repo> add .`.
- Added regression tests for the new Git workflow prompts and broad-staging policy.
- Added canonical public docs metadata for `https://piagent.io.vn`.

### Changed

- Install docs now default to latest:
  - `pi install git:github.com/Vt-mmm/pi_agent`
  - `pi update --extensions`
- Pinned install examples use placeholders such as `vX.Y.Z` and `x.y.z` instead of hardcoding an old release.
- Runtime smoke verification now reads the current package version from `package.json` instead of hardcoding a tag.
- Docs site, README, package metadata, and Vercel docs now point to `https://piagent.io.vn`.

### Security

- Git remains a normal guarded capability, not a privileged `/git` bypass.
- Broad staging requires confirmation so unrelated or private files are not committed silently.
- Protected paths, sensitive-output redaction, capability lock integrity, and destructive/external confirmation gates remain active in every permission profile.

### Verification

- `npm run verify`: pass.
- `bash scripts/runtime-policy-smoke.sh`: pass.
- `npm test`: 185/185 pass.
- `npm run typecheck`: pass.

## v0.4.6 - 2026-07-22

### Added

- Added the static HTML documentation site under `docs-site/`.
- Added Vercel static-site configuration and deployment documentation.
- Added project logo, favicon, GitHub link, and Facebook link to the docs site.

### Changed

- Streamlined command documentation for lower-token daily usage.
- Removed the `SHIP` sidebar section from the docs site.
- Centered the docs layout and tightened the visual structure for wide screens.
- Documented latest global install and pinned project setup separately.

### Verification

- `git diff --check`: pass.
- Package verification remains covered by `npm run verify`.

## v0.4.5 - 2026-07-22

### Added

- Added direct profile commands that apply immediately without model follow-up:
  - `/profile`
  - `/profile`
  - `/profile list`
  - `/profile <profile>`
  - `/profile auto`
- Added short profile aliases such as `fe`, `be`, `full`, `be-fe`, and TypeScript-oriented aliases.

### Changed

- `/company-status` and `/company-memory` now return concise local summaries instead of prompting verbose model/tool follow-up.
- Profile status output is intentionally compact to reduce token burn in routine checks.

### Security

- Direct profile apply still regenerates the deterministic capability lock and does not relax protected paths, secret redaction, or capability integrity checks.

## v0.4.4 - 2026-07-21

### Added

- Added session-local permission slash commands:
  - `/permission-status`
  - `/read-only`
  - `/workspace-write`
  - `/full-access`
  - `/full-access <task>`

### Changed

- Permission resolution precedence is explicit: launch environment override, then session command, then project profile, then policy default.
- `/full-access <task>` switches the session and forwards the task text as the next request.

### Security

- `trusted-full-access` remains guarded. It relaxes selected autonomy checks for trusted workspace work but does not disable protected paths, secret redaction, capability lock integrity, or destructive/external confirmations.

## v0.4.3 - 2026-07-21

### Added

- Added runtime permission profiles:
  - `read-only`;
  - `workspace-write`;
  - `trusted-full-access`.
- Added `PI_COMPANY_PERMISSION_PROFILE` for trusted one-run permission override.

### Security

- Invalid permission override values fail closed.
- The profile system is a runtime policy layer, not an operating-system sandbox.

## v0.4.2 - 2026-07-21

### Added

- Added sensitive-data redaction benchmark coverage for contextual secrets, benign preservation, structured payloads, and large output.
- Added release gates for redaction recall and false-positive control.

### Changed

- Improved sensitive-data redaction for common credential shapes and nested structured data.
- Kept unlabeled high-entropy strings observational instead of redacting indiscriminately.

### Verification

- Frozen-tree redaction baseline: 52/52 contextual cases detected, 0/30 benign false positives, 8/8 structured sensitive values redacted, and 7/7 structured benign values preserved.

## v0.4.1 - 2026-07-21

### Fixed

- Hardened shell secret protection against glob expansion targeting protected files.
- Hardened shell protection for bare-word aliases and symlinks resolving to protected paths.
- Added sensitive bash output redaction before tool results reach the model.
- Covered attached redirections such as `cat<.env` and similar shell forms.

### Security

- Static shell protection is stronger, but the guard still does not claim to be an OS sandbox.
- Protected-path blocking and output redaction are separate defense layers.

## v0.4.0 - 2026-07-21

### Added

- Added governed capability packs with deterministic catalog generation.
- Added profile capability resolution and `.pi/company-profile.lock.json`.
- Added lock integrity checks for package source, artifact digests, capability scope, and runtime enforcement files.
- Added atomic profile/lock write behavior with rollback on failure.

### Security

- Lock tampering fails closed.
- Core protected paths include `.pi/settings.json` and `.pi/company-profile.lock.json`.
- Capability scope can only narrow access; protected paths remain denied before allow-scope checks.
