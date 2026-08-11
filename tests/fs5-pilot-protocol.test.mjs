import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  evaluateFs5StageGate,
  fs5PilotProtocolValidationErrors,
  fs5StageArguments
} from "../packages/piagent-core/benchmark/fs5-pilot-protocol.js";

const root = path.resolve(import.meta.dirname, "..");
const protocolPath = path.join(root, "evals", "fs5-pilot-protocol.v1.json");
const protocolV2Path = path.join(root, "evals", "fs5-pilot-protocol.v2.json");
const protocolV3Path = path.join(root, "evals", "fs5-pilot-protocol.v3.json");
const protocolV4Path = path.join(root, "evals", "fs5-pilot-protocol.v4.json");
const protocolV5Path = path.join(root, "evals", "fs5-pilot-protocol.v5.json");
const protocol = JSON.parse(fs.readFileSync(protocolPath, "utf8"));
const protocolV2 = JSON.parse(fs.readFileSync(protocolV2Path, "utf8"));
const protocolV3 = JSON.parse(fs.readFileSync(protocolV3Path, "utf8"));
const protocolV4 = JSON.parse(fs.readFileSync(protocolV4Path, "utf8"));
const protocolV5 = JSON.parse(fs.readFileSync(protocolV5Path, "utf8"));

function clone(value = protocol) {
  return structuredClone(value);
}

test("freezes the exact Piagent-versus-Codex Luna Medium product protocol", () => {
  assert.deepEqual(fs5PilotProtocolValidationErrors(protocol), []);
  assert.equal(protocol.comparison.baselineSurface, "codex-cli");
  assert.equal(protocol.comparison.rawPiReleaseBaselineAllowed, false);
  assert.equal(protocol.comparison.model, "openai-codex/gpt-5.6-luna");
  assert.equal(protocol.comparison.thinking, "medium");
  assert.equal(protocol.comparison.piagentTreatment, "local-safe");
  assert.deepEqual(protocol.stages.map((stage) => stage.maxSessions), [2, 2, 12]);
});

test("binds every declared protocol artifact to the current bytes", () => {
  for (const value of [protocol, protocolV4, protocolV5]) {
    for (const artifact of value.artifactBindings) {
      const bytes = fs.readFileSync(path.join(root, artifact.path));
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), artifact.sha256, `${value.id}:${artifact.path}`);
    }
  }
});

test("freezes FS5 v2 with one transparent known-zero provider retry and new run identity", () => {
  assert.deepEqual(fs5PilotProtocolValidationErrors(protocolV2), []);
  assert.equal(protocolV2.advanceGate.infrastructureRetries, 1);
  assert.deepEqual(protocolV2.stages.map((stage) => stage.infrastructureRetries), [1, 1, 1]);
  assert.deepEqual(protocolV2.stages.map((stage) => stage.retryDelaySeconds), [15, 15, 15]);
  assert.equal(protocolV2.stages.every((stage) => stage.seed.endsWith("-v2")), true);
  assert.equal(protocolV2.usageContract.unknownUsageRetryAllowsAdvance, false);
  const args = fs5StageArguments(protocolV2, "six-family-pilot", { mode: "execute", operatorAuthorized: true });
  assert.deepEqual(args.slice(args.indexOf("--infrastructure-retries"), args.indexOf("--infrastructure-retries") + 4), [
    "--infrastructure-retries", "1", "--retry-delay", "15"
  ]);
});

test("freezes FS5 v3 after the v2 blocked-call upper-bound evidence gap", () => {
  assert.deepEqual(fs5PilotProtocolValidationErrors(protocolV3), []);
  assert.equal(protocolV3.stages.every((stage) => stage.seed.endsWith("-v3")), true);
  assert.equal(protocolV3.artifactBindings.some((item) => item.id === "failure-and-operational-classifier"), true);
});

