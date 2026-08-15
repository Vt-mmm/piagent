import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { contextEnginePaths } from "../packages/piagent-core/extensions/context-engine.js";
import { taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { safeTaskId, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { projectTaskCompactionHistory } from "../packages/piagent-core/runtime/inspection/task-compaction-history.ts";
import { projectTaskHandoffHistory } from "../packages/piagent-core/runtime/inspection/task-handoff-history.ts";
import { projectTaskRecoveryTimeline } from "../packages/piagent-core/runtime/inspection/task-recovery-timeline.ts";
import { projectTaskRunIndex } from "../packages/piagent-core/runtime/inspection/task-run-index.ts";
import { projectTaskSubagentTree } from "../packages/piagent-core/runtime/inspection/task-subagent-tree.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, ".."), taskFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry(), generatedAt = "2026-08-14T14:00:00.000Z";

function setup(t, prefix = "piagent-webui-long-task-") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = { ...structuredClone(taskFixture), taskId: "scale-task", taskRunId: "scale-task-run", sessionId: "scale-private-session",
    sessionName: "Scale session", summary: "Bounded long task", trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  const task = writeTaskContract(cwd, source), identity = { projectRef: "project.scale", runtimeInstanceId: "runtime.scale",
    sessionRef: "session.scale", taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  return { cwd, task, identity };
}

function writeJournal(cwd, task, count) {
  const records = []; let previousHash;
  for (let index = 0; index < count; index += 1) {
    const record = { schemaVersion: 1, sequence: index + 1, ...(previousHash ? { previousHash } : {}), eventType: "contract-written",
      taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, data: { outcome: "pending" },
      recordedAt: new Date(Date.parse("2026-08-14T10:00:00.000Z") + index * 1000).toISOString() };
    const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex"); records.push({ ...record, hash }); previousHash = hash;
  }
  const paths = taskJournalPaths(cwd); fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.events, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
}

function writeTelemetry(cwd, task, compactions, handoffs, offsetMs = 0) {
  const rows = [];
  for (let index = 0; index < compactions; index += 1) rows.push({ schemaVersion: 1, source: "piagent",
    recordedAt: new Date(Date.parse("2026-08-14T11:00:00.000Z") + offsetMs + index * 1000).toISOString(), sessionId: task.sessionId,
    taskId: task.taskId, taskRunId: task.taskRunId, event: "session_compact", reason: "threshold", willRetry: false, fromExtension: false });
  for (let index = 0; index < handoffs; index += 1) rows.push({ schemaVersion: 1, source: "piagent",
    recordedAt: new Date(Date.parse("2026-08-14T12:00:00.000Z") + offsetMs + index * 1000).toISOString(), sessionId: task.sessionId,
    taskId: task.taskId, taskRunId: task.taskRunId, event: "handoff_projection_written", phase: "verify",
    completionApproved: false, recoveryAction: "resume" });
  const target = contextEnginePaths(cwd).telemetry; fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
}

function writeHelperBudget(cwd, task, count) {
  const reservations = Array.from({ length: count }, (_, index) => ({ id: index.toString(16).padStart(32, "0"),
    deduplicationKey: createHash("sha256").update(`helper-${index}`).digest("hex"), role: "scout", authority: "read-only",
    status: "succeeded", reservedAt: "2026-08-14T10:00:00.000Z", expiresAt: "2026-08-14T10:10:00.000Z",
    completedAt: "2026-08-14T10:05:00.000Z", usageRef: null }));
  const target = path.join(cwd, ".pi", "piagent-state", "helper-budgets", `${safeTaskId(task.taskRunId)}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify({ version: "owned-work-budget-v1", taskId: task.taskId, taskRunId: task.taskRunId,
    terminal: false, reservations, updatedAt: "2026-08-14T10:05:00.000Z" })}\n`, { mode: 0o600 });
  return target;
}

test("WEBUI-4 history projections stay bounded, schema-valid and revision-stable at their hard limits", (t) => {
  const { cwd, task, identity } = setup(t);
  const taskRoot = path.join(cwd, ".pi", "piagent-state", "tasks"), template = JSON.parse(fs.readFileSync(path.join(taskRoot, `${safeTaskId(task.taskRunId)}.json`)));
  for (let index = 1; index < 225; index += 1) {
    const suffix = String(index).padStart(3, "0"), row = { ...structuredClone(template), taskId: `scale-task-${suffix}`,
      taskRunId: `scale-task-run-${suffix}`, sessionId: `private-session-${suffix}`,
      createdAt: new Date(Date.parse("2026-08-13T00:00:00.000Z") + index * 1000).toISOString(),
      updatedAt: new Date(Date.parse("2026-08-13T00:00:00.000Z") + index * 1000).toISOString(), trace: { outcome: "completed" } };
    fs.writeFileSync(path.join(taskRoot, `${safeTaskId(row.taskRunId)}.json`), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }
  writeJournal(cwd, task, 1050); writeTelemetry(cwd, task, 350, 150); writeHelperBudget(cwd, task, 64);
  const index = projectTaskRunIndex({ cwd, identity: { ...identity, taskId: null, taskRunId: null }, currentSessionId: task.sessionId, generatedAt, limit: 200 });
  const timeline = projectTaskRecoveryTimeline({ cwd, task, identity, generatedAt });
  const recovery = projectTaskCompactionHistory({ cwd, task, identity, generatedAt });
  const handoff = projectTaskHandoffHistory({ cwd, task, identity, generatedAt });
  const helpers = projectTaskSubagentTree({ cwd, task, identity, generatedAt });

  for (const [schema, value] of [["task-index-v1", index], ["task-timeline-v1", timeline], ["recovery-history-v1", recovery],
    ["handoff-history-v1", handoff], ["subagent-tree-v1", helpers]]) {
    const validation = validateFixture(registry, schema, value); assert.equal(validation.valid, true, `${schema}: ${validation.errors}`);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 2 * 1024 * 1024, `${schema} exceeded the bounded response budget`);
    assert.doesNotMatch(JSON.stringify(value), /scale-private-session|private-session-\d|\.pi\/piagent-state/);
  }
  assert.equal(index.runs.length, 200); assert.equal(index.page.total, 225); assert.equal(index.page.truncated, true);
  assert.equal(timeline.events.length, 300); assert.equal(timeline.page.truncated, true);
  assert.ok(timeline.warnings.some((warning) => warning.code === "journal-input-truncated"));
  assert.equal(recovery.events.length, 300); assert.equal(recovery.page.truncated, true);
  assert.equal(handoff.events.length, 100); assert.equal(handoff.page.truncated, true); assert.equal(handoff.nextAction.dispatchable, false);
  assert.equal(helpers.children.length, 64); assert.equal(helpers.summary.total, 64);

  assert.equal(projectTaskRunIndex({ cwd, identity: { ...identity, taskId: null, taskRunId: null }, currentSessionId: task.sessionId, generatedAt, limit: 200 }).indexRevision, index.indexRevision);
  assert.equal(projectTaskRecoveryTimeline({ cwd, task, identity, generatedAt }).timelineRevision, timeline.timelineRevision);
  assert.equal(projectTaskCompactionHistory({ cwd, task, identity, generatedAt }).historyRevision, recovery.historyRevision);
  assert.equal(projectTaskHandoffHistory({ cwd, task, identity, generatedAt }).historyRevision, handoff.historyRevision);
  assert.equal(projectTaskSubagentTree({ cwd, task, identity, generatedAt }).treeRevision, helpers.treeRevision);
});

test("WEBUI-4 history keeps the newest bounded window across retained telemetry rotation", (t) => {
  const { cwd, task, identity } = setup(t, "piagent-webui-long-task-retention-");
  writeTelemetry(cwd, task, 200, 80); const target = contextEnginePaths(cwd).telemetry; fs.renameSync(target, `${target}.1`);
  writeTelemetry(cwd, task, 200, 80, 24 * 60 * 60 * 1000);
  const recovery = projectTaskCompactionHistory({ cwd, task, identity, generatedAt });
  const handoff = projectTaskHandoffHistory({ cwd, task, identity, generatedAt });
  assert.equal(recovery.page.total, 400); assert.equal(recovery.events.length, 300); assert.equal(recovery.page.truncated, true);
  assert.match(recovery.events.at(-1).recordedAt, /^2026-08-15/);
  assert.equal(handoff.page.total, 160); assert.equal(handoff.events.length, 100); assert.equal(handoff.page.truncated, true);
  assert.match(handoff.events.at(-1).recordedAt, /^2026-08-15/);
  for (const [schema, value] of [["recovery-history-v1", recovery], ["handoff-history-v1", handoff]]) {
    const validation = validateFixture(registry, schema, value); assert.equal(validation.valid, true, `${schema}: ${validation.errors}`);
  }
});

test("WEBUI-4 inspection fails closed on symlink, oversized task and oversized helper evidence", (t) => {
  const { cwd, task, identity } = setup(t, "piagent-webui-long-task-corrupt-"), external = path.join(cwd, "external-state");
  fs.writeFileSync(external, "{}\n");
  const journal = taskJournalPaths(cwd); fs.rmSync(journal.events); fs.symlinkSync(external, journal.events);
  assert.equal(projectTaskRecoveryTimeline({ cwd, task, identity, generatedAt }).state, "unavailable");

  const telemetry = contextEnginePaths(cwd).telemetry; fs.mkdirSync(path.dirname(telemetry), { recursive: true }); fs.symlinkSync(external, telemetry);
  assert.equal(projectTaskCompactionHistory({ cwd, task, identity, generatedAt }).state, "unavailable");
  assert.equal(projectTaskHandoffHistory({ cwd, task, identity, generatedAt }).state, "unavailable");

  const helper = writeHelperBudget(cwd, task, 1); fs.rmSync(helper); fs.symlinkSync(external, helper);
  assert.equal(projectTaskSubagentTree({ cwd, task, identity, generatedAt }).state, "unavailable");
  fs.rmSync(helper); fs.writeFileSync(helper, "{}"); fs.truncateSync(helper, 1024 * 1024 + 1);
  assert.equal(projectTaskSubagentTree({ cwd, task, identity, generatedAt }).state, "unavailable");

  const oversized = path.join(cwd, ".pi", "piagent-state", "tasks", "oversized.json"); fs.writeFileSync(oversized, "{}"); fs.truncateSync(oversized, 8 * 1024 * 1024 + 1);
  const index = projectTaskRunIndex({ cwd, identity: { ...identity, taskId: null, taskRunId: null }, currentSessionId: task.sessionId, generatedAt, limit: 200 });
  assert.equal(index.state, "ready"); assert.ok(index.warnings.some((warning) => warning.code === "corrupt-task-state"));
  assert.doesNotMatch(JSON.stringify({ index, timeline: projectTaskRecoveryTimeline({ cwd, task, identity, generatedAt }) }), /external-state|oversized\.json/);
});
