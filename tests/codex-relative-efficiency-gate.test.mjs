import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  CODEX_RELATIVE_EFFICIENCY_POLICY,
  evaluateCodexRelativeEfficiency
} from "../packages/piagent-core/benchmark/benchmark-codex-relative-efficiency.js";

const model = "openai-codex/gpt-5.6-luna";
const thinking = "medium";
const promptHash = "1".repeat(64);
const fixtureDigest = "2".repeat(64);
const pricingSnapshot = {
  schemaVersion: 1,
  id: "openai-gpt-5-6-luna-2026-08-22",
  model,
  currency: "USD",
  unitTokens: 1_000_000,
  rates: { freshInput: 0.2, cachedInput: 0.02, output: 1.2 },
  cacheWrite: { basis: "fresh-input", multiplier: 1.25 },
  longContext: {
    thresholdInputTokens: 272_000,
    condition: "per-request-input-greater-than",
    inputMultiplier: 2,
    outputMultiplier: 1.5
  },
  source: {
    url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    retrievedAt: "2026-08-22"
  }
};
const suite = {
  executionContract: { surfaces: ["piagent", "codex-cli"], model, thinking, codexMode: "controlled" },
  pricingSnapshot,
  scenarios: ["backend-change", "frontend-change", "platform-change"].map((id) => ({ id }))
};

function tokenBucket({ input, output, cacheRead = 0, cacheWrite = 0, subagentSessions = 0, subagentTotal = 0 }) {
  const total = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: 0,
    fresh: input + output,
    total,
    sessions: 1 + subagentSessions,
    subagentSessions,
    subagentTokens: {
      input: 0,
      output: 0,
      cacheRead: subagentTotal,
      cacheWrite: 0,
      reasoning: 0,
      fresh: 0,
      total: subagentTotal
    },
    model,
    thinkingLevel: thinking,
    usageCompleteness: "exact"
  };
}

function run(scenarioId, surface, repeat, usage) {
  return {
    scenarioId,
    surface,
    repeat,
    resolved: true,
    usageStatus: "measured",
    usage,
    infrastructureAttempts: 1,
    infrastructureRetries: 0,
    infrastructureFailures: [],
    promptHash,
    variant: { generated: true, fixtureDigest }
  };
}

function pairs(candidateUsage = () => tokenBucket({ input: 20_000, output: 5_000, cacheRead: 20_000 })) {
  const values = [];
  for (const scenario of suite.scenarios) {
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      values.push({
        baseline: run(scenario.id, "codex-cli", repeat, tokenBucket({ input: 50_000, output: 10_000, cacheRead: 50_000 })),
        candidate: run(scenario.id, "piagent", repeat, candidateUsage(scenario.id, repeat))
      });
    }
  }
  return values;
}

function evidence(allPairs = pairs()) {
  return evaluateCodexRelativeEfficiency({
    suite,
    allPairs,
    repeats: 3,
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    required: true,
    parityChecks: {
      "comparison-protocol": true,
      "equivalent-task-access-context": true,
      "full-suite": true
    },
    qualityChecks: {
      "quality-noninferior": true,
      "candidate-task-continuity": true
    }
  });
}

test("passes only when total traffic and API-equivalent cost both clear the Codex-relative 0.70 upper bound", () => {
  const result = evidence();
  assert.equal(result.passed, true);
  assert.equal(result.totalTokenTraffic.ratio, 45_000 / 110_000);
  assert.ok(result.totalTokenTraffic.ratioConfidence95Raw.upper < 0.7);
  assert.ok(result.apiEquivalentCost.ratioConfidence95Raw.upper < 0.7);
  assert.equal(result.policy.maximumTotalTokenTrafficRatioUpper95, 0.7);
  assert.equal(result.policy.maximumApiEquivalentCostRatioUpper95, 0.7);
  assert.equal(result.billedOrSubscriptionCost, false);
});

test("rejects a fresh-token win that burns more cached provider traffic than Codex CLI", () => {
  const result = evidence(pairs(() => tokenBucket({ input: 10_000, output: 5_000, cacheRead: 100_000 })));
  assert.equal(result.totalTokenTraffic.ratio > 1, true);
  assert.equal(result.checks["total-token-traffic-point"], false);
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes("total-token-traffic-point"));
});

test("rejects an output-heavy candidate whose API-equivalent cost exceeds 70% despite lower total traffic", () => {
  const result = evidence(pairs(() => tokenBucket({ input: 5_000, output: 25_000, cacheRead: 5_000 })));
  assert.ok(result.totalTokenTraffic.ratio < 0.7);
  assert.ok(result.apiEquivalentCost.ratio > 0.7);
  assert.equal(result.checks["api-equivalent-cost-point"], false);
  assert.equal(result.passed, false);
});

test("fails closed when aggregate evidence cannot price a request above the long-context threshold", () => {
  const result = evidence(pairs(() => tokenBucket({ input: 100_000, output: 5_000, cacheRead: 180_000 })));
  assert.equal(result.totalTokenTraffic.complete, true, "exact token traffic must remain measurable independently of pricing applicability");
  assert.ok(Number.isFinite(result.totalTokenTraffic.ratio));
  assert.equal(result.apiEquivalentCost.complete, false);
  assert.equal(result.checks["fixed-workload-api-equivalent-cost-complete"], false);
  assert.ok(result.families[0].issues.some((issue) => issue.includes("long-context-per-request-usage-unavailable")));
  assert.equal(result.passed, false);
});

