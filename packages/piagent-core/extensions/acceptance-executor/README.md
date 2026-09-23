# Isolated contract worker (experimental)

This experimental worker supplies bounded behavioral observations for JavaScript modules in an explicitly approved in-memory source graph, including primitive/Date inputs, bounded array/record data and explicit multi-call histories. Worker v9 retains v8 capabilities and adds opt-in bounded error-message observation. It is reachable through host-approved verification; the worker itself cannot approve completion. External/package imports, timers, arbitrary object graphs and unsupported values must not silently count as supported behavior.

## Authority and isolation

- The host selects an authorized local Docker socket and a previously built, approved image by its full `sha256:` ID. A model-supplied image or expected-result plan is not trusted verifier configuration.
- QuickJS-WASM executes candidate code without host callbacks, process/IO bindings or expected answers. Cases get a fresh realm unless they belong to one explicit contiguous sequence. A reset destroys that realm; only explicitly referenced, actually observed inert data can cross the reset.
- The host retains expectations and compares typed observations. Candidate `JSON.stringify`, `toJSON`, exception names and stdout are not verdict authorities. Reflection/Date/error intrinsics are captured before initialization; data-property creation uses captured functions and null-prototype descriptors. Proxy tracking uses null-prototype handlers to prevent candidate-added inherited traps from exposing an untracked factory. Returned accessors and tracked proxies are not traversed.
- The container has no workspace/socket mounts, network access, root user, elevated capabilities, or writable root filesystem. The controller inspects the actual configuration before starting it. Image pulling and host-execution fallbacks are disabled.
- QuickJS uses a 32 MiB memory ceiling, 512 KiB stack ceiling, and a 300,000-microsecond per-case **executing-thread** CPU budget. Both user and system CPU on that thread count, including parsing, host marshalling and observation work. Background compiler/support threads do not consume the case allowance; they remain charged by the unchanged container-wide CPU-time rlimit (10 seconds soft / 12 seconds hard), one-CPU quota and wall watchdog. This changes the accounting domain from worker v5, not merely its numeric limit. Scheduler waiting does not consume the case budget. The absolute 5-second request wall deadline is not renewed by another case. Both limits are polled during interpretation and before admitting a completed observation; a poll can overshoot, and native operations still require the watchdog. The container retains its 256 MiB memory limit, 32-PID limit and separate 8-second OS watchdog. An outer host deadline can stop an attached run. Engine interrupts alone are not treated as sufficient isolation.
- Cleanup is limited to the newly created container with the exact run label, image ID, and container ID. Unconfirmed cleanup invalidates the observation. No Docker pruning or deletion of user containers is performed.

These are tested containment controls, not a guarantee against every engine or kernel vulnerability. Backend/image admission, verifier installation integrity, and project execution authorization must remain separate runtime gates.

## Building and verifying

This directory has its own locked dependencies and is deliberately separate from the platform's shared `node_modules`. Install them with `npm ci --ignore-scripts --workspaces=false --no-audit --no-fund`. The lock pins QuickJS core, the release-sync WASM package, and FFI types to 0.32.0, including package integrity hashes. No dependency lifecycle scripts are required.

Build this directory with `BASE_IMAGE` set to a locally available, approved repository-qualified Node digest (`node@sha256:...`, not a bare image ID `sha256:...`). The Dockerfile deliberately has no mutable default base. The build context allowlist contains only worker source, its manifest/lock, and its dedicated dependencies; it never contains a project snapshot, credentials, or expected-result plans. Build with `--network=none --pull=false`; dependency installation is a separate, explicit setup step. Check that the selected builder actually uses the cached base: RUN network isolation does not itself prohibit registry metadata resolution. The local v4 verification used the already cached base with the legacy builder explicitly selected; that deprecated builder is not a future portability guarantee.

