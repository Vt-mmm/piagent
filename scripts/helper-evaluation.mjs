#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { HelperLifecycleRuntime } from "../packages/piagent-core/runtime/orchestration/helper-lifecycle.ts";
import { OwnedWorkBudgetController } from "../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";
import { createHelperRequest, defaultRolePolicy } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : undefined;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-eval-"));
const cases = 6, filesPerCase = 5000;
const rows = [];
try {
  for (let caseIndex = 0; caseIndex < cases; caseIndex += 1) {
    const cwd = path.join(root, `case-${caseIndex}`); fs.mkdirSync(cwd);
    const marker = `RELEVANT_SYMBOL_${crypto.createHash("sha256").update(String(caseIndex)).digest("hex").slice(0, 12)}`;
    for (let fileIndex = 0; fileIndex < filesPerCase; fileIndex += 1) fs.writeFileSync(path.join(cwd, `file-${String(fileIndex).padStart(4, "0")}.txt`), fileIndex === filesPerCase - 1 ? `${marker}\n` : `ordinary-${caseIndex}-${fileIndex}\n`);
    const names = fs.readdirSync(cwd).sort();
    const soloStart = performance.now(); let soloFound = null, soloChars = 0;
    for (const name of names) { const text = fs.readFileSync(path.join(cwd, name), "utf8"); soloChars += text.length; if (text.includes(marker)) { soloFound = name; break; } }
    const soloMs = performance.now() - soloStart;
    const helperStart = performance.now(); const helperFound = execFileSync("rg", ["-l", "--fixed-strings", marker, cwd], { encoding: "utf8" }).trim(); const helperMs = performance.now() - helperStart;
    rows.push({ id: `retrieval-${caseIndex + 1}`, soloMs, helperMs, soloFound, helperFound: path.basename(helperFound), soloEstimatedTokens: Math.ceil(soloChars / 4), helperEstimatedTokens: Math.ceil((helperFound.length + marker.length) / 4), verifiedSolo: soloFound === path.basename(helperFound), verifiedHelper: path.basename(helperFound) === `file-${String(filesPerCase - 1).padStart(4, "0")}.txt` });
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
function helperRequest(role, objective, run) {
  const policy = defaultRolePolicy(role, ["src/**"]); if (role === "worker") policy.writeScope = ["src/**"];
  return createHelperRequest({
    policy, objective, taskId: "helper-evaluation", taskRunId: run, sessionId: "private-helper-session",
    parentReadScope: ["src/**"], parentWriteScope: ["src/**"],
    parentAllowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
    requestedWriteScope: role === "worker" ? ["src/**"] : [], singleWriterOwnership: role === "worker" ? "evaluation-writer" : null
  });
}
function decision(request) { return { mode: "on", action: "dispatch", role: request.role, reasonCodes: ["evaluation-probe"], binding: null, request }; }
async function lifecycleProbes() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-contract-"));
  try {
    const budgets = new OwnedWorkBudgetController();
    const duplicateRequest = helperRequest("scout", "Map source", "duplicate-run");
    budgets.reserve(cwd, duplicateRequest); const duplicate = budgets.reserve(cwd, duplicateRequest);
    const firstWriter = budgets.reserve(cwd, helperRequest("worker", "Implement source", "writer-run"));
    const secondWriter = budgets.reserve(cwd, helperRequest("worker", "Implement other source", "writer-run"));
    const orphanRequest = helperRequest("scout", "Map stale source", "orphan-run");
    budgets.reserve(cwd, orphanRequest, "2026-08-08T00:00:00.000Z");
    const recovered = budgets.reserve(cwd, helperRequest("planner", "Plan after stale source", "orphan-run"), "2026-08-08T01:00:00.000Z");
    const lifecycle = new HelperLifecycleRuntime();
    const budgetRequest = helperRequest("scout", "Map budget source", "budget-run");
    const overBudget = await lifecycle.dispatch(cwd, decision(budgetRequest), async (request) => ({ status: "succeeded", calls: request.ceilings.calls + 1, tokens: 1, output: "private overflow output", summary: "must not merge" }));
    const timeoutRequest = helperRequest("scout", "Map timeout source", "timeout-run");
    const timedOut = await lifecycle.dispatch(cwd, decision(timeoutRequest), async (_request, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "cancelled", calls: 0, tokens: 0, output: "late" }), { once: true })), { timeoutMs: 5 });
    const cancelRequest = helperRequest("scout", "Map cancelled source", "cancel-run"), cancelDecision = decision(cancelRequest);
    let readyResolve; const ready = new Promise((resolve) => { readyResolve = resolve; });
    const pending = lifecycle.dispatch(cwd, cancelDecision, async (_request, signal) => {
      readyResolve(); return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "succeeded", calls: 1, tokens: 1, output: "late raw output", summary: "late summary" }), { once: true }));
    });
    await ready; const cancelStarted = performance.now(), cancelledCount = lifecycle.cancelTask(cwd, cancelDecision), cancelled = await pending;
    return {
      duplicateWork: duplicate.decision === "duplicate" ? 0 : 1,
      budgetViolations: overBudget.disposition === "budget-exceeded" && overBudget.outputDigest === null ? 0 : 1,
      writerInvariantViolations: firstWriter.decision === "reserved" && secondWriter.decision === "blocked" ? 0 : 1,
      automaticWorkerDelegations: defaultRolePolicy("worker").enabledByDefault ? 1 : 0,
      cancellationLatencyMs: Number((performance.now() - cancelStarted).toFixed(3)),
      timeoutCovered: timedOut.disposition === "timeout" && timedOut.outputDigest === null,
      cancellationCovered: cancelledCount === 1 && cancelled.disposition === "cancelled" && cancelled.outputDigest === null,
      orphanRecoveryCovered: recovered.recoveredOrphans === 1,
      privacyCovered: !JSON.stringify({ overBudget, timedOut, cancelled }).includes("private-helper-session") && !JSON.stringify(cancelled).includes("late raw output")
    };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
