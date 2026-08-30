# Harness Next: computation budgets are not scheduler deadlines

Status: development verification; the prior full-offline failure remains
recorded. This checkpoint does not establish a completed release campaign.

## Cause model and primary sources

The full run on `b70c785` returned `guest-timeout` for a small subtraction
implementation before it could retain the expected behavioral counterexample.
The unchanged file passed in isolation. That alone did not prove contention.

[Wasmtime's interruption design](https://docs.wasmtime.dev/examples-interrupting-wasm.html)
distinguishes deterministic instruction fuel from nondeterministic wall-time
epochs, with different costs and guarantees. We transfer the distinction
between computation allowance and liveness deadline, not Wasmtime's fuel
implementation or its performance numbers.

[QuickJS's interrupt API](https://bellard.org/quickjs/quickjs.html#Execution-timeout-and-interrupts)
and the [pinned quickjs-emscripten 0.32.0 wrapper](https://github.com/justjake/quickjs-emscripten/blob/v0.32.0/packages/quickjs-emscripten-core/src/runtime.ts)
provide periodic callbacks. Counting those callbacks is not documented as an
exact portable instruction budget, and native operations still need an outer
watchdog. Replacing the backend with Wasmtime solely for this fault would also
change the tested runtime and require a separate compatibility evaluation.

[Node 22.19 process CPU accounting](https://nodejs.org/download/release/v22.19.0/docs/api/process.html#processcpuusagepreviousvalue)
measures user and system CPU separately from elapsed time, including work by
multiple process threads. This supplies an implementable compute allowance for
the existing worker. It is not deterministic fuel or candidate-only CPU time.

## Controlled diagnostic, not a relabelled campaign

The diagnostic probe runs inside the same pinned, restricted local worker
image. It substitutes an explicit diagnostic entrypoint, retains the watchdog
and container resource restrictions, and wraps the interpreter's first
interrupt callback with a known idle wait. Candidate source still runs only
in QuickJS. Its output is marked diagnostic and is not a worker observation
that the acceptance parser can admit.

The exact probe bytes and requests are the same across the two images. Selected
single-run observations are below; all seven rows per image are retained.

| Controlled case | Worker v3 | Worker v4 |
| --- | --- | --- |
| Correct sum, 600 ms injected idle wait | Timeout; 34.765 ms process CPU | Returns 5; 39.175 ms process CPU |
| Wrong sum, 600 ms injected idle wait | Timeout; 32.805 ms process CPU | Returns -1; 42.249 ms process CPU |
| Infinite loop, 600 ms injected idle wait | Timeout before computation; 32.061 ms CPU | CPU-budget stop; 301.003 ms CPU |
| Correct sum, 5,200 ms injected idle wait | Undifferentiated timeout | Request wall-deadline stop |

Without the injected wait, both versions returned 5 for the correct sum and -1
for the wrong sum. The experiment establishes a mechanism by which elapsed
waiting can conceal either result under v3. It does not recover scheduler
telemetry from the original failed full run, prove its sole cause, estimate
failure prevalence, or measure a speed/token improvement.

## Implemented policy and evidence boundaries

- Each case has a fixed 300,000-microsecond worker-process CPU allowance,
  including user, system and support work. Invalid/regressing CPU observations
  fail closed. A new case resets only its compute allowance.
- The absolute five-second request deadline remains fixed across all cases.
  The eight-second OS watchdog, outer host timeout/cancellation, one-CPU
  allocation, memory/stack/PID limits, mount/network restrictions and exact
  owned-container cleanup are unchanged.
- Polling happens during interpretation and before admitting a completed
  observation. It can overshoot between polls; native operations are not
  claimed to be preemptible at an exact CPU instant. The OS watchdog remains
  necessary. Severe contention can still hit the request wall deadline.
- Worker v4 distinguishes CPU exhaustion and request wall expiry. A top-level
  cause preserves wall expiry between cases. The parser refuses contradictory
  status/cause combinations, nonterminal errors and v3 responses. The existing
  finite recovery policy receives a resource diagnostic, not source-repair
  authority or a fabricated counterexample.
- Worker source, the CPU policy and dependency declarations are now included
  in installed-verifier identity. A changed policy revokes the old approval;
  the exact image digest remains a separate host-approved binding. Building v4
  does not update any live production approval or old stored observation.

The new image is
`sha256:3ae9b26df230c1ed7d207875d7404a150ab7b5c59dc1f3db727595707439d88a`.
Its base is the existing local `node@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90`;
QuickJS dependencies remain pinned at 0.32.0. The completed build used the
cached base and dedicated existing dependencies, with no dependency install.
An initial bare-ID BuildKit attempt resolved a registry name and failed; that
log is preserved. The successful local build used a repository-qualified
digest and the explicitly selected legacy builder. That deprecated builder
is not claimed as a future portability solution.

## Verification and remaining release obligations

The combined final-source acceptance, calibration-accounting and historical
artifact regression passes 290/290 with zero skips in 38.893 seconds. This
includes real isolated execution, resource fault injection, ISO valid/equivalent
variants and 17 defects, durable admission/recovery, and policy-drift refusal.
These are tests, not model sessions or held-out evaluation. Four selected
completion-hook scenarios passed on v4 before the final installed-identity
declaration change; a new full-source run is recorded separately.

The 51 resource, host-approval and isolated-executor checks also pass on Node
22.23.2 with zero skips in 10.108 seconds. This is not minimum-host-22.19 proof.
Actual selected-development execution matches all 21 declared labels: eight
correct implementations pass, nine defects retain counterexamples, and four
remain unknown, with no executor error. The development labels and unknowns
are unchanged; neither these fixtures nor the injected stalls are held-out.

Actual selected-development calibration, full offline/browser verification and
minimum-host-runtime evidence must remain separately identified. The required
independently frozen held-out evaluation, benchmark host-approval integration,
real production/backend compatibility, new frozen candidate and finite
S0/S12/S18/S54/S108 campaign are not completed by a resource-budget fix. Old
campaigns remain closed and no percentage token-saving claim is made.
