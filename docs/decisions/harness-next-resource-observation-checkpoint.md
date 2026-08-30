# Harness Next: retain the actual resource stopping sample

Status: diagnostic capability and minimum-runtime verification; resource
reliability and release qualification remain incomplete.

## The full result did not support another budget change

Full offline verification on clean `aeb96b4` finished with 3,537/3,538 tests
passing, zero skipped/cancelled, and exit 1. The failing ISO development mutant
was `numeric-expiry-coercion`. Its 39th case, `fraction-long-after`, stopped
with `guest-cpu-budget`; cleanup was confirmed, but no behavioral counterexample
was available. The subsequent browser and typecheck stages were not reached.
The full log remains preserved with SHA-256
`799881d7d527ed3bda85ff164fe73b73a9103dd15fec3aa5802bb7be115d9e50`.
This is not the same test or elapsed-time cause as the older v3 full failure.

The exact failed request and source digests were reconstructed and checked
before a bounded diagnostic experiment. Three default runs, three runs with
the experimental V8 no-tier-up flag, and three waves of eight concurrent
default runs all completed the same 209 inputs. Each used the pinned v4 image,
an explicitly diagnostic entrypoint and verified owned-container cleanup.
No retries continued until a desired result appeared. The largest measured
case used 69,213 microseconds of process CPU and 21,968 microseconds on the
current thread. These observations did **not** reproduce the full failure.
They are neither production receipts, held-out evaluation nor model sessions.

[V8 documents background WebAssembly optimization](https://v8.dev/docs/wasm-compilation-pipeline).
[Node 22.19 distinguishes current-thread CPU from process CPU](https://nodejs.org/download/release/v22.19.0/docs/api/process.html#processthreadcpuusagepreviousvalue).
The difference is a plausible contributor, not established attribution for
the failed case. Disabling tier-up did not establish a fix and was not adopted.
Increasing the limit, changing to thread-only accounting, or asserting
instruction-fuel equivalence is not justified by these samples.

## Implemented observation, unchanged decision policy

Worker v5 retains the first stopping sample for a CPU or wall stop within a
case: `caseCpuMicros`, `caseThreadCpuMicros`, and `caseWallMicros`. The sample
is fixed when the budget first stops the case; later polls do not replace it.
A new case clears the sample but does not renew the request deadline. Module
initialization timeouts also retain the sample.

The case CPU decision still charges the whole process and still stops at
300,000 microseconds. Thread CPU is **diagnostic only**. The five-second request
deadline, eight-second OS watchdog, memory/stack/container limits, finite
attempt policy and completion requirements are unchanged. A wall deadline
between cases does not invent a case sample.

The parser requires exact nonnegative safe-integer measurements for case
resource stops and refuses a CPU-stop sample below the policy threshold.
Measurements on completed/unsupported observations, missing/extra fields and
v4 responses are rejected. These checks validate the trusted worker's protocol;
an arbitrary JSON object does not gain execution or completion authority.
Thread and process counters are sampled at slightly different instants, so
their numeric ordering is not used as a false consistency requirement.

The new image is
`sha256:0f82601310d56a69bda685a1d8bf2b3c3670c414687784d34e904fc66d92180e`.
It uses the same cached base and existing dedicated dependencies as v4.
No shared dependencies, production approvals or old campaign records changed.

## Executed checks

The official Darwin arm64 Node 22.19.0 archive was placed in a private
directory and matched the [official SHA-256 manifest](https://nodejs.org/download/release/v22.19.0/SHASUMS256.txt):
`c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d`.
No global runtime was replaced; this is checksum verification, not an
independent signing-key audit.

Before the diagnostic change, unchanged aeb96b4 passed 290 acceptance/accounting
checks and four actual completion-hook scenarios on native Node 22.19.0, zero
skips. These did not supersede its full failure.

After the change, with native Node 22.19.0 first in PATH and the v5 image:

- Final acceptance, calibration-accounting, FS5 and artifact checks: 292/292,
  zero skips/failures, 42.239 seconds. Includes real resource stops during
  module initialization, normal execution and injected idle waits, forged
  clock attempts, unchanged isolation, and invalid resource samples.
- Four actual completion-hook scenarios (ISO valid, unavailable backend,
  unsupported result and timeout): 4/4, zero skips, 102.808 seconds. Project
  verifiers and real isolated workers execute; model responses are controlled
  SDK fixtures, not provider calls.
- An additional actual production-protocol infinite-loop probe stopped at
  300,018 microseconds process CPU, with 213,982 microseconds current-thread CPU
  and 307,512 microseconds elapsed. The v5 parser admitted the timeout record
  and cleanup was confirmed. It did not create a behavioral counterexample.
- Typecheck, architecture (548 source files), documentation and whitespace
  checks pass. An initial unavailable npm architecture-script name was corrected
  to the repository's actual checker; it was not a source-test failure.

## Remaining obligations

This adds actionable evidence to a future resource stop; it does not prove the
intermittent failure fixed. Full offline/browser reliability, complete
minimum-runtime packaging, independently frozen held-out coverage, host-approved
benchmark integration, production/backend compatibility and the new frozen
S0/S12/S18/S54/S108 campaign remain required. No new full run was launched merely
to replace the preserved failure. No provider campaign, push or publish occurred,
and no 108-session or token-saving release claim follows from this checkpoint.
