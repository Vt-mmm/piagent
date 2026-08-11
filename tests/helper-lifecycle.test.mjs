import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HelperLifecycleRuntime, selectHelperRole } from "../packages/piagent-core/runtime/orchestration/helper-lifecycle.ts";
import { OwnedWorkBudgetController } from "../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";
import { acceptanceReceiptValidationErrors, applyAcceptanceHelperUsage, buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
const features = { schemaVersion: 1, featureHash: "a".repeat(64), workflowIntent: "implement", changeMode: "source-change", riskLane: "normal", riskSignals: [], ambiguity: "low", explicitPathCount: 1, scopeEstimate: "bounded", profileMode: null, projectShape: [], gitReady: true, dirtyTree: false, verifierReady: true, contextPressure: 0.2, activeTaskState: "pending", runtimeSnapshotDigest: null, runtimeCapabilitiesKnown: true, userPinnedProvider: "openai-codex", userPinnedModel: "gpt-5.6-sol", userPinnedEffort: "high", protectedTarget: false, externalAction: false, destructiveAction: false, permissionExpansion: false };
const solver = { helper: { needed: true, role: "scout" }, route: "scout-first" };
const runtime = { provider: "openai-codex", modelId: "gpt-5.6-sol", effectiveThinkingLevel: "high", availability: "authenticated" };
const catalog = { availability: "authenticated", models: [{ provider: "openai-codex", modelId: "gpt-5.6-luna", supportedThinkingLevels: ["low", "medium"] }, { provider: "openai-codex", modelId: "gpt-5.6-sol", supportedThinkingLevels: ["high", "xhigh"] }] };
function input(mode) { return { mode, objective: "Map independent source entry points", taskId: "task-1", taskRunId: "task-1-run-1", sessionId: "private-session", taskScope: ["src/**"], parentAllowedTools: ["read", "grep", "find", "ls"], features, solver, runtime, catalog }; }
describe("helper decision and lifecycle", () => {
  it("keeps off solo, recommend non-spawning, and on read-only dispatchable", () => { const lifecycle = new HelperLifecycleRuntime(); assert.equal(lifecycle.decide(input("off")).action, "solo"); assert.equal(lifecycle.decide(input("recommend")).action, "recommend"); assert.equal(lifecycle.decide(input("on")).action, "dispatch"); });
  it("adds zero helper/provider turns in recommend mode", async () => {
    const lifecycle = new HelperLifecycleRuntime(), root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-recommend-")); let calls = 0;
    const usage = await lifecycle.dispatch(root, lifecycle.decide(input("recommend")), async () => { calls += 1; return { status: "succeeded", calls: 1, tokens: 1, output: "must not run" }; });
    assert.equal(calls, 0); assert.equal(usage.helperUsed, false); assert.equal(usage.disposition, "recommend");
  });
  it("permits at most one automatic helper dispatch for a task run", async () => {
    const lifecycle = new HelperLifecycleRuntime(), root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-auto-budget-"));
    const first = await lifecycle.dispatch(root, lifecycle.decide(input("on")), async () => ({ status: "succeeded", calls: 1, tokens: 1, output: "first" }));
    let secondCalls = 0;
    const second = await lifecycle.dispatch(root, lifecycle.decide({ ...input("on"), objective: "Map another source region" }), async () => { secondCalls += 1; return { status: "succeeded", calls: 1, tokens: 1, output: "second" }; });
    assert.equal(first.disposition, "succeeded"); assert.equal(second.disposition, "helper-budget-exhausted"); assert.equal(secondCalls, 0);
  });
  it("dispatches through an injected provider adapter and stores digest-only receipt usage", async () => { const lifecycle = new HelperLifecycleRuntime(); const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-life-")); const decision = lifecycle.decide(input("on")); const usage = await lifecycle.dispatch(root, decision, async (request) => { assert.equal(request.authority, "read-only"); return { status: "succeeded", calls: 4, tokens: 900, output: "private detailed helper output" }; }); assert.equal(usage.helperUsed, true); assert.equal(usage.disposition, "succeeded"); assert.equal(JSON.stringify(usage).includes("private detailed helper output"), false); const receipt = buildAcceptanceReceipt({ summary: "Record bounded helper usage", expectedOutput: "Receipt identifies helper use without raw output", acceptanceCriteria: ["Helper usage is bounded"], changeMode: "source-change" }).receipt; const task = applyAcceptanceHelperUsage({ acceptanceReceipt: receipt }, { mode: "on", reasonCodes: usage.reasonCodes, helpers: [usage], recordedAt: "2026-08-08T00:00:00.000Z" }); assert.equal(task.acceptanceReceipt.helperUsage.used, true); assert.equal(task.acceptanceReceipt.helperUsage.helpers[0].role, "scout"); assert.deepEqual(acceptanceReceiptValidationErrors(task.acceptanceReceipt), []); });
  it("uses Oracle only for eligible high-risk uncertainty and reviewer only when useful", () => { assert.equal(selectHelperRole({ features: { ...features, riskLane: "high-risk" }, solver: { ...solver, helper: { needed: false, role: null } }, confidence: "low" }).role, "oracle"); assert.equal(selectHelperRole({ features, solver: { ...solver, helper: { needed: false, role: null } }, independentReviewUseful: true }).role, "reviewer"); assert.notEqual(selectHelperRole({ features: { ...features, riskLane: "high-risk" }, solver: { ...solver, helper: { needed: false, role: null } }, confidence: "high" }).role, "oracle"); });
  it("does not dispatch unavailable models or automatic workers", () => { const lifecycle = new HelperLifecycleRuntime(); assert.equal(lifecycle.decide({ ...input("on"), catalog: { availability: "offline", models: [] } }).action, "unavailable"); const worker = lifecycle.decide({ ...input("on"), solver: { ...solver, helper: { needed: true, role: "worker" } } }); assert.notEqual(worker.action, "dispatch"); });
  it("enforces timeout and aborts the isolated helper operation", async () => {
    const lifecycle = new HelperLifecycleRuntime(), root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-timeout-"));
    let aborted = false;
    const usage = await lifecycle.dispatch(root, lifecycle.decide(input("on")), async (_request, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({ status: "cancelled", calls: 0, tokens: 0, output: "late" }); }, { once: true });
    }), { timeoutMs: 10 });
    assert.equal(aborted, true); assert.equal(usage.disposition, "timeout"); assert.equal(usage.outputDigest, null); assert.equal(usage.summary, null);
  });
  it("cancels active helpers at parent terminal and rejects their late result", async () => {
    const lifecycle = new HelperLifecycleRuntime(), root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-cancel-"));
    const decision = lifecycle.decide(input("on")); let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const pending = lifecycle.dispatch(root, decision, async (_request, signal) => {
      started();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "succeeded", calls: 1, tokens: 10, output: "late raw output", summary: "late summary" }), { once: true }));
    });
    await ready; assert.equal(lifecycle.cancelTask(root, decision), 1);
    const usage = await pending;
    assert.equal(usage.disposition, "cancelled"); assert.equal(usage.outputDigest, null); assert.equal(usage.summary, null); assert.equal(usage.mergeOwner, null);
  });
  it("rejects a stale success even when the adapter ignores cancellation", async () => {
    const budgets = new OwnedWorkBudgetController(), lifecycle = new HelperLifecycleRuntime(budgets);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-stale-")), decision = lifecycle.decide(input("on"));
    let started, finish;
    const ready = new Promise((resolve) => { started = resolve; });
    const pending = lifecycle.dispatch(root, decision, async () => {
      started(); return new Promise((resolve) => { finish = resolve; });
    });
    await ready; budgets.markParentTerminal(root, decision.request);
    finish({ status: "succeeded", calls: 1, tokens: 10, output: "late private output", summary: "late summary" });
    const usage = await pending;
    assert.equal(usage.disposition, "cancelled"); assert.equal(usage.outputDigest, null); assert.equal(usage.summary, null);
    assert.equal(JSON.stringify(usage).includes("late private output"), false);
  });
  it("fails closed when helper call or token usage exceeds its request ceiling", async () => {
    const lifecycle = new HelperLifecycleRuntime(), root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-ceiling-"));
    const calls = lifecycle.decide(input("on"));
    const callUsage = await lifecycle.dispatch(root, calls, async (request) => ({ status: "succeeded", calls: request.ceilings.calls + 1, tokens: 1, output: "unmergeable", summary: "unmergeable" }));
    assert.equal(callUsage.disposition, "budget-exceeded"); assert.ok(callUsage.reasonCodes.includes("helper-call-budget-exceeded")); assert.equal(callUsage.outputDigest, null);
    const tokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-token-ceiling-"));
    const tokenDecision = lifecycle.decide({ ...input("on"), objective: "Map another independent source entry point" });
    const tokenUsage = await lifecycle.dispatch(tokenRoot, tokenDecision, async (request) => ({ status: "succeeded", calls: 1, tokens: request.contextBudget + 1, output: "unmergeable", summary: "unmergeable" }));
    assert.equal(tokenUsage.disposition, "budget-exceeded"); assert.ok(tokenUsage.reasonCodes.includes("helper-token-budget-exceeded")); assert.equal(tokenUsage.summary, null);
  });
  it("returns only a redacted bounded summary for parent-owned merge", async () => {
    const lifecycle = new HelperLifecycleRuntime(), root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-summary-"));
    const usage = await lifecycle.dispatch(root, lifecycle.decide(input("on")), async () => ({
      status: "succeeded", calls: 2, tokens: 100, output: "private detailed helper output",
      summary: `Found the target. TOKEN=hunter2 ${"bounded ".repeat(200)}`
    }));
    assert.equal(usage.mergeOwner, "parent"); assert.equal(usage.summary.length <= 1000, true);
    assert.match(usage.summary, /\[REDACTED_SECRET\]/); assert.equal(JSON.stringify(usage).includes("private detailed helper output"), false);
  });
});