Worker v7 retains v6's separate `guest-cpu-budget` and `guest-wall-deadline` diagnostics, including a top-level timeout reason when the request expires between cases. A case that stops on either limit includes its first stopping sample: process CPU, current-thread CPU and elapsed case time, in microseconds. The CPU stop must be justified by at least 300,000 microseconds on the executing thread. Process CPU is retained as a diagnostic of total support overhead, not discarded. The parser requires bounded samples for case resource stops, rejects them on completed/unsupported cases, and rejects older worker observations. A wall deadline between cases has no invented case sample. Neither timeout is a behavioral counterexample. CPU accounting is platform/thread-dependent, not deterministic instruction fuel or a performance promise. Worker source and dependency declarations participate in installed-verifier identity, and the exact built image remains a separate host-approved binding. No production approval or retry allowance is changed by building another image. No experimental V8 compiler flags are enabled.

If Docker's credential helper blocks a local-only build, use a separate temporary Docker client configuration containing an empty JSON object and an explicit local socket. Do not inspect, replace, or weaken the user's credential store. The initial local diagnostic used Docker's legacy builder with that isolated configuration; build portability remains to be validated before release.

Set `PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID` to the built image's full ID and `PIAGENT_CONTRACT_EXECUTOR_SOCKET` to the approved local socket to enable the real executor tests. Without both, tests requiring Docker are visibly skipped, not silently counted as passes. The retained expiry diagnostic additionally requires `PIAGENT_RETAINED_EXPIRY_SOURCE`; its expected source hash is checked before and after read-only execution.

## Remaining integration work

`acceptance-independent-contract.js` keeps expectations outside the guest and captures counterexamples on the host. Its result remains **diagnostic evidence** until separate authenticated admission validates the latest private receipt, current source/Git/project-verifier bindings and approved plan. Existing safety, repair and continuation ceilings remain in force.

## Bounded data and histories (worker v2)

- Tagged `array` values contain dense arrays of tagged values. Tagged `record` values contain unique `{key,value}` entries. This preserves undefined and special numbers and safely represents an own `__proto__` property. Record equality ignores insertion order; array equality preserves order.
- A tree is limited to depth 8, 256 nodes, 64 entries per collection, 4096 characters per string/key and 64 KiB of aggregate string/key text. Date values are allowed in inputs/argument observations, not returned data. Existing request, source, response, memory and execution-time limits remain unchanged.
- These are own enumerable data-property snapshots, not claims about hidden object brands, descriptors, arbitrary prototypes or all JavaScript reflection behavior. Exact identity is observed only by the explicit v7 capability below, not inferred from equal snapshots. Cycles, sparse arrays, accessors, symbols, returned proxies and ordinary exotic objects abstain. Proxy construction is intercepted to track those objects; primitive results produced through internal proxy operations remain supported. Intrinsic reflection is not guaranteed to match Node's runtime.
- A case may specify `sequence`, a named `exportName`, `reset: true`, and `observeArgs: true`. A sequence must be contiguous. A `result` argument names an earlier successful return in that same sequence and supplies a **copy of its observed data**, not a live object handle or an expected value. Forward/self/cross-history references are rejected before execution. Unavailable results prevent dependent calls from running.
- `observeArgs` captures every resolved argument after a return or throw. The host may require exact `expected.argsAfter` values. Inputs are mutable; observation must not freeze them. Clock observations are per call, including when module state is retained. A captured `Date.now` callable observes the current step's clock rather than its first step's value; its identity survives mocked/real-clock transitions. Only mocked reads contribute to `clockReads`.
- Counterexamples include the complete input prefix for a stateful failure. Worst-case repeated prefix bytes are bounded to 2 MiB before execution. No invocation history or expected answer is injected into the candidate's global scope.

A realm reset tests a component's checkpoint/restore contract. It is **not** an OS-crash, filesystem-durability, transaction or arbitrary application-state proof. S0 process-death tests and host receipt reconciliation remain separate.

## Approved module graphs (worker v3)

