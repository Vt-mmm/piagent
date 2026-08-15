import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendContextTelemetry, contextEnginePaths } from "../packages/piagent-core/extensions/context-engine.js";
import { bindSessionTask, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { projectTaskCompactionHistory } from "../packages/piagent-core/runtime/inspection/task-compaction-history.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-recovery-history-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = { ...structuredClone(fixture), taskId: "history-task", taskRunId: "history-task-run", sessionId: "history-raw-session",
    sessionName: "History session", summary: "Project bounded compaction history", trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  const task = writeTaskContract(cwd, source); bindSessionTask(cwd, task.sessionId, task.sessionName, task);
  const identity = { projectRef: "project.history", runtimeInstanceId: "runtime.history", sessionRef: "session.history",
    taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  return { cwd, task, identity };
}

function record(cwd, task, value) {
  return appendContextTelemetry(cwd, { sessionId: task.sessionId, taskId: task.taskId, taskRunId: task.taskRunId, ...value });
}

test("history projects exact session and tool compaction metadata while omitting retained content", async (t) => {
  const { cwd, task, identity } = setup(t);
  record(cwd, task, { recordedAt: "2026-08-14T10:00:00.000Z", event: "session_compact", reason: "threshold", willRetry: false, fromExtension: false });
  record(cwd, task, { recordedAt: "2026-08-14T10:01:00.000Z", event: "tool_result", compacted: true, compactedCaptures: 2,
    toolName: "bash sk-proj-THIS_IS_A_RAW_CREDENTIAL_1234567890", outputChars: 120000, outputLines: 3000,
    path: ".pi/piagent-state/tool-results/raw-secret.log", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  appendContextTelemetry(cwd, { sessionId: "different-session", taskId: task.taskId, taskRunId: task.taskRunId,
    recordedAt: "2026-08-14T10:02:00.000Z", event: "session_compact", reason: "wrong session", willRetry: true, fromExtension: false });
  const value = projectTaskCompactionHistory({ cwd, task, identity, generatedAt: "2026-08-14T11:00:00.000Z" });
  const validation = validateFixture(registry, "recovery-history-v1", value); assert.equal(validation.valid, true, validation.errors);
  assert.equal(value.state, "ready"); assert.equal(value.completeness, "complete");
  assert.deepEqual(value.events.map((event) => event.kind), ["context-compaction", "tool-result-compaction"]);
  assert.deepEqual(value.summary, { contextCompactions: 1, toolResultCompactions: 1, compactedToolResults: 2 });
  assert.match(value.events[1].toolName, /REDACTED/);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /THIS_IS_A_RAW_CREDENTIAL|history-raw-session|raw-secret\.log|aaaaaaaaaaaaaaaa|\.pi\/piagent-state|sha256/);
  assert.deepEqual(value.retainedContent, { access: "omitted", exposed: false, reasonCode: "protected-runtime-evidence" });

  const before = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.history", messageSetDigest: digestZeroTurnFact("messages", ["message.history"]),
    taskContractDigest: digestZeroTurnFact("task", task.taskRunId), journalHead: value.historyRevision, promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "recovery-history.view", commandId: "history.zero-turn",
    concurrency: "quiescent", mutationClass: "read-only" }, () => structuredClone(before),
  () => projectTaskCompactionHistory({ cwd, task, identity }));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
});

test("missing or corrupt telemetry stays explicit and never fabricates complete history", (t) => {
  const { cwd, task, identity } = setup(t);
  const missing = projectTaskCompactionHistory({ cwd, task, identity });
  assert.equal(missing.state, "ready"); assert.equal(missing.completeness, "missing"); assert.deepEqual(missing.events, []);
  assert.ok(missing.warnings.some((warning) => warning.code === "telemetry-missing"));
  const telemetry = contextEnginePaths(cwd).telemetry;
  fs.mkdirSync(path.dirname(telemetry), { recursive: true });
  fs.writeFileSync(telemetry, [
    JSON.stringify({ schemaVersion: 1, source: "piagent", recordedAt: "2026-08-14T10:00:00.000Z", sessionId: task.sessionId,
      taskId: task.taskId, taskRunId: task.taskRunId, event: "session_compact", reason: "threshold", willRetry: false, fromExtension: false }),
    "{broken-json}",
    "{\"partial\":true"
  ].join("\n"));
  const partial = projectTaskCompactionHistory({ cwd, task, identity });
  const validation = validateFixture(registry, "recovery-history-v1", partial); assert.equal(validation.valid, true, validation.errors);
  assert.equal(partial.state, "ready"); assert.equal(partial.completeness, "partial"); assert.equal(partial.events.length, 1);
  assert.ok(partial.warnings.some((warning) => warning.code === "telemetry-corrupt"));
  assert.ok(partial.warnings.some((warning) => warning.code === "telemetry-incomplete-tail"));
  assert.doesNotMatch(JSON.stringify(partial), /broken-json|\{\"partial\":true|history-raw-session/);
});

test("recovery history route accepts one opaque run ref and rejects path or query authority", async () => {
  let seen = null; const provider = { recoveryHistory: async (runRef) => { seen = runRef; return { state: "ready" }; } };
  const valid = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/recovery-history"), provider);
  assert.equal(valid.status, 200); assert.equal(seen, "run.abc123");
  const query = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/recovery-history?raw=1"), provider);
  assert.equal(query.status, 400); assert.equal(seen, "run.abc123");
  const traversal = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/..%2Fsecret/recovery-history"), provider);
  assert.equal(traversal.status, 400); assert.equal(seen, "run.abc123");
});
