import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditToolProtocol,
  minimumContextSavingsTokens,
  projectAdaptiveContext
} from "../../packages/piagent-core/runtime/session/adaptive-context-governor.ts";
import {
  BoundedEmissionGuard,
  runtimeEventEmissionCandidate
} from "../../packages/piagent-core/runtime/inspection/bounded-emission-guard.ts";
import { EditFreshnessGuard } from "../../packages/piagent-core/runtime/quality/edit-freshness-guard.ts";
import {
  SessionOperationLifecycle,
  sessionOperationRetryPolicy
} from "../../packages/piagent-webui/gateway/session-operation-lifecycle.ts";

const laneRoot = path.dirname(fileURLToPath(import.meta.url));
const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "lane.json"), "utf8"));
const argumentsList = process.argv.slice(2);
const option = (name) => {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
};
const outputArgument = option("--output");
if (argumentsList.includes("--output") && !outputArgument) throw new Error("--output requires a path");
const outputPath = outputArgument ? path.resolve(outputArgument) : null;
const startedAtMs = Date.now();
let timestamp = 1;

function user(text) {
  return { role: "user", content: text, timestamp: timestamp++ };
}

function toolRound(id, name, args, output) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name, arguments: args }],
      timestamp: timestamp++
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: output }],
      isError: false,
      timestamp: timestamp++
    }
  ];
}

function task() {
  return {
    taskId: "runtime-conformance",
    taskRunId: "runtime-conformance-run-1",
    summary: "Implement a frontend contract without changing backend behavior.",
    riskLane: "normal",
    acceptanceCriteria: ["Preserve behavior", "Pass focused verification"],
    scope: ["src/**"],
    outOfScope: ["backend mutation"],
    changedFiles: ["src/page.tsx"],
    verifyCommands: ["node --test"],
    trace: { outcome: "pending" }
  };
}

function boundedCandidate(text, updateKey, reference) {
  return {
    channel: "reviewer",
    identityKey: "runtime-conformance-reviewer",
    updateKey,
    text,
    actionable: true,
    reference
  };
}

function finalMessageCandidate() {
  return runtimeEventEmissionCandidate({
    kind: "message.completed",
    sessionRef: "runtime-conformance-session",
    taskRunId: "runtime-conformance-run-1",
    agentOperationId: "runtime-conformance-operation",
    turnIndex: 1,
    toolCallId: null,
    revision: { runtimeRevision: "runtime-revision-1" },
    payload: { role: "assistant", textPreview: "Final response remains visible." }
  }, "message-final");
}

const results = [];
const metrics = {
  context: {
    projections: 0,
    noops: 0,
    estimatedSavingsTokens: 0,
    governorProviderCalls: 0,
    toolProtocolOrphans: 0
  },
  operations: {
    pristineRetriesAllowed: 0,
    unsafeRetriesAllowed: 0,
    unsafeRetriesAborted: 0,
    terminalSettlements: 0,
    duplicateTerminalSettlements: 0,
    lateEventsIgnored: 0,
    compactionRetryBudgetConsumed: 0
  },
  emissions: {
    accepted: 0,
    suppressed: 0,
    retained: 0,
    finalMessagesSuppressed: 0
  },
  edits: {
    staleEvaluations: 0,
    staleMutationsAllowed: 0,
    freshRereadRecoveries: 0
  }
};