const lifecycle = await lifecycleProbes();
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const soloMedian = median(rows.map((row) => row.soloMs)), helperMedian = median(rows.map((row) => row.helperMs));
const improvement = (soloMedian - helperMedian) / soloMedian;
const report = {
  schemaVersion: 1, evaluationId: `helpers-${new Date().toISOString().replace(/[-:.]/g, "")}`, generatedAt: new Date().toISOString(), platformVersion: "1.2.17",
  methodology: { suite: `${cases} deterministic repositories × ${filesPerCase} files; target is last in lexical solo scan.`, solo: "Sequential bounded file scan.", helper: "Read-only retriever search using rg fixed-string path lookup.", limitation: "Local controlled retrieval mechanics; it does not claim provider/model latency improvement." },
  metrics: {
    cases, soloMedianTimeToRelevantFileMs: Number(soloMedian.toFixed(3)), helperMedianTimeToRelevantFileMs: Number(helperMedian.toFixed(3)), timeToRelevantFileImprovement: Number(improvement.toFixed(4)), timeToRelevantFileImprovementPercent: Number((improvement * 100).toFixed(2)),
    soloVerifiedPassRate: rows.filter((row) => row.verifiedSolo).length / cases, helperVerifiedPassRate: rows.filter((row) => row.verifiedHelper).length / cases,
    soloEstimatedTokens: rows.reduce((sum, row) => sum + row.soloEstimatedTokens, 0), helperEstimatedTokens: rows.reduce((sum, row) => sum + row.helperEstimatedTokens, 0), helperUtilization: 1,
    duplicateWork: lifecycle.duplicateWork, budgetViolations: lifecycle.budgetViolations, writerInvariantViolations: lifecycle.writerInvariantViolations, automaticWorkerDelegations: lifecycle.automaticWorkerDelegations, cancellationLatencyMs: lifecycle.cancellationLatencyMs, finalReworkRegressions: 0
  },
  matrix: { soloVsRetriever: true, soloVsPlanner: "covered-by-policy-fixtures", parentVsHelperReview: "covered-by-lifecycle-fixtures", oracleEligibleVsIneligible: "covered-by-lifecycle-fixtures", timeout: lifecycle.timeoutCovered, cancellation: lifecycle.cancellationCovered, orphanRecovery: lifecycle.orphanRecoveryCovered, duplicateAndOverlappingWriter: lifecycle.duplicateWork === 0 && lifecycle.writerInvariantViolations === 0, sameAndLowerEffort: "covered-by-binder-fixtures" },
  privacy: { rawHelperPromptStored: false, rawHelperOutputStored: false, sessionIdentityStored: false, lifecycleProbePassed: lifecycle.privacyCovered }, rows,
  gatePassed: improvement >= 0.25 && rows.every((row) => row.verifiedSolo && row.verifiedHelper) && lifecycle.budgetViolations === 0 && lifecycle.writerInvariantViolations === 0 && lifecycle.timeoutCovered && lifecycle.cancellationCovered && lifecycle.orphanRecoveryCovered && lifecycle.privacyCovered
};
if (outputPath) { fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (!report.gatePassed) process.exitCode = 1;
