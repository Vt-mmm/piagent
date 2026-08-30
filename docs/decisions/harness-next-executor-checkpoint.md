# Harness Next executor checkpoint — 2026-08-30

Status: implemented and diagnostically tested; not enabled for production completion or released.

## What changed

- Added a dedicated QuickJS-WASM worker and strict bounded input/output protocol. Inputs support primitives and Date; outputs support primitives and captured error classes. Candidate code receives no host callbacks or expected answers. Every case has a fresh runtime.
- Added a host-only local Docker controller: immutable image ID, explicit local socket, no pull, no network/workspace mounts, unprivileged identity, read-only filesystem, bounded memory/PIDs/CPU, OS watchdog, and outer deadline/cancellation. Actual container configuration is inspected before execution. Cleanup failure invalidates results.
- Added an independent expected-result plan and host comparison. A genuine mismatching behavior captures a content-addressed counterexample. Unsupported cases remain unknown; execution faults remain errors. These results do not themselves mint acceptance receipts or grant completion.
- Kept the assessment kernel and all existing completion/recovery hooks unchanged. Approved runtime contract selection, source snapshot binding, authenticated persistence, and recovery integration are still required.

## Local provenance

- Base candidate: frozen v6 `db4bbca147bb9c6a181a4758239035e95d41504b`; implementation branch `codex/harness-next` in its separate clone.
- Node base image: `node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90` (locally installed Node 22.19.0 Debian Bookworm slim, Linux arm64).
- Diagnostic worker image: `sha256:015cfdeeccf767027c217be9312f80a44dabd3d48e5b632ea205bf4871b0799a`.
- Dedicated dependency lock: QuickJS core, release-sync WASM, and FFI types 0.32.0 with registry integrity hashes. The WASM package identifies upstream QuickJS revision `f1139494d18a2053630c5ed3384a42bb70db3c53`.
- Docker build had network disabled and used only the local base plus the allowlisted worker directory. The initial normal build waited on Docker's credential helper; it was cancelled. A separate empty Docker client configuration and local-only legacy build completed without changing the user's credential store. Cross-platform build reproducibility is not yet established.

## Observed results

- Full current acceptance suite with real executor and retained diagnostic enabled: 151/151 passed, zero skipped or failed. Typecheck passed; architecture passed for 519 source files. This is not a full offline release verification.
- Executor suite: 13/13 groups passed with the real container enabled, including configuration admission, typed results, fresh realms, actual versus named-only TypeError, prototype/serialization tampering, unavailable host/IO bindings, denied imports, Date mutation observation, infinite loops, memory exhaustion, outer deadline, and pre-start/in-flight cancellation.
- A pathological regular expression was interrupted and cleaned up in about 0.54 seconds in its isolated diagnostic. `Atomics.wait` was unavailable in the selected guest, returning ReferenceError; this is not a watchdog firing test.
- Independent comparison suite: 6/6 groups passed. Three structurally different correct implementations passed the same bounded contract; three broken comparator implementations produced host-captured counterexamples. Unsupported return types and unavailable backends were not passed.
- Retained expiry replay: unchanged source SHA-256 `06e12ad0b3709d9cb1936501f423ee7eded80609e4c5f28d4d76f0b70159e1bf` passed all 194 cases across valid ISO/calendar/boundary inputs, invalid inputs, input stability, and clock laziness. Expected epochs for selected valid ISO inputs came from host V8; invalid calendar partitions were explicitly labelled. The benchmark hidden grader was not imported or used as an oracle.
- Four in-memory mutants of that exact source were all rejected with counterexamples: exclusive rather than inclusive comparison, swapped second/fraction captures, wrong year 0000–0099 handling, and removed calendar validation. The retained file hash was unchanged afterward.
- No provider/model benchmark calls were made. Closed v5/v6 campaign results and accounting remain unchanged. Tests removed their own disposable containers; the labelled-container check found none left over.

## Limits and next work

This is a development calibration set, not held-out evaluation. Finite successful cases are not universal proof. The current worker does not support imported modules, async execution, object/array inputs or outputs, or persistent multi-call state. QuickJS and Node semantics require explicit adapter compatibility testing. The separate OS watchdog is present and admission-checked; the tested infinite loop and regex stopped via earlier limits, so those tests do not establish its behavior under every VM failure.

Do not wire this evidence into completion merely because these tests pass. First implement approved contract/backend admission and exact source/probe/verifier binding, durable authenticated receipt recovery, fail/unknown/error routing under the existing mutation policy, and interruption-safe checkpoints. Then calibrate additional domains, labelled valid/mutated/held-out fixtures, and end-to-end runtime behavior. A new frozen release campaign remains required; the old failed lineage cannot be resumed or relabelled.