function runCase(id, area, execute) {
  const caseStartedAt = Date.now();
  try {
    const evidence = execute() ?? {};
    results.push({ id, area, status: "passed", durationMilliseconds: Date.now() - caseStartedAt, evidence });
  } catch (error) {
    results.push({
      id,
      area,
      status: "failed",
      durationMilliseconds: Date.now() - caseStartedAt,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

runCase("context-small-passthrough", "adaptive-context-governor", () => {
  const messages = [user("Implement src/cart.ts"), ...toolRound("small-read", "read", { path: "src/cart.ts" }, "export const cart = true;")];
  const projection = projectAdaptiveContext(messages, {
    reportedTokens: 9_000,
    contextWindow: 400_000,
    task: task()
  });
  assert.equal(projection.decision.action, "passthrough");
  assert.equal(projection.messages, messages);
  assert.equal(projection.decision.accounting.billedTraffic.governorProviderCalls, 0);
  metrics.context.governorProviderCalls += projection.decision.accounting.billedTraffic.governorProviderCalls;
  return { action: projection.decision.action, originalMessages: messages.length };
});

runCase("context-insufficient-savings-noop", "adaptive-context-governor", () => {
  const messages = [user("Continue the same implementation")];
  for (let index = 0; index < 8; index += 1) {
    messages.push(...toolRound(`noop-${index}`, "read", { path: `src/noop-${index}.ts` }, "x".repeat(6_000)));
  }
  const projection = projectAdaptiveContext(messages, {
    reportedTokens: 250_000,
    contextWindow: 400_000,
    task: task()
  });
  assert.equal(projection.decision.action, "passthrough");
  assert.equal(projection.decision.fallback, "insufficient-savings");
  assert.equal(projection.messages, messages);
  assert.ok(projection.decision.estimatedSavingsTokens < projection.decision.minimumSavingsTokens);
  assert.equal(
    projection.decision.minimumSavingsTokens,
    minimumContextSavingsTokens(projection.decision.originalMessageTokens)
  );
  assert.equal(projection.decision.accounting.billedTraffic.governorProviderCalls, 0);
  metrics.context.noops += 1;
  metrics.context.governorProviderCalls += projection.decision.accounting.billedTraffic.governorProviderCalls;
  return {
    action: projection.decision.action,
    fallback: projection.decision.fallback,
    candidateSavingsTokens: projection.decision.estimatedSavingsTokens,
    minimumSavingsTokens: projection.decision.minimumSavingsTokens
  };
});

runCase("context-projection-protocol-safe", "adaptive-context-governor", () => {
  const messages = [user("Scout the backend subscription contract")];
  for (let index = 0; index < 14; index += 1) {
    messages.push(...toolRound(
      `project-${index}`,
      "read",
      { path: `backend/src/module-${index}.ts` },
      `source-${index}\n${"x".repeat(5_000)}`
    ));
  }
  messages.push(user("Proceed to implement the frontend subscription mapping"));
  const projection = projectAdaptiveContext(messages, {
    reportedTokens: 92_000,
    contextWindow: 400_000,
    task: task()
  });
  const protocol = auditToolProtocol(projection.messages);
  assert.equal(projection.decision.action, "project");
  assert.equal(projection.decision.reason, "semantic-boundary");
  assert.equal(protocol.intact, true);
  assert.equal(protocol.orphanCallIds.length + protocol.orphanResultIds.length, 0);
  assert.ok(projection.decision.estimatedSavingsTokens >= projection.decision.minimumSavingsTokens);
  assert.match(String(projection.messages.at(-1)?.content ?? ""), /implement the frontend subscription mapping/i);
  assert.equal(projection.decision.accounting.billedTraffic.governorProviderCalls, 0);
  metrics.context.projections += 1;
  metrics.context.estimatedSavingsTokens += projection.decision.estimatedSavingsTokens;
  metrics.context.governorProviderCalls += projection.decision.accounting.billedTraffic.governorProviderCalls;
  metrics.context.toolProtocolOrphans += protocol.orphanCallIds.length + protocol.orphanResultIds.length;
  return {
    action: projection.decision.action,
    reason: projection.decision.reason,
    originalMessageTokens: projection.decision.originalMessageTokens,
    projectedMessageTokens: projection.decision.projectedMessageTokens,
    estimatedSavingsTokens: projection.decision.estimatedSavingsTokens,
    savingsRatio: projection.decision.savingsRatio,
    toolProtocolIntact: protocol.intact
  };
});

runCase("context-orphan-protocol-fail-closed", "adaptive-context-governor", () => {
  const messages = [user("Continue implementation")];
  for (let index = 0; index < 8; index += 1) {
    messages.push(...toolRound(`valid-${index}`, "read", { path: `src/valid-${index}.ts` }, "x".repeat(6_000)));
  }
  messages.push({
    role: "toolResult",
    toolCallId: "missing-call",
    toolName: "read",
    content: [{ type: "text", text: "orphan result" }],
    timestamp: timestamp++
  });
  messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id: "missing-result", name: "read", arguments: { path: "src/missing.ts" } }],
    timestamp: timestamp++
  });
  const sourceProtocol = auditToolProtocol(messages);
  const projection = projectAdaptiveContext(messages, {
    reportedTokens: 250_000,
    contextWindow: 400_000,
    task: task()
  });
  assert.equal(sourceProtocol.intact, false);
  assert.equal(projection.decision.action, "passthrough");
  assert.equal(projection.decision.fallback, "unsafe-tool-protocol");
  assert.equal(projection.messages, messages);
  assert.ok(projection.decision.reasonCodes.includes("unsafe-tool-protocol"));
  assert.equal(projection.decision.accounting.billedTraffic.governorProviderCalls, 0);
  metrics.context.noops += 1;
  metrics.context.governorProviderCalls += projection.decision.accounting.billedTraffic.governorProviderCalls;
  return {
    sourceOrphanCalls: sourceProtocol.orphanCallIds.length,
    sourceOrphanResults: sourceProtocol.orphanResultIds.length,
    projected: false,
    fallback: projection.decision.fallback
  };
});