test("freezes FS5 v4 as one privacy-safe bounded-retry adjudication before any larger stage", () => {
  assert.deepEqual(fs5PilotProtocolValidationErrors(protocolV4), []);
  assert.deepEqual(protocolV4.stages.map((stage) => stage.id), [
    "bounded-retry-adjudication", "canary-a-fullstack", "canary-b-migration", "six-family-pilot"
  ]);
  assert.equal(protocolV4.stages[0].scenarioIds[0], "bounded-retry");
  assert.equal(protocolV4.stages[0].maxSessions, 2);
  assert.equal(protocolV4.stopRules.adjudicationMaximumPairs, 1);
  assert.equal(protocolV4.stopRules.adjudicationPassRelabelsHistoricalRun, false);
  assert.equal(protocolV4.phaseAttributionContract.rawCommandsPathsPromptsRetained, false);
  const args = fs5StageArguments(protocolV4, "bounded-retry-adjudication", { mode: "execute", operatorAuthorized: true });
  assert.deepEqual(args.slice(args.indexOf("--scenarios"), args.indexOf("--scenarios") + 4), [
    "--scenarios", "bounded-retry", "--seed", "cf-fs5-bounded-retry-adjudication-luna-medium-v4"
  ]);
});

test("freezes FS5 v5 as the only post-infrastructure adjudication without a paid automatic retry", () => {
  assert.deepEqual(fs5PilotProtocolValidationErrors(protocolV5), []);
  assert.equal(protocolV5.stages[0].seed, "cf-fs5-bounded-retry-adjudication-luna-medium-v5");
  assert.equal(protocolV5.stages[0].prerequisites.includes("CF-FS5-04-v4-provider-infrastructure-stop"), true);
  assert.equal(protocolV5.stopRules.priorProviderInfrastructureOccurrences, 1);
  assert.equal(protocolV5.stopRules.paidTerminalProviderFailureClosesLane, true);
  assert.equal(protocolV5.stopRules.paidTerminalProviderFailureAllowsAutomaticRetry, false);
  assert.equal(protocolV5.stopRules.validCompletedPairRequiredToAdvance, true);
  const args = fs5StageArguments(protocolV5, "bounded-retry-adjudication", { mode: "execute", operatorAuthorized: true });
  assert.deepEqual(args.slice(args.indexOf("--scenarios"), args.indexOf("--scenarios") + 4), [
    "--scenarios", "bounded-retry", "--seed", "cf-fs5-bounded-retry-adjudication-luna-medium-v5"
  ]);

  for (const field of [
    "priorProviderInfrastructureOccurrences",
    "paidTerminalProviderFailureClosesLane",
    "paidTerminalProviderFailureAllowsAutomaticRetry",
    "validCompletedPairRequiredToAdvance"
  ]) {
    const unsafe = structuredClone(protocolV5);
    delete unsafe.stopRules[field];
    assert.notDeepEqual(fs5PilotProtocolValidationErrors(unsafe), []);
  }
});

test("builds dry-run and provider-free preflight commands without execution authority", () => {
  const dryRun = fs5StageArguments(protocol, "canary-a-fullstack");
  assert.equal(dryRun.includes("--dry-run"), true);
  assert.equal(dryRun.includes("--yes"), false);
  assert.deepEqual(dryRun.slice(0, 12), [
    "--suite", "capability-v1",
    "--surfaces", "piagent,codex-cli",
    "--model", "openai-codex/gpt-5.6-luna",
    "--thinking", "medium",
    "--codex-mode", "controlled",
    "--piagent-treatment", "local-safe"
  ]);
  const preflight = fs5StageArguments(protocol, "canary-b-migration", { mode: "preflight" });
  assert.equal(preflight.includes("--preflight-only"), true);
  assert.equal(preflight.includes("--json"), true);
  assert.equal(preflight.includes("--yes"), false);
  assert.throws(() => fs5StageArguments(protocol, "canary-a-fullstack", { mode: "execute" }), /explicit operator authorization/);
  assert.equal(fs5StageArguments(protocol, "canary-a-fullstack", { mode: "execute", operatorAuthorized: true }).at(-1), "--yes");
});

