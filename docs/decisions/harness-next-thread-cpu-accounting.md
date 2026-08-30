# Separate case execution CPU from supporting-thread CPU

This decision changes the resource-accounting domain in worker v6. It does not
turn an executor error into a behavioral failure, weaken an acceptance check,
enable a retry or qualify the release.

## Evidence and limitation

The native Node 22.19 full offline run on `f5b13aa` failed the redactor mutant
diagnostic with process CPU 310,014 µs, executing-thread CPU 100,256 µs and case
wall time 244,051 µs. Approximately 209,758 µs was outside the executing thread.
This is direct evidence that the former process-wide case budget could stop a
case while its executing thread had used about one third of its nominal limit.
The separate [full findings](harness-next-minimum-full-findings.md) retain both
failures and the failed qualification result.

A bounded 12-run diagnostic replayed the exact failing request digest
`1b915fce83b85068d379d2d13948ec46eae91c07189af9660e26ae18cd4104dc`
and source digest
`eacc06054e8897668184db0543581dbdfd2c98d3165d45dc584f152372706efc`.
Two waves each used six concurrent containers, alternating default compilation
and experimental `--no-wasm-tier-up`. All 12 returned all four cases and confirmed
cleanup, so they did not reproduce the full failure. Supporting-thread CPU
remained visible with tier-up disabled. No compiler flag was adopted, and no
claim is made that Wasm optimization alone caused the full failure.

[Node 22.19's thread CPU API](https://nodejs.org/download/release/v22.19.0/docs/api/process.html#processthreadcpuusagepreviousvalue)
provides current-thread user and system CPU. [V8's compilation documentation](https://v8.dev/docs/wasm-compilation-pipeline)
describes background optimization; it does not establish the identity of the
supporting threads in this particular sample.

## Layered limits

The case limit is now 300,000 µs of executing-thread CPU, including parsing,
marshalling and observation on that thread. Both counters remain recorded at
the first stop, and regressions/invalid values in either counter fail closed.
Background CPU remains inside the unchanged one-CPU container quota, process
CPU rlimit (10/12 seconds), eight-second outer watchdog and memory/PID limits.
The five-second absolute request deadline remains unrenewable by later cases.
All these limits include finite overshoot until the next interrupt or watchdog.

This is not the old per-case total-process ceiling: supporting work is accounted
at the container/request level instead. It is not deterministic fuel or a speed
guarantee. The worker protocol is v6; v5 observations are refused, and a v6 CPU
timeout must carry a thread sample at or above the threshold. Installed verifier
and immutable image identities invalidate approvals made for the old policy.

The image built with the existing private locked dependencies and cached base is
`sha256:804844c4b2e6f2ab03f0a44cb4280ed7ea65aa9fa17df253ae4e2f277a70add8`.
No package installation, image pull, expected-answer change, completion-gate
change or paid campaign is part of this decision. Targeted real-executor tests,
combined bridge integration and a new fixed-source full run are still required
before treating this as qualified.
