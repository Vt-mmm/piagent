export const RC_LOCAL_GATE_THRESHOLDS = Object.freeze({
  routeCoverageMinimum: 0.98,
  routeRegretMaximumExclusive: 0.10,
  safetyRouteFalseNegativesMaximum: 0,
  helperBudgetViolationsMaximum: 0,
  writerInvariantViolationsMaximum: 0
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function evaluateRcLocalGates(input) {
  const checks = {
    "all-test-groups": input.allLocalTestsPassed === true,
    "performance-ceilings": input.localPerformancePassed === true,
    "privacy-scan": input.privacyPassed === true,
    "route-coverage": finite(input.routeCoverage) && input.routeCoverage >= RC_LOCAL_GATE_THRESHOLDS.routeCoverageMinimum,
    "route-regret": finite(input.routeRegret) && input.routeRegret < RC_LOCAL_GATE_THRESHOLDS.routeRegretMaximumExclusive,
    "safety-route-false-negatives": input.safetyRouteFalseNegatives === RC_LOCAL_GATE_THRESHOLDS.safetyRouteFalseNegativesMaximum,
    "helper-budget-violations": input.helperBudgetViolations === RC_LOCAL_GATE_THRESHOLDS.helperBudgetViolationsMaximum,
    "writer-invariant-violations": input.writerInvariantViolations === RC_LOCAL_GATE_THRESHOLDS.writerInvariantViolationsMaximum,
    "recovery-gate": input.recoveryGatePassed === true,
    "phase-tool-gate": input.phaseToolGatePassed === true,
    "host-boundary-coverage": input.hostBoundaryCovered === true
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([id]) => id);
  return {
    status: failedChecks.length === 0 ? "passed" : "failed",
    checks,
    failedChecks,
    thresholds: RC_LOCAL_GATE_THRESHOLDS
  };
}
