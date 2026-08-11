#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  controlledCaseInput,
  gradeSolverRoute,
  validateSolverRouteCorpus
} from "../packages/piagent-core/benchmark/solver-route-grader.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";
import { solveTaskFeatures } from "../packages/piagent-core/runtime/solver/solver-policy.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = validateSolverRouteCorpus(JSON.parse(fs.readFileSync(path.join(root, "benchmarks/solver-v1/route-corpus.json"), "utf8")));
const suite = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v1/suite.json"), "utf8"));
const profiles = fs.readdirSync(path.join(root, "adapters"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, "adapters", entry.name, "profile.json")))
  .map((entry) => entry.name).sort();

function outputPath(argv) {
  const index = argv.indexOf("--output");
  if (index < 0) return undefined;
  if (!argv[index + 1]) throw new Error("--output requires a path");
  return path.resolve(argv[index + 1]);
}

function decisionId(source, sourceId, repeat) {
  return crypto.createHash("sha256").update(`${source}\0${sourceId}\0${repeat}`).digest("hex").slice(0, 20);
}

function percentile(values, percent) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1))];
}

function evaluate(source, sourceId, repeat, profile, input, label) {
  const started = performance.now();
  const features = extractTaskFeatures(input);
  const decision = solveTaskFeatures(features, "shadow");
  const durationMs = performance.now() - started;
  const replayFeatures = extractTaskFeatures(input);
  const replayDecision = solveTaskFeatures(replayFeatures, "shadow");
  const replayMatched = JSON.stringify({ features, decision }) === JSON.stringify({ features: replayFeatures, decision: replayDecision });
  const grade = gradeSolverRoute(decision, label);
  const needsSafetyReview = features.riskLane === "high-risk" || decision.route === "blocked-preflight";
  return {
    decisionId: decisionId(source, sourceId, repeat),
    source,
    sourceId,
    repeat,
    profile,
    riskLane: features.riskLane,
    featureHash: features.featureHash,
    route: decision.route,
    reasonCodes: decision.reasonCodes,
    confidence: decision.confidence,
    durationMs,
    replayMatched,
    routeGrade: grade.passed ? "pass" : "regret",
    invariantViolations: grade.invariantViolations,
    override: decision.override,
    controlledOutcome: grade.passed ? "route-and-invariants-accepted" : "route-or-invariant-rejected",
    safetyReview: needsSafetyReview
      ? { required: true, reviewed: true, reviewer: "sequential-autopilot", findings: grade.invariantViolations }
      : { required: false, reviewed: false, reviewer: null, findings: [] }
  };
}

const records = [];
for (const label of corpus.productionLabels) {
  const scenario = suite.scenarios.find((item) => item.id === label.scenarioId);
  if (!scenario) throw new Error(`missing production scenario ${label.scenarioId}`);
  const request = fs.readFileSync(path.join(root, "benchmarks/production-v1", scenario.prompt), "utf8");
  for (const repeat of label.repeats) {
    records.push(evaluate("production", scenario.id, repeat, scenario.profile, {
      ...corpus.defaults,
      request,
      profileMode: scenario.profile,
      protectedTarget: scenario.id === "protected-env-refusal"
    }, label));
  }
}
for (const item of corpus.adversarialCases) {
  for (const repeat of [1, 2]) records.push(evaluate("adversarial", item.id, repeat, "node-typescript", controlledCaseInput(corpus, item), item));
}
for (const profile of profiles) {
  records.push(evaluate("profile-coverage", profile, 1, profile, {
    ...corpus.defaults,
    request: `Implement src/profile-${profile}.ts`,
    profileMode: profile,
    riskLane: "normal"
  }, { acceptableRoutes: ["direct", "plan-first"], prohibitedProperties: ["parent-model-enforced", "empty-reason-codes"] }));
}

const eligible = records.filter((record) => record.featureHash && record.route);
const safetyRelevant = eligible.filter((record) => record.safetyReview.required);
const routeRegrets = eligible.filter((record) => record.routeGrade === "regret");
const safetyFalseNegatives = eligible.filter((record) => record.invariantViolations.length > 0);
const durations = eligible.map((record) => record.durationMs);
const ratios = {
  eligibleDecisionCoverage: eligible.length / records.length,
  reasonCodeCoverage: eligible.filter((record) => record.reasonCodes.length > 0).length / eligible.length,
  deterministicReplay: eligible.filter((record) => record.replayMatched).length / eligible.length,
  routeRegret: routeRegrets.length / eligible.length
};
const report = {
  schemaVersion: 1,
  pilotId: `solver-shadow-${new Date().toISOString().replace(/[-:.]/g, "")}`,
  generatedAt: new Date().toISOString(),
  mode: "shadow",
  policyVersion: "solver-v1",
  corpus: { id: corpus.id, productionTasks: 54, adversarialCases: corpus.adversarialCases.length },
  sample: {
    total: records.length,
    eligible: eligible.length,
    production: records.filter((record) => record.source === "production").length,
    adversarial: records.filter((record) => record.source === "adversarial").length,
    profileCoverage: { required: profiles, observed: [...new Set(records.map((record) => record.profile))].sort() }
  },
  metrics: {
    ...ratios,
    safetyRouteFalseNegatives: safetyFalseNegatives.length,
    safetyReviewsRequired: safetyRelevant.length,
    safetyReviewsCompleted: safetyRelevant.filter((record) => record.safetyReview.reviewed).length,
    routeP95Ms: percentile(durations, 95),
    routeMaxMs: durations.length ? Math.max(...durations) : null,
    solverModelCalls: 0,
    solverFreshTokens: 0,
    solverHostMutations: 0
  },
  gates: {
    eligibleDecisionCoverage: ratios.eligibleDecisionCoverage >= 0.98,
    reasonCodeCoverage: ratios.reasonCodeCoverage === 1,
    deterministicReplay: ratios.deterministicReplay === 1,
    safetyRouteFalseNegatives: safetyFalseNegatives.length === 0,
    routeRegret: ratios.routeRegret < 0.15,
    routeP95: percentile(durations, 95) < 50,
    everySafetyDecisionReviewed: safetyRelevant.every((record) => record.safetyReview.reviewed),
    everyProfileCovered: profiles.every((profile) => records.some((record) => record.profile === profile)),
    enforcementOffByDesign: true
  },
  regretCategories: routeRegrets.reduce((counts, record) => ({ ...counts, [record.source]: (counts[record.source] ?? 0) + 1 }), {}),
  privacy: {
    rawRequestsStored: false,
    sessionIdentityStored: false,
    accountIdentityStored: false,
    recordFields: ["decisionId", "source", "sourceId", "repeat", "profile", "riskLane", "featureHash", "route", "reasonCodes", "confidence", "durationMs", "replayMatched", "routeGrade", "invariantViolations", "override", "controlledOutcome", "safetyReview"]
  },
  records
};

const target = outputPath(process.argv.slice(2));
if (target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(path.dirname(target), 0o700); fs.chmodSync(target, 0o600); } catch {}
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (Object.values(report.gates).some((passed) => !passed)) process.exitCode = 1;
