function diagnostic(report, { tier, purpose, reason, limitation, flag }) {
  report[flag] = true;
  report.comparison.purpose = purpose;
  report.comparison.tokenClaimAllowed = false;
  report.comparison.tokenClaimUnavailableReason = reason;
  report.comparison.claimEligibility = {
    ...(report.comparison.claimEligibility ?? {}),
    achievedTier: tier,
    generalizationClaimAllowed: false,
    comparisonPurpose: purpose,
    limitations: [...new Set([...(report.comparison.claimEligibility?.limitations ?? []), limitation])]
  };
}

export function applyBenchmarkClaimRestrictions(report, { tokenReason, replaySource, codexMode, surfaces }) {
  if (tokenReason) {
    report.comparison.tokenClaimAllowed = false;
    report.comparison.tokenClaimUnavailableReason = tokenReason;
  }
  if (surfaces.includes("codex-cli") && codexMode === "native") {
    diagnostic(report, {
      tier: "diagnostic-native-config",
      purpose: "diagnostic-native-codex",
      reason: "native-codex-operator-configuration-is-not-frozen",
      limitation: "native-codex-results-cannot-support-release-token-or-generalization-claims",
      flag: "nativeCodexDiagnosticOnly"
    });
  }
  if (replaySource) {
    diagnostic(report, {
      tier: "diagnostic-replay",
      purpose: "diagnostic-replay",
      reason: "replay-results-are-diagnostic-only",
      limitation: "replay-results-cannot-support-release-token-or-generalization-claims",
      flag: "replayDiagnosticOnly"
    });
  }
  return report;
}
