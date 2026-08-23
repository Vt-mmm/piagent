import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { benchmarkCausalContextReceipt } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import {
  completedBenchmarkRecord,
  summarizeBenchmarkCausalContextEvidence,
  validBenchmarkCausalContextReceipt
} from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { createBenchmarkTimingCollector } from "../packages/piagent-core/benchmark/benchmark-timing-diagnostics.js";
import {
  appendContextTelemetry,
  contextEnginePaths,
  inspectContextTelemetry
} from "../packages/piagent-core/extensions/context-engine.js";

function notApplicableReceipt() {
  return {
    schemaVersion: 1,
    evidenceSource: "not-applicable",
    applicability: "not-applicable",
    available: false,
    coverage: {
      status: "not-applicable",
      telemetryTruncated: false,
      telemetryIntegrityFailures: 0,
      recoverableTailBytes: 0,
      criterionExpected: false,
      sessionEventsObserved: 0,
      observedLanes: 0,
      requiredLanes: 0,
      missingLanes: []
    },
    aggregates: null
  };
}

function telemetryEvent(event) {
  return { schemaVersion: 2, telemetrySource: "piagent", ...event };
}

function completeEvents(sessionId = "session-a") {
  const selectedItems = [{
    path: "src/private-target.ts",
    estimatedTokens: 80,
    fileContentHash: `context-file-v1:${"a".repeat(64)}`,
    payloadHash: `context-payload-v1:${"b".repeat(64)}`
  }];
  return [
    { event: "session_start", sessionId, editRecoveryContextTelemetryVersion: 1 },
    { event: "turn_task_bound", sessionId, turnId: "turn-private", taskRunId: "run-private" },
    { event: "agent_prompt", sessionId, turnId: "turn-private", managedInstructionsCompacted: true },
    { event: "criterion_context_pack", sessionId, turnId: "turn-private", selected: 1, candidates: 2, estimatedTokens: 100, reasonCode: "selected" },
    { event: "context_pack_offered", sessionId, turnId: "turn-private", deliveryId: "delivery-private", source: "criterion-pack", estimatedTokens: 100, selectedItems },
    { event: "context_delivery_confirmed", sessionId, turnId: "turn-private", deliveryId: "delivery-private", selected: 1 },
    { event: "context_pack_injected", sessionId, turnId: "turn-private", taskRunId: "run-private", injectionId: "delivery-private", source: "criterion-pack", estimatedTokens: 100, selectedItems },
    { event: "tool_call", sessionId, taskRunId: "run-private", toolCallId: "read-private", toolName: "read", targetPath: "src/private-target.ts" },
    { event: "tool_result", sessionId, taskRunId: "run-private", toolCallId: "read-private", toolName: "read", isError: false },
    { event: "agent_settled", sessionId }
  ].map(telemetryEvent);
}

function completedRecord(surface, causalContextReceipt) {
  return {
    schemaVersion: 1,
    runId: "run",
    attemptId: "attempt",
    configurationDigest: "a".repeat(64),
    orderIndex: 1,
    scenarioId: "scenario",
    scenarioTitle: "Scenario",
    scenarioKind: "source-change",
    category: "backend",
    difficulty: "small",
    profile: "node-typescript",
    lifecycle: "steady-state",
    surface,
    repeat: 1,
    infrastructureAttempt: 1,
    infrastructureAttempts: 1,
    sessionId: "session",
    abortSuite: false,
    resolved: true,
    agent: { exitCode: 0, timedOut: false, stdoutHash: "b".repeat(64), stderrHash: "c".repeat(64) },
    grade: { passed: true, score: 10, checks: [] },
    graderIntegrity: { passed: true },
    scope: { passed: true, changedFiles: [], outsideScope: [] },
    outputSafety: { passed: true, forbiddenHits: [] },
    outputEvidence: { passed: true, requiredCount: 0 },
    causalContextReceipt,
    durationSeconds: 1,
    promptHash: "d".repeat(64),
    variant: { generated: false, fixtureDigest: "e".repeat(64) },
    usage: {
      sessions: 1,
      fresh: 10,
      input: 8,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 10,
      cost: null,
      costSource: "unavailable"
    }
  };
}

