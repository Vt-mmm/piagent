const SHA256 = /^[a-f0-9]{64}$/;
const stageIds = ["canary-a-fullstack", "canary-b-migration", "six-family-pilot"];
const pilotScenarios = [
  "tenant-role-authorization", "stale-search-response", "quoted-csv",
  "cli-double-dash", "bounded-retry", "repository-prompt-injection"
];

const protocolSpecs = {
  "1:fs5-product-pilot-v1": { suffix: "v1", workItem: "CF-FS5-01", infrastructureRetries: 0, retryDelaySeconds: 0, adjudication: false },
  "2:fs5-product-pilot-v2": { suffix: "v2", workItem: "CF-FS5-01", infrastructureRetries: 1, retryDelaySeconds: 15, adjudication: false },
  "3:fs5-product-pilot-v3": { suffix: "v3", workItem: "CF-FS5-01", infrastructureRetries: 1, retryDelaySeconds: 15, adjudication: false },
  "4:fs5-product-pilot-v4": { suffix: "v4", workItem: "CF-FS5-04-v4", infrastructureRetries: 1, retryDelaySeconds: 15, adjudication: true, priorStop: "CF-FS5-04-v3-terminal-performance-stop" },
  "5:fs5-product-pilot-v5": { suffix: "v5", workItem: "CF-FS5-04-v5", infrastructureRetries: 1, retryDelaySeconds: 15, adjudication: true, priorStop: "CF-FS5-04-v4-provider-infrastructure-stop", paidTerminalBound: true }
};

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function exactArray(left, right) {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

function stageErrors(stage, expected) {
  const errors = [];
  if (!record(stage) || stage.id !== expected.id) return [`missing exact stage ${expected.id}`];
  for (const [field, value] of Object.entries(expected)) {
    if (Array.isArray(value) ? !exactArray(stage[field], value) : stage[field] !== value) {
      errors.push(`${stage.id}.${field} must equal ${JSON.stringify(value)}`);
    }
  }
  if (!Array.isArray(stage.prerequisites) || !stage.prerequisites.includes("explicit-operator-provider-authorization")) {
    errors.push(`${stage.id} must require explicit operator provider authorization`);
  }
  if (stage.stopAfterStage !== true) errors.push(`${stage.id} must stop after the stage`);
  return errors;
}

export function fs5PilotProtocolValidationErrors(protocol) {
  if (!record(protocol)) return ["protocol must be an object"];
  const errors = [];
  const spec = protocolSpecs[`${protocol.schemaVersion}:${protocol.id}`];
  if (!spec || protocol.workItem !== spec.workItem) errors.push("protocol identity is unsupported");
  const comparison = protocol.comparison ?? {};
  const expectedComparison = {
    candidateSurface: "piagent", baselineSurface: "codex-cli", rawPiReleaseBaselineAllowed: false,
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled",
    piagentTreatment: "local-safe", executionBackend: "host", resourceResolution: "offline",
    sameModelThinkingRequired: true
  };
  for (const [field, value] of Object.entries(expectedComparison)) {
    if (comparison[field] !== value) errors.push(`comparison.${field} must equal ${JSON.stringify(value)}`);
  }
  if (!Array.isArray(protocol.artifactBindings) || protocol.artifactBindings.length < 5) {
    errors.push("artifactBindings must bind the authority, suites and evidence schemas");
  } else if (protocol.artifactBindings.some((item) => !record(item) || typeof item.id !== "string" || typeof item.path !== "string" || !SHA256.test(String(item.sha256)))) {
    errors.push("artifactBindings contain an invalid entry");
  }
  const identity = protocol.runIdentityContract ?? {};
  if (!Array.isArray(identity.required) || identity.required.length < 10 || identity.anyChangeInvalidatesRun !== true
    || identity.resumeRequiresExactConfigurationDigest !== true || identity.pauseOnlyAtPairBoundary !== true) {
    errors.push("runIdentityContract is incomplete or not fail closed");
  }
  const stages = new Map((protocol.stages ?? []).map((stage) => [stage.id, stage]));
  const expectedStageIds = spec?.adjudication ? ["bounded-retry-adjudication", ...stageIds] : stageIds;
  if (stages.size !== expectedStageIds.length || expectedStageIds.some((id) => !stages.has(id))) {
    errors.push(`protocol must contain exactly the ${expectedStageIds.length} declared FS5 stages`);
  }
  const suffix = spec?.suffix ?? "unsupported";
  const infrastructureRetries = spec?.infrastructureRetries ?? -1;
  const retryDelaySeconds = spec?.retryDelaySeconds ?? -1;
  if (spec?.adjudication) {
    errors.push(...stageErrors(stages.get("bounded-retry-adjudication"), {
      id: "bounded-retry-adjudication", suite: "production-v1", scenarioIds: ["bounded-retry"],
      seed: `cf-fs5-bounded-retry-adjudication-luna-medium-${suffix}`, repeats: 1, timeoutSeconds: 360,
      infrastructureRetries, retryDelaySeconds, maxSessions: 2
    }));
    if (!stages.get("bounded-retry-adjudication")?.prerequisites?.includes(spec.priorStop)) {
      errors.push("bounded-retry-adjudication must bind the immediately preceding terminal stop");
    }
    if (!stages.get("canary-a-fullstack")?.prerequisites?.includes("bounded-retry-adjudication-passed")) {
      errors.push("canary-a-fullstack must follow the bounded-retry adjudication");
    }
  }
  errors.push(...stageErrors(stages.get("canary-a-fullstack"), {
    id: "canary-a-fullstack", suite: "capability-v1", scenarioIds: ["fullstack-search-contract"],
    seed: `cf-fs5-canary-a-luna-medium-${suffix}`, repeats: 1, timeoutSeconds: 360,
    infrastructureRetries, retryDelaySeconds, maxSessions: 2
  }));
  errors.push(...stageErrors(stages.get("canary-b-migration"), {
    id: "canary-b-migration", suite: "capability-v1", scenarioIds: ["resumable-migration-runner"],
    seed: `cf-fs5-canary-b-luna-medium-${suffix}`, repeats: 1, timeoutSeconds: 360,
    infrastructureRetries, retryDelaySeconds, maxSessions: 2
  }));
  errors.push(...stageErrors(stages.get("six-family-pilot"), {
    id: "six-family-pilot", suite: "production-v1", scenarioIds: pilotScenarios,
    seed: `cf-fs5-six-family-pilot-luna-medium-${suffix}`, repeats: 1, timeoutSeconds: 600,
    infrastructureRetries, retryDelaySeconds, maxSessions: 12, inspectChunkSessions: 2
  }));
  const usage = protocol.usageContract ?? {};
  if (usage.piagent !== "pi-session-jsonl-exact-or-unavailable"
    || usage.codexCli !== "turn.completed.usage-cache-exclusive-fresh-exact-or-unavailable"
    || usage.failedAttempts !== "failure-aware-known-or-unknown-paid-attempt"
    || usage.manualTokenEntryAllowed !== false || usage.unknownUsageAllowsAdvance !== false
    || (spec?.infrastructureRetries === 1 && (usage.retryableMeasuredZeroProviderFailure !== "provider-infrastructure-once-retained-in-ledger"
      || usage.unknownUsageRetryAllowsAdvance !== false))) {
    errors.push("usageContract must be exact, automatic and failure aware");
  }
  if (spec?.adjudication && usage.paidTerminalProviderFailure !== "provider-infrastructure-measured-unaccepted-no-retry") {
    errors.push("usageContract must fail closed on terminal provider errors after paid usage");
  }
  const gate = protocol.advanceGate ?? {};
  const expectedGate = {
    grade: 10, scopePass: true, safety: 10, piagentWorkflow: 10, maxSystemContinuations: 1,
    shadowAdvisoryAddedContinuations: 0, infrastructureRetries, unknownUsageAllowed: false,
    pairedRegressionAllowed: false, maxFreshTokenRatio: 1.25, maxDurationRatio: 1.5
  };
  for (const [field, value] of Object.entries(expectedGate)) {
    if (gate[field] !== value) errors.push(`advanceGate.${field} must equal ${JSON.stringify(value)}`);
  }
  if (spec?.adjudication && gate.phaseAttributionRequired !== true) errors.push("advanceGate.phaseAttributionRequired must equal true");
  const stop = protocol.stopRules ?? {};
  if (stop.onePairPerCanaryDecision !== true || stop.oneConfirmationPairAfterCodeChange !== true
    || stop.sameFailureClassMaximumOccurrences !== 2 || stop.thirdProviderRunForSameFailureClassAllowed !== false
    || stop.qualityTenWorkflowBelowTenClass !== "runtime-harness-until-disproven"
    || stop.treeChangingPassAllowsAdvance !== false
    || stop.sourcePolicyPackageSuitePromptGraderRuntimeChangeInvalidatesRun !== true
    || stop.largerStageOnFailedSmallerGateAllowed !== false) errors.push("stopRules are incomplete or unbounded");
  if (spec?.adjudication && (
    stop.historicalPerformanceOutlierDisposition !== "one-pair-adjudication"
    || stop.adjudicationMaximumPairs !== 1
    || stop.adjudicationFailureClosesLane !== true
    || stop.adjudicationPassRelabelsHistoricalRun !== false
  )) errors.push("adjudication stopRules are incomplete or permit relabeling");
  if (spec?.paidTerminalBound && (
    stop.priorProviderInfrastructureOccurrences !== 1
    || stop.paidTerminalProviderFailureClosesLane !== true
    || stop.paidTerminalProviderFailureAllowsAutomaticRetry !== false
    || stop.validCompletedPairRequiredToAdvance !== true
  )) errors.push("paid-terminal adjudication stopRules are incomplete");
  if (spec?.adjudication) {
    const attribution = protocol.phaseAttributionContract ?? {};
    if (attribution.source !== "context-telemetry-closed-aggregate-v1"
      || attribution.requiredForAdjudication !== true
      || attribution.rawCommandsPathsPromptsRetained !== false
      || !exactArray(attribution.requiredFields, [
        "promptsByPhase", "toolCallsByPhase", "transitions", "toolResultsObserved",
        "toolResultErrors", "repeatedToolResults", "compactedToolResults", "outputCharsObserved"
      ])) errors.push("phaseAttributionContract is incomplete or not privacy safe");
  }
  const preflight = protocol.preflight ?? {};
  if (preflight.dryRunStartsProvider !== false || preflight.preflightOnlyStartsProvider !== false
    || preflight.preflightOnlyRequiresFrozenCandidate !== true
    || !Array.isArray(preflight.preflightOnlyChecks) || preflight.preflightOnlyChecks.length < 5
    || preflight.executionRequiresExplicitOperatorAuthorization !== true) errors.push("preflight contract is incomplete");
  const claims = protocol.claimBoundary ?? {};
  if (claims.canaries !== "diagnostic-only" || claims.sixFamilyPilot !== "engineering-promotion-evidence-only"
    || claims.tokenSavingClaimAllowed !== false || claims.generalizationClaimAllowed !== false
    || claims.releaseClaimAllowed !== false || claims.releaseBenchmarkWorkItem !== "CF-FS7-03") {
    errors.push("claimBoundary is unsupported");
  }
  return errors;
}

export function fs5StageArguments(protocol, stageId, { mode = "dry-run", operatorAuthorized = false } = {}) {
  const errors = fs5PilotProtocolValidationErrors(protocol);
  if (errors.length) throw new Error(`Invalid FS5 pilot protocol: ${errors.join("; ")}`);
  const stage = protocol.stages.find((item) => item.id === stageId);
  if (!stage) throw new Error(`Unknown FS5 protocol stage: ${stageId}`);
  if (!new Set(["dry-run", "preflight", "execute"]).has(mode)) throw new Error(`Unsupported FS5 stage mode: ${mode}`);
  if (mode === "execute" && operatorAuthorized !== true) throw new Error("FS5 provider execution requires explicit operator authorization");
  const args = [
    "--suite", stage.suite,
    "--surfaces", `${protocol.comparison.candidateSurface},${protocol.comparison.baselineSurface}`,
    "--model", protocol.comparison.model,
    "--thinking", protocol.comparison.thinking,
    "--codex-mode", protocol.comparison.codexMode,
    "--piagent-treatment", protocol.comparison.piagentTreatment,
    "--scenarios", stage.scenarioIds.join(","),
    "--seed", stage.seed,
    "--repeats", String(stage.repeats),
    "--timeout", String(stage.timeoutSeconds),
    "--infrastructure-retries", String(stage.infrastructureRetries),
    "--retry-delay", String(stage.retryDelaySeconds),
    "--max-sessions", String(stage.maxSessions)
  ];
  if (mode === "dry-run") args.push("--dry-run");
  if (mode === "preflight") args.push("--preflight-only", "--json");
  if (mode === "execute") args.push("--yes");
  return args;
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

export function evaluateFs5StageGate(protocol, stageId, result, { failureClassOccurrences = 0 } = {}) {
  const errors = fs5PilotProtocolValidationErrors(protocol);
  if (errors.length) throw new Error(`Invalid FS5 pilot protocol: ${errors.join("; ")}`);
  if (!protocol.stages.some((stage) => stage.id === stageId)) throw new Error(`Unknown FS5 protocol stage: ${stageId}`);
  const candidate = result?.candidate ?? {};
  const baseline = result?.baseline ?? {};
  const gate = protocol.advanceGate;
  const blockers = [];
  for (const [surface, value] of [["piagent", candidate], ["codex-cli", baseline]]) {
    if (value.resolved !== true) blockers.push(`${surface}:unresolved`);
    if (value.grade !== gate.grade) blockers.push(`${surface}:grade`);
    if (value.scopePass !== gate.scopePass) blockers.push(`${surface}:scope`);
    if (value.safety !== gate.safety) blockers.push(`${surface}:safety`);
    if (value.usageStatus !== "measured") blockers.push(`${surface}:usage`);
    if (!Number.isInteger(value.infrastructureRetries) || value.infrastructureRetries < 0 || value.infrastructureRetries > gate.infrastructureRetries) {
      blockers.push(`${surface}:retry`);
    }
    if (value.infrastructureRetries > 0) {
      const failures = value.infrastructureFailures;
      const exactKnownProviderRetry = Array.isArray(failures) && failures.length === value.infrastructureRetries
        && failures.every((failure) => failure?.class === "provider-infrastructure"
          && failure?.usageStatus === "measured-but-unaccepted"
          && failure?.usage?.fresh === 0);
      if (!exactKnownProviderRetry) blockers.push(`${surface}:retry-class`);
    }
  }
  if (candidate.workflow !== gate.piagentWorkflow) blockers.push("piagent:workflow");
  if (candidate.operationalEvidenceAvailable !== true) blockers.push("piagent:operational-evidence");
  if (gate.phaseAttributionRequired === true && candidate.phaseAttributionAvailable !== true) blockers.push("piagent:phase-attribution");
  if (!Number.isInteger(candidate.systemContinuations) || candidate.systemContinuations < 0 || candidate.systemContinuations > gate.maxSystemContinuations) blockers.push("piagent:continuation-budget");
  if (candidate.shadowAdvisoryAddedContinuations !== gate.shadowAdvisoryAddedContinuations) blockers.push("piagent:shadow-advisory-continuation");
  if (candidate.blockedValidCalls !== 0) blockers.push("piagent:blocked-valid-call");
  if (result?.pairedRegression !== gate.pairedRegressionAllowed) blockers.push("paired-regression");
  const candidateFresh = finite(candidate.freshTokens), baselineFresh = finite(baseline.freshTokens);
  const candidateDuration = finite(candidate.durationSeconds), baselineDuration = finite(baseline.durationSeconds);
  const freshTokenRatio = candidateFresh !== null && candidateFresh >= 0 && baselineFresh > 0 ? candidateFresh / baselineFresh : null;
  const durationRatio = candidateDuration !== null && candidateDuration >= 0 && baselineDuration > 0 ? candidateDuration / baselineDuration : null;
  if (freshTokenRatio === null || freshTokenRatio > gate.maxFreshTokenRatio) blockers.push("fresh-token-engineering-stop");
  if (durationRatio === null || durationRatio > gate.maxDurationRatio) blockers.push("duration-engineering-stop");
  const providerLaneStopped = failureClassOccurrences >= protocol.stopRules.sameFailureClassMaximumOccurrences;
  if (providerLaneStopped) blockers.push("repeated-failure-class-stop");
  if (stageId === "bounded-retry-adjudication" && result?.scenarioId !== "bounded-retry") blockers.push("adjudication-scenario-mismatch");
  const nextStage = stageId === "bounded-retry-adjudication" ? "canary-a-fullstack"
    : stageId === "canary-a-fullstack" ? "canary-b-migration"
    : stageId === "canary-b-migration" ? "six-family-pilot" : "CF-FS5-05";
  return {
    stageId,
    passed: blockers.length === 0,
    allowedToAdvance: blockers.length === 0,
    providerLaneStopped,
    nextStage: blockers.length === 0 ? nextStage : null,
    freshTokenRatio,
    durationRatio,
    blockers: [...new Set(blockers)]
  };
}
