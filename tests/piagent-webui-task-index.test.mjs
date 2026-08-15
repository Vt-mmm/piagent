import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindSessionTask, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { projectTaskRunIndex } from "../packages/piagent-core/runtime/inspection/task-run-index.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.index", runtimeInstanceId: "runtime.index", sessionRef: "session.index",
  taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };

function task(taskId, taskRunId, sessionId, outcome, summary) {
  const value = { ...structuredClone(fixture), taskId, taskRunId, sessionId, sessionName: `Session ${sessionId}`, summary,
    trace: { outcome }, workPlan: [{ id: "one", title: "One", role: "parent", mode: "single-writer", status: "done", dependsOn: [] },
      { id: "two", title: "Two", role: "parent", mode: "single-writer", status: outcome === "pending" ? "in-progress" : "done", dependsOn: ["one"] }] };
  delete value.authoritySnapshot;
  return value;
}

test("task index uses authoritative contracts, marks the exact active run, redacts and bounds output", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-task-index-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const currentSession = "raw-current-session-secret";
  const completed = writeTaskContract(cwd, task("task-old", "task-old-run", "old-session-secret", "completed", "Completed task"));
  assert.equal(completed.trace.outcome, "completed");
  const other = writeTaskContract(cwd, task("task-other", "task-other-run", "other-session-secret", "blocked", "Blocked task"));
  assert.equal(other.trace.outcome, "blocked");
  const active = writeTaskContract(cwd, task("task-active", "task-active-run", currentSession, "pending",
    "Build sk-proj-THIS_IS_A_RAW_CREDENTIAL_1234567890 dashboard"));
  bindSessionTask(cwd, currentSession, "Current private session", active);
  const taskRoot = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.writeFileSync(path.join(taskRoot, "private-corrupt-name.json"), "{broken", { mode: 0o600 });

  const value = projectTaskRunIndex({ cwd, identity, currentSessionId: currentSession, generatedAt: "2026-08-14T10:00:00.000Z", limit: 2 });
  const validation = validateFixture(registry, "task-index-v1", value);
  assert.equal(validation.valid, true, validation.errors);
  assert.equal(value.runs.length, 2); assert.equal(value.page.total, 3); assert.equal(value.page.truncated, true);
  assert.equal(value.runs[0].taskRunId, active.taskRunId); assert.equal(value.runs[0].isActive, true);
  assert.equal(value.runs[0].progress.completed, 1); assert.equal(value.runs[0].progress.total, 2);
  assert.equal(value.activeRunRef, value.runs[0].runRef);
  assert.ok(value.warnings.some((warning) => warning.code === "corrupt-task-state"));
  assert.ok(value.warnings.some((warning) => warning.code === "task-index-truncated"));
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /sk-proj-/); assert.doesNotMatch(serialized, /raw-current-session-secret|old-session-secret|other-session-secret/);
  assert.doesNotMatch(serialized, /private-corrupt-name/);

  const before = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.index", messageSetDigest: digestZeroTurnFact("messages", ["message.index"]),
    taskContractDigest: digestZeroTurnFact("task", active.taskRunId), journalHead: "journal.index", promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "task-index.view", commandId: "task-index.zero-turn",
    concurrency: "quiescent", mutationClass: "read-only" }, () => structuredClone(before),
  () => projectTaskRunIndex({ cwd, identity, currentSessionId: currentSession, limit: 2 }));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
});

test("task index route is read-only and rejects query smuggling", async () => {
  let reads = 0;
  const provider = { taskIndex: async () => { reads += 1; return { state: "ready" }; } };
  const current = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks"), provider);
  assert.deepEqual(current, { handled: true, status: 200, value: { state: "ready" } }); assert.equal(reads, 1);
  const smuggled = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks?task=anything"), provider);
  assert.equal(smuggled.handled, false); assert.equal(reads, 1);
});
