function all(checks) {
  return Object.values(checks).every(Boolean);
}

export function evaluateFs4Readiness(input = {}) {
  const e0 = input.e0 ?? {};
  const e1 = input.e1 ?? {};
  const e2 = input.e2 ?? {};
  const e3 = input.e3 ?? {};
  const long = input.longHorizon ?? {};

  const e0Checks = {
    "artifact-bindings-current": input.artifactBindingsCurrent === true,
    "deterministic-tests-pass": e0.testsPassed === true,
    "core-suite-id": e0.suiteId === "core-v1",
    "core-scenario-count": e0.scenarioCount === 4
  };
  const e1Checks = {
    "public-tests-pass": e1.testsPassed === true,
    "public-suite-id": e1.suiteId === "production-v1",
    "public-scenario-count": e1.scenarioCount === 18,
    "public-repeats": e1.defaultRepeats === 3,
    "public-claim-tier": e1.claimTier === "public-regression",
    "generated-variants-disclosed": e1.generatedVariants === true,
    "not-family-disjoint": e1.familyDisjointSplit === false,
    "public-reviewed": e1.reviewed === true
  };
  const e2Checks = {
    "capability-tests-pass": e2.testsPassed === true,
    "capability-suite-id": e2.suiteId === "e2-framework-v1",
    "capability-scenario-count": e2.scenarioCount === 4,
    "capability-claim-tier": e2.claimTier === "capability",
    "references-pass": e2.referenceCount === 4 && e2.referenceScore === 10,
    "mutations-killed": e2.mutationCount === 20 && e2.mutationsKilled === 20,
    "alternatives-pass": e2.alternativeCount === 4 && e2.alternativeScore === 10 && e2.structurallyDistinct === true,
    "scope-calibrated": e2.scopeCount === 4 && e2.outsideScopeExpected === false && e2.vendorMutationAllowed === false,
    "grader-sensitive": e2.rubricChecks === 20 && e2.seededExpectedPassing === 0 && e2.referenceExpectedPassing === 4 && e2.alternativeExpectedPassing === 4
  };
  const longChecks = {
    "lane-tests-pass": long.testsPassed === true,
    "provider-free": long.providerUsed === false,
    "wall-clock-qualified": Number(long.wallClockMinutes) >= 30 && long.wallClockQualified === true,
    "completed-from-resume": long.completedFromResume === true,
    "crash-and-restart": long.hardCrashes === 1 && long.processStarts >= 3,
    "compaction-and-handoff": long.compactions >= 4 && long.handoffReadback === true,
    "continuation-bounded": long.continuationConsumed === 1 && long.continuationMaximum === 1 && long.secondContinuationAllowed === false,
    "context-bounded": long.contextWithinCeiling === true,
    "state-bounded": long.stateWithinCeiling === true,
    "stable-current-tree": long.stableCurrentTree === true && long.verifierExitCode === 0
  };
  const e3LocalChecks = {
    "custody-tests-pass": e3.testsPassed === true,
    "local-protocol-verified": e3.localProtocolVerified === true,
    "external-input-declared": e3.externalInputState === "not-present-and-not-fabricated",
    "self-attestation-refused": e3.selfAttestationAllowed === false,
    "execute-only-boundary": e3.operatorAccess === "execute-only",
    "author-access-denied": e3.authorPromptAccess === "denied-until-rc-freeze"
      && e3.authorGraderAccess === "denied-until-rc-freeze"
      && e3.authorRepositoryAccess === "denied-until-rc-freeze",
    "human-process-bounded": e3.minimumItems >= 12 && e3.minimumFamilies >= 4
      && e3.minimumReviewers >= 2 && e3.unresolvedAllowed === 0,
    "external-execution-deferred": e3.executionStatus === "deferred-to-fs7-01"
  };
  const e3ExternalChecks = {
    "sealed-custodian-receipt": e3.sealedCustodianReceiptPresent === true,
    "human-calibration-recorded": e3.humanCalibrationRecorded === true,
    "custody-origin-verified": e3.custodyOriginVerified === true,
    "private-holdout-ready": e3.privateHoldoutReady === true
  };

  const tierPassed = {
    e0: all(e0Checks), e1: all(e1Checks), e2: all(e2Checks),
    longHorizon: all(longChecks), e3Local: all(e3LocalChecks), e3External: all(e3ExternalChecks)
  };
  const readinessReviewPassed = tierPassed.e0 && tierPassed.e1 && tierPassed.e2
    && tierPassed.longHorizon && tierPassed.e3Local;
  const fs4ExitPassed = readinessReviewPassed && tierPassed.e3External;
  return {
    status: !readinessReviewPassed ? "failed" : fs4ExitPassed ? "passed" : "passed-local-external-e3-deferred",
    tierStatus: {
      e0: tierPassed.e0 ? "passed-deterministic" : "failed",
      e1: tierPassed.e1 ? "passed-public-regression" : "failed",
      e2: tierPassed.e2 ? "passed-public-capability" : "failed",
      e3: tierPassed.e3External ? "passed-private-holdout" : tierPassed.e3Local ? "protocol-ready-external-execution-pending" : "failed",
      longHorizon: tierPassed.longHorizon ? "passed-provider-free-lifecycle" : "failed"
    },
    checks: { e0: e0Checks, e1: e1Checks, e2: e2Checks, e3Local: e3LocalChecks, e3External: e3ExternalChecks, longHorizon: longChecks },
    readinessReviewPassed,
    fs4ExitPassed,
    fs5ProtocolPreparationAllowed: readinessReviewPassed,
    providerExecutionAuthorized: false,
    releasePromotionAllowed: fs4ExitPassed,
    claims: {
      deterministicLocalEvidence: tierPassed.e0,
      publicRegression: tierPassed.e1,
      publicCapability: tierPassed.e2,
      providerFreeLifecycle: tierPassed.longHorizon,
      modelLongTaskPerformance: false,
      generalization: tierPassed.e3External,
      tokenOrLatency: false,
      release: false
    },
    blockers: fs4ExitPassed ? [] : [
      "sealed external custodian receipt missing",
      "sampled human calibration record missing",
      "external custody origin not yet verified"
    ]
  };
}
