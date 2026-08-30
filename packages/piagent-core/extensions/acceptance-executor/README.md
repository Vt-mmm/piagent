# Isolated contract worker (experimental)

This worker is not enabled in production completion hooks. It supplies host-observed, bounded behavioral evidence for a **closed synchronous JavaScript module with primitive/Date inputs and primitive outputs**. It does not prove arbitrary programs correct. Imports, asynchronous modules, object results, and other unsupported values remain unsupported; they must not silently pass.

## Authority and isolation

- The host selects an authorized local Docker socket and a previously built, approved image by its full `sha256:` ID. A model-supplied image or expected-result plan is not trusted verifier configuration.
- QuickJS-WASM executes candidate code in a separate realm, without host callbacks, process/IO bindings, or access to expected answers. Each case gets a fresh runtime/context. The current adapter does not test persistent multi-call state.
- The host supplies input values, retains expected results, and compares typed observations. Candidate `JSON.stringify`, `toJSON`, exception names, and stdout are not verdict authorities. Date observation and error prototypes are captured before candidate initialization.
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

`acceptance-independent-contract.js` keeps expectations outside the guest and captures counterexamples on the host. Its output is **diagnostic evidence**, not a durable authenticated receipt or completion permission. Runtime integration still needs approved contract adapters, source-closure/current-tree binding, verifier identity, durable authenticated admission, bounded recovery policy, and checkpoint persistence. The existing completion gates are unchanged until those requirements are implemented and tested.
