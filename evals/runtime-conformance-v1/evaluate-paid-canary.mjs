import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_RELATIVE_EFFICIENCY_POLICY,
  evaluateCodexRelativeEfficiency
} from "../../packages/piagent-core/benchmark/benchmark-codex-relative-efficiency.js";

const laneRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(laneRoot, "../..");

function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function candidateSurface(report) {
  return Object.values(report?.surfaces ?? {}).find((surface) => surface?.surface === "piagent") ?? null;
}

function pairedRuns(report) {
  const baseline = new Map((report.runs ?? [])
    .filter((run) => run.surface === "codex-cli")
    .map((run) => [`${run.scenarioId}\0${run.repeat}`, run]));
  return (report.runs ?? [])
    .filter((run) => run.surface === "piagent")
    .map((candidate) => ({
      baseline: baseline.get(`${candidate.scenarioId}\0${candidate.repeat}`),
      candidate
    }))
    .filter((pair) => pair.baseline);
}

function exactRunKeys(report) {
  return sorted((report.runs ?? []).map((run) => `${run.scenarioId}:${run.surface}:r${run.repeat}`));
}

function expectedRunKeys(policy) {
  return sorted(policy.scenarioIds.flatMap((scenarioId) => policy.surfaces
    .map((surface) => `${scenarioId}:${surface}:r1`)));
}

function scoreAtLeast(value, floor) {
  return Number.isFinite(value) && value >= floor;
}

function scoreAbove(value, floor) {
  return Number.isFinite(value) && value > floor;
}

