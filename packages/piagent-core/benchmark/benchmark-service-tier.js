const FAST_SERVICE_TIERS = new Set(["fast", "priority"]);

function normalizedTier(value) {
  const tier = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["default", "fast", "priority"].includes(tier) ? tier : null;
}

function uniqueTiers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizedTier).filter(Boolean))].sort();
}

function evidenceForRun(run) {
  if (run?.surface === "piagent") return run.providerWireEvidence?.serviceTier ?? run.serviceTierEvidence ?? null;
  if (run?.surface === "codex-cli") return run.usage?.serviceTierEvidence ?? run.serviceTierEvidence ?? null;
  return run?.serviceTierEvidence ?? null;
}

function classifyRun(run, requestedServiceTier) {
  const evidence = evidenceForRun(run);
  const requestedTiers = uniqueTiers(evidence?.requestedTiers);
  const observedRequestTiers = uniqueTiers(evidence?.observedRequestTiers);
  const providerResponseTiers = uniqueTiers(evidence?.providerResponseTiers);
  const evidenceSourceVerified = run?.surface === "piagent"
    ? evidence?.source === "piagent-provider-request-telemetry"
    : run?.surface === "codex-cli"
      ? evidence?.source === "codex-controlled-invocation-rollout-settings"
        && evidence.identityBound === true
        && evidence.invocationBound === true
        && evidence.coverageBound === true
        && evidence.settingsBound === true
        && Array.isArray(evidence.diagnostics)
        && evidence.diagnostics.length === 0
      : false;
  const defaultFallback = [...requestedTiers, ...observedRequestTiers, ...providerResponseTiers].includes("default")
    || Number(evidence?.defaultFallbackEvents ?? 0) > 0;
  const evidenceEvents = Number.isSafeInteger(evidence?.events) ? evidence.events : 0;
  const providerStartedEvents = Number.isSafeInteger(run?.usage?.execution?.providerStartedAttempts)
    ? run.usage.execution.providerStartedAttempts
    : 0;
  const wireEvents = Number.isSafeInteger(run?.providerWireEvidence?.wireEvents)
    ? run.providerWireEvidence.wireEvents
    : 0;
  const appliedEvents = Number.isSafeInteger(evidence?.appliedEvents) ? evidence.appliedEvents : 0;
  const appliedFastEvents = Number.isSafeInteger(evidence?.appliedFastEvents) ? evidence.appliedFastEvents : 0;
  const executionConfigurationCoverageVerified = run?.surface === "piagent"
    ? providerStartedEvents > 0
      && wireEvents > 0
      && evidenceEvents === providerStartedEvents
      && evidenceEvents === wireEvents
      && evidence?.requestedFastEvents === evidenceEvents
      && evidence?.observedFastRequestEvents === evidenceEvents
      && evidence?.fastModeEvents === evidenceEvents
      && appliedEvents === evidenceEvents
      && appliedFastEvents === evidenceEvents
    : run?.surface === "codex-cli"
      ? providerStartedEvents > 0
        && evidenceEvents === providerStartedEvents
        && evidence?.providerStartedEvents === providerStartedEvents
        && evidence?.invocationEvents === providerStartedEvents
        && evidence?.initialInvocationEvents === 1
        && evidence?.resumeInvocationEvents === providerStartedEvents - 1
        && evidence?.resumeSettingsEvents === providerStartedEvents - 1
        && evidence?.turnContextEvents === providerStartedEvents
        && evidence?.coverageBound === true
      : false;
  const expectedObservedRequestTier = run?.surface === "piagent" ? "priority" : null;
  const executionConfigurationVerified = requestedServiceTier === "fast"
    && evidenceEvents > 0
    && requestedTiers.length === 1
    && requestedTiers[0] === "fast"
    && observedRequestTiers.length === 1
    && observedRequestTiers.every((tier) => expectedObservedRequestTier === null
      ? FAST_SERVICE_TIERS.has(tier)
      : tier === expectedObservedRequestTier)
    && evidenceSourceVerified
    && executionConfigurationCoverageVerified
    && !defaultFallback;
  const providerResponseVerified = providerResponseTiers.length === 0
    ? null
    : providerResponseTiers.every((tier) => FAST_SERVICE_TIERS.has(tier)) && !defaultFallback;
  return {
    scenarioId: run?.scenarioId ?? null,
    repeat: run?.repeat ?? null,
    surface: run?.surface ?? null,
    source: evidence?.source ?? "unavailable",
    evidenceSourceVerified,
    events: evidenceEvents,
    providerStartedEvents,
    wireEvents,
    appliedEvents,
    appliedFastEvents,
    initialInvocationEvents: Number(evidence?.initialInvocationEvents ?? 0),
    resumeInvocationEvents: Number(evidence?.resumeInvocationEvents ?? 0),
    resumeSettingsEvents: Number(evidence?.resumeSettingsEvents ?? 0),
    turnContextEvents: Number(evidence?.turnContextEvents ?? 0),
    requestedTiers,
    observedRequestTiers,
    providerResponseTiers,
    responseEvidence: Array.isArray(evidence?.responseEvidence) ? [...evidence.responseEvidence] : [],
    executionConfigurationCoverageVerified,
    executionConfigurationVerified,
    providerResponseVerified,
    defaultFallback
  };
}

