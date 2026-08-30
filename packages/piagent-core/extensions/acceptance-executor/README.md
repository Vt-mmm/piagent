# Isolated contract worker (experimental)

This experimental worker supplies bounded behavioral observations for a **closed synchronous JavaScript module**, including primitive/Date inputs, bounded array/record data and explicit multi-call histories. It is reachable through opt-in host-approved verification; the worker itself cannot approve completion. Imports, async execution, arbitrary object graphs and unsupported values must not silently pass.

## Authority and isolation

- The host selects an authorized local Docker socket and a previously built, approved image by its full `sha256:` ID. A model-supplied image or expected-result plan is not trusted verifier configuration.
- QuickJS-WASM executes candidate code without host callbacks, process/IO bindings or expected answers. Cases get a fresh realm unless they belong to one explicit contiguous sequence. A reset destroys that realm; only explicitly referenced, actually returned data can cross the reset.
- The host retains expectations and compares typed observations. Candidate `JSON.stringify`, `toJSON`, exception names and stdout are not verdict authorities. Reflection/Date/error intrinsics are captured before initialization; data-property creation uses captured functions and null-prototype descriptors. Proxy tracking uses null-prototype handlers to prevent candidate-added inherited traps from exposing an untracked factory. Returned accessors and tracked proxies are not traversed.
- The container has no workspace/socket mounts, network access, root user, elevated capabilities, or writable root filesystem. The controller inspects the actual configuration before starting it. Image pulling and host-execution fallbacks are disabled.
- QuickJS uses a 32 MiB memory ceiling, 512 KiB stack ceiling, and a 300 ms per-case interrupt deadline. A request has a 5-second internal deadline. The container also has a 256 MiB memory limit, 32-PID limit, one CPU, a CPU-time rlimit, and a separate 8-second OS watchdog. An outer host deadline can stop an attached run. Engine interrupts alone are not treated as sufficient isolation.
- Cleanup is limited to the newly created container with the exact run label, image ID, and container ID. Unconfirmed cleanup invalidates the observation. No Docker pruning or deletion of user containers is performed.

These are tested containment controls, not a guarantee against every engine or kernel vulnerability. Backend/image admission, verifier installation integrity, and project execution authorization must remain separate runtime gates.

## Building and verifying

This directory has its own locked dependencies and is deliberately separate from the platform's shared `node_modules`. Install them with `npm ci --ignore-scripts --workspaces=false --no-audit --no-fund`. The lock pins QuickJS core, the release-sync WASM package, and FFI types to 0.32.0, including package integrity hashes. No dependency lifecycle scripts are required.

Build this directory with `BASE_IMAGE` set to a locally available, approved Node image digest. The Dockerfile deliberately has no mutable default base. The build context allowlist contains only worker source, its manifest/lock, and its dedicated dependencies; it never contains a project snapshot, credentials, or expected-result plans. Build with `--network=none --pull=false`; dependency installation is a separate, explicit setup step.

If Docker's credential helper blocks a local-only build, use a separate temporary Docker client configuration containing an empty JSON object and an explicit local socket. Do not inspect, replace, or weaken the user's credential store. The initial local diagnostic used Docker's legacy builder with that isolated configuration; build portability remains to be validated before release.

Set `PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID` to the built image's full ID and `PIAGENT_CONTRACT_EXECUTOR_SOCKET` to the approved local socket to enable the real executor tests. Without both, tests requiring Docker are visibly skipped, not silently counted as passes. The retained expiry diagnostic additionally requires `PIAGENT_RETAINED_EXPIRY_SOURCE`; its expected source hash is checked before and after read-only execution.

## Remaining integration work

`acceptance-independent-contract.js` keeps expectations outside the guest and captures counterexamples on the host. Its result remains **diagnostic evidence** until separate authenticated admission validates the latest private receipt, current source/Git/project-verifier bindings and approved plan. Existing safety, repair and continuation ceilings remain in force.

## Bounded data and histories (worker v2)

- Tagged `array` values contain dense arrays of tagged values. Tagged `record` values contain unique `{key,value}` entries. This preserves undefined and special numbers and safely represents an own `__proto__` property. Record equality ignores insertion order; array equality preserves order.
- A tree is limited to depth 8, 256 nodes, 64 entries per collection, 4096 characters per string/key and 64 KiB of aggregate string/key text. Date values are allowed in inputs/argument observations, not returned data. Existing request, source, response, memory and execution-time limits remain unchanged.
- These are own enumerable data-property snapshots, not claims about hidden object brands, descriptors, alias identity, arbitrary prototypes or all JavaScript reflection behavior. Cycles, sparse arrays, accessors, symbols, returned proxies and ordinary exotic objects abstain. Proxy construction is intercepted to track those objects; primitive results produced through internal proxy operations remain supported. Intrinsic reflection is not guaranteed to match Node's runtime.
- A case may specify `sequence`, a named `exportName`, `reset: true`, and `observeArgs: true`. A sequence must be contiguous. A `result` argument names an earlier successful return in that same sequence and supplies a **copy of its observed data**, not a live object handle or an expected value. Forward/self/cross-history references are rejected before execution. Unavailable results prevent dependent calls from running.
- `observeArgs` captures every resolved argument after a return or throw. The host may require exact `expected.argsAfter` values. Inputs are mutable; observation must not freeze them. Clock observations are per call, including when module state is retained.
- Counterexamples include the complete input prefix for a stateful failure. Worst-case repeated prefix bytes are bounded to 2 MiB before execution. No invocation history or expected answer is injected into the candidate's global scope.

A realm reset tests a component's checkpoint/restore contract. It is **not** an OS-crash, filesystem-durability, transaction or arbitrary application-state proof. S0 process-death tests and host receipt reconciliation remain separate. General imports/async backends, reusable production contract selection, independently frozen held-out calibration, minimum-Node packaging and the full release campaign remain required.