export function evaluateRuntimePaidCanary(report, options = {}) {
  const policy = options.policy ?? json(path.join(laneRoot, "paid-canary.json"));
  const deepSuite = options.deepSuite ?? json(path.join(repositoryRoot, "benchmarks/deep-logic-v1/suite.json"));
  const productionSuite = options.productionSuite ?? json(path.join(repositoryRoot, "benchmarks/production-v1/suite.json"));
  const scenarios = deepSuite.scenarios.filter((scenario) => policy.scenarioIds.includes(scenario.id));
  const candidate = candidateSurface(report);
  const candidateRuns = (report.runs ?? []).filter((run) => run.surface === "piagent");
  const exactOrder = JSON.stringify(exactRunKeys(report)) === JSON.stringify(expectedRunKeys(policy));
  const everyCandidateOutcomeAboveFloor = candidateRuns.length === policy.scenarioIds.length
    && candidateRuns.every((run) => run.resolved === true
      && run.grade?.passed === true
      && scoreAbove(run.grade?.score, policy.gates.minimumOutcomeScoreExclusive)
      && scoreAbove(run.workflow?.score, policy.gates.minimumOutcomeScoreExclusive));
  const noInfrastructureRetry = (report.infrastructure?.retries ?? 0) === policy.infrastructureRetries
    && (report.runs ?? []).every((run) => (run.infrastructureRetries ?? 0) === policy.infrastructureRetries
      && run.infrastructureAttempts === 1
      && Array.isArray(run.infrastructureFailures)
      && run.infrastructureFailures.length === 0);

  const contractChecks = {
    "suite-id": report.suite?.id === policy.suiteId,
    "selected-scenario-coverage": scenarios.length === policy.scenarioIds.length && exactOrder,
    "exact-session-count": (report.runs ?? []).length === policy.expectedSessions,
    "one-repeat": report.repeats === policy.repeats,
    "surface-parity": report.comparison?.baselineSurface === "codex-cli"
      && report.comparison?.candidateSurface === "piagent",
    "model-parity": report.environment?.requestedModel === policy.model
      && (report.runs ?? []).every((run) => run.usage?.model === policy.model),
    "thinking-parity": report.environment?.requestedThinking === policy.thinking
      && (report.runs ?? []).every((run) => run.usage?.thinkingLevel === policy.thinking),
    "provider-wire": report.comparison?.providerWireSurfaceGate === true,
    "causal-context-receipt": report.comparison?.causalContextEvidenceGate === true,
    "attempt-ledger": report.comparison?.infrastructureFailureLedgerGate !== false
      && report.comparison?.allAttemptUsageCompletenessGate !== false
      && report.comparison?.stabilityGate !== false,
    "no-infrastructure-retry": noInfrastructureRetry,
    "candidate-continuity": report.comparison?.candidateTaskContinuityGate === true,
    "no-paired-regression": report.comparison?.pairedRegressionGate === true,
    "paired-quality-noninferior": report.comparison?.pairedQualityNoninferiorityGate !== false,
    "candidate-quality": scoreAtLeast(candidate?.scores?.quality, policy.gates.minimumCandidateQualityScore),
    "candidate-safety": scoreAtLeast(candidate?.scores?.safety, policy.gates.minimumCandidateSafetyScore),
    "candidate-reliability": scoreAtLeast(candidate?.scores?.reliability, policy.gates.minimumCandidateReliabilityScore),
    "candidate-workflow": scoreAtLeast(candidate?.scores?.workflow, policy.gates.minimumCandidateWorkflowScore),
    "every-candidate-outcome-above-floor": everyCandidateOutcomeAboveFloor
  };

  const evaluationSuite = {
    ...deepSuite,
    defaultRepeats: policy.repeats,
    pricingSnapshot: productionSuite.pricingSnapshot,
    scenarios
  };
  const efficiencyPolicy = {
    ...CODEX_RELATIVE_EFFICIENCY_POLICY,
    maximumTotalTokenTrafficRatio: policy.gates.targetTotalTokenTrafficRatioUpper95,
    maximumTotalTokenTrafficRatioUpper95: policy.gates.targetTotalTokenTrafficRatioUpper95,
    maximumApiEquivalentCostRatio: policy.gates.targetApiEquivalentCostRatioUpper95,
    maximumApiEquivalentCostRatioUpper95: policy.gates.targetApiEquivalentCostRatioUpper95,
    maximumSubagentSessionsPerAttempt: policy.gates.maximumSubagentSessionsPerAttempt,
    maximumSubagentTrafficShare: policy.gates.maximumSubagentTrafficShare
  };
  const efficiency = evaluateCodexRelativeEfficiency({
    suite: evaluationSuite,
    allPairs: pairedRuns(report),
    repeats: policy.repeats,
    baselineSurface: report.comparison?.baselineSurface,
    candidateSurface: report.comparison?.candidateSurface,
    required: false,
    policy: efficiencyPolicy,
    parityChecks: {
      "canary-contract": Object.values(contractChecks).every(Boolean),
      "selected-workload-complete": exactOrder
    },
    qualityChecks: {
      "quality-noninferior": report.comparison?.qualityNonInferior === true,
      "candidate-task-continuity": report.comparison?.candidateTaskContinuityGate === true,
      "candidate-outcomes-above-floor": everyCandidateOutcomeAboveFloor
    }
  });
  const spendChecks = {
    "total-token-traffic-complete": efficiency.totalTokenTraffic.complete === true,
    "pooled-total-token-traffic-guardrail": Number.isFinite(efficiency.totalTokenTraffic.aggregateRatio)
      && efficiency.totalTokenTraffic.aggregateRatio <= policy.gates.maximumPooledTotalTokenTrafficRatio,
    "family-total-token-traffic-guardrail": efficiency.families.length === policy.scenarioIds.length
      && efficiency.families.every((family) => Number.isFinite(family.totalTokenTrafficRatio)
        && family.totalTokenTrafficRatio <= policy.gates.maximumFamilyTotalTokenTrafficRatio),
    "subagent-usage-complete": efficiency.checks["subagent-usage-complete"] === true,
    "subagent-session-budget": efficiency.checks["subagent-session-budget"] === true,
    "subagent-traffic-budget": efficiency.checks["subagent-traffic-budget"] === true
  };
  const diagnostics = {
    decisionRole: "nonblocking-until-s108",
    "target-total-token-traffic-point": efficiency.checks["total-token-traffic-point"],
    "target-total-token-traffic-upper95": efficiency.checks["total-token-traffic-upper95"],
    "api-equivalent-cost-complete": efficiency.checks["fixed-workload-api-equivalent-cost-complete"],
    "target-api-equivalent-cost-point": efficiency.checks["api-equivalent-cost-point"],
    "target-api-equivalent-cost-upper95": efficiency.checks["api-equivalent-cost-upper95"]
  };
  const failures = [
    ...Object.entries(contractChecks).filter(([, passed]) => !passed).map(([id]) => id),
    ...Object.entries(spendChecks).filter(([, passed]) => !passed).map(([id]) => `spend:${id}`)
  ];
  return {
    schemaVersion: 1,
    policyId: policy.id,
    sourceRunId: report.runId ?? null,
    evaluatedAt: new Date().toISOString(),
    expectedSessions: policy.expectedSessions,
    observedSessions: report.runs?.length ?? 0,
    contractChecks,
    efficiency,
    spendChecks,
    diagnostics,
    failures: [...new Set(failures)],
    passed: failures.length === 0,
    nextStep: failures.length === 0
      ? "Eligible to prepare a new clean-source production-v1 S12 stage; this canary is not a public claim."
      : "Stop paid expansion, inspect the failed checks, and rerun only after a fix.",
    claimBoundary: policy.claimBoundary
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const input = option(argv, "--report") ?? argv.find((value) => !value.startsWith("--"));
  const output = option(argv, "--output");
  if (!input) throw new Error("Usage: evaluate-paid-canary.mjs --report <report.json> [--output <receipt.json>]");
  const result = evaluateRuntimePaidCanary(json(path.resolve(input)));
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
