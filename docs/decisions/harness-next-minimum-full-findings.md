# Minimum-runtime full verification findings

The full offline run on unchanged `f5b13aa02ec1404e5759e00d37e205320d680ea0`
failed on 2026-08-30. This is not release qualification: 3,538 of 3,540 tests
passed, two failed, and none were skipped or cancelled. Node was native Darwin
arm64 22.19.0; the worker image was
`sha256:0f82601310d56a69bda685a1d8bf2b3c3670c414687784d34e904fc66d92180e`.
Elapsed time was 1,030,617.997625 ms. The retained private full log SHA-256 is
`cd1b3d1ff3f13af8bd8db99ccfcfd92d003c9a2bac0c1946efde9c7798236a88`.
The later browser/typecheck stages were not reached after the failing test stage.

## CPU observation, not a behavioral counterexample

The five-file production-redactor diagnostic's in-memory mutant stopped on its
first (`plain`) case. The valid implementation had already passed. The mutant
returned `error`, not the expected behavioral `fail`, with confirmed cleanup.
Resource observations were process CPU 310,014 µs, current-thread CPU 100,256 µs,
and wall time 244,051 µs. Thus approximately 209,758 µs of the measured process
CPU was outside the executing thread. No counterexample was produced.

[Node's process API](https://nodejs.org/download/release/v22.19.0/docs/api/process.html#processthreadcpuusagepreviousvalue)
distinguishes these counters. [V8 documents background Wasm optimization](https://v8.dev/docs/wasm-compilation-pipeline),
which is a plausible contributor, but the observation does not identify the
specific supporting thread or establish that disabling optimization fixes it.
The whole-process 300,000 µs case limit, five-second request deadline, eight-second
outer watchdog, and completion gate have **not** been relaxed. The resource
reliability question remains open; another full run is not a substitute for
isolating it.

## Exact coordinator-crash regression

The other failure was the advertised unit-5 resume assertion. The test observed
unit 5, then waited for a competing coordinator to start and reject its lock,
and only afterwards killed the original coordinator. The worker was free to
advance meanwhile. Therefore the originally observed unit was not necessarily
the actual last committed unit at interruption.

The regression now uses an external, test-only preload to stop the actual worker
with SIGSTOP immediately after the target checkpoint's atomic rename. While
stopped it checks the competing coordinator's refusal, kills the original
coordinator, and resumes the worker so its real IPC-disconnect shutdown runs.
It asserts the exact retained unit and that this exact unit appears in the
resumed lifecycle. Cleanup also releases a stopped test-owned worker.

All seven checkpoint tests passed on native Node 22.19.0: exact units 2, 5 and 8,
plus four before/after atomic-commit crash windows. No production checkpoint
logic was changed. These accelerated tests remain calibration-only and do not
count as a new full S0 or any model-provider session.
