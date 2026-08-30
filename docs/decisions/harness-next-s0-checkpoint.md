# Harness Next: restartable provider-free S0

Status: development checkpoint; not a frozen candidate or a completed S0/108-session result.

## Failure and design evidence

The old S0 collector stored lane outputs in a temporary directory and only cached an aggregate after all four lanes passed. Its long-horizon runner also created a fresh temporary project on every invocation. The worker already supported its two *planned* process transitions, but losing the outer runner lost the address and control state of that project. A retained `58/90` counter alone could not safely reconstruct the execution.

The implementation applies two distinct persistence boundaries. [LangGraph's checkpointer documentation](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) distinguishes completed per-task writes from a completed overall checkpoint; this motivates retaining successful S0 lanes while a later lane is interrupted. It also explains that replay after a checkpoint can execute subsequent work again. Piagent therefore checks live process ownership before replay, rather than assuming a missing caller means the lane stopped. This is a design transfer, not adoption of LangGraph or a claim about its benchmark performance.

[SQLite's atomic-commit explanation](https://www.sqlite.org/atomiccommit.html) distinguishes atomic visibility from flushing durable writes and documents filesystem/hardware assumptions. This implementation uses a bounded JSON snapshot, a same-directory temporary file, file synchronization, atomic rename, and directory synchronization. It does **not** use SQLite for S0, claim SQLite's full guarantees, or claim that process-kill tests simulate power loss.

## Implemented boundaries

- The S0 cache directory is keyed by the exact candidate/configuration binding, including the Node version, platform and architecture. The existing clean-Git and lane-source checks run before cached evidence is accepted and after executed lanes. Changed source/configuration cannot reuse the old progress namespace.
- Each lane keeps its result and a separate `running`, `interrupted`, `passed` or `failed` checkpoint. A passed lane is reused only after its result digest and original gate are validated. A failed lane is terminal for that binding; another invocation does not silently retry it. An invalid aggregate can be reconstructed from valid settled lane records, not from unverified output.
- A preloaded lane owner takes a process-lifetime lock before the actual lane entrypoint runs and checks its reservation ID. A surviving lane still holds that lock when its benchmark caller dies. A stale queued launch cannot execute a newer reservation. Ownership refusal is distinct from a failed test and never becomes PASS.
- The long-horizon runner accepts `--state-directory` and `--binding`; S0 supplies both automatically. It persists the owned fixture project, task identity, coordinator phase, real observed crash, continuation/handoff evidence, and final report. Non-durable standalone invocation remains supported.
- The worker commits one bounded snapshot containing progress, working context, telemetry and context events per unit. Other private files are projections rebuilt from that snapshot after interruption. Committed unit artifacts are checked against source bytes and are neither re-executed nor rewritten. Uncommitted units may run again; no exactly-once side-effect guarantee is made for arbitrary programs.
- A worker lifetime lock excludes concurrent writers. The long-horizon worker observes IPC disconnection and stops when its coordinator exits. Recovery refuses a still-live coordinator or worker rather than killing an uncertain PID.
- The planned hard-crash point is an explicit committed boundary and an observed `SIGKILL`, not a timing race. Additional external restarts are reported as additional process starts; the required crash and handoff boundaries must still both be exercised.
- The 30-minute qualification uses accumulated active worker time. Time while the runner is stopped cannot qualify the lane. Fast calibration remains labelled `calibration-fast` and cannot satisfy production S0.

Checkpoint checksums detect damaged/mismatched local records; they are not authentication against an attacker with the same host UID. Checkpoints are private local execution data, not public release artifacts. The original lost v5 checkpoint is not reconstructed or counted.

## Verification and remaining gates

Focused tests exercise real coordinator deaths at units 2, 5 and 8; OS kills before and after unit checkpoint publication; a kill after the coordinator transition; concurrent callers; configuration mismatch; unchanged committed artifact bytes and modification times; exact continuation budget; and complete-result reuse without another worker. A separate test uses the real benchmark process controller, kills its caller, observes the detached lane still alive, and proves a contender and obsolete reservation cannot run the entrypoint.

The final combined checkpoint/provider-free/long-horizon regression passed 20/20 with zero skips. This includes the crash window after the continuation reservation but before coordinator commit: the resumed run reconstructs the same consumed reservation and still refuses a second continuation. Corrupt partial lane results are also rejected without being silently rerun or accepted.

The broader benchmark and production regression passed 303/303 with zero skips, including immutable snapshots, paid-attempt accounting with fixture providers, interruption, staged resume, terminal stops and privacy. These are accelerated nine-unit lifecycle tests plus receipt/storage/ownership tests and the retained historical fixture checks. They are not a new 90-unit or 30-minute S0 run. Typecheck, documentation checks and architecture boundaries (539 source files) also passed at this checkpoint.

Remaining work includes final interruption/error recovery integration, multi-domain held-out harness calibration, full offline release verification, a newly frozen candidate, and a fresh S0 followed by the spend-controlled S12 → S18 → S54 → S108 campaign. The v5/v6 campaigns remain closed and cannot be merged into this candidate.

Operationally, invoke the same S0 configuration again to use its retained progress. A live ownership lock is a reason to inspect the existing process and progress, not to delete the lock or launch another run. Corrupt partial checkpoints fail closed and remain available for diagnosis. No provider run, push, publish, shared dependency installation, or main-workspace edit was performed for this checkpoint.
