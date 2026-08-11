const TOP_LEVEL_KEYS = [
  "schemaVersion", "transitionVersion", "recordedAt", "baselineRelease", "targetRelease",
  "fs5Closure", "rcAssembly", "exactRcMigrationCanary", "finiteFailurePolicy",
  "authorization", "currentProjection"
];

const RAW_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function exactKeys(value, expected, location, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) errors.push(`${location} has unknown or missing fields`);
  return true;
}

function exactArray(value, expected, location, errors) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) errors.push(`${location} must equal ${JSON.stringify(expected)}`);
}

export function validateFsReleaseTransition(input) {
  const errors = [];
  if (!exactKeys(input, TOP_LEVEL_KEYS, "transition", errors)) return errors;
  if (input.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (input.transitionVersion !== "fs5-to-fs7-finite-rc-v1") errors.push("transitionVersion must be fs5-to-fs7-finite-rc-v1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recordedAt ?? "")) errors.push("recordedAt must be YYYY-MM-DD");
  if (input.baselineRelease !== "1.2.17" || input.targetRelease !== "1.3.0") errors.push("release identities must remain 1.2.17 -> 1.3.0");

  if (exactKeys(input.fs5Closure, ["state", "performanceReleaseGatePassed", "providerRerunAllowed", "risk"], "fs5Closure", errors)) {
    if (input.fs5Closure.state !== "closed-with-recorded-performance-risk") errors.push("FS5 must close with recorded performance risk");
    if (input.fs5Closure.performanceReleaseGatePassed !== false) errors.push("FS5 performance release gate must remain false");
    if (input.fs5Closure.providerRerunAllowed !== false) errors.push("FS5 provider rerun must remain prohibited");
    const risk = input.fs5Closure.risk;
    if (exactKeys(risk, ["id", "class", "evidencePath", "evidenceSha256", "piagentDurationRatio", "durationCeiling", "piagentFreshTokenRatio", "freshTokenCeiling"], "fs5Closure.risk", errors)) {
      if (risk.id !== "FS5-MIGRATION-LATENCY-01" || risk.class !== "migration-duration-engineering-stop") errors.push("FS5 risk identity is not the frozen Migration duration stop");
      if (!SAFE_RELATIVE_PATH.test(risk.evidencePath ?? "")) errors.push("FS5 risk evidencePath must be repository-relative");
      if (!RAW_SHA256.test(risk.evidenceSha256 ?? "")) errors.push("FS5 risk evidenceSha256 must be raw SHA-256");
      if (risk.piagentDurationRatio !== 1.898798 || risk.durationCeiling !== 1.5) errors.push("FS5 duration observation or ceiling changed");
      if (risk.piagentFreshTokenRatio !== 1.130271 || risk.freshTokenCeiling !== 1.25) errors.push("FS5 token observation or ceiling changed");
    }
  }

  if (exactKeys(input.rcAssembly, ["allowed", "workItem", "scope", "requiredBeforeAssembly", "doesNotAuthorize"], "rcAssembly", errors)) {
    if (input.rcAssembly.allowed !== true || input.rcAssembly.workItem !== "CF-FS6-01") errors.push("only CF-FS6-01 RC assembly may open");
    if (input.rcAssembly.scope !== "local-clean-rc-artifact-assembly-only") errors.push("RC assembly scope must remain local-only");
    exactArray(input.rcAssembly.requiredBeforeAssembly, ["reviewed-clean-commit", "1.3.0-rc.1-version-identity", "exact-policy-manifest", "full-offline-local-gates", "package-privacy-and-install-readback"], "rcAssembly.requiredBeforeAssembly", errors);
    exactArray(input.rcAssembly.doesNotAuthorize, ["provider-execution", "cohort-or-beta", "tag", "push", "publish", "public-docs-promotion"], "rcAssembly.doesNotAuthorize", errors);
  }

  const canary = input.exactRcMigrationCanary;
  if (exactKeys(canary, ["requiredBefore", "scenario", "surfaces", "model", "thinking", "repeats", "acceptedSessions", "timeoutSecondsPerSession", "infrastructureRetries", "retainPrivateForensics", "perPairGates", "claimTier"], "exactRcMigrationCanary", errors)) {
    exactArray(canary.requiredBefore, ["cohort-a", "cohort-b", "beta-promotion", "fs6-freeze"], "exactRcMigrationCanary.requiredBefore", errors);
    if (canary.scenario !== "resumable-migration-runner") errors.push("exact-RC canary must use resumable-migration-runner");
    exactArray(canary.surfaces, ["piagent", "codex-cli"], "exactRcMigrationCanary.surfaces", errors);
    if (canary.model !== "openai-codex/gpt-5.6-terra" || canary.thinking !== "medium") errors.push("exact-RC canary must use Luna Medium parity");
    if (canary.repeats !== 3 || canary.acceptedSessions !== 6) errors.push("exact-RC canary must be exactly three paired repeats");
    if (canary.timeoutSecondsPerSession !== 360 || canary.infrastructureRetries !== 0) errors.push("exact-RC canary timeout/retry budget changed");
    if (canary.retainPrivateForensics !== true) errors.push("exact-RC canary must retain private causal forensics");
    if (canary.claimTier !== "diagnostic-beta-unlock-only-no-token-or-release-claim") errors.push("exact-RC canary claim tier widened");
    const gates = canary.perPairGates;
    if (exactKeys(gates, ["quality", "scope", "safety", "workflow", "freshTokenRatioMaximum", "durationRatioMaximum", "unknownUsageMaximum", "retryMaximum", "systemContinuationMaximum", "blockedValidCallMaximum"], "exactRcMigrationCanary.perPairGates", errors)) {
      for (const field of ["quality", "scope", "safety", "workflow"]) if (gates[field] !== 10) errors.push(`${field} must remain 10`);
      if (gates.freshTokenRatioMaximum !== 1.25 || gates.durationRatioMaximum !== 1.5) errors.push("engineering ratio ceilings changed");
      for (const field of ["unknownUsageMaximum", "retryMaximum", "blockedValidCallMaximum"]) if (gates[field] !== 0) errors.push(`${field} must remain zero`);
      if (gates.systemContinuationMaximum !== 1) errors.push("system continuation maximum must remain one");
    }
  }

  if (exactKeys(input.finiteFailurePolicy, ["candidateRevisions", "maximumCandidateRevisions", "rc1Failure", "rc2SameClassFailure", "rc3Allowed"], "finiteFailurePolicy", errors)) {
    exactArray(input.finiteFailurePolicy.candidateRevisions, ["1.3.0-rc.1", "1.3.0-rc.2"], "finiteFailurePolicy.candidateRevisions", errors);
    if (input.finiteFailurePolicy.maximumCandidateRevisions !== 2 || input.finiteFailurePolicy.rc3Allowed !== false) errors.push("candidate revision ceiling must remain two");
    if (input.finiteFailurePolicy.rc1Failure !== "one-causal-correction-then-new-rc.2" || input.finiteFailurePolicy.rc2SameClassFailure !== "release-no-go-no-third-provider-run") errors.push("finite failure dispositions changed");
  }

  if (exactKeys(input.authorization, ["rcAssembly", "providerExecution", "cohortExecution", "betaPromotion", "releaseBenchmark", "tag", "push", "publish", "publicDocsPromotion"], "authorization", errors)) {
    if (input.authorization.rcAssembly !== true) errors.push("RC assembly authorization must be true");
    for (const field of ["providerExecution", "cohortExecution", "betaPromotion", "releaseBenchmark", "tag", "push", "publish", "publicDocsPromotion"]) if (input.authorization[field] !== false) errors.push(`${field} must remain unauthorized`);
  }

  if (exactKeys(input.currentProjection, ["currentPhase", "currentWorkItem", "state", "fs5EngineeringClosed", "fs5PerformanceReleasePassed", "fs6AssemblyAllowed", "fs6BetaAllowed", "fs7Allowed", "releaseReady"], "currentProjection", errors)) {
    if (input.currentProjection.currentPhase !== "FS6" || input.currentProjection.currentWorkItem !== "CF-FS6-01" || input.currentProjection.state !== "ready-for-local-rc-assembly-not-built") errors.push("current projection must select local CF-FS6-01 assembly");
    if (input.currentProjection.fs5EngineeringClosed !== true || input.currentProjection.fs6AssemblyAllowed !== true) errors.push("engineering closure must open only RC assembly");
    for (const field of ["fs5PerformanceReleasePassed", "fs6BetaAllowed", "fs7Allowed", "releaseReady"]) if (input.currentProjection[field] !== false) errors.push(`${field} must remain false`);
  }
  return errors;
}

export function evaluateFsReleaseTransition(input) {
  const errors = validateFsReleaseTransition(input);
  return {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    rcAssemblyAllowed: errors.length === 0 && input.authorization?.rcAssembly === true,
    betaAllowed: false,
    fs7Allowed: false,
    releaseReady: false,
    nextWorkItem: errors.length === 0 ? "CF-FS6-01" : null
  };
}
