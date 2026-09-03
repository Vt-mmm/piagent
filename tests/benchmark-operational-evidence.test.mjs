import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkOperationalEvidence,
  classifyPreUsageFailure,
  createBenchmarkTransportCircuit,
  observeBenchmarkTransportFailure,
  validBenchmarkTransportCircuit,
  terminalPiSessionError
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";

test("derives bounded operational evidence from complete context telemetry", () => {
  const evidence = benchmarkOperationalEvidence([
    { event: "agent_prompt" },
    { event: "trajectory_transition", from: "intake", to: "execute" },
    { event: "tool_call", toolCallId: "call-1", toolName: "read" },
    { event: "tool_decision", toolCallId: "call-1", toolName: "read", decision: "allowed" },
    { event: "tool_result", toolCallId: "call-1", toolName: "read", outputChars: 120, repeated: false, compacted: false },
    { event: "tool_call", toolCallId: "call-2", toolName: "edit" },
    { event: "tool_decision", toolCallId: "call-2", decision: "blocked" },
    { event: "completion_recovery_scheduled", taskRunId: "run-1", attempt: 1, progressSignature: "a" },
    { event: "performance_review_scheduled", taskRunId: "run-1", attempt: 1, progressSignature: "b" }
  ]);
  assert.deepEqual(evidence, {
    evidenceSource: "context-telemetry",
    available: true,
    toolCallsObserved: 2,
    toolDecisionsObserved: 2,
    systemContinuations: 2,
    shadowAdvisoryAddedContinuations: 1,
    blockedToolCalls: 1,
    blockedInvalidCallsConfirmed: 0,
    blockedDecisionClasses: { unclassified: 1 },
    blockedValidCallsUpperBound: 1,
    phaseAttributionAvailable: true,
    phaseAttribution: {
      schemaVersion: 1,
      available: true,
      promptsObserved: 1,
      promptsByPhase: { intake: 1 },
      toolCallsByPhase: { execute: { mutation: 1, read: 1 } },
      transitions: { "intake->execute": 1 },
      toolResultsObserved: 1,
      toolResultErrors: 0,
      repeatedToolResults: 0,
      compactedToolResults: 0,
      outputCharsObserved: 120
    }
  });
});

test("attributes result churn by closed phase and tool classes without retaining commands or paths", () => {
  const evidence = benchmarkOperationalEvidence([
    { event: "agent_prompt", promptHash: "private" },
    { event: "trajectory_transition", from: "intake", to: "execute", cause: "task-start" },
    { event: "tool_call", toolCallId: "a", toolName: "bash", command: "secret command" },
    { event: "tool_decision", toolCallId: "a", toolName: "bash", decision: "allowed" },
    { event: "tool_result", toolCallId: "a", toolName: "bash", exitCodeExact: true, exitCode: 1, outputChars: 900, compacted: true },
    { event: "trajectory_transition", from: "execute", to: "verify" },
    { event: "agent_prompt" },
    { event: "tool_call", toolCallId: "b", toolName: "grep", targetPath: "secret/path" },
    { event: "tool_decision", toolCallId: "b", toolName: "grep", decision: "allowed" },
    { event: "tool_result", toolCallId: "b", toolName: "grep", outputChars: 40, repeated: true }
  ]);
  assert.deepEqual(evidence.phaseAttribution, {
    schemaVersion: 1,
    available: true,
    promptsObserved: 2,
    promptsByPhase: { intake: 1, verify: 1 },
    toolCallsByPhase: { execute: { shell: 1 }, verify: { search: 1 } },
    transitions: { "execute->verify": 1, "intake->execute": 1 },
    toolResultsObserved: 2,
    toolResultErrors: 1,
    repeatedToolResults: 1,
    compactedToolResults: 1,
    outputCharsObserved: 940
  });
  const serialized = JSON.stringify(evidence.phaseAttribution);
  assert.doesNotMatch(serialized, /secret|command|path|promptHash/);
});

test("excludes only policy blocks proven invalid by a closed reason class", () => {
  const evidence = benchmarkOperationalEvidence([
    { event: "tool_call", toolCallId: "call-scope" },
    { event: "tool_decision", toolCallId: "call-scope", decision: "blocked", reason: "Path is outside the allowed task scope." },
    { event: "tool_call", toolCallId: "call-phase" },
    { event: "tool_decision", toolCallId: "call-phase", decision: "blocked", reason: "Current phase verify does not allow edit." }
  ]);
  assert.equal(evidence.blockedToolCalls, 2);
  assert.equal(evidence.blockedInvalidCallsConfirmed, 1);
  assert.deepEqual(evidence.blockedDecisionClasses, { "scope-invalid": 1, unclassified: 1 });
  assert.equal(evidence.blockedValidCallsUpperBound, 1, "phase and unknown blocks remain fail-closed");
});

