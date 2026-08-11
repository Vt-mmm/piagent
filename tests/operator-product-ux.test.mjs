import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { buildTaskEfficiencyMetrics } from "../packages/piagent-core/runtime/product/efficiency-metrics.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import {
  buildCompletionReceiptView,
  buildLiveTaskStatus,
  buildProductPreflight,
  formatLiveTaskStatus,
  formatProductPreflight
} from "../packages/piagent-core/runtime/product/operator-projections.ts";
import { SolverShadowRuntime } from "../packages/piagent-core/runtime/solver/solver-shadow.ts";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { appendTrajectoryTransition, writeTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-product-ux-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function task(overrides = {}) {
  const value = {
    ...structuredClone(fixture),
    taskId: "product-101",
    taskRunId: "product-101-run-1",
    sessionId: "product-session",
    sessionName: "PRODUCT-101",
    scope: ["src/**"],
    contextManifest: [{ path: "src/a.ts", reason: "target" }],
    requiredContext: ["src/a.ts"],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:04.000Z",
    ...overrides
  };
  value.authoritySnapshot = createBoundTaskAuthority(value);
  return value;
}

function solverInput(request, overrides = {}) {
  return {
    request,
    profileMode: "fullstack",
    projectShape: ["backend"],
    gitReady: true,
    dirtyTree: false,
    verifierReady: true,
    contextPressure: 0.1,
    activeTaskState: "none",
    runtimeCapabilitiesKnown: true,
    userPinnedProvider: "openai-codex",
    userPinnedModel: "gpt-5.6-terra",
    userPinnedEffort: "medium",
    ...overrides
  };
}

function writeTrajectory(cwd, current) {
  let state = createTrajectoryState({
    taskId: current.taskId,
    taskRunId: current.taskRunId,
    sessionId: current.sessionId,
    changeMode: current.changeMode,
    riskLane: current.riskLane,
    createdAt: current.createdAt
  });
  for (const input of [
    { to: "plan", cause: "plan-observed", sourceHook: "task-state", observedAt: "2026-08-08T00:00:01.000Z" },
    { to: "execute", cause: "mutation-observed", sourceHook: "task-state", observedAt: "2026-08-08T00:00:02.000Z" },
    { to: "verify", cause: "verification-started", sourceHook: "tool-call", observedAt: "2026-08-08T00:00:03.000Z" }
  ]) {
    const event = createTrajectoryTransition(state, input);
    appendTrajectoryTransition(cwd, event);
    state = reduceTrajectory(state, event);
  }
  writeTrajectoryState(cwd, state);
}

function receipt(status = "satisfied") {
  return {
    schemaVersion: 1,
    source: "runtime",
    promptHash: "f".repeat(64),
    generatedAt: "2026-08-08T00:00:00.000Z",
    criteria: [{
      id: "criterion-1",
      hash: "a".repeat(64),
      obligation: "requested-outcome",
      priority: "critical",
      status,
      evidence: [{ kind: "runtime", summary: "bounded evidence", paths: ["src/a.ts"] }]
    }]
  };
}

describe("operator product UX", () => {
  it("renders stable preflight facts and visually distinct control modes without implementation authority for read-only work", () => {
    const cwd = workspace();
    const shadowEvaluation = new SolverShadowRuntime("shadow").evaluate(cwd, "preflight-shadow", solverInput("Implement src/a.ts"));
    const assistEvaluation = new SolverShadowRuntime("recommend").evaluate(cwd, "preflight-assist", solverInput("Implement src/a.ts"));
    const readOnlyEvaluation = new SolverShadowRuntime("shadow").evaluate(cwd, "preflight-read", solverInput("Review src/a.ts"));
    assert.equal(shadowEvaluation.status, "ok");
    assert.equal(assistEvaluation.status, "ok");
    assert.equal(readOnlyEvaluation.status, "ok");
    const shadow = buildProductPreflight(shadowEvaluation, { scope: ["src/**"] });
    const assist = buildProductPreflight(assistEvaluation, { scope: ["src/**"] });
    const enforce = buildProductPreflight(shadowEvaluation, { controlMode: "enforce", scope: ["src/**"] });
    const readOnly = buildProductPreflight(readOnlyEvaluation);
    assert.deepEqual([shadow.controlMode, assist.controlMode, enforce.controlMode], ["shadow", "assist", "enforce"]);
    assert.equal(readOnly.execution.implementationAuthorized, false);
    assert.equal(shadow.schemaVersion, 1);
    assert.match(shadow.version, /^product-preflight-v/);
    assert.match(formatProductPreflight(shadow), /host execution is not a sandbox/);
    const unknown = buildProductPreflight({ status: "off", durationMs: 0 });
    assert.equal(unknown.runtime, null);
    assert.match(formatProductPreflight(unknown), /runtime: unknown/);
  });

  it("projects persisted active, corrupt, and terminal task truth without a model call", () => {
    const cwd = workspace();
    const current = task();
    writeTrajectory(cwd, current);
    const active = buildLiveTaskStatus(cwd, current, current.sessionId, { activeToolGroups: ["task"] });
    assert.equal(active.state, "active");
    assert.equal(active.task.phase, "verify");
    assert.equal(active.efficiency.trajectory.phaseDurations.length, 4);
    assert.match(formatLiveTaskStatus(active), /next:/);
    const currentDigest = workingTreeEvidenceDigest({});
    const observed = (exitCode, observedAt) => ({
      command: current.verifyCommands[0], exitCode, summary: exitCode === 0 ? "pass" : "fail",
      recordedAt: observedAt, observed: true, observedAt, matchedProfileCommand: true,
      preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest
    });
    current.verifyEvidence = [
      observed(0, "2026-08-08T00:00:01.000Z"),
      observed(1, "2026-08-08T00:00:03.000Z"),
      observed(0, "2026-08-08T00:00:02.000Z")
    ];
    assert.ok(buildLiveTaskStatus(cwd, current, current.sessionId).task.pendingVerifiers.includes(current.verifyCommands[0]));
    current.verifyEvidence.push(observed(0, "2026-08-08T00:00:04.000Z"));
    assert.equal(buildLiveTaskStatus(cwd, current, current.sessionId).task.pendingVerifiers.length, 0);

    const journal = taskJournalPaths(cwd);
    fs.mkdirSync(path.dirname(journal.events), { recursive: true });
    fs.writeFileSync(journal.events, "{broken\n");
    const corrupt = buildLiveTaskStatus(cwd, current, current.sessionId);
    assert.equal(corrupt.state, "corrupt");
    assert.equal(corrupt.resume.safe, false);

    const terminal = buildLiveTaskStatus(cwd, task({ trace: { outcome: "blocked", friction: "operator approval required" }, acceptanceReceipt: receipt("blocked") }), "product-session");
    assert.equal(terminal.state, "terminal");
    assert.equal(terminal.receipt.completionApproved, false);
    assert.match(terminal.receipt.remainingRisk.join(" "), /operator approval required/);
  });

  it("fails closed when a completed-looking receipt has no current hard-gate result", () => {
    const cwd = workspace();
    const incomplete = buildCompletionReceiptView(task({ trace: { outcome: "completed" }, acceptanceReceipt: receipt("pending") }));
    assert.equal(incomplete.outcome, "completed");
    assert.equal(incomplete.completionApproved, false);
    const completedLooking = task({ trace: { outcome: "completed" }, acceptanceReceipt: receipt("satisfied") });
    const currentDigest = workingTreeEvidenceDigest(completedLooking.finalFileDigests ?? {});
    const unavailable = buildCompletionReceiptView(completedLooking);
    assert.equal(unavailable.completionApproved, false);
    assert.equal(unavailable.gate.decision, "unavailable");
    assert.deepEqual(unavailable.remainingRisk, ["completion-gate-unavailable"]);

    const failedGate = buildCompletionReceiptView(completedLooking, { gate: {
      decision: "fail",
      missing: ["verify evidence", "completed work plan (plan:pending, implement:pending, review:pending)"],
      warnings: [],
      currentWorkingTreeDigest: "b".repeat(64)
    } });
    assert.equal(failedGate.completionApproved, false);
    assert.deepEqual(failedGate.remainingRisk, ["verify evidence", "completed work plan (plan:pending, implement:pending, review:pending)"]);
    assert.equal(failedGate.gate.currentWorkingTreeDigest, null);
    assert.equal(failedGate.tree.currentDigest, currentDigest);
    assert.equal(failedGate.tree.algorithm, "wt-content-v2");
    const partialMigration = buildCompletionReceiptView(task({
      trace: { outcome: "completed" }, acceptanceReceipt: receipt("satisfied"),
      workingTreeDigestMigration: { status: "refreshed" }
    }), { gate: { decision: "fail", missing: ["invalid task contract"], currentWorkingTreeDigest: currentDigest } });
    assert.equal(partialMigration.tree.evidenceCurrent, false);
    assert.equal(partialMigration.assurance, "historical-or-untrusted-working-tree-evidence");
    const terminalStatus = buildLiveTaskStatus(cwd, completedLooking, completedLooking.sessionId, { completionGate: failedGate.gate });
    assert.equal(terminalStatus.receipt.completionApproved, false);
    assert.match(terminalStatus.receipt.remainingRisk.join(" "), /completed work plan/);

    const completed = buildCompletionReceiptView(completedLooking, { gate: {
      decision: "pass",
      missing: [],
      warnings: [],
      currentWorkingTreeDigest: currentDigest
    } });
    assert.equal(completed.completionApproved, true);
    assert.deepEqual(completed.remainingRisk, []);
    assert.equal(completed.tree.evidenceCurrent, true);
    assert.equal(completed.assurance, "same-runtime-operational-evidence");
    assert.doesNotMatch(JSON.stringify(completed), /independent audit/i);

    const legacy = buildCompletionReceiptView(task({
      trace: { outcome: "completed" },
      acceptanceReceipt: receipt("satisfied"),
      workingTreeDigestAlgorithm: "legacy-untrusted",
      workingTreeDigestMigration: {
        status: "historical-unverifiable",
        source: "legacy-unversioned",
        reasonCode: "terminal-legacy-evidence",
        requiredAction: "historical-only",
        archivePath: ".pi/piagent-state/digest-migrations/product-101-run-1.legacy.json",
        archiveDigest: "a".repeat(64), archiveBytes: 1,
        baselineEvidenceDigest: "b".repeat(64), finalEvidenceDigest: "c".repeat(64),
        recordedAt: "2026-08-08T00:00:00.000Z"
      }
    }), { gate: { decision: "pass", missing: [], currentWorkingTreeDigest: currentDigest } });
    assert.equal(legacy.completionApproved, false);
    assert.equal(legacy.tree.evidenceCurrent, false);
    assert.equal(legacy.assurance, "historical-or-untrusted-working-tree-evidence");
    assert.equal(legacy.tree.migration.status, "historical-unverifiable");
    assert.ok(legacy.remainingRisk.includes("working-tree-digest-legacy-untrusted"));
  });

  it("reports bounded task efficiency with hashed identity, honest nulls, and old-session compatibility", () => {
    const cwd = workspace();
    const current = task({ summary: "secret raw task text" });
    new SolverShadowRuntime("shadow").evaluate(cwd, current.sessionId, solverInput("Implement src/a.ts"));
    writeTrajectory(cwd, current);
    const metrics = buildTaskEfficiencyMetrics(cwd, current, { activeToolGroups: ["task", "retrieval"] });
    assert.match(metrics.identity.sessionHash, /^[a-f0-9]{64}$/);
    assert.equal(metrics.solver.route, "direct");
    assert.equal(metrics.timing.timeToFirstCorrectEditMs, null);
    assert.equal(metrics.exactUsage.tokens, null);
    assert.equal(metrics.tools.actualInvocationCounts, null);
    assert.doesNotMatch(JSON.stringify(metrics), /secret raw task text|product-session|Implement src/);

    const old = buildTaskEfficiencyMetrics(workspace(), current);
    assert.equal(old.compatibility.oldSessionReadable, true);
    assert.equal(old.compatibility.solver, "unavailable");
    assert.equal(old.compatibility.trajectory, "missing");
  });
});