runCase("operation-pristine-retry-bounded", "webui-operation-lifecycle", () => {
  assert.deepEqual(sessionOperationRetryPolicy(), { maximumAttempts: 1, maximumDelayMs: 8_000 });
  const lifecycle = new SessionOperationLifecycle({ operationRef: "operation-pristine" });
  lifecycle.observe({ type: "agent_start", operationRef: "operation-pristine" });
  const first = lifecycle.observe({
    type: "auto_retry_start",
    operationRef: "operation-pristine",
    attempt: 1,
    delayMs: 100
  });
  assert.equal(first.retry, "allowed");
  metrics.operations.pristineRetriesAllowed += 1;
  lifecycle.observe({ type: "auto_retry_end", operationRef: "operation-pristine", attempt: 1, success: false });
  const second = lifecycle.observe({
    type: "auto_retry_start",
    operationRef: "operation-pristine",
    attempt: 2,
    delayMs: 100
  });
  assert.equal(second.retry, "abort");
  assert.equal(second.reasonCode, "automatic-retry-attempt-limit");
  return { maximumAttempts: lifecycle.retryPolicy.maximumAttempts, firstRetry: first.retry, secondRetry: second.retry };
});

runCase("operation-replay-unsafe-and-exactly-once", "webui-operation-lifecycle", () => {
  const visible = new SessionOperationLifecycle({ operationRef: "operation-visible" });
  visible.observe({ type: "agent_start" });
  visible.observe({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "Visible output" }] },
    assistantMessageEvent: { type: "text_delta", delta: "Visible output" }
  });
  const visibleRetry = visible.observe({ type: "auto_retry_start", attempt: 1, delayMs: 0 });
  assert.equal(visibleRetry.retry, "abort");
  assert.equal(visibleRetry.reasonCode, "automatic-retry-replay-unsafe");

  const tool = new SessionOperationLifecycle({ operationRef: "operation-tool" });
  tool.observe({ type: "agent_start" });
  tool.observe({ type: "tool_execution_start", toolCallId: "write-1", toolName: "write" });
  const toolRetry = tool.observe({ type: "auto_retry_start", attempt: 1, delayMs: 0 });
  assert.equal(toolRetry.retry, "abort");
  assert.equal(toolRetry.reasonCode, "automatic-retry-replay-unsafe");
  metrics.operations.unsafeRetriesAborted += 2;

  assert.equal(tool.markTerminal(), true);
  metrics.operations.terminalSettlements += 1;
  const duplicateTerminal = tool.markTerminal();
  assert.equal(duplicateTerminal, false);
  if (duplicateTerminal) metrics.operations.duplicateTerminalSettlements += 1;
  const late = tool.observe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });
  assert.equal(late.accepted, false);
  assert.equal(late.reasonCode, "operation-event-after-settlement");
  metrics.operations.lateEventsIgnored += 1;
  return {
    visibleRetry: visibleRetry.retry,
    toolRetry: toolRetry.retry,
    terminalSettlements: 1,
    duplicateTerminalSettlements: 0,
    lateEvent: late.reasonCode
  };
});

runCase("operation-compaction-isolated", "webui-operation-lifecycle", () => {
  const lifecycle = new SessionOperationLifecycle({ operationRef: "operation-compaction" });
  lifecycle.observe({ type: "agent_start" });
  const start = lifecycle.observe({ type: "compaction_start", reason: "overflow" });
  assert.equal(start.phase, "compaction");
  const summarization = lifecycle.observe({ type: "summarization_retry_scheduled", attempt: 1, delayMs: 5 });
  assert.equal(summarization.accepted, true);
  assert.equal(summarization.retry, "none");
  const end = lifecycle.observe({ type: "compaction_end", reason: "overflow" });
  assert.equal(end.phase, "running");
  const providerRetry = lifecycle.observe({ type: "auto_retry_start", attempt: 1, delayMs: 5 });
  assert.equal(providerRetry.retry, "allowed");
  metrics.operations.pristineRetriesAllowed += 1;
  return { compactionPhase: start.phase, summarizationRetry: summarization.retry, providerRetry: providerRetry.retry };
});