test("keeps observational timing outside authoritative record acceptance", () => {
  const record = completedRecord("codex-cli", notApplicableReceipt());
  assert.equal(completedBenchmarkRecord(record), true);
  record.timingDiagnostics = { rawPayload: "must-not-affect-paid-result-acceptance" };
  assert.equal(completedBenchmarkRecord(record), true);
  const collector = createBenchmarkTimingCollector({ surface: "codex-cli" });
  collector.write(`${JSON.stringify({ type: "thread.started", thread_id: "timing-thread" })}\n`, 0.05);
  collector.write(`${JSON.stringify({ type: "turn.started" })}\n`, 0.1);
  collector.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, 0.9);
  record.timingDiagnostics = collector.finish(1);
  assert.equal(completedBenchmarkRecord(record), true);
});

test("persists a complete causal aggregate without paths, hashes, prompts, or identifiers", () => {
  const events = [
    ...completeEvents(),
    ...completeEvents("other-session").map((event) => ({ ...event, estimatedTokens: 999_999 }))
  ];
  const receipt = benchmarkCausalContextReceipt(events, { surface: "piagent", sessionId: "session-a" });
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.available, true);
  assert.equal(receipt.coverage.status, "complete");
  assert.deepEqual(receipt.aggregates.packCounts, { offered: 1, delivered: 1, injected: 1 });
  assert.deepEqual(receipt.aggregates.estimatedTokens, { offered: 100, delivered: 100, injected: 100 });
  assert.deepEqual(receipt.aggregates.selectedItemEstimatedTokens, { offered: 80, delivered: 80, injected: 80 });
  assert.equal(receipt.aggregates.criterionInitialPack.attempts, 1);
  assert.deepEqual(receipt.aggregates.directFallbackRereads, {
    successfulCalls: 1,
    shellToolCallsObserved: 0,
    definition: "successful-direct-path-tool-call-v1"
  });
  assert.deepEqual(receipt.aggregates.managedPrefix, { promptsObserved: 1, compactedPrompts: 1, state: "compacted" });
  assert.deepEqual(receipt.aggregates.editRecoveryContext, {
    count: 0,
    failuresObserved: 0,
    suppressedFailures: 0,
    injectedChars: 0,
    injectedEstimatedTokens: 0,
    evidenceCoverage: { status: "complete", observed: 0, comparable: 0, rate: 1 },
    definition: "matched-edit-recovery-context-receipt-v1"
  });
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ["private-target", "delivery-private", "turn-private", "run-private", "context-file-v1", "context-payload-v1", "999999"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(validBenchmarkCausalContextReceipt(receipt, "piagent"), true);
  assert.equal(completedBenchmarkRecord(completedRecord("piagent", receipt)), true);
});

