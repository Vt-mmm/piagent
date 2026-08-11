import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateRcLocalGates } from "../packages/piagent-core/benchmark/rc-readiness-gates.js";

const passing = Object.freeze({
  allLocalTestsPassed: true,
  localPerformancePassed: true,
  privacyPassed: true,
  routeCoverage: 0.98,
  routeRegret: 0.099,
  safetyRouteFalseNegatives: 0,
  helperBudgetViolations: 0,
  writerInvariantViolations: 0,
  recoveryGatePassed: true,
  phaseToolGatePassed: true,
  hostBoundaryCovered: true
});

describe("RC local readiness gates", () => {
  it("passes only when every named local gate passes", () => {
    const result = evaluateRcLocalGates(passing);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.failedChecks, []);
    assert.equal(Object.values(result.checks).every(Boolean), true);
  });

  for (const [field, failedValue, check] of [
    ["allLocalTestsPassed", false, "all-test-groups"],
    ["localPerformancePassed", false, "performance-ceilings"],
    ["privacyPassed", false, "privacy-scan"],
    ["routeCoverage", 0.979, "route-coverage"],
    ["routeRegret", 0.10, "route-regret"],
    ["safetyRouteFalseNegatives", 1, "safety-route-false-negatives"],
    ["helperBudgetViolations", 1, "helper-budget-violations"],
    ["writerInvariantViolations", 1, "writer-invariant-violations"],
    ["recoveryGatePassed", false, "recovery-gate"],
    ["phaseToolGatePassed", false, "phase-tool-gate"],
    ["hostBoundaryCovered", false, "host-boundary-coverage"]
  ]) {
    it(`fails closed when ${check} fails`, () => {
      const result = evaluateRcLocalGates({ ...passing, [field]: failedValue });
      assert.equal(result.status, "failed");
      assert.deepEqual(result.failedChecks, [check]);
      assert.equal(result.checks[check], false);
    });
  }

  it("fails closed for missing or non-finite routing evidence", () => {
    const missing = evaluateRcLocalGates({ ...passing, routeCoverage: undefined });
    const nonFinite = evaluateRcLocalGates({ ...passing, routeRegret: Number.NaN });
    assert.deepEqual(missing.failedChecks, ["route-coverage"]);
    assert.deepEqual(nonFinite.failedChecks, ["route-regret"]);
  });
});
