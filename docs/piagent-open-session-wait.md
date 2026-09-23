<!-- language: en -->

# Waiting between useful checks

Piagent provides `piagent_wait` for an operator-requested wait or monitoring task in an open session. It uses one local timer for 1–3600 whole seconds and returns a short reminder of the next observation. It does not run commands, inspect a condition, schedule another session, or mark the task complete. A running process's own completion-aware wait is preferable when available.

The model chooses the interval within the user's deadline and supplies `nextCheck`. Finish independent work first; call the wait tool alone. The tool itself does not poll, dispatch a model request, or emit periodic updates. On expiry the SDK can make its ordinary next model turn, which must inspect the actual result. Waiting wall time still counts toward external session/campaign deadlines. It does not extend the benchmark's 900-second session limit or increase its budget.

The tool group is activated for wait/monitor/follow-up intent, including Vietnamese equivalents, and is retained from the active task's original request on resume. Ordinary coding prompts do not acquire the additional schema. The existing loader can explicitly load the `waiting` group. Phase enforcement permits waiting in working phases, not terminal/handoff phases; waiting grants no mutation or provider authority.

Cancellation clears the timer, records interruption, and supplies the SDK's terminal tool-result hint. The SDK only terminates a batch when every result requests it, hence the instruction to call the wait tool alone. Session switch, fork, tree change and shutdown also interrupt an active wait. A late callback cannot write a receipt into a different session. The existing SDK session journal stores pending/elapsed/interrupted receipts; there is no second memory database. Replaying the same journaled tool-call ID is refused. A crash leaves pending as pending, never as success, and reopening does not restart the timer or schedule a model call. The next-check text remains in the durable tool request/result.

This is an in-process wait, not a durable scheduler: the host must remain open and running. It does not claim to prevent requests initiated independently by other extensions or host cache warming. The controlled benchmark already disables cache warming in its private settings; operator-wide settings are unchanged.

## Evidence and limits

Unit tests advance one simulated hour and exercise cancellation, duplicate calls, invalid input, session isolation, lifecycle changes, replay and opt-in exposure. Installed-SDK tests use scripted responses, real timers, a test-owned session, explicit tool allowlisting and cache warming off. They verify no model invocation during the interval, one ordinary continuation after expiry, no continuation after a standalone cancelled wait, intact tool pairing and cold journal readback. These are provider-free protocol checks, not measured billed-token savings or model-quality results.

Existing context-governor behavior is retained: bounded deterministic compaction, complete operator constraints, tool-call/result pairing, source freshness and current-tree verification. No model/effort reduction, shorter benchmark prompt, changed grader, altered timeout, extra retry budget or skipped work is introduced. A token-saving claim still requires paired real-model outcomes: total input/output/cache tokens and failed attempts, elapsed time, and correct completion together.