test("fails closed when any observed tool call lacks its decision", () => {
  const evidence = benchmarkOperationalEvidence([
    { event: "tool_call", toolCallId: "call-1" },
    { event: "completion_recovery_scheduled", taskRunId: "run-1", attempt: 1, progressSignature: "a" }
  ]);
  assert.equal(evidence.available, false);
  assert.equal(evidence.systemContinuations, null);
  assert.equal(evidence.blockedInvalidCallsConfirmed, null);
  assert.equal(evidence.blockedDecisionClasses, null);
  assert.equal(evidence.blockedValidCallsUpperBound, null);
  assert.equal(evidence.phaseAttributionAvailable, false);
});

test("classifies only a terminal Pi overload after paid usage as infrastructure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-terminal-provider-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const sessionId = "root-session";
  const error = "Codex error: Our servers are currently overloaded. Please try again later.";
  const write = (messages) => fs.writeFileSync(file, [
    { type: "session", id: sessionId },
    ...messages.map((message) => ({ type: "message", message }))
  ].map(JSON.stringify).join("\n") + "\n");
  write([
    { role: "assistant", content: [], stopReason: "toolUse" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: error }
  ]);
  assert.equal(terminalPiSessionError([file], sessionId), error);
  assert.deepEqual(classifyPreUsageFailure(
    { code: 0, timedOut: false },
    { sessions: 1, input: 20, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 1, total: 25, fresh: 25,
      usageCompleteness: "exact", cost: 0.002 },
    error,
    { terminalProviderError: true }
  ), {
    failure: "provider-temporarily-unavailable-after-measured-usage",
    class: "provider-infrastructure",
    usageStatus: "measured-but-unaccepted",
    retryable: false
  });
  write([
    { role: "assistant", content: [], stopReason: "error", errorMessage: error },
    { role: "assistant", content: [{ type: "text", text: "completed" }], stopReason: "stop" }
  ]);
  assert.equal(terminalPiSessionError([file], sessionId), undefined, "a recovered transient error is not terminal");
});

test("keeps exact token evidence independent from cost and never retries a paid process exit", () => {
  const usage = { sessions: 1, input: 60, output: 15, cacheRead: 20, cacheWrite: 5, reasoning: 4, total: 100,
    fresh: 75, usageCompleteness: "exact", cost: null };
  assert.deepEqual(classifyPreUsageFailure({ code: 1, timedOut: false }, usage, "process ended"), {
    failure: "agent-exit-1-after-measured-usage",
    class: "agent-process",
    usageStatus: "measured-but-unaccepted",
    retryable: false
  });
  assert.deepEqual(classifyPreUsageFailure({ code: 1, timedOut: false }, usage, "provider safety policy refusal"), {
    failure: "provider-policy-refusal-after-measured-usage",
    class: "provider-policy",
    usageStatus: "measured-but-unaccepted",
    retryable: false
  });
  assert.equal(classifyPreUsageFailure({ code: 1, timedOut: false }, { ...usage, total: 99 }, "process ended").usageStatus, "unknown-after-provider-start");
});

test("accepts only an exact positive-usage structured lifecycle mismatch as a candidate outcome", () => {
  const usage = { sessions: 1, input: 60, output: 15, cacheRead: 20, cacheWrite: 5, reasoning: 4, total: 100,
    fresh: 75, usageCompleteness: "exact", cost: null };
  const candidateOutcome = { schemaVersion: 2, kind: "terminal-lifecycle-mismatch",
    expectedOperationStatus: "completed", observedOperationStatus: "blocked",
    expectedTaskStatus: "completed", observedTaskStatus: "pending", turnIndex: 2 };
  assert.equal(classifyPreUsageFailure({ code: 1, timedOut: false }, usage, "webui blocked", { candidateOutcome }), undefined);
  assert.equal(classifyPreUsageFailure({ code: 1, timedOut: false }, usage, "webui refusal incomplete", {
    candidateOutcome: { ...candidateOutcome, observedOperationStatus: "completed",
      expectedTaskStatus: "refused", observedTaskStatus: "completed", turnIndex: 1 }
  }), undefined);
  assert.deepEqual(classifyPreUsageFailure({ code: 1, timedOut: false },
    { ...usage, usageCompleteness: "unverified" }, "webui blocked", { candidateOutcome }), {
    failure: "agent-exit-1-after-measured-usage",
    class: "agent-process",
    usageStatus: "measured-lower-bound",
    retryable: false
  });
  assert.deepEqual(classifyPreUsageFailure({ code: 1, timedOut: false }, usage, "transport closed"), {
    failure: "agent-exit-1-after-measured-usage",
    class: "agent-process",
    usageStatus: "measured-but-unaccepted",
    retryable: false
  });
});

