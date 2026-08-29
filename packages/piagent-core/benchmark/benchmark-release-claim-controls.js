import { evaluateAllAttemptPooledFreshEfficiency } from "./benchmark-all-attempt-efficiency.js";
import { productionCampaignAttemptCoverage, productionCampaignExpectedAttempts } from "./benchmark-campaign.js";
import { summarizeBenchmarkServiceTierEvidence } from "./benchmark-service-tier.js";

const CANONICAL_PRODUCTION_SUITE_IDS = new Set(["production-v1", "production-v2"]);

export function canonicalProductionSuiteId(suiteId) {
  return CANONICAL_PRODUCTION_SUITE_IDS.has(suiteId);
}

/**
 * Builds the source, all-attempt net-efficiency, and Fast execution-
 * configuration controls used by a production token-saving claim. Keeping
 * these related fail-closed gates together prevents report assembly from
 * subtly recomputing them differently.
 */
export function summarizeBenchmarkReleaseClaimControls({
  suite,
  canonicalProductionSuite,
  tokenAccounting,
  infrastructureFailureLedgerIssues,
  runs,
  environment,
  baselineSurface,
  candidateSurface,
  maximumFreshTokenRatioUpper95,
  maximumBandFreshTokenRatio,
  maximumFamilyFreshTokenRatio,
  primaryEfficiencyEstimand,
  primaryUsesFixedWorkload
}) {
  const releaseGate = suite.releaseGate ?? {};
  const maximumAllAttemptPooledFreshTokenRatio = releaseGate.maximumAllAttemptPooledFreshTokenRatio;
  const requiresFullSuite = releaseGate.requireFullSuiteForClaim === true;
  const requiresProviderWireSurface = releaseGate.requireStableProviderWireSurface === true;
  const requiresCausalContextReceipt = releaseGate.requireCausalContextReceipt === true;
  const requiresFastServiceTier = releaseGate.requireFastServiceTier === true;
  const requiresCampaignAccounting = releaseGate.requireCampaignAccounting === true;
  const requestsTokenSavingClaim = releaseGate.requireEfficiencyClaim === true;
  const requestsNormalizedCostClaim = releaseGate.requireNormalizedCostClaim === true;
  const requiresHostReadiness = releaseGate.requireHostReadinessForClaim === true;
  const canonicalProductionIdentityGate = !canonicalProductionSuiteId(suite.id) || canonicalProductionSuite;
  const releaseClaimConfigurationGate = requestsTokenSavingClaim
    ? suite.schemaVersion === 2 && Number.isFinite(maximumFreshTokenRatioUpper95)
      && maximumFreshTokenRatioUpper95 <= 0.8 && requiresFullSuite && requiresProviderWireSurface
      && requiresCausalContextReceipt
      && (!canonicalProductionSuiteId(suite.id) || suite.id !== "production-v2" || requiresCampaignAccounting)
      && (!Number.isFinite(maximumAllAttemptPooledFreshTokenRatio)
        || maximumAllAttemptPooledFreshTokenRatio <= 0.65)
      && ["successful-pair-family-ratio", "failure-aware-family-ratio", "fixed-workload-family-ratio"].includes(primaryEfficiencyEstimand)
      && (!primaryUsesFixedWorkload
        || (!Number.isFinite(maximumBandFreshTokenRatio) && !Number.isFinite(maximumFamilyFreshTokenRatio)))
    : null;
  const acceptedUsageCompletenessGate = requestsTokenSavingClaim
    ? tokenAccounting.acceptedAttempts.complete === true
    : null;
  const failedUsageCompletenessGate = requestsTokenSavingClaim
    ? tokenAccounting.failedAttempts.complete === true
    : null;
  const allAttemptUsageCompletenessGate = requestsTokenSavingClaim
    ? tokenAccounting.allAttempts.complete === true
    : null;
  const infrastructureFailureLedgerGate = requestsTokenSavingClaim
    ? infrastructureFailureLedgerIssues.length === 0
    : null;
  const codexBaselineGate = requestsTokenSavingClaim ? baselineSurface === "codex-cli" : null;
  const allAttemptPooledEfficiency = evaluateAllAttemptPooledFreshEfficiency({
    tokenAccounting,
    baselineSurface,
    candidateSurface,
    maximumRatio: maximumAllAttemptPooledFreshTokenRatio
  });
  const serviceTierEvidence = summarizeBenchmarkServiceTierEvidence(runs, {
    requestedServiceTier: environment.requestedServiceTier,
    requestedModel: environment.requestedModel,
    required: requiresFastServiceTier
  });
  const cleanReleaseSourceGate = requestsTokenSavingClaim
    ? environment.source?.kind === "git-working-tree"
      && environment.source.dirty === false
      && /^[a-f0-9]{40,64}$/.test(environment.source.commit ?? "")
    : null;
  const hostReadinessHistory = environment.hostReadinessHistory ?? null;
  const hostReadinessGate = requiresHostReadiness
    ? hostReadinessHistory?.valid === true
      && hostReadinessHistory?.ready === true
      && hostReadinessHistory?.windowCoverage === "complete"
    : null;
  const campaignEvidence = environment.campaignEvidence ?? null;
  const campaignClaimStateGate = campaignEvidence?.status === "claim-sealed"
    ? campaignEvidence.claimOutcome == null
    : campaignEvidence?.status === "claim-passed" && campaignEvidence.claimOutcome?.allowed === true;
  const campaignAccountingGate = requiresCampaignAccounting
    ? campaignEvidence?.required === true
      && campaignEvidence.passed === true
      && campaignEvidence.complete === true
      && campaignEvidence.claimReady === true
      && campaignEvidence.exactOutputLineage === true
      && campaignClaimStateGate
      && campaignEvidence.runId === environment.runId
      && campaignEvidence.configurationDigest === environment.configurationDigest
      && productionCampaignAttemptCoverage(productionCampaignExpectedAttempts(runs), campaignEvidence)
      && campaignEvidence.allAttempts?.complete === true
    : null;
  return {
    maximumAllAttemptPooledFreshTokenRatio,
    requiresFullSuite,
    requiresProviderWireSurface,
    requiresCausalContextReceipt,
    requiresFastServiceTier,
    requiresCampaignAccounting,
    requestsTokenSavingClaim,
    requestsNormalizedCostClaim,
    requiresHostReadiness,
    canonicalProductionIdentityGate,
    releaseClaimConfigurationGate,
    acceptedUsageCompletenessGate,
    failedUsageCompletenessGate,
    allAttemptUsageCompletenessGate,
    infrastructureFailureLedgerGate,
    codexBaselineGate,
    allAttemptPooledEfficiency,
    allAttemptPooledEfficiencyGate: allAttemptPooledEfficiency.passed,
    serviceTierEvidence,
    fastServiceTierGate: serviceTierEvidence.passed,
    cleanReleaseSourceGate,
    hostReadinessHistory,
    hostReadinessGate,
    campaignEvidence,
    campaignAccountingGate
  };
}