test("rejects parity, retry, usage, stop-budget and claim-boundary drift", () => {
  const mutations = [
    (value) => { value.comparison.baselineSurface = "raw-pi"; },
    (value) => { value.comparison.thinking = "high"; },
    (value) => { value.stages[0].infrastructureRetries = 1; },
    (value) => { value.stages[1].maxSessions = 3; },
    (value) => { value.usageContract.unknownUsageAllowsAdvance = true; },
    (value) => { value.advanceGate.maxSystemContinuations = 2; },
    (value) => { value.stopRules.thirdProviderRunForSameFailureClassAllowed = true; },
    (value) => { value.claimBoundary.tokenSavingClaimAllowed = true; }
  ];
  for (const mutate of mutations) {
    const value = clone();
    mutate(value);
    assert.notDeepEqual(fs5PilotProtocolValidationErrors(value), []);
  }
});

test("keeps canary B and the pilot causally gated behind smaller stages", () => {
  const canaryB = protocol.stages.find((stage) => stage.id === "canary-b-migration");
  const pilot = protocol.stages.find((stage) => stage.id === "six-family-pilot");
  assert.equal(canaryB.prerequisites.includes("canary-a-fullstack-passed"), true);
  assert.equal(pilot.prerequisites.includes("both-canaries-passed"), true);
  assert.equal(protocol.stopRules.largerStageOnFailedSmallerGateAllowed, false);
  assert.equal(protocol.claimBoundary.releaseBenchmarkWorkItem, "CF-FS7-03");
});

function passingPair() {
  return {
    candidate: {
      resolved: true, grade: 10, scopePass: true, safety: 10, workflow: 10,
      usageStatus: "measured", infrastructureRetries: 0, freshTokens: 100,
      durationSeconds: 100, systemContinuations: 1,
      shadowAdvisoryAddedContinuations: 0, blockedValidCalls: 0,
      operationalEvidenceAvailable: true, phaseAttributionAvailable: true
    },
    baseline: {
      resolved: true, grade: 10, scopePass: true, safety: 10,
      usageStatus: "measured", infrastructureRetries: 0,
      freshTokens: 100, durationSeconds: 100
    },
    pairedRegression: false
  };
}

function recoveredPair() {
  const value = passingPair();
  value.candidate.infrastructureRetries = 1;
  value.candidate.infrastructureFailures = [{
    class: "provider-infrastructure",
    usageStatus: "measured-but-unaccepted",
    usage: { fresh: 0 }
  }];
  return value;
}

test("advances one stage only when every finite engineering stop passes", () => {
  const decision = evaluateFs5StageGate(protocol, "canary-a-fullstack", passingPair());
  assert.equal(decision.passed, true);
  assert.equal(decision.nextStage, "canary-b-migration");
  assert.equal(decision.freshTokenRatio, 1);
  assert.equal(decision.durationRatio, 1);
});

test("stops on workflow, unknown usage, retry, blocked calls, ratios, regression or repeated failure class", () => {
  const mutations = [
    (value) => { value.candidate.workflow = 9.5; },
    (value) => { value.candidate.operationalEvidenceAvailable = false; },
    (value) => { value.candidate.usageStatus = "unknown-after-provider-start"; },
    (value) => { value.baseline.infrastructureRetries = 1; },
    (value) => { value.candidate.blockedValidCalls = 1; },
    (value) => { value.candidate.freshTokens = 126; },
    (value) => { value.candidate.durationSeconds = 151; },
    (value) => { value.pairedRegression = true; }
  ];
  for (const mutate of mutations) {
    const value = passingPair();
    mutate(value);
    assert.equal(evaluateFs5StageGate(protocol, "canary-a-fullstack", value).allowedToAdvance, false);
  }
  const repeated = evaluateFs5StageGate(protocol, "canary-a-fullstack", passingPair(), { failureClassOccurrences: 2 });
  assert.equal(repeated.providerLaneStopped, true);
  assert.equal(repeated.allowedToAdvance, false);
  assert.equal(repeated.blockers.includes("repeated-failure-class-stop"), true);
});