test("aggregates matched edit recovery receipts without folding in failed tool output", () => {
  const events = completeEvents();
  events.splice(-1, 0,
    telemetryEvent({
      event: "edit_recovery_context",
      sessionId: "session-a",
      taskRunId: "run-private",
      toolCallId: "edit-recovery-1",
      targetPath: "src/private-target.ts",
      contentHash: "c".repeat(64),
      originalChars: 300,
      injectedChars: 480,
      injectedEstimatedTokens: 220,
      sensitiveContentRedacted: false
    }),
    telemetryEvent({
      event: "tool_result",
      sessionId: "session-a",
      taskRunId: "run-private",
      toolCallId: "edit-recovery-1",
      toolName: "edit",
      targetPath: "src/private-target.ts",
      isError: true,
      reasonCode: "edit-anchor-stale",
      outputChars: 9_999,
      editRecoveryContext: true,
      editRecoveryInjectedChars: 480,
      editRecoveryEstimatedTokens: 220
    })
  );
  const receipt = benchmarkCausalContextReceipt(events, { surface: "piagent", sessionId: "session-a" });
  assert.equal(receipt.available, true);
  assert.deepEqual(receipt.aggregates.editRecoveryContext, {
    count: 1,
    failuresObserved: 1,
    suppressedFailures: 0,
    injectedChars: 480,
    injectedEstimatedTokens: 220,
    evidenceCoverage: { status: "complete", observed: 1, comparable: 1, rate: 1 },
    definition: "matched-edit-recovery-context-receipt-v1"
  });
  assert.notEqual(receipt.aggregates.editRecoveryContext.injectedChars, 10_479,
    "original failed-tool output is not part of recovery injection totals");
  assert.equal(validBenchmarkCausalContextReceipt(receipt, "piagent"), true);

  const summary = summarizeBenchmarkCausalContextEvidence([
    completedRecord("piagent", receipt),
    completedRecord("piagent", benchmarkCausalContextReceipt(completeEvents("session-b"), { surface: "piagent", sessionId: "session-b" }))
  ], { required: true });
  assert.equal(summary.aggregates.editRecoveryContext.count, 1);
  assert.equal(summary.aggregates.editRecoveryContext.failuresObserved, 1);
  assert.equal(summary.aggregates.editRecoveryContext.suppressedFailures, 0);
  assert.equal(summary.aggregates.editRecoveryContext.injectedChars, 480);
  assert.equal(summary.aggregates.editRecoveryContext.injectedEstimatedTokens, 220);
  assert.deepEqual(summary.aggregates.editRecoveryContext.evidenceCoverage, {
    status: "complete",
    runs: 2,
    comparableRuns: 2,
    rate: 1
  });

  const mismatched = events.map((event) => event.event === "tool_result" && event.toolCallId === "edit-recovery-1"
    ? { ...event, editRecoveryEstimatedTokens: 221 }
    : event);
  const rejected = benchmarkCausalContextReceipt(mismatched, { surface: "piagent", sessionId: "session-a" });
  assert.equal(rejected.available, false);
  assert.ok(rejected.coverage.missingLanes.includes("edit-recovery-context"));
});

test("does not report a genuine zero-recovery lane without a versioned runtime capability marker", () => {
  const legacyLike = completeEvents().filter((event) => event.event !== "session_start");
  const receipt = benchmarkCausalContextReceipt(legacyLike, { surface: "piagent", sessionId: "session-a" });
  assert.equal(receipt.available, false);
  assert.equal(receipt.aggregates, null);
  assert.ok(receipt.coverage.missingLanes.includes("edit-recovery-context"));
});

test("continues to validate already persisted schema-v1 Piagent causal receipts", () => {
  const current = benchmarkCausalContextReceipt(completeEvents(), { surface: "piagent", sessionId: "session-a" });
  const { editRecoveryContext: _recovery, ...legacyAggregates } = current.aggregates;
  const legacy = {
    ...current,
    schemaVersion: 1,
    evidenceSource: "context-telemetry-closed-aggregate-v1",
    coverage: { ...current.coverage, observedLanes: 6, requiredLanes: 6, missingLanes: [] },
    aggregates: legacyAggregates
  };
  assert.equal(validBenchmarkCausalContextReceipt(legacy, "piagent"), true);
  assert.equal(completedBenchmarkRecord(completedRecord("piagent", legacy)), true);
});

test("requires an explicit recovery policy decision for every classified edit-anchor failure", () => {
  const withoutDecision = completeEvents();
  withoutDecision.splice(-1, 0, telemetryEvent({
    event: "tool_result",
    sessionId: "session-a",
    taskRunId: "run-private",
    toolCallId: "edit-suppressed-1",
    toolName: "edit",
    targetPath: "src/private-target.ts",
    isError: true,
    reasonCode: "edit-anchor-stale"
  }));
  const rejected = benchmarkCausalContextReceipt(withoutDecision, { surface: "piagent", sessionId: "session-a" });
  assert.equal(rejected.available, false);
  assert.ok(rejected.coverage.missingLanes.includes("edit-recovery-context"));

  const classified = withoutDecision.map((event) => event.toolCallId === "edit-suppressed-1"
    ? { ...event, editRecoveryContext: false }
    : event);
  const accepted = benchmarkCausalContextReceipt(classified, { surface: "piagent", sessionId: "session-a" });
  assert.equal(accepted.available, true);
  assert.equal(accepted.aggregates.editRecoveryContext.count, 0);
  assert.equal(accepted.aggregates.editRecoveryContext.failuresObserved, 1);
  assert.equal(accepted.aggregates.editRecoveryContext.suppressedFailures, 1);
});

