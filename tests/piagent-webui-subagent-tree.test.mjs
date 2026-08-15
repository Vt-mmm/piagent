import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { OwnedWorkBudgetController } from "../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";
import { createHelperRequest, defaultRolePolicy } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { projectTaskSubagentTree } from "../packages/piagent-core/runtime/inspection/task-subagent-tree.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-subagent-tree-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const task = writeTaskContract(cwd, { ...structuredClone(fixture), taskId: "helper-tree-task", taskRunId: "helper-tree-run",
    sessionId: "private-helper-session", sessionName: "Helper tree session", summary: "Inspect helper ownership",
    orchestration: { mode: "bounded-subagents", subagents: "used", reason: "Use one bounded read-only scout." }, trace: { outcome: "pending" } });
  const identity = { projectRef: "project.helper", runtimeInstanceId: "runtime.helper", sessionRef: "session.helper",
    taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  const policy = defaultRolePolicy("scout", ["src/**"]);
  const request = createHelperRequest({ policy, objective: "Map private source without returning raw output", taskId: task.taskId,
    taskRunId: task.taskRunId, sessionId: task.sessionId, parentReadScope: ["src/**"], parentWriteScope: ["src/**"],
    parentAllowedTools: ["read", "grep", "find", "ls"] });
  return { cwd, task, identity, request };
}

test("subagent tree projects exact one-level ownership and stale result without raw helper authority", async (t) => {
  const { cwd, task, identity, request } = setup(t), budgets = new OwnedWorkBudgetController();
  budgets.reserve(cwd, request, "2026-08-14T10:00:00.000Z");
  task.acceptanceReceipt = { helperUsage: { used: true, helpers: [{ role: "scout", disposition: "stale-result",
    requestRef: request.deduplicationKey, outputDigest: null, calls: 1, tokens: 20 }] } };
  const value = projectTaskSubagentTree({ cwd, task, identity, generatedAt: "2026-08-14T11:00:00.000Z" });
  const validation = validateFixture(registry, "subagent-tree-v1", value); assert.equal(validation.valid, true, validation.errors);
  assert.equal(value.state, "ready"); assert.equal(value.evidenceState, "complete"); assert.equal(value.children.length, 1);
  assert.equal(value.children[0].lifecycleState, "orphaned"); assert.equal(value.children[0].result.state, "stale-result");
  assert.equal(value.children[0].authority, "read-only"); assert.equal(value.writer.state, "parent");
  assert.equal(value.nestedLineage.state, "unavailable"); assert.equal(value.summary.staleResults, 1);
  assert.equal(budgets.snapshot(cwd, request).reservations[0].status, "active", "read-only inspection must not repair runtime state");
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /private-helper-session|Map private source|deduplicationKey|outputDigest|objectiveText|helper-budgets|\.pi\/piagent-state/);
  assert.equal(serialized.includes(request.deduplicationKey), false);

  const before = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }, continuationConsumed: 0,
    turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.helper", messageSetDigest: digestZeroTurnFact("messages", ["message.helper"]),
    taskContractDigest: digestZeroTurnFact("task", task.taskRunId), journalHead: value.treeRevision, promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "subagent-tree.view", commandId: "subagent.zero-turn",
    concurrency: "quiescent", mutationClass: "read-only" }, () => structuredClone(before),
  () => projectTaskSubagentTree({ cwd, task, identity, generatedAt: "2026-08-14T11:00:00.000Z" }));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
});

test("missing helper ledger stays aggregate-only and corrupt ledger removes detail authority", (t) => {
  const { cwd, task, identity } = setup(t);
  const missing = projectTaskSubagentTree({ cwd, task, identity });
  assert.equal(missing.state, "ready"); assert.equal(missing.evidenceState, "aggregate-only"); assert.deepEqual(missing.children, []);
  assert.equal(missing.writer.state, "unknown"); assert.ok(missing.warnings.some((warning) => warning.code === "helper-budget-missing"));
  const target = path.join(cwd, ".pi", "piagent-state", "helper-budgets", `${task.taskRunId}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "{corrupt}", { mode: 0o600 });
  const corrupt = projectTaskSubagentTree({ cwd, task, identity });
  const validation = validateFixture(registry, "subagent-tree-v1", corrupt); assert.equal(validation.valid, true, validation.errors);
  assert.equal(corrupt.state, "unavailable"); assert.equal(corrupt.treeRevision, null); assert.deepEqual(corrupt.children, []);
  assert.equal(corrupt.writer.state, "unknown");
});

test("subagent tree route accepts one opaque run ref and rejects query or path authority", async () => {
  let seen = null; const provider = { subagentTree: async (runRef) => { seen = runRef; return { state: "ready" }; } };
  const valid = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/subagent-tree"), provider);
  assert.equal(valid.status, 200); assert.equal(seen, "run.abc123");
  const query = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/run.abc123/subagent-tree?spawn=1"), provider);
  assert.equal(query.status, 400); assert.equal(seen, "run.abc123");
  const traversal = await routeReadOnlyRequest(new URL("http://localhost/api/v1/tasks/..%2Fsecret/subagent-tree"), provider);
  assert.equal(traversal.status, 400); assert.equal(seen, "run.abc123");
});