test("v2 advances after at most one exact measured-zero provider retry and rejects every other retry class", () => {
  assert.equal(evaluateFs5StageGate(protocolV2, "canary-a-fullstack", passingPair()).allowedToAdvance, true);
  assert.equal(evaluateFs5StageGate(protocolV2, "canary-a-fullstack", recoveredPair()).allowedToAdvance, true);
  const unknown = recoveredPair();
  unknown.candidate.infrastructureFailures[0] = {
    class: "unknown-cost", usageStatus: "unknown-after-provider-start", usage: { fresh: null }
  };
  assert.equal(evaluateFs5StageGate(protocolV2, "canary-a-fullstack", unknown).blockers.includes("piagent:retry-class"), true);
  const excessive = recoveredPair();
  excessive.candidate.infrastructureRetries = 2;
  excessive.candidate.infrastructureFailures.push(structuredClone(excessive.candidate.infrastructureFailures[0]));
  assert.equal(evaluateFs5StageGate(protocolV2, "canary-a-fullstack", excessive).blockers.includes("piagent:retry"), true);
  const malformed = clone(protocolV2);
  malformed.usageContract.unknownUsageRetryAllowsAdvance = true;
  assert.notDeepEqual(fs5PilotProtocolValidationErrors(malformed), []);
});

test("v4 adjudicates the historical performance outlier exactly once without relabeling it", () => {
  const pass = passingPair();
  pass.scenarioId = "bounded-retry";
  const accepted = evaluateFs5StageGate(protocolV4, "bounded-retry-adjudication", pass, { failureClassOccurrences: 1 });
  assert.equal(accepted.allowedToAdvance, true);
  assert.equal(accepted.nextStage, "canary-a-fullstack");
  assert.equal(accepted.providerLaneStopped, false);

  const missingAttribution = structuredClone(pass);
  missingAttribution.candidate.phaseAttributionAvailable = false;
  assert.equal(
    evaluateFs5StageGate(protocolV4, "bounded-retry-adjudication", missingAttribution, { failureClassOccurrences: 1 }).blockers.includes("piagent:phase-attribution"),
    true
  );

  const repeated = structuredClone(pass);
  repeated.candidate.freshTokens = 126;
  const stopped = evaluateFs5StageGate(protocolV4, "bounded-retry-adjudication", repeated, { failureClassOccurrences: 2 });
  assert.equal(stopped.allowedToAdvance, false);
  assert.equal(stopped.providerLaneStopped, true);
  assert.equal(stopped.blockers.includes("fresh-token-engineering-stop"), true);
  assert.equal(stopped.blockers.includes("repeated-failure-class-stop"), true);

  const unsafePaidFailure = structuredClone(protocolV4);
  delete unsafePaidFailure.usageContract.paidTerminalProviderFailure;
  assert.match(fs5PilotProtocolValidationErrors(unsafePaidFailure).join("; "), /terminal provider errors after paid usage/);

  const wrongFamily = structuredClone(pass);
  wrongFamily.scenarioId = "quoted-csv";
  assert.equal(
    evaluateFs5StageGate(protocolV4, "bounded-retry-adjudication", wrongFamily, { failureClassOccurrences: 1 }).blockers.includes("adjudication-scenario-mismatch"),
    true
  );

  const unsafe = structuredClone(protocolV4);
  unsafe.phaseAttributionContract.rawCommandsPathsPromptsRetained = true;
  assert.notDeepEqual(fs5PilotProtocolValidationErrors(unsafe), []);
});

test("v5 advances only a valid completed pair and closes on a second provider failure", () => {
  const pass = passingPair();
  pass.scenarioId = "bounded-retry";
  assert.equal(
    evaluateFs5StageGate(protocolV5, "bounded-retry-adjudication", pass, { failureClassOccurrences: 1 }).allowedToAdvance,
    true
  );

  const paidTerminal = structuredClone(pass);
  paidTerminal.candidate.resolved = false;
  paidTerminal.candidate.usageStatus = "measured-but-unaccepted";
  paidTerminal.candidate.infrastructureFailures = [{
    class: "provider-infrastructure",
    usageStatus: "measured-but-unaccepted",
    usage: { fresh: 3478 }
  }];
  const stopped = evaluateFs5StageGate(protocolV5, "bounded-retry-adjudication", paidTerminal, { failureClassOccurrences: 2 });
  assert.equal(stopped.allowedToAdvance, false);
  assert.equal(stopped.providerLaneStopped, true);
  assert.equal(stopped.blockers.includes("piagent:unresolved"), true);
  assert.equal(stopped.blockers.includes("piagent:usage"), true);
  assert.equal(stopped.blockers.includes("repeated-failure-class-stop"), true);
});