/**
 * Fast-mode claims are intentionally two-stage. The execution-configuration
 * gate combines exact Piagent outbound-request telemetry with a strict,
 * identity-bound Codex initial invocation and exact resume-settings coverage;
 * it does not claim both surfaces expose the same wire evidence. The response
 * gate separately proves the provider reported fast/priority when the host
 * exposes that field. A missing response tier never inherits a configuration
 * value: an actual provider-processing-tier claim remains unavailable until
 * every run exposes response evidence. Any observed `default` value fails the
 * execution-configuration gate.
 */
export function summarizeBenchmarkServiceTierEvidence(runs, { requestedServiceTier, requestedModel, required = false } = {}) {
  const gpt56FastReferenceRates = requestedServiceTier === "fast"
    && /(?:^|\/)gpt-5\.6(?:-|$)/.test(String(requestedModel ?? ""));
  const records = (Array.isArray(runs) ? runs : []).map((run) => classifyRun(run, requestedServiceTier));
  const bySurface = Object.fromEntries([...new Set(records.map((record) => record.surface).filter(Boolean))]
    .sort()
    .map((surface) => {
      const surfaceRecords = records.filter((record) => record.surface === surface);
      return [surface, {
        runs: surfaceRecords.length,
        executionConfigurationVerifiedRuns: surfaceRecords.filter((record) => record.executionConfigurationVerified).length,
        executionConfigurationCoverageVerifiedRuns: surfaceRecords.filter((record) => record.executionConfigurationCoverageVerified).length,
        providerResponseVerifiedRuns: surfaceRecords.filter((record) => record.providerResponseVerified === true).length,
        providerResponseEvidenceRuns: surfaceRecords.filter((record) => record.providerResponseVerified !== null).length,
        defaultFallbackRuns: surfaceRecords.filter((record) => record.defaultFallback).length,
        missingExecutionConfigurationEvidenceRuns: surfaceRecords.filter((record) => !record.executionConfigurationVerified).length,
        incompleteExecutionConfigurationCoverageRuns: surfaceRecords.filter((record) => !record.executionConfigurationCoverageVerified).length,
        missingProviderResponseEvidenceRuns: surfaceRecords.filter((record) => record.providerResponseVerified === null).length
      }];
    }));
  const expectedSurfaces = ["piagent", "codex-cli"];
  const surfaceCoverage = expectedSurfaces.every((surface) => Number(bySurface[surface]?.runs ?? 0) > 0);
  const executionConfigurationParityGate = !required ? null : requestedServiceTier === "fast"
    && records.length > 0
    && surfaceCoverage
    && records.every((record) => record.executionConfigurationVerified);
  const responseEvidenceRecords = records.filter((record) => record.providerResponseVerified !== null);
  const providerResponseEvidenceGate = !required
    ? null
    : records.some((record) => record.providerResponseVerified === false)
      ? false
      : responseEvidenceRecords.length > 0
        ? responseEvidenceRecords.every((record) => record.providerResponseVerified === true)
        : null;
  return {
    schemaVersion: 1,
    required,
    requestedServiceTier: requestedServiceTier ?? null,
    acceptedProviderResponseTiers: [...FAST_SERVICE_TIERS],
    runs: records.length,
    bySurface,
    executionConfigurationParityGate,
    providerResponseEvidenceGate,
    passed: !required ? null : executionConfigurationParityGate === true && providerResponseEvidenceGate !== false,
    claimBoundary: "fast-execution-configuration-parity",
    actualProviderProcessingTierClaimAllowed: providerResponseEvidenceGate === true
      && responseEvidenceRecords.length === records.length,
    claimPolicy: "execution-configuration-hard-gate; piagent-fast-intent-must-map-to-applied-priority-outbound-telemetry-for-every-provider-start-and-wire-event; codex-cli-requires-one-strict-identity-bound-initial-invocation-plus-exact-priority-resume-settings-coverage; provider-response-tier-gated-when-host-exposes-it; literal-fast-or-default-pi-wire-tier-fails",
    subscriptionCreditAccounting: {
      blocking: false,
      includedInTokenRatio: false,
      actualBillingMode: "unverified",
      applicableMultiplier: null,
      referenceRates: {
        chatgptSubscriptionCredits: gpt56FastReferenceRates
          ? { multiplier: 2.5, applicability: "reference-only" }
          : null,
        apiFastTokenPricing: gpt56FastReferenceRates
          ? { multiplier: 2, applicability: "reference-only" }
          : null
      },
      status: gpt56FastReferenceRates ? "reference-rates-only-billing-mode-unverified" : "not-applicable-or-unavailable",
      source: "OpenAI Codex Fast mode reference rates for GPT-5.6",
      note: "Reference rates are reported separately; no multiplier is applied until the run's billing mode is independently verified."
    },
    records
  };
}

export function benchmarkFastExecutionConfigurationVerified(run) {
  return classifyRun(run, "fast").executionConfigurationVerified;
}
