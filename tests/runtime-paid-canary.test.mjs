import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateRuntimePaidCanary } from "../evals/runtime-conformance-v1/evaluate-paid-canary.mjs";

const root = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(fs.readFileSync(path.join(root, "evals/runtime-conformance-v1/paid-canary.json"), "utf8"));
const model = policy.model;

function usage(total, subagentSessions = 0, subagentTotal = 0) {
  const input = Math.floor(total * 0.75), output = total - input;
  return {
    input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    fresh: input + output, total, sessions: 1 + subagentSessions,
    subagentSessions,
    subagentTokens: { input: 0, output: 0, cacheRead: subagentTotal, cacheWrite: 0, reasoning: 0, fresh: 0, total: subagentTotal },
    model, thinkingLevel: "medium", usageCompleteness: "exact"
  };
}

function run(scenarioId, surface, total) {
  return {
    scenarioId, surface, repeat: 1, resolved: true,
    grade: { passed: true, score: 10 }, workflow: { score: 10 },
    usageStatus: "measured", usage: usage(total),
    infrastructureAttempts: 1, infrastructureRetries: 0, infrastructureFailures: [],
    promptHash: "a".repeat(64), variant: { fixtureDigest: "b".repeat(64) }
  };
}

function report(candidateRatio = 0.5) {
  const runs = policy.scenarioIds.flatMap((scenarioId, index) => [
    run(scenarioId, "codex-cli", 100_000),
    run(scenarioId, "piagent", 100_000 * (Array.isArray(candidateRatio) ? candidateRatio[index] : candidateRatio))
  ]);
  return {
    runId: "runtime-p0-canary-test",
    suite: { id: policy.suiteId }, repeats: 1, runs,
    environment: { requestedModel: model, requestedThinking: "medium" },
    infrastructure: { retries: 0 },
    comparison: {
      baselineSurface: "codex-cli", candidateSurface: "piagent",
      providerWireSurfaceGate: true, causalContextEvidenceGate: true,
      candidateTaskContinuityGate: true, pairedRegressionGate: true,
      pairedQualityNoninferiorityGate: true, qualityNonInferior: true
    },
    surfaces: {
      codexCli: { surface: "codex-cli", scores: { quality: 10, safety: 10, reliability: 10 } },
      piagent: { surface: "piagent", scores: { quality: 10, safety: 10, reliability: 10, workflow: 10 } }
    }
  };
}

test("paid runtime canary uses futility guardrails while final confidence remains diagnostic", () => {
  const value = report([0.15, 0.36, 0.93, 0.93]);
  const temporal = policy.scenarioIds.at(-1);
  value.runs.find((run) => run.scenarioId === temporal && run.surface === "codex-cli").usage = usage(400_000);
  value.runs.find((run) => run.scenarioId === temporal && run.surface === "piagent").usage = usage(350_000);
  const result = evaluateRuntimePaidCanary(value);
  assert.equal(result.passed, true, result.failures.join(", "));
  assert.equal(result.observedSessions, 8);
  assert.equal(result.spendChecks["pooled-total-token-traffic-guardrail"], true);
  assert.equal(result.spendChecks["family-total-token-traffic-guardrail"], true);
  assert.equal(result.diagnostics["target-total-token-traffic-upper95"], false);
  assert.equal(result.diagnostics["api-equivalent-cost-complete"], false);
  assert.equal(result.diagnostics.decisionRole, "nonblocking-until-s108");
});

test("paid runtime canary fails closed on regression, retry, or token traffic above target", () => {
  const value = report(1.3);
  value.runs.find((run) => run.surface === "piagent").infrastructureRetries = 1;
  value.comparison.pairedRegressionGate = false;
  const result = evaluateRuntimePaidCanary(value);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes("no-infrastructure-retry"));
  assert.ok(result.failures.includes("no-paired-regression"));
  assert.ok(result.failures.includes("spend:pooled-total-token-traffic-guardrail"));
  assert.ok(result.failures.includes("spend:family-total-token-traffic-guardrail"));
});