An approved host contract can add `modulePaths`, listing dependencies relative to the project root; `sourcePath` remains the entry. The list is explicit, bounded and authenticated. It is not populated by reading candidate import expressions. For example, a contract whose entry is `src/main.js` may name `src/state.js` and `shared/math.js` as dependencies. Omitting the list retains closed-module execution; an empty list permits only the named entry's identity.

The host captures authorized regular files into `moduleGraph: {entry, dependencies: [{path, source}]}` alongside entry `source`. Entry plus dependencies are limited to 32 files and **128 KiB total source**, not 128 KiB per file. The request/response, memory and time ceilings are unchanged. Each file's bytes, path and mode, graph membership, project identity and Git baseline are bound. Snapshot, execution, durable reuse and authenticated admission use the same graph source identity. A dependency-only change invalidates old evidence. Current project-verifier evidence must cover every member; an ignored dependency cannot borrow the entry's project-verifier pass.

The worker resolves only relative ESM imports to that in-memory allowlist. It supports transitive imports, re-exports, cyclic live bindings and one instance per normalized module path; reset destroys the entire realm and module state. Dynamic imports additionally require the explicit async capability below. No module request reads the host filesystem. Missing files, bare/package specifiers, Node built-ins, URLs, root escapes, encoded names, query/fragment identities and directory imports are unsupported. No extension guessing or package resolution occurs.

Without `awaitResult: true`, returned promises, asynchronous modules and pending QuickJS jobs remain unsupported. Pending-job checks run before a call, after it and after observation. Even in async mode, new jobs caused by observation are not drained after snapshots have already been captured; they abstain. Graph membership is a captured-source identity, not a claim that every branch or export was tested.

## Approved async and identity capabilities (worker v7, retained in v8)

Capabilities belong to each signed case, not an ambient worker switch. `awaitResult: true` drains at most 1,024 guest jobs and observes intrinsic Promise settlement under the unchanged CPU/wall limits. Top-level await and ordinary thenables are supported within these limits. Unresolved work abstains; job exhaustion is an executor error, not a behavioral counterexample.

`callbacks` declares up to eight named, private guest functions, with finite return/throw steps, explicit sync/Promise mode and repeat-last policy. Inputs reference them with `{type:"callback",value:"id"}`, including inside options records. Promise responses settle after 1–32 guest jobs, default one; this is scheduling control, not elapsed time. There are at most 64 invocations and 32,768 trace characters per case. `callbackTrace` records ordered call/settlement events with invocation indices and inert argument snapshots. It is required in both expectations and settled observations whenever callbacks are declared. Candidate-installed thenable behavior in response data, unsupported arguments, exhausted plans, overflow and stale callbacks cause sticky verifier faults. Expected answers never enter these closures.

`observeIdentity: true` requires `returnIdentity` on a return: the indices of direct object arguments identical to the actual result. Primitives are not identity matches. `observeError: true` requires an `errorObservation` on a throw, containing identity against optional approved `errors` and inert own properties. In v8, custom non-enumerable own data properties are included too: an attached checkpoint must not appear absent merely because of its descriptor. Non-enumerable native `message`/`stack` metadata is excluded. Custom getters and symbol keys abstain without invocation. This does not certify descriptors or arbitrary error prototypes. An argument `{type:"error-property",value:"earlier-case",key:"checkpoint"}` copies that earlier throw's observed property in the same history; it cannot copy executable callback references or borrow the expected answer. This also works across a realm reset.

See the [design and qualification obligations](../../../../docs/decisions/harness-next-async-observation-design.md). The pinned engine does not expose Node's unhandled-rejection policy; detached rejections, timers, IO, package/CommonJS resolution and general Node equivalence are not certified. Current project tests remain mandatory. Reusable production family review, independently frozen held-out calibration, minimum-Node packaging and the full release campaign remain separate requirements. Universal JavaScript support is not claimed.

## Nested object identity (worker v8)