test("classifies fetch failures without erasing exact or lower-bound provider usage", () => {
  const exact = { sessions: 1, input: 60, output: 15, cacheRead: 20, cacheWrite: 5, reasoning: 0, total: 100,
    fresh: 75, usageCompleteness: "exact", reasoningCompleteness: "lower-bound", cost: null };
  assert.deepEqual(classifyPreUsageFailure(
    { code: 0, timedOut: false }, exact, "TypeError: fetch failed", { terminalProviderError: true }
  ), {
    failure: "provider-fetch-failed-after-measured-usage",
    class: "provider-transport",
    usageStatus: "measured-but-unaccepted",
    retryable: false
  });

  const partial = { ...exact, usageCompleteness: "unverified" };
  assert.deepEqual(classifyPreUsageFailure(
    { code: 1, timedOut: false }, partial, "cause: ECONNRESET"
  ), {
    failure: "provider-fetch-failed-after-measured-usage",
    class: "provider-transport",
    usageStatus: "measured-lower-bound",
    retryable: false
  });

  const zero = { ...exact, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, fresh: 0 };
  assert.deepEqual(classifyPreUsageFailure(
    { code: 0, timedOut: false }, zero, "fetch failed", { terminalProviderError: true }
  ), {
    failure: "provider-fetch-failed-with-zero-measured-usage",
    class: "provider-transport",
    usageStatus: "unknown-after-provider-start",
    retryable: false
  });

  assert.deepEqual(classifyPreUsageFailure(
    { code: 1, timedOut: false }, { sessions: 0, usageCompleteness: "unavailable" }, "fetch failed"
  ), {
    failure: "provider-fetch-failed-with-usage-unavailable",
    class: "provider-transport",
    usageStatus: "unknown-after-provider-start",
    retryable: false
  });
});

test("retains readable token lower bounds when strict Pi session parsing fails", () => {
  const partial = { sessions: 1, input: 60, output: 15, cacheRead: 20, cacheWrite: 5, reasoning: 0, total: 100,
    fresh: 75, usageCompleteness: "unverified", cost: null };
  assert.deepEqual(classifyPreUsageFailure(
    { code: 0, timedOut: false }, partial, "usage.cacheWrite missing", { usageParsingError: true }
  ), {
    failure: "pi-session-usage-incomplete-after-provider-start",
    class: "usage-accounting",
    usageStatus: "measured-lower-bound",
    retryable: false
  });
});

test("opens the run-wide transport circuit after two incidents and preserves it across reload", () => {
  const first = observeBenchmarkTransportFailure(createBenchmarkTransportCircuit(), {
    infrastructureClass: "provider-transport",
    orderIndex: 1,
    scenarioId: "first",
    surface: "piagent",
    repeat: 1,
    infrastructureAttempt: 1,
    infrastructureFailure: "provider-fetch-failed-with-zero-measured-usage"
  });
  assert.equal(first.state, "closed");
  assert.equal(first.failures, 1);

  const reloaded = JSON.parse(JSON.stringify(first));
  assert.equal(validBenchmarkTransportCircuit(reloaded), true);
  const second = observeBenchmarkTransportFailure(reloaded, {
    infrastructureClass: "provider-infrastructure",
    orderIndex: 4,
    scenarioId: "second",
    surface: "codex-cli",
    repeat: 1,
    infrastructureAttempt: 1,
    infrastructureFailure: "provider-temporarily-unavailable-with-zero-measured-usage"
  });
  assert.equal(second.state, "open");
  assert.equal(second.failures, 2);
  assert.equal(validBenchmarkTransportCircuit(JSON.parse(JSON.stringify(second))), true);
  assert.deepEqual(second.lastFailure, {
    orderIndex: 4,
    scenarioId: "second",
    surface: "codex-cli",
    repeat: 1,
    infrastructureAttempt: 1,
    failure: "provider-temporarily-unavailable-with-zero-measured-usage"
  });

  assert.equal(observeBenchmarkTransportFailure(second, {
    infrastructureClass: "provider-policy",
    orderIndex: 5
  }), second, "non-transport failures do not consume the circuit budget");
  assert.equal(validBenchmarkTransportCircuit({ ...second, failures: 1 }), false, "open state cannot be rolled back by malformed persistence");
});

test("keeps timeout usage as a lower bound and never treats it as exact", () => {
  const usage = { sessions: 1, input: 60, output: 15, cacheRead: 20, cacheWrite: 5, reasoning: 4, total: 100,
    fresh: 75, usageCompleteness: "exact", cost: null };
  assert.deepEqual(classifyPreUsageFailure({ code: 1, timedOut: true }, usage, "webui-journey-timeout", {
    candidateOutcome: { schemaVersion: 1, kind: "terminal-settlement-mismatch",
      expectedSettlement: "completed", observedSettlement: "blocked", turnIndex: 2 }
  }), {
    failure: "agent-timeout-after-observed-usage",
    class: "transport-timeout",
    usageStatus: "measured-lower-bound",
    retryable: false
  });
});
