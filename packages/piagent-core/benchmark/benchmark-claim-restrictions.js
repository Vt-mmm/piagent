const RESTRICTION_VERDICTS = new Set([
  "token-claim-withheld",
  "diagnostic-native-codex",
  "diagnostic-replay"
]);

function restrictionCanReplaceVerdict(status, includeObservational) {
  return typeof status === "string"
    && (status.endsWith("-more-efficient")
      || RESTRICTION_VERDICTS.has(status)
      || (includeObservational && status === "observational-efficiency-only"));
}

function withholdTokenClaim(report, { reason, limitation, verdictStatus, includeObservational = false }) {
  report.comparison.tokenClaimAllowed = false;
  report.comparison.tokenClaimUnavailableReason = reason;
  report.comparison.claimEligibility = {
    ...(report.comparison.claimEligibility ?? {}),
    tokenClaimScope: "unavailable",
    limitations: [...new Set([...(report.comparison.claimEligibility?.limitations ?? []), limitation])]
  };
  report.verdict ??= {};
  if (restrictionCanReplaceVerdict(report.verdict.status, includeObservational)) {
    report.verdict.status = verdictStatus;
  }
  report.verdict.claimRestrictionReason = reason;
}

function diagnostic(report, { tier, purpose, reason, limitation, flag, verdictStatus }) {
  report[flag] = true;
  report.comparison.purpose = purpose;
  withholdTokenClaim(report, { reason, limitation, verdictStatus, includeObservational: true });
  report.comparison.claimEligibility = {
    ...(report.comparison.claimEligibility ?? {}),
    achievedTier: tier,
    generalizationClaimAllowed: false,
    comparisonPurpose: purpose
  };
}

export function applyBenchmarkClaimRestrictions(report, { tokenReason, replaySource, codexMode, surfaces }) {
  if (tokenReason) {
    withholdTokenClaim(report, {
      reason: tokenReason,
      limitation: `token-claim-withheld:${tokenReason}`,
      verdictStatus: "token-claim-withheld"
    });
  }
  if (surfaces.includes("codex-cli") && codexMode === "native") {
    diagnostic(report, {
      tier: "diagnostic-native-config",
      purpose: "diagnostic-native-codex",
      reason: "native-codex-operator-configuration-is-not-frozen",
      limitation: "native-codex-results-cannot-support-release-token-or-generalization-claims",
      verdictStatus: "diagnostic-native-codex",
      flag: "nativeCodexDiagnosticOnly"
    });
  }
  if (replaySource) {
    diagnostic(report, {
      tier: "diagnostic-replay",
      purpose: "diagnostic-replay",
      reason: "replay-results-are-diagnostic-only",
      limitation: "replay-results-cannot-support-release-token-or-generalization-claims",
      verdictStatus: "diagnostic-replay",
      flag: "replayDiagnosticOnly"
    });
  }
  return report;
}
