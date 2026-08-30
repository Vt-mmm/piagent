# Harness Next: conditional repair intake and unresolved timeout

Status: development checkpoint, not a release candidate or a production campaign.

## Preserve the whole request, not just a repair phrase

The previous classifier answered whether a request contained *any* conditional
repair phrase, then used that answer to make the whole source task optional.
That conflated two different requests: verifying an existing implementation
with repair only if needed, and implementing a required change followed by
conditional repair. Fixed phrase-distance limits also failed on the long ISO
contract's trailing repair instruction.

`task-repair-intent.ts` now separates no recognized conditional repair,
conditional-only repair, and mixed required/conditional work. Intake permits a
zero-delta source task only for the conditional-only case. Task-wide read-only
boundaries still take precedence. The same classifier supplies the existing
follow-up intent check; prior-task evidence still requires its original exact
lineage, source, scope and snapshot bindings.

The bounded classifier examines instruction clauses rather than imposing a
distance between inspection and repair. It masks quoted/code examples, handles
the tested English/Vietnamese command forms and condition placement, and retains
recognized mandatory commands in mixed requests. A local prohibition cannot
erase its surrounding implementation command. A repair word in a description
does not itself make that different command conditional.

This is a finite linguistic classifier, **not** a complete natural-language
parser, an independently calibrated language model, or proof of arbitrary task
semantics. The regression prompts are development examples, not held-out data.
It creates no external-provider approval and bypasses no source scope, mutation
guard, observed-verifier requirement, or completion gate. An explicit task
contract remains distinct from these automatic intake heuristics.

The ISO completion tests now use the original problematic layout: a long API
contract followed by the conditional repair instruction. They no longer move
the condition to the beginning as a workaround. The selected scenarios exercise
an already valid implementation, a real invalid-calendar counterexample, and a
counterexample-backed repair using the existing isolated worker and actual
project verifier commands. The hook harness uses controlled SDK fixtures, not
a paid model session or a new installed-Pi end-to-end campaign.

## Verification and the full-run failure remain separate

- Focused intake plus runtime/session/product regressions: 108/108 on Node
  24.11.1, zero failures/skips. These are tests, **not 108 benchmark sessions**.
- The four focused intake/guidance/workflow files: 25/25 on Node 22.23.2,
  zero failures/skips. This does not establish the minimum 22.19.0 runtime.
- Selected completion-hook checks: 8/8, zero failures/skips, 201.224 seconds.
  These include the three mandatory-command forms, unchanged valid source,
  all three long-suffix ISO scenarios, and exact adjacent-task evidence reuse.
- Typecheck, architecture (547 source files), documentation checks and
  whitespace validation pass. None of these focused results establishes a
  full offline release pass.

The unchanged development commit `b70c785` finished its full Node test stage
with 3,519/3,520 passing, one failure and zero skips. The stage took 897.161
seconds; the offline script stopped before its later browser/release checks.
The failing clean-commit invalidation case received `guest-timeout` for the
changed subtraction implementation instead of a completed counterexample.
Cleanup was confirmed and completion remained refused. No source defect or
passing behavior can be inferred from that timeout alone.

The unchanged complete durable-execution file then passed 14/14 in 26.593
seconds, including the failed case and an intentionally nonterminating guest.
This separate diagnostic does **not** supersede the full-run failure. No
deadline, expected verdict, retry policy, or completion gate was relaxed.

The worker uses `performance.now()` for its 300 ms per-case deadline. The
[Node 24.11.1 time API](https://nodejs.org/download/release/v24.11.1/docs/api/perf_hooks.html#performancenow)
measures elapsed timestamps; [CPU usage](https://nodejs.org/download/release/v24.11.1/docs/api/process.html#processcpuusagepreviousvalue)
is a different measurement. The [test execution model](https://nodejs.org/download/release/v24.11.1/docs/api/test.html#test-runner-execution-model)
also runs separate files in concurrent processes. Contention is therefore a
plausible hypothesis, not established causation: the failed attempt did not
capture scheduler/CPU telemetry. Queue admission and CPU-versus-wall budgeting
need measured calibration before changing production limits; blindly rerunning
until green would not provide that evidence.

## Remaining gates

Retain the failed full-run log and source identity; reproduce or characterize
the timeout with resource observations; finish independently frozen held-out
evaluation, minimum-runtime and benchmark host-approval integration; then run
full offline/browser verification on the final source. Only a newly frozen,
ready candidate can enter S0 and the finite spend-controlled S12/S18/S54/S108
campaign. S0/S12 failure stops advancement rather than authorizing an automatic
source-repair/restart loop. Old campaigns and the lost v5 checkpoint are not
reconstructed, resumed, merged or relabelled by this change.