test("context telemetry seals its provenance envelope after applying event fields", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-causal-envelope-"));
  try {
    const record = appendContextTelemetry(cwd, {
      schemaVersion: 999,
      telemetrySource: "attacker",
      source: "criterion-pack",
      event: "agent_prompt",
      sessionId: "session-a"
    });
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.telemetrySource, "piagent");
    assert.equal(record.source, "criterion-pack", "domain-specific source remains separate from envelope provenance");
    const inspection = inspectContextTelemetry(cwd, { limit: 10 });
    assert.equal(inspection.records[0].telemetrySource, "piagent");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("treats a fully observed zero-selection criterion attempt as measured zero", () => {
  const receipt = benchmarkCausalContextReceipt([
    telemetryEvent({ event: "session_start", sessionId: "session-zero", editRecoveryContextTelemetryVersion: 1 }),
    telemetryEvent({ event: "agent_prompt", sessionId: "session-zero", turnId: "turn-zero", managedInstructionsCompacted: false }),
    telemetryEvent({ event: "criterion_context_pack", sessionId: "session-zero", turnId: "turn-zero", selected: 0, candidates: 0, estimatedTokens: 0, reasonCode: "no-candidates" }),
    telemetryEvent({ event: "agent_settled", sessionId: "session-zero" })
  ], { surface: "piagent", sessionId: "session-zero" });
  assert.equal(receipt.available, true);
  assert.deepEqual(receipt.aggregates.packCounts, { offered: 0, delivered: 0, injected: 0 });
  assert.equal(receipt.aggregates.criterionInitialPack.zeroSelectionReasonCounts.noCandidates, 1);
  assert.equal(receipt.aggregates.managedPrefix.state, "uncompacted");
});

test("rejects forged envelopes, stale terminal events, mismatched packs, and orphan offers", () => {
  const forged = completeEvents();
  forged[1] = { ...forged[1], schemaVersion: 999, telemetrySource: "attacker" };
  const forgedReceipt = benchmarkCausalContextReceipt(forged, { surface: "piagent", sessionId: "session-a" });
  assert.equal(forgedReceipt.available, false);
  assert.equal(forgedReceipt.coverage.telemetryIntegrityFailures, 1);
  assert.ok(forgedReceipt.coverage.missingLanes.includes("telemetry-window"));

  const staleTerminal = completeEvents().filter((event) => event.event !== "agent_settled");
  staleTerminal.unshift(telemetryEvent({ event: "agent_settled", sessionId: "session-a" }));
  const staleReceipt = benchmarkCausalContextReceipt(staleTerminal, { surface: "piagent", sessionId: "session-a" });
  assert.equal(staleReceipt.available, false);
  assert.ok(staleReceipt.coverage.missingLanes.includes("session-lifecycle"));

  const mismatched = completeEvents();
  const injectionIndex = mismatched.findIndex((event) => event.event === "context_pack_injected");
  mismatched[injectionIndex] = {
    ...mismatched[injectionIndex],
    source: "auto-pack",
    selectedItems: [{ ...mismatched[injectionIndex].selectedItems[0], path: "src/other.ts" }]
  };
  const mismatchReceipt = benchmarkCausalContextReceipt(mismatched, { surface: "piagent", sessionId: "session-a" });
  assert.equal(mismatchReceipt.available, false);
  assert.ok(mismatchReceipt.coverage.missingLanes.includes("pack-lifecycle"));

  const orphan = completeEvents().filter((event) => !["context_delivery_confirmed", "context_pack_injected"].includes(event.event));
  const orphanReceipt = benchmarkCausalContextReceipt(orphan, { surface: "piagent", sessionId: "session-a" });
  assert.equal(orphanReceipt.available, false);
  assert.ok(orphanReceipt.coverage.missingLanes.includes("pack-lifecycle"));
});

test("counts every successful direct fallback reread and exposes shell-call blind spots", () => {
  const events = completeEvents();
  events.splice(-1, 0,
    telemetryEvent({ event: "tool_call", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-repeat", toolName: "read", targetPath: "src/private-target.ts" }),
    telemetryEvent({ event: "tool_decision", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-repeat", toolName: "read", decision: "allowed" }),
    telemetryEvent({ event: "tool_result", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-repeat", toolName: "read", isError: false }),
    telemetryEvent({ event: "tool_call", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-blocked", toolName: "read", targetPath: "src/private-target.ts" }),
    telemetryEvent({ event: "tool_decision", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-blocked", toolName: "read", decision: "blocked" }),
    telemetryEvent({ event: "tool_call", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-failed", toolName: "grep", targetPath: "src/private-target.ts" }),
    telemetryEvent({ event: "tool_result", sessionId: "session-a", taskRunId: "run-private", toolCallId: "read-failed", toolName: "grep", isError: true }),
    telemetryEvent({ event: "tool_call", sessionId: "session-a", taskRunId: "run-private", toolCallId: "shell-one", toolName: "bash", command: "sed -n 1,20p src/private-target.ts" })
  );
  const receipt = benchmarkCausalContextReceipt(events, { surface: "piagent", sessionId: "session-a" });
  assert.equal(receipt.available, true);
  assert.deepEqual(receipt.aggregates.directFallbackRereads, {
    successfulCalls: 2,
    shellToolCallsObserved: 1,
    definition: "successful-direct-path-tool-call-v1"
  });
});

test("fails closed for truncated, malformed, or unmatched telemetry instead of reporting zero", () => {
  const truncated = benchmarkCausalContextReceipt(completeEvents(), {
    surface: "piagent",
    sessionId: "session-a",
    telemetryTruncated: true
  });
  assert.equal(truncated.available, false);
  assert.equal(truncated.aggregates, null);
  assert.ok(truncated.coverage.missingLanes.includes("telemetry-window"));

  const unmatched = benchmarkCausalContextReceipt(completeEvents().filter((event) => event.event !== "context_delivery_confirmed"), {
    surface: "piagent",
    sessionId: "session-a"
  });
  assert.equal(unmatched.available, false);
  assert.equal(unmatched.aggregates, null);
  assert.ok(unmatched.coverage.missingLanes.includes("pack-lifecycle"));

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-causal-context-"));
  try {
    const telemetryPath = contextEnginePaths(cwd).telemetry;
    fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
    fs.writeFileSync(telemetryPath, `${JSON.stringify({ event: "agent_prompt", sessionId: "session-a" })}\n{malformed}\n`, { mode: 0o600 });
    const inspection = inspectContextTelemetry(cwd, { limit: 100 });
    assert.equal(inspection.exists, true);
    assert.equal(inspection.integrityFailures, 1);
    const malformed = benchmarkCausalContextReceipt(inspection.records, {
      surface: "piagent",
      sessionId: "session-a",
      telemetryExists: inspection.exists,
      telemetryTruncated: inspection.inputTruncated,
      telemetryIntegrityFailures: inspection.integrityFailures,
      recoverableTailBytes: inspection.recoverableTailBytes
    });
    assert.equal(malformed.available, false);
    assert.equal(malformed.aggregates, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("accepts the exact non-Pi sentinel and rejects unavailable Pi evidence as complete", () => {
  const sentinel = notApplicableReceipt();
  assert.equal(validBenchmarkCausalContextReceipt(sentinel, "codex-cli"), true);
  assert.equal(completedBenchmarkRecord(completedRecord("codex-cli", sentinel)), true);
  assert.equal(validBenchmarkCausalContextReceipt(sentinel, "piagent"), false);

  const unavailable = benchmarkCausalContextReceipt([], {
    surface: "piagent",
    sessionId: "session-a",
    telemetryExists: false
  });
  assert.equal(validBenchmarkCausalContextReceipt(unavailable, "piagent"), true);
  assert.equal(unavailable.available, false);
  assert.equal(completedBenchmarkRecord(completedRecord("piagent", unavailable)), true,
    "paid records remain ledger-valid even when the stage/claim gate must fail");
});