runCase("emission-bounded-final-preserved", "bounded-emission-guard", () => {
  const guard = new BoundedEmissionGuard({ capacity: 2 });
  const filler = guard.inspect(boundedCandidate("No issue; continue.", "update-0", "review-0"));
  assert.equal(filler.reason, "filler");

  const first = boundedCandidate("Potential race in queue.", "update-1", "review-1");
  assert.equal(guard.inspect(first).accepted, true);
  guard.recordAccepted(first);
  assert.equal(guard.inspect(boundedCandidate("Potential race in queue.", "update-2", "review-2")).reason, "duplicate-exact");
  assert.equal(guard.inspect(boundedCandidate("potential RACE in queue!", "update-3", "review-3")).reason, "duplicate-normalized");

  const second = boundedCandidate("Mutation lacks a verifier.", "update-4", "review-4");
  assert.equal(guard.inspect(second).accepted, true);
  guard.recordAccepted(second);
  const third = boundedCandidate("Late activity remains bounded.", "update-5", "review-5");
  assert.equal(guard.inspect(third).accepted, true);
  guard.recordAccepted(third);

  const telemetry = guard.telemetry();
  assert.equal(telemetry.retained, 2);
  assert.equal(finalMessageCandidate(), null, "final assistant messages must bypass suppression");
  metrics.emissions.accepted += telemetry.accepted;
  metrics.emissions.suppressed += telemetry.suppressed;
  metrics.emissions.retained = telemetry.retained;
  return {
    capacity: telemetry.capacity,
    retained: telemetry.retained,
    accepted: telemetry.accepted,
    suppressed: telemetry.suppressed,
    suppressedByReason: telemetry.suppressedByReason,
    finalMessageBypassesGuard: true
  };
});

runCase("edit-stale-blocked-until-reread", "edit-freshness-guard", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-conformance-edit-"));
  try {
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    const target = path.join(cwd, "src", "value.ts");
    fs.writeFileSync(target, "export const value = 1;\n");
    const ctx = { cwd, sessionManager: { getSessionId: () => "runtime-conformance-session" } };
    const guard = new EditFreshnessGuard("enforce");
    assert.deepEqual(guard.observe(ctx, "runtime-conformance-run-1", ["src/value.ts"], "read"), ["src/value.ts"]);
    assert.equal(guard.evaluate(ctx, "runtime-conformance-run-1", ["src/value.ts"]).decision, "current");

    fs.writeFileSync(target, "// concurrent change\nexport const value = 1;\n");
    const beforeRejectedMutation = fs.readFileSync(target, "utf8");
    const stale = guard.evaluate(ctx, "runtime-conformance-run-1", ["src/value.ts"]);
    assert.equal(stale.decision, "stale");
    assert.equal(stale.enforce, true);
    assert.deepEqual(stale.stalePaths, ["src/value.ts"]);
    assert.equal(fs.readFileSync(target, "utf8"), beforeRejectedMutation, "evaluation must not mutate stale content");
    metrics.edits.staleEvaluations += 1;

    guard.observe(ctx, "runtime-conformance-run-1", ["src/value.ts"], "read");
    const recovered = guard.evaluate(ctx, "runtime-conformance-run-1", ["src/value.ts"]);
    assert.equal(recovered.decision, "current");
    metrics.edits.freshRereadRecoveries += 1;
    return { staleDecision: stale.decision, stalePaths: stale.stalePaths, recoveredDecision: recovered.decision };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

const completedAtMs = Date.now();
const failed = results.filter((result) => result.status !== "passed");
const configuredCaseIds = lane.cases.map((item) => item.id);
const observedCaseIds = results.map((item) => item.id);
const configuredCasesMatched = JSON.stringify(configuredCaseIds) === JSON.stringify(observedCaseIds);
const gates = {
  allCasesPass: failed.length === 0 && configuredCasesMatched,
  providerCalls: metrics.context.governorProviderCalls === lane.releaseGates.providerCalls,
  modelInputTokens: lane.releaseGates.modelInputTokens === 0,
  modelOutputTokens: lane.releaseGates.modelOutputTokens === 0,
  toolProtocolOrphans: metrics.context.toolProtocolOrphans === lane.releaseGates.toolProtocolOrphans,
  unsafeRetriesAllowed: metrics.operations.unsafeRetriesAllowed === lane.releaseGates.unsafeRetriesAllowed,
  duplicateTerminalSettlements: metrics.operations.duplicateTerminalSettlements === lane.releaseGates.duplicateTerminalSettlements,
  finalMessagesSuppressed: metrics.emissions.finalMessagesSuppressed === lane.releaseGates.finalMessagesSuppressed,
  staleMutationsAllowed: metrics.edits.staleMutationsAllowed === lane.releaseGates.staleMutationsAllowed
};
const passed = failed.length === 0 && configuredCasesMatched && Object.values(gates).every(Boolean);
const report = {
  schemaVersion: 1,
  laneId: lane.id,
  evidenceClass: "provider-free-runtime-conformance",
  startedAt: new Date(startedAtMs).toISOString(),
  completedAt: new Date(completedAtMs).toISOString(),
  wallClockMilliseconds: completedAtMs - startedAtMs,
  provider: {
    required: lane.providerRequired,
    used: false,
    calls: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0
  },
  summary: {
    configuredCases: lane.cases.length,
    executedCases: results.length,
    passedCases: results.length - failed.length,
    failedCases: failed.length,
    passed
  },
  metrics,
  gates,
  cases: results,
  claimBoundary: lane.claimBoundary
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
}
process.stdout.write(serialized);
if (!passed) process.exitCode = 1;
