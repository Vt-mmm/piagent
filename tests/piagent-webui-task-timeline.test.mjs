import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendTaskJournalEvent, recordTaskCheckpoint, taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { bindSessionTask, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { projectTaskRecoveryTimeline } from "../packages/piagent-core/runtime/inspection/task-recovery-timeline.ts";
import { taskRunOpaqueRef } from "../packages/piagent-core/runtime/inspection/task-run-index.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, ".."), fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-task-timeline-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = { ...structuredClone(fixture), taskId: "timeline-task", taskRunId: "timeline-task-run", sessionId: "timeline-raw-session",
    sessionName: "Timeline session", summary: "Project durable recovery timeline", trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  const task = writeTaskContract(cwd, source); bindSessionTask(cwd, task.sessionId, task.sessionName, task);
  const identity = { projectRef: "project.timeline", runtimeInstanceId: "runtime.timeline", sessionRef: "session.timeline",
    taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  return { cwd, task, identity };
}

test("timeline projects exact ordered checkpoint and control facts without claiming an unobserved crash", async (t) => {
  const { cwd, task, identity } = setup(t);
  recordTaskCheckpoint(cwd, { taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, checkpointId: "verify-step",
    idempotencyKey: "checkpoint.verify", phase: "verify", status: "paused", attempt: 1, evidence: {}, recordedAt: "2026-08-14T10:00:00.000Z" });
  for (const [eventType, resultCode, at] of [
    ["task-control.pause-requested", "pause-requested", "2026-08-14T10:01:00.000Z"],
    ["task-control.paused", "paused", "2026-08-14T10:02:00.000Z"],
    ["task-control.resume-requested", "resume-requested", "2026-08-14T10:03:00.000Z"],
    ["task-control.resumed", "resumed", "2026-08-14T10:04:00.000Z"]
  ]) appendTaskJournalEvent(cwd, { eventType, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId,
    data: { resultCode } }, { recordedAt: at });
  const value = projectTaskRecoveryTimeline({ cwd, task, identity, generatedAt: "2026-08-14T11:00:00.000Z" });
  const validation = validateFixture(registry, "task-timeline-v1", value); assert.equal(validation.valid, true, validation.errors);
  assert.equal(value.state, "ready"); assert.equal(value.runRef, taskRunOpaqueRef(task.taskRunId));
  assert.deepEqual(value.events.slice(-5).map((event) => event.kind), ["checkpoint", "pause-requested", "paused", "resume-requested", "resumed"]);
  assert.deepEqual(value.events.map((event) => event.sequence), [...value.events.map((event) => event.sequence)].sort((a, b) => a - b));
  assert.equal(value.continuity.crashEvidence, "unknown"); assert.equal(value.continuity.recoveryDecision, "paused");
  assert.ok(value.warnings.some((warning) => warning.code === "crash-not-observed"));
  const serialized = JSON.stringify(value); assert.doesNotMatch(serialized, /timeline-raw-session|events\.jsonl|\.pi\/piagent-state/);
  const before = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.timeline", messageSetDigest: digestZeroTurnFact("messages", ["message.timeline"]),
    taskContractDigest: digestZeroTurnFact("task", task.taskRunId), journalHead: value.timelineRevision, promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "task-timeline.view", commandId: "timeline.zero-turn",
    concurrency: "quiescent", mutationClass: "read-only" }, () => structuredClone(before),
  () => projectTaskRecoveryTimeline({ cwd, task, identity }));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
});

test("an incomplete journal tail is only possible interruption evidence and corruption removes timeline authority", (t) => {
  const { cwd, task, identity } = setup(t), paths = taskJournalPaths(cwd);
  fs.appendFileSync(paths.events, '{"partial":true');
  const possible = projectTaskRecoveryTimeline({ cwd, task, identity });
  assert.equal(possible.state, "ready"); assert.equal(possible.continuity.crashEvidence, "possible-interruption");
  assert.ok(possible.warnings.some((warning) => warning.code === "recoverable-tail"));
  fs.appendFileSync(paths.events, "}\n");
  const corrupt = projectTaskRecoveryTimeline({ cwd, task, identity });
  const validation = validateFixture(registry, "task-timeline-v1", corrupt); assert.equal(validation.valid, true, validation.errors);
  assert.equal(corrupt.state, "unavailable"); assert.deepEqual(corrupt.events, []); assert.equal(corrupt.health.state, "error");
  assert.doesNotMatch(JSON.stringify(corrupt), /line \d|hash mismatch|invalid JSON/);
});

test("timeline route accepts one opaque run ref and rejects path or query authority", async () => {
  let seen = null; const provider = { taskTimeline: async (runRef) => { seen = runRef; return { state: "ready" }; } };
  const valid = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/timeline"), provider);
  assert.equal(valid.status, 200); assert.equal(seen, "run.abc123");
  const query = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/timeline?raw=1"), provider);
  assert.equal(query.status, 400); assert.equal(seen, "run.abc123");
  const traversal = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/..%2Fsecret/timeline"), provider);
  assert.equal(traversal.status, 400); assert.equal(seen, "run.abc123");
});