test("rejects fractional token buckets even when their arithmetic invariants balance", () => {
  const fractional = pairs();
  fractional[0].candidate.usage.input += 0.5;
  fractional[0].candidate.usage.fresh += 0.5;
  fractional[0].candidate.usage.total += 0.5;
  const result = evidence(fractional);
  assert.equal(result.totalTokenTraffic.complete, false);
  assert.ok(result.families[0].issues.includes("candidate:accepted-usage-not-exact"));
  assert.equal(result.passed, false);
});

test("includes exact failed attempts and caps subagent sessions and traffic", () => {
  const withFailure = pairs();
  const failedUsage = tokenBucket({ input: 1_000, output: 500 });
  withFailure[0].candidate.infrastructureAttempts = 2;
  withFailure[0].candidate.infrastructureRetries = 1;
  withFailure[0].candidate.infrastructureFailures.push({ usageStatus: "measured", usage: failedUsage });
  const accounted = evidence(withFailure);
  assert.equal(accounted.families[0].candidateTokenTraffic, (45_000 * 3) + 1_500);

  const delegated = evidence(pairs(() => tokenBucket({
    input: 20_000,
    output: 5_000,
    cacheRead: 20_000,
    subagentSessions: 2,
    subagentTotal: 10_000
  })));
  assert.equal(delegated.checks["subagent-session-budget"], false);
  assert.equal(delegated.checks["subagent-traffic-budget"], false);
  assert.equal(delegated.passed, false);
});

test("counts failed-attempt subagents and fails closed when their evidence is missing", () => {
  const withDelegatedFailure = pairs();
  withDelegatedFailure[0].candidate.infrastructureAttempts = 2;
  withDelegatedFailure[0].candidate.infrastructureRetries = 1;
  withDelegatedFailure[0].candidate.infrastructureFailures.push({
    usageStatus: "measured",
    usage: tokenBucket({
      input: 1_000,
      output: 500,
      cacheRead: 30_000,
      subagentSessions: 2,
      subagentTotal: 30_000
    })
  });
  const delegated = evidence(withDelegatedFailure);
  assert.equal(delegated.subagents.candidateAttempts, 10);
  assert.equal(delegated.subagents.sessions, 2);
  assert.equal(delegated.subagents.tokenTraffic, 30_000);
  assert.equal(delegated.subagents.maximumObservedSessionsPerAttempt, 2);
  assert.equal(delegated.checks["subagent-session-budget"], false);
  assert.equal(delegated.checks["subagent-traffic-budget"], false);

  const missing = pairs();
  const missingUsage = tokenBucket({ input: 1_000, output: 500 });
  delete missingUsage.subagentTokens;
  missing[0].candidate.infrastructureAttempts = 2;
  missing[0].candidate.infrastructureRetries = 1;
  missing[0].candidate.infrastructureFailures.push({ usageStatus: "measured", usage: missingUsage });
  const incomplete = evidence(missing);
  assert.equal(incomplete.checks["subagent-usage-complete"], false);
  assert.ok(incomplete.families[0].issues.includes("candidate:failed-attempt-subagent-usage-not-exact"));
  assert.equal(incomplete.passed, false);
});

test("reconciles attempt ledgers and refuses unexplained candidate sessions", () => {
  const omittedAttempt = pairs();
  omittedAttempt[0].candidate.infrastructureAttempts = 2;
  const omitted = evidence(omittedAttempt);
  assert.equal(omitted.totalTokenTraffic.complete, false);
  assert.equal(omitted.checks["subagent-usage-complete"], false);
  assert.ok(omitted.families[0].issues.includes("candidate:failed-attempt-ledger-mismatch"));
  assert.ok(omitted.families[0].issues.includes("candidate:failed-attempt-subagent-ledger-mismatch"));

  const hiddenSessions = pairs();
  hiddenSessions[0].candidate.usage.sessions = 3;
  const hidden = evidence(hiddenSessions);
  assert.equal(hidden.checks["subagent-usage-complete"], false);
  assert.ok(hidden.families[0].issues.includes("candidate:subagent-usage-not-exact"));
  assert.equal(hidden.passed, false);
});

test("requires task/model/effort parity and no quality or continuity regression", () => {
  const mismatched = pairs();
  mismatched[0].candidate.usage.thinkingLevel = "high";
  mismatched[1].candidate.promptHash = "3".repeat(64);
  const result = evaluateCodexRelativeEfficiency({
    suite,
    allPairs: mismatched,
    repeats: 3,
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    required: true,
    parityChecks: { "comparison-protocol": true, "equivalent-task-access-context": true },
    qualityChecks: { "quality-noninferior": false, "candidate-task-continuity": true }
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.includes("quality-noninferior"));
  assert.ok(result.families[0].issues.includes("candidate:accepted-thinking-mismatch"));
  assert.ok(result.families[0].issues.includes("paired-prompt-mismatch"));
});

test("emits evidence conforming to the public schema", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../schemas/codex-relative-efficiency-v1.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const result = evidence();
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(result.policy, CODEX_RELATIVE_EFFICIENCY_POLICY);
});
