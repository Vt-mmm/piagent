import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  IE6_RELEASE_SCENARIOS,
  evaluateIe6Prerequisites,
  ie6ChunkPlan,
  ie6ReleaseArguments,
  ie6ReleaseProtocolValidationErrors
} from "../packages/piagent-core/benchmark/ie6-release-protocol.js";

const root = path.resolve(import.meta.dirname, "..");
const protocol = JSON.parse(fs.readFileSync(path.join(root, "evals/ie6-release-protocol.v1.json"), "utf8"));
const clone = () => structuredClone(protocol);

test("freezes the intelligence-engine Luna Medium release comparison", () => {
  assert.deepEqual(ie6ReleaseProtocolValidationErrors(protocol), []);
  assert.equal(protocol.candidate.expectedPackageVersion, "1.3.0-ie.2");
  assert.equal(protocol.comparison.baselineSurface, "codex-cli");
  assert.equal(protocol.comparison.rawPiReleaseBaselineAllowed, false);
  assert.equal(protocol.comparison.piagentTreatment, "intelligence-engine");
  assert.equal(protocol.policy.semanticRepair, "off");
  assert.equal(protocol.policy.maximumSystemContinuations, 1);
});

test("binds all 18 production families, three repeats and 18 inspected chunks", () => {
  const suite = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v1/suite.json"), "utf8"));
  assert.deepEqual(IE6_RELEASE_SCENARIOS, suite.scenarios.map((item) => item.id));
  assert.equal(new Set(suite.scenarios.map((item) => item.category)).size, 6);
  assert.equal(protocol.suite.totalSessions, 18 * 3 * 2);
  const chunks = ie6ChunkPlan(protocol);
  assert.equal(chunks.length, 18);
  assert.deepEqual(chunks[0], { chunk: 1, firstSession: 1, lastSession: 6, maximumSessions: 6, requiresInspectionBeforeNext: true });
  assert.deepEqual(chunks.at(-1), { chunk: 18, firstSession: 103, lastSession: 108, maximumSessions: 6, requiresInspectionBeforeNext: true });
});

test("binds every release-critical artifact to current bytes", () => {
  for (const artifact of protocol.artifactBindings) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, artifact.path))).digest("hex");
    assert.equal(actual, artifact.sha256, artifact.path);
  }
});

test("builds no-provider commands and denies premature execution", () => {
  const dry = ie6ReleaseArguments(protocol);
  assert.equal(dry.includes("--dry-run"), true);
  assert.equal(dry.includes("--yes"), false);
  assert.equal(dry[dry.indexOf("--max-sessions") + 1], "6");
  const preflight = ie6ReleaseArguments(protocol, { mode: "preflight" });
  assert.equal(preflight.includes("--preflight-only"), true);
  assert.equal(preflight.includes("--json"), true);
  assert.throws(() => ie6ReleaseArguments(protocol, { mode: "execute" }), /explicit operator authorization/);
  assert.throws(() => ie6ReleaseArguments(protocol, { mode: "execute", operatorAuthorized: true }), /every frozen prerequisite/);
  const execute = ie6ReleaseArguments(protocol, { mode: "execute", operatorAuthorized: true, prerequisitesPassed: true });
  assert.equal(execute.at(-1), "--yes");
});

test("keeps the release prerequisite gate closed until every field and human gate exists", () => {
  const empty = evaluateIe6Prerequisites(protocol);
  assert.equal(empty.passed, false);
  assert.equal(empty.blockers.includes("platform:linux-x64"), true);
  assert.equal(empty.blockers.includes("cohort:C"), true);
  const local = Object.fromEntries(protocol.prerequisites.local.map((item) => [item, true]));
  const complete = evaluateIe6Prerequisites(protocol, {
    local,
    platforms: { "darwin-arm64": true, "linux-x64": true },
    cohorts: { cohortATasks: 20, cohortBAttempts: 100, cohortCTerminalAttempts: 200 },
    independentHumanParticipants: 5,
    privateFamilyDisjointHoldout: true,
    longHorizonInterruptionResume: true,
    explicitOperatorChunkApproval: true
  });
  assert.deepEqual(complete, { passed: true, blockers: [] });
});

test("rejects identity, parity, family, chunk, retry, gate, claim and authorization drift", () => {
  const mutations = [
    (value) => { value.candidate.expectedPackageVersion = "1.3.0-rc.2"; },
    (value) => { value.comparison.baselineSurface = "raw-pi"; },
    (value) => { value.comparison.thinking = "high"; },
    (value) => { value.policy.semanticRepair = "on"; },
    (value) => { value.suite.scenarioIds.pop(); },
    (value) => { value.suite.repeats = 1; },
    (value) => { value.suite.maximumSessionsPerChunk = 12; },
    (value) => { value.suite.infrastructureRetries = 1; },
    (value) => { value.releaseGate.maximumFreshTokenRatioUpper95 = 1.1; },
    (value) => { value.stopRules.rewriteMeasuredEvidenceAllowed = true; },
    (value) => { value.claimBoundary.longTaskClaimWithoutLongHorizonAllowed = true; },
    (value) => { value.authorization.releaseBenchmark = true; }
  ];
  for (const mutate of mutations) {
    const value = clone();
    mutate(value);
    assert.notDeepEqual(ie6ReleaseProtocolValidationErrors(value), []);
  }
});