An approved case may declare 1–16 `referencePairs`, each with a unique `id` and two selectors (`left`, `right`). A selector has a `root` (`argument`, `return` or `error`) and `path`, an array of at most eight string property keys. An argument root also requires its `index`; an error root requires `observeError: true`. These are bounded data paths, never expressions. Each declared pair requires an ordered `{id, same}` entry in `expected.referenceIdentity` and the settled worker observation. Old worker responses cannot supply v8 evidence.

For example, compare `{root:"error",path:["checkpoint"]}` with `{root:"argument",index:1,path:[]}` to require a new attached checkpoint, or `{root:"return",path:["results"]}` with `{root:"argument",index:1,path:["results"]}` to reject a result array borrowed from an action. Captured identity and own-property descriptor intrinsics run before any candidate-controlled getter or proxy trap. Such unsupported paths abstain instead of executing accessors. Inherited properties are not traversed. Missing paths, absent return/error roots and primitives are not object aliases, so `same:false` alone does **not** establish that a field exists or has the correct shape: the accompanying typed value or error-property expectations must do that. Paths refer to actual objects at the end of this invocation, not pre-call handles or cross-case live references. Existing argument snapshots remain necessary to reject mutation. No resource ceiling or approval rule is relaxed.

## Error messages (worker v9 / Node profile worker v2)

`observeErrorMessage: true` requests a separate `errorMessage` on a throw. It reads
only the first inert string `message` descriptor in a prototype chain bounded to
32 objects and checks that complete chain for tracked proxies before error-class
observation. Getters, proxies, coercion, non-string messages, excessive depth or
messages longer than 4096 UTF-16 code units produce unsupported/unknown. No stack
is read. A verified absence throughout the complete inert chain is `null`; this
is observed missing data, not a stand-in for unavailable observation. Primitive
throws also have `null` and retain their `non-error` classification.

The host-only expectation is `errorMessage: {includes: "conflict", ignoreCase: true}`.
The non-empty literal is bounded to 4096 code units. `ignoreCase` is required and
uses ECMAScript non-Unicode case-insensitive matching; metacharacters are escaped,
not interpreted as a plan-supplied expression. Missing required observation is
rejected. Unsupported execution never becomes a behavioral counterexample.

Without this opt-in, message collection and existing `observeError` property
semantics are unchanged. Observed message text may appear in private diagnostic
receipts/counterexamples, so do not enable it for contracts containing secrets or
publish raw observations without review. Expectations never enter the guest.
Worker/comparison versions and Node-profile/installed-verifier digests change;
old images and approvals are not qualified by new source tests. This capability
does not activate any plan, supply completion authority or change benchmark mode.

Node profile worker v4 hashes the same pinned Node executable with a 1 MiB buffer instead of reading its approximately 120 MB body into one temporary. Every byte and the expected SHA-256 remain identical; the request wall, case thread-CPU, container CPU/memory and watchdog limits are unchanged. The worker/profile/source identity changes, so old observations are not current v4 evidence. This addresses measured bootstrap allocation/I/O overhead, not a wider supported API or a retry allowance.


### Docker startup and control deadlines

The host executor allows up to 60 seconds for each Docker create, inspect, or removal command. These control requests can wait on daemon maintenance independently of guest execution. An inconclusive create is reconciled by its unique name, owner label and pinned image. A timed-out create is never retried or started; an owned late container is removed. If ownership or removal cannot be established, cleanup remains unconfirmed.

The approved backend may specify `startupAllowanceMs`, an integer from 0 to 60000 (default 0). The attached start command waits at most `timeoutMs + startupAllowanceMs`. This is an additional bound on the entire attached command, not a measurement of time spent before guest startup. The image watchdog and guest CPU/wall limits remain unchanged. An explicit old `timeoutMs` is not silently extended. Cancellation interrupts the attached command; ownership checks and cleanup still run afterward.

Selection recipes, signed host approvals, durable execution identities and benchmark observations bind the allowance. Changing it requires a new approved backend identity and cannot reuse evidence collected with a different allowance. Omitting it and explicitly setting zero have identical execution semantics. A longer allowance does not grant completion, add a retry, or turn uncertain cleanup into success.
