import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";
import { bindSessionTask, workingTreeSnapshot, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { buildHandoffProjection, handoffProjectionPath, writeHandoffProjection } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { projectTaskHandoffHistory } from "../packages/piagent-core/runtime/inspection/task-handoff-history.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-handoff-history-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = { ...structuredClone(fixture), taskId: "handoff-task", taskRunId: "handoff-task-run", sessionId: "handoff-raw-session",
    sessionName: "Handoff session", summary: "Project bounded handoff history", trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  const task = writeTaskContract(cwd, source); bindSessionTask(cwd, task.sessionId, task.sessionName, task);
  const identity = { projectRef: "project.handoff", runtimeInstanceId: "runtime.handoff", sessionRef: "session.handoff",
    taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  return { cwd, task, identity };
}

test("handoff history binds exact telemetry, latest projection and a non-dispatching next action", async (t) => {
  const { cwd, task, identity } = setup(t), digests = workingTreeSnapshot(cwd), tree = workingTreeEvidenceDigest(digests);
  const projection = buildHandoffProjection(cwd, task, { generatedAt: "2026-08-14T12:00:00.000Z", currentDigests: digests,
    gate: { decision: "fail", missing: ["operator review"], missingVerifyCommands: task.verifyCommands, currentWorkingTreeDigest: tree }, recovery: null });
  writeHandoffProjection(cwd, projection);
  appendContextTelemetry(cwd, { sessionId: task.sessionId, taskId: task.taskId, taskRunId: task.taskRunId,
    recordedAt: "2026-08-14T12:00:00.000Z", event: "handoff_projection_written", path: handoffProjectionPath(cwd, task.taskRunId),
    phase: projection.state.phase, completionApproved: projection.state.completionApproved, recoveryAction: projection.nextSafeAction.action });
  appendContextTelemetry(cwd, { sessionId: "another-session", taskId: task.taskId, taskRunId: task.taskRunId,
    recordedAt: "2026-08-14T12:01:00.000Z", event: "handoff_projection_written", phase: "terminal", completionApproved: true, recoveryAction: "completed" });
  const value = projectTaskHandoffHistory({ cwd, task, identity, generatedAt: "2026-08-14T13:00:00.000Z" });
  const validation = validateFixture(registry, "handoff-history-v1", value); assert.equal(validation.valid, true, validation.errors);
  assert.equal(value.state, "ready"); assert.equal(value.completeness, "complete"); assert.equal(value.events.length, 1);
  assert.equal(value.current.generatedAt, projection.generatedAt); assert.equal(value.current.completionApproved, false);
  assert.equal(value.nextAction.dispatchable, false); assert.notEqual(value.nextAction.action, "unknown");
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /handoff-raw-session|\.pi\/piagent-state|handoffs\/|taskContract|journal|trajectory|verifyCommands|operator review/);

  const before = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.handoff", messageSetDigest: digestZeroTurnFact("messages", ["message.handoff"]),
    taskContractDigest: digestZeroTurnFact("task", task.taskRunId), journalHead: value.historyRevision, promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "handoff-history.view", commandId: "handoff.zero-turn",
    concurrency: "quiescent", mutationClass: "read-only" }, () => structuredClone(before),
  () => projectTaskHandoffHistory({ cwd, task, identity }));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
});

test("missing history is explicit and a corrupt current handoff removes handoff authority", (t) => {
  const { cwd, task, identity } = setup(t);
  const missing = projectTaskHandoffHistory({ cwd, task, identity });
  assert.equal(missing.state, "ready"); assert.equal(missing.completeness, "missing"); assert.equal(missing.current, null);
  assert.ok(missing.warnings.some((warning) => warning.code === "current-handoff-missing"));
  const target = handoffProjectionPath(cwd, task.taskRunId); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "{corrupt}");
  const corrupt = projectTaskHandoffHistory({ cwd, task, identity });
  const validation = validateFixture(registry, "handoff-history-v1", corrupt); assert.equal(validation.valid, true, validation.errors);
  assert.equal(corrupt.state, "unavailable"); assert.equal(corrupt.historyRevision, null); assert.deepEqual(corrupt.events, []);
  assert.equal(corrupt.nextAction.action, "unknown"); assert.equal(corrupt.nextAction.dispatchable, false);
});

test("handoff history route accepts one opaque run ref and rejects path or query authority", async () => {
  let seen = null; const provider = { handoffHistory: async (runRef) => { seen = runRef; return { state: "ready" }; } };
  const valid = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/handoff-history"), provider);
  assert.equal(valid.status, 200); assert.equal(seen, "run.abc123");
  const query = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/handoff-history?execute=1"), provider);
  assert.equal(query.status, 400); assert.equal(seen, "run.abc123");
  const traversal = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/..%2Fsecret/handoff-history"), provider);
  assert.equal(traversal.status, 400); assert.equal(seen, "run.abc123");
});
