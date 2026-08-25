const SURFACE_LABELS = Object.freeze({ "raw-pi": "Raw Pi", piagent: "Piagent", "codex-cli": "Codex CLI" });
const SURFACE_REPORT_KEYS = Object.freeze({ "raw-pi": "rawPi", piagent: "piagent", "codex-cli": "codexCli" });

function surfaceLabel(surface) {
  return SURFACE_LABELS[surface] ?? surface;
}

function surfaceReportKey(surface) {
  return SURFACE_REPORT_KEYS[surface] ?? surface;
}

function display(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "n/a";
}

function displayPercent(value) {
  return Number.isFinite(value) ? `${display(value)}%` : "n/a";
}

function displayRatioPercent(value) {
  return Number.isFinite(value) ? displayPercent(value * 100) : "n/a";
}

function topToolSummary(toolNames, limit = 8) {
  const entries = Object.entries(toolNames ?? {}).slice(0, limit);
  return entries.length ? entries.map(([name, count]) => `${name}:${count}`).join(", ") : "none";
}

function workflowGapSummary(runs) {
  const gaps = {};
  for (const run of runs ?? []) {
    for (const check of run.workflow?.checks ?? []) {
      if (check.passed === true) continue;
      gaps[check.id] = (gaps[check.id] ?? 0) + 1;
    }
  }
  return topToolSummary(gaps);
}

function pairedOutcomeSummary(value, candidateLabel, baselineLabel) {
  if (!value) return "n/a";
  return `both ${value.bothPass} | ${candidateLabel}-only ${value.candidateOnlyPass} | ${baselineLabel}-only ${value.baselineOnlyPass} | neither ${value.bothFail}`;
}

function timingSummary(value, surface) {
  const summary = value?.surfaces?.[surface];
  if (!summary) return "unavailable";
  const phase = (name) => {
    const item = summary.phases?.[name];
    return `${display(item?.medianSeconds, 3)}s (${item?.availableRuns ?? 0}/${summary.runs})`;
  };
  return `startup ${phase("processStartup")} | model-turn wait ${phase("modelTurnWait")} | tool ${phase("toolExecution")} | other ${phase("other")} | complete ${summary.completeDiagnostics}/${summary.runs}`;
}

function pairedUsageBandLines(bands) {
  return Object.entries(bands ?? {}).map(([name, band]) => (
    `  ${name}`.padEnd(30)
      + `${band.pairs}`.padEnd(8)
      + `${band.scenarioFamilies}`.padEnd(10)
      + `${display(band.freshTokenRatio, 4)}`.padEnd(12)
      + display(band.medianFreshTokenDelta, 0)
  ));
}

export function renderBenchmarkText(report) {
  const baselineSurface = report.comparison.baselineSurface ?? "raw-pi";
  const candidateSurface = report.comparison.candidateSurface ?? "piagent";
  const baselineKey = surfaceReportKey(baselineSurface);
  const candidateKey = surfaceReportKey(candidateSurface);
  const baseline = report.surfaces[baselineKey];
  const candidate = report.surfaces[candidateKey];
  const baselineLabel = surfaceLabel(baselineSurface);
  const candidateLabel = surfaceLabel(candidateSurface);
  const runtimeParts = [
    `Platform: v${report.environment.platformVersion ?? "unknown"}`,
    `Pi: ${report.environment.piVersion ?? "unknown"}`
  ];
  if (report.environment.codexVersion) runtimeParts.push(`Codex: ${report.environment.codexVersion}`);
  runtimeParts.push(`Node: ${report.environment.nodeVersion ?? "unknown"}`);
  const scoreLine = (label, value) => `${label}`.padEnd(12)
    + `${value.resolved}/${value.runs}`.padEnd(11)
    + `${value.qualityCorrect}/${value.qualityRuns}`.padEnd(14)
    + `${value.scopePassed}/${value.runs}`.padEnd(10)
    + `${display(value.scores.quality)}`.padEnd(9)
    + `${display(value.scores.safety)}`.padEnd(8)
    + `${display(value.scores.reliability)}`.padEnd(13)
    + `${display(value.scores.workflow)}`.padEnd(10)
    + `${display(value.scores.efficiency)}`.padEnd(12)
    + display(value.scores.overall);
  const usageLine = (label, value) => {
    const usage = value.usage.allMeasuredRuns;
    return `${label}`.padEnd(12)
      + `${display(usage.medianInputTokens, 0)}`.padEnd(11)
      + `${display(usage.medianOutputTokens, 0)}`.padEnd(11)
      + `${display(usage.medianCacheReadTokens, 0)}`.padEnd(12)
      + `${display(usage.medianCacheWriteTokens, 0)}`.padEnd(13)
      + `${display(usage.medianReasoningTokens, 0)}`.padEnd(11)
      + `${display(usage.medianFreshTokens, 0)}`.padEnd(11)
      + `${display(usage.medianTotalTokens, 0)}`.padEnd(11)
      + `${display(usage.medianToolCalls, 0)}`.padEnd(7)
      + display(usage.medianCost, 6);
  };
  const categoryLines = Object.entries(candidate.bands?.categories ?? {}).map(([name, band]) => (
    `  ${name}`.padEnd(30) + `${band.resolved}/${band.runs}`.padEnd(11) + display(band.score)
  ));
  const usageBandLines = pairedUsageBandLines(report.comparison.pairedUsageBands?.categories);
  const confidence = report.comparison.freshTokenRatioConfidence95;
  const primaryConfidence = report.comparison.primaryEfficiencyRatioConfidence95;
  const fixedWorkloadConfidence = report.comparison.fixedWorkloadFamilyFreshTokenRatioConfidence95;
  const failureAwareFamilyConfidence = report.comparison.failureAwareFamilyFreshTokenRatioConfidence95;
  const durationConfidence = report.comparison.durationRatioConfidence95;
  const normalizedCost = report.comparison.normalizedCost;
  const normalizedCostConfidence = normalizedCost?.ratioConfidence95;
  const codexRelative = report.comparison.codexRelativeEfficiency;
  const codexRelativeTrafficConfidence = codexRelative?.totalTokenTraffic?.ratioConfidence95;
  const codexRelativeCostConfidence = codexRelative?.apiEquivalentCost?.ratioConfidence95;
  const causalContext = report.comparison.causalContextEvidence;
  const causalAggregates = causalContext?.aggregates;
  const hostReadiness = report.environment.hostReadinessHistory;
  const suiteFailureReasons = (report.comparison.suiteGate?.failureReasons ?? [])
    .map((failure) => `${failure.id}: ${failure.message}`)
    .join("; ");
  const lines = [
    `Piagent Benchmark — ${report.suite.title}`,
    `Run: ${report.runId} | ${report.runCount} sessions | ${report.repeats} repeat(s)`,
    runtimeParts.join(" | "),
    `Treatment baseline: ${report.environment.treatmentBaseline ?? "unknown"}`,
    `Piagent treatment: ${report.environment.piagentTreatment?.id ?? "unrecorded"}`,
    `Comparison: ${candidateLabel} vs ${baselineLabel}`,
    `Comparison purpose: ${report.comparison.purpose ?? "unspecified"}`,
    `Claim tier: ${report.comparison.claimEligibility?.achievedTier ?? "unavailable"} (declared ${report.comparison.claimEligibility?.declaredTier ?? "unavailable"})`,
    `Token claim scope: ${report.comparison.claimEligibility?.tokenClaimScope ?? "unavailable"}`,
    ...(report.comparison.tokenClaimUnavailableReason
      ? [`Token claim restriction: ${report.comparison.tokenClaimUnavailableReason}`]
      : []),
    `Suite digest: ${report.environment.suiteDigest ?? "unknown"} | Source: ${report.environment.source?.kind ?? "unknown"}${report.environment.source?.dirty === true ? " (dirty)" : ""}`,
    `Infrastructure: ${report.infrastructure?.attempts ?? report.runCount} attempts | ${report.infrastructure?.retries ?? 0} retries across ${report.infrastructure?.retriedRuns ?? 0} measured runs`,
    "",
    "Surface     Resolved   Task grade    Scope     Quality  Safety  Reliability  Workflow  Efficiency  Overall",
    scoreLine(baselineLabel, baseline),
    scoreLine(candidateLabel, candidate),
    "",
    "Median usage across all measured runs",
    "Surface     Input      Output     Cache read  Cache write  Reasoning  Fresh      Total      Tools  Reported cost",
    usageLine(baselineLabel, baseline),
    usageLine(candidateLabel, candidate),
    `${baselineLabel} tools: ${topToolSummary(baseline.usage.toolNames)}`,
    `${candidateLabel} tools: ${topToolSummary(candidate.usage.toolNames)}`,
    `Observational timing (${baselineLabel}): ${timingSummary(report.timingDiagnostics, baselineSurface)}`,
    `Observational timing (${candidateLabel}): ${timingSummary(report.timingDiagnostics, candidateSurface)}`,
    "Timing authority: privacy-safe monotonic JSONL receipt boundaries only; unavailable boundaries are not estimated and timing never affects duration or a release/spend gate.",
    `Piagent workflow gaps: ${workflowGapSummary(report.runs.filter((run) => run.surface === "piagent"))}`,
    `Token accounting: input=fresh input; reasoning is included in output; fresh=input+output; total=input+cache read+cache write+output`,
    `Attempt completeness: accepted ${report.tokenAccounting?.acceptedAttempts.exactAttempts ?? 0}/${report.tokenAccounting?.acceptedAttempts.attempts ?? 0} exact | failed ${report.tokenAccounting?.failedAttempts.exactAttempts ?? 0}/${report.tokenAccounting?.failedAttempts.attempts ?? 0} exact | failed fresh ${display(report.tokenAccounting?.failedAttempts.tokens.fresh, 0)}`,
    "",
    `Paired successful runs: ${report.comparison.pairedSuccessfulRuns}`,
    `Paired runs with comparable usage: ${report.comparison.pairedUsageRuns}`,
    `Independent paired scenario families: ${report.comparison.pairedUsageScenarios ?? 0}`,
    `Complete paired scenario families: ${report.comparison.pairedCompleteScenarios ?? 0}`,
    `Paired runs with comparable duration: ${report.comparison.pairedDurationRuns ?? 0}`,
    `Complete paired duration families: ${report.comparison.pairedCompleteDurationScenarios ?? 0}`,
    `Complete paired outcome families: ${report.comparison.pairedOutcomeScenarios ?? 0}`,
    `Usage estimator: ${report.comparison.usageEstimator}`,
    `Primary efficiency estimand: ${report.comparison.primaryEfficiencyEstimand ?? "unavailable"}`,
    `Primary fresh-token ratio: ${display(report.comparison.primaryEfficiencyRatio, 4)} | 95% CI ${primaryConfidence ? `${display(primaryConfidence.lower, 4)}..${display(primaryConfidence.upper, 4)}` : "n/a"}`,
    `Fixed-workload family ratio: ${display(report.comparison.fixedWorkloadFamilyFreshTokenRatio, 4)} | 95% CI ${fixedWorkloadConfidence ? `${display(fixedWorkloadConfidence.lower, 4)}..${display(fixedWorkloadConfidence.upper, 4)}` : "n/a"} | complete ${report.comparison.fixedWorkloadFamilyCoverage?.usableScenarioFamilies ?? 0}/${report.comparison.fixedWorkloadFamilyCoverage?.expectedScenarioFamilies ?? 0}`,
    `Fixed-workload aggregate ratio (descriptive): ${display(report.comparison.fixedWorkloadAggregateFreshTokenRatio, 4)}`,
    `Fresh-token pair wins: ${candidateLabel} ${report.comparison.pairedFreshTokenWins[candidateKey]} | ${baselineLabel} ${report.comparison.pairedFreshTokenWins[baselineKey]} | ties ${report.comparison.pairedFreshTokenWins.ties}`,
    `Median paired fresh-token delta: ${display(report.comparison.medianPairedFreshTokenDelta, 0)} tok (negative favors ${candidateLabel})`,
    `Successful-pair complete-family ratio: ${display(report.comparison.freshTokenRatio, 4)} | 95% CI ${confidence ? `${display(confidence.lower, 4)}..${display(confidence.upper, 4)}` : "n/a"}`,
    `All-successful-pairs descriptive ratio: ${display(report.comparison.allSuccessfulPairsFreshTokenRatio, 4)}`,
    `Normalized API-equivalent text-token cost: ${display(normalizedCost?.ratio, 4)} | 95% CI ${normalizedCostConfidence ? `${display(normalizedCostConfidence.lower, 4)}..${display(normalizedCostConfidence.upper, 4)}` : "n/a"} | delta ${displayPercent(normalizedCost?.deltaPercent)}`,
    `Normalized-cost source: ${normalizedCost?.pricingSnapshot?.id ?? "n/a"} | billed/provider-reported cost: no | exact/applicable pairs ${normalizedCost?.comparablePairs ?? 0}/${normalizedCost?.expectedPairs ?? 0}`,
    `Codex-relative total token traffic: ${display(codexRelative?.totalTokenTraffic?.ratio, 4)} | 95% CI ${codexRelativeTrafficConfidence ? `${display(codexRelativeTrafficConfidence.lower, 4)}..${display(codexRelativeTrafficConfidence.upper, 4)}` : "n/a"} | required upper <= ${display(codexRelative?.policy?.maximumTotalTokenTrafficRatioUpper95, 2)}`,
    `Codex-relative API-equivalent cost: ${display(codexRelative?.apiEquivalentCost?.ratio, 4)} | 95% CI ${codexRelativeCostConfidence ? `${display(codexRelativeCostConfidence.lower, 4)}..${display(codexRelativeCostConfidence.upper, 4)}` : "n/a"} | required upper <= ${display(codexRelative?.policy?.maximumApiEquivalentCostRatioUpper95, 2)}`,
    `Codex-relative subagent budget: ${codexRelative?.subagents?.sessions ?? "n/a"} sessions | ${displayRatioPercent(codexRelative?.subagents?.trafficShare)} traffic share | max ${codexRelative?.policy?.maximumSubagentSessionsPerAttempt ?? "n/a"}/attempt and ${displayRatioPercent(codexRelative?.policy?.maximumSubagentTrafficShare)}`,
    `Codex-relative efficiency gate: ${report.comparison.codexRelativeEfficiencyGate === null ? "n/a" : report.comparison.codexRelativeEfficiencyGate ? "pass" : `fail (${(codexRelative?.failures ?? []).join(", ") || "missing evidence"})`} | subscription-billed claim: no`,
    `Duration pair wins: ${candidateLabel} ${report.comparison.pairedDurationWins?.[candidateKey] ?? 0} | ${baselineLabel} ${report.comparison.pairedDurationWins?.[baselineKey] ?? 0} | ties ${report.comparison.pairedDurationWins?.ties ?? 0}`,
    `Median paired duration delta: ${display(report.comparison.medianPairedDurationDeltaSeconds, 2)}s (negative favors ${candidateLabel})`,
    `Duration ratio 95% CI: ${durationConfidence ? `${display(durationConfidence.lower, 4)}..${display(durationConfidence.upper, 4)}` : "n/a"}`,
    `Failure-aware fresh tokens/resolved outcome: ${candidateLabel} ${display(report.comparison.freshTokensPerResolvedOutcome?.[candidateKey], 2)} | ${baselineLabel} ${display(report.comparison.freshTokensPerResolvedOutcome?.[baselineKey], 2)} | ratio ${display(report.comparison.failureAwareFreshTokenRatio, 4)}`,
    `Failure-aware family ratio: ${display(report.comparison.failureAwareFamilyFreshTokenRatio, 4)} | 95% CI ${failureAwareFamilyConfidence ? `${display(failureAwareFamilyConfidence.lower, 4)}..${display(failureAwareFamilyConfidence.upper, 4)}` : "n/a"} | complete ${report.comparison.failureAwareFamilyCoverage?.usableScenarioFamilies ?? 0}/${report.comparison.failureAwareFamilyCoverage?.expectedScenarioFamilies ?? 0}`,
    `Paired resolved outcomes: ${pairedOutcomeSummary(report.comparison.pairedOutcomes?.resolved, candidateLabel, baselineLabel)}`,
    `Paired quality outcomes: ${pairedOutcomeSummary(report.comparison.pairedOutcomes?.quality, candidateLabel, baselineLabel)}`,
    `Paired safety outcomes: ${pairedOutcomeSummary(report.comparison.pairedOutcomes?.safety, candidateLabel, baselineLabel)}`,
    `Comparison protocol gate: ${report.comparison.comparisonProtocolGate?.passed ? "pass" : `fail (${(report.comparison.comparisonProtocolGate?.failedChecks ?? []).join(", ") || "missing evidence"})`}`,
    `Provider-wire surface gate: ${report.comparison.providerWireSurfaceGate === null ? "n/a" : report.comparison.providerWireSurfaceGate ? "pass" : "fail"}`,
    `Provider-wire evidence: ${report.comparison.providerWireEvidence?.verifiedRuns ?? 0}/${report.comparison.providerWireEvidence?.runs ?? 0} runs | ${report.comparison.providerWireEvidence?.groups?.length ?? 0} repeat groups | ${(report.comparison.providerWireEvidence?.driftGroups ?? []).length} base-prefix drift groups | failures ${topToolSummary(report.comparison.providerWireEvidence?.failureCounts)}`,
    `Deferred tool surfaces: ${(report.comparison.providerWireEvidence?.groups ?? []).filter((group) => group.deferredToolSurfaceHashCount > 1).length} varying groups (reported separately; not base-prefix drift)`,
    `Causal context receipt gate: ${report.comparison.causalContextEvidenceGate === null ? "n/a" : report.comparison.causalContextEvidenceGate ? "pass" : "fail"} | current v${causalContext?.requiredSchemaVersion ?? "?"} complete ${causalContext?.currentAvailableRuns ?? 0}/${causalContext?.runs ?? 0} Piagent runs`,
    `Causal pack totals: offered ${causalAggregates?.packCounts.offered ?? "n/a"} | delivered ${causalAggregates?.packCounts.delivered ?? "n/a"} | injected ${causalAggregates?.packCounts.injected ?? "n/a"} | injected estimated tokens ${causalAggregates?.estimatedTokens.injected ?? "n/a"} | selected items ${causalAggregates?.selectedItemCounts.injected ?? "n/a"}`,
    `Causal criterion/continuity: attempts ${causalAggregates?.criterionInitialPack.attempts ?? "n/a"} | selected ${causalAggregates?.criterionInitialPack.selectedAttempts ?? "n/a"} | successful direct fallback rereads ${causalAggregates?.directFallbackRereads.successfulCalls ?? "n/a"} | shell calls after injection ${causalAggregates?.directFallbackRereads.shellToolCallsObserved ?? "n/a"} | compactions ${causalAggregates?.compactionEventsObserved ?? "n/a"} | managed-prefix compacted ${causalAggregates?.managedPrefixCompactedPrompts ?? "n/a"}/${causalAggregates?.managedPrefixPromptsObserved ?? "n/a"}`,
    `Causal edit recovery: contexts ${causalAggregates?.editRecoveryContext?.count ?? "n/a"}/${causalAggregates?.editRecoveryContext?.failuresObserved ?? "n/a"} failures | suppressed ${causalAggregates?.editRecoveryContext?.suppressedFailures ?? "n/a"} | injected chars ${causalAggregates?.editRecoveryContext?.injectedChars ?? "n/a"} | injected estimated tokens ${causalAggregates?.editRecoveryContext?.injectedEstimatedTokens ?? "n/a"} | evidence ${causalAggregates?.editRecoveryContext?.evidenceCoverage?.status ?? "unavailable"} (${causalAggregates?.editRecoveryContext?.evidenceCoverage?.comparableRuns ?? 0}/${causalAggregates?.editRecoveryContext?.evidenceCoverage?.runs ?? 0} runs)`,
    `Release-claim configuration gate: ${report.comparison.releaseClaimConfigurationGate === false ? "fail" : report.comparison.releaseClaimConfigurationGate === true ? "pass" : "n/a"}`,
    `Codex baseline gate: ${report.comparison.codexBaselineGate === null ? "n/a" : report.comparison.codexBaselineGate ? "pass" : "fail"}`,
    `Clean release source gate: ${report.comparison.cleanReleaseSourceGate === null ? "n/a" : report.comparison.cleanReleaseSourceGate ? "pass" : "fail"}`,
    `Host-readiness history gate: ${report.comparison.hostReadinessGate === null ? "n/a" : report.comparison.hostReadinessGate ? "pass" : "fail"} | valid receipts ${hostReadiness?.validReceiptCount ?? 0}/${hostReadiness?.receiptCount ?? 0} | coverage ${hostReadiness?.windowCoverage ?? "n/a"}`,
    `Full-suite gate: ${report.comparison.fullSuiteGate === null ? "n/a" : report.comparison.fullSuiteGate ? "pass" : "fail"}`,
    `Paired outcome evidence gate: ${report.comparison.outcomeEvidenceGate ? "pass" : "fail"}`,
    `Successful-pair evidence (${report.comparison.successfulPairEfficiencyRole ?? "blocking"}): ${report.comparison.efficiencyEvidenceGate ? "complete" : "incomplete"}`,
    `Successful-pair category coverage (${report.comparison.successfulPairEfficiencyRole ?? "blocking"}): ${report.comparison.efficiencyBandCoverageGate ? "complete" : `incomplete (${(report.comparison.efficiencyCategoryCoverage?.missing ?? []).join(", ") || "missing evidence"})`}`,
    `Failure-aware efficiency (${report.comparison.failureAwareEfficiencyRole ?? "blocking"}): ${report.comparison.failureAwareEfficiencyGate ? "within threshold" : "unavailable or above threshold"}`,
    `Primary efficiency evidence gate: ${report.comparison.primaryEfficiencyEvidenceGate ? "pass" : "fail"}`,
    `Primary efficiency category coverage: ${report.comparison.primaryEfficiencyBandCoverageGate ? "pass" : `fail (${(report.comparison.primaryEfficiencyCategoryCoverage?.missing ?? []).join(", ") || "missing evidence"})`}`,
    `Primary efficiency confidence gate: ${report.comparison.primaryEfficiencyConfidenceGate === null ? "n/a" : report.comparison.primaryEfficiencyConfidenceGate ? "pass" : "fail"}`,
    `Primary efficiency gate: ${report.comparison.primaryEfficiencyGate === null ? "n/a" : report.comparison.primaryEfficiencyGate ? "pass" : "fail"}`,
    `Paired candidate-regression gate: ${report.comparison.pairedRegressionGate ? "pass" : "fail"}`,
    `Repeat-count gate: ${report.comparison.repeatGate === null ? "n/a" : report.comparison.repeatGate ? "pass" : "fail"}`,
    `Efficiency confidence gate: ${report.comparison.efficiencyConfidenceGate === null ? "n/a" : report.comparison.efficiencyConfidenceGate ? "pass" : "fail"}`,
    `Fresh-token band gate: ${report.comparison.freshTokenBandGate === null ? "n/a" : report.comparison.freshTokenBandGate ? "pass" : `fail (${(report.comparison.freshTokenBandFailures ?? []).map((item) => `${item.dimension}:${item.name}=${item.observedBound ?? "n/a"}`).join(", ")})`}`,
    `Fresh-token family guardrail: ${report.comparison.freshTokenFamilyGate === null ? "n/a" : report.comparison.freshTokenFamilyGate ? "pass" : `fail (${(report.comparison.freshTokenFamilyFailures ?? []).map((item) => `${item.scenarioId}=${item.ratio}`).join(", ")})`}`,
    `Performance evidence gate: ${report.comparison.performanceEvidenceGate === null ? "n/a" : report.comparison.performanceEvidenceGate ? "pass" : "fail"}`,
    `Performance point-estimate gate (ratio <= 1.0): ${report.comparison.performancePointEstimateGate === null ? "n/a" : report.comparison.performancePointEstimateGate ? "pass" : "fail"}`,
    `Performance confidence gate: ${report.comparison.performanceConfidenceGate === null ? "n/a" : report.comparison.performanceConfidenceGate ? "pass" : "fail"}`,
    `Duration band gate: ${report.comparison.durationBandGate === null ? "n/a" : report.comparison.durationBandGate ? "pass" : `fail (${(report.comparison.durationBandFailures ?? []).map((item) => `${item.dimension}:${item.name}=${item.ratio ?? "n/a"}`).join(", ")})`}`,
    `Duration family guardrail: ${report.comparison.durationFamilyGate === null ? "n/a" : report.comparison.durationFamilyGate ? "pass" : `fail (${(report.comparison.durationFamilyFailures ?? []).map((item) => `${item.scenarioId}=${item.ratio ?? "n/a"}`).join(", ")})`}`,
    `Infrastructure retry gate: ${report.comparison.infrastructureRetryGate === null ? "n/a" : report.comparison.infrastructureRetryGate ? "pass" : "fail"}`,
    `Infrastructure failure-ledger gate: ${report.comparison.infrastructureFailureLedgerGate === null ? "n/a" : report.comparison.infrastructureFailureLedgerGate ? "pass" : `fail (${report.comparison.infrastructureFailureLedgerIssues?.length ?? 0} runs)`}`,
    `Unknown infrastructure usage gate: ${report.comparison.unknownInfrastructureUsageGate === null ? "n/a" : report.comparison.unknownInfrastructureUsageGate ? "pass" : "fail"}`,
    `Accepted usage completeness gate: ${report.comparison.acceptedUsageCompletenessGate === null ? "n/a" : report.comparison.acceptedUsageCompletenessGate ? "pass" : "fail"}`,
    `Failed-attempt usage completeness gate: ${report.comparison.failedUsageCompletenessGate === null ? "n/a" : report.comparison.failedUsageCompletenessGate ? "pass" : "fail"}`,
    `All-attempt usage completeness gate: ${report.comparison.allAttemptUsageCompletenessGate === null ? "n/a" : report.comparison.allAttemptUsageCompletenessGate ? "pass" : "fail"}`,
    `Normalized-cost configuration gate: ${report.comparison.normalizedCostClaimConfigurationGate === null ? "n/a" : report.comparison.normalizedCostClaimConfigurationGate ? "pass" : "fail"}`,
    `Normalized-cost pricing applicability gate: ${report.comparison.normalizedCostPricingApplicabilityGate === null ? "n/a" : report.comparison.normalizedCostPricingApplicabilityGate ? "pass" : "fail"}`,
    `Normalized-cost confidence gate: ${report.comparison.normalizedCostConfidenceGate === null ? "n/a" : report.comparison.normalizedCostConfidenceGate ? "pass" : "fail"}`,
    `Normalized-cost band gate: ${report.comparison.normalizedCostBandGate === null ? "n/a" : report.comparison.normalizedCostBandGate ? "pass" : "fail"}`,
    `Normalized-cost family gate: ${report.comparison.normalizedCostFamilyGate === null ? "n/a" : report.comparison.normalizedCostFamilyGate ? "pass" : "fail"}`,
    `Quality gate: ${report.comparison.qualityGate ? "pass" : "fail"}`,
    `Reliability gate: ${report.comparison.reliabilityGate ? "pass" : "fail"}`,
    `Successful-pair complete-family token delta: ${displayPercent(report.comparison.freshTokenDeltaPercent)} (negative favors ${candidateLabel})`,
    `Primary efficiency token delta: ${displayPercent(report.comparison.primaryEfficiencyDeltaPercent)} (negative favors ${candidateLabel})`,
    `Duration delta: ${displayPercent(report.comparison.durationDeltaPercent)} (negative favors ${candidateLabel})`,
    `Provider-reported cost delta: ${displayPercent(report.comparison.costDeltaPercent)} (negative favors ${candidateLabel}; not normalized cost)`,
    `Workflow gate: ${report.comparison.workflowGate === null ? "n/a" : report.comparison.workflowGate ? "pass" : "fail"}`,
    `Category gate: ${report.comparison.categoryGate === null ? "n/a" : report.comparison.categoryGate ? "pass" : "fail"}`,
    `Every outcome score > floor: ${report.comparison.outcomeScoreGate === null ? "n/a" : report.comparison.outcomeScoreGate ? "pass" : `fail (${(report.comparison.outcomeScoreFailures ?? []).map((item) => `${item.id}=${item.score ?? "n/a"}`).join(", ")})`}`,
    ...(report.comparison.suiteGate ? [
      `Suite gate: ${report.comparison.suiteGate.passed ? "pass" : "fail"}`,
      `Suite gate failures: ${suiteFailureReasons || "none"}`
    ] : []),
    ...(usageBandLines.length ? ["", "Paired fresh-token ratio by category", "Category                      Pairs   Families  Ratio       Median delta", ...usageBandLines] : []),
    ...(categoryLines.length ? ["", `${candidateLabel} category bands`, "Category                      Resolved   Score", ...categoryLines] : []),
    `Verdict: ${report.verdict.status}`,
    `Token-saving claim allowed: ${report.comparison.tokenClaimAllowed ? "yes" : "no"}`,
    `Generalization claim allowed: ${report.comparison.claimEligibility?.generalizationClaimAllowed ? "yes" : "no"}`,
    `Claim limitations: ${(report.comparison.claimEligibility?.limitations ?? []).join(", ") || "none"}`
  ];
  return `${lines.join("\n")}\n`;
}

function htmlEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderBenchmarkHtml(report) {
  const baselineSurface = report.comparison.baselineSurface ?? "raw-pi";
  const candidateSurface = report.comparison.candidateSurface ?? "piagent";
  const baselineKey = surfaceReportKey(baselineSurface);
  const candidateKey = surfaceReportKey(candidateSurface);
  const surfaceEntries = [[baselineSurface, report.surfaces[baselineKey]], [candidateSurface, report.surfaces[candidateKey]]];
  const baselineLabel = surfaceLabel(baselineSurface);
  const candidateLabel = surfaceLabel(candidateSurface);
  const rows = report.runs.map((run) => `<tr><td>${htmlEscape(run.scenarioId)}</td><td>${htmlEscape(run.category ?? "unspecified")}</td><td>${htmlEscape(run.difficulty ?? "unspecified")}</td><td>${htmlEscape(run.profile ?? "unspecified")}</td><td>${htmlEscape(run.lifecycle ?? "unspecified")}</td><td>${htmlEscape(run.surface)}</td><td>${run.repeat}</td><td>${run.infrastructureRetries ?? 0}</td><td>${run.resolved ? "PASS" : "FAIL"}</td><td>${run.grade?.passed ? "PASS" : "FAIL"}</td><td>${run.scope?.passed ? "PASS" : "FAIL"}</td><td>${display(run.workflow?.score)}</td><td>${htmlEscape((run.workflow?.checks ?? []).filter((check) => !check.passed).map((check) => check.id).join(", ") || "none")}</td><td>${htmlEscape(run.usage?.model ?? "unknown")}</td><td>${htmlEscape(run.usage?.thinkingLevel ?? "unknown")}</td><td>${htmlEscape(run.usage?.usageSource ?? "unknown")}</td><td>${display(run.usage?.input, 0)}</td><td>${display(run.usage?.output, 0)}</td><td>${display(run.usage?.cacheRead, 0)}</td><td>${display(run.usage?.cacheWrite, 0)}</td><td>${display(run.usage?.reasoning, 0)}</td><td>${display(run.usage?.fresh, 0)}</td><td>${display(run.usage?.total, 0)}</td><td>${display(run.usage?.toolCalls, 0)}</td><td>${htmlEscape(topToolSummary(run.usage?.toolNames, 5))}</td><td>${display(run.usage?.cost, 6)}</td><td>${display(run.durationSeconds, 1)}</td><td>${htmlEscape(run.failure ?? "")}</td></tr>`).join("");
  const scoreRows = surfaceEntries.map(([id, surface]) => `<tr><th>${htmlEscape(surfaceLabel(id))}</th><td>${surface.resolved}/${surface.runs}</td><td>${surface.qualityCorrect}/${surface.qualityRuns}</td><td>${surface.scopePassed}/${surface.runs}</td><td>${display(surface.scores.quality)}</td><td>${display(surface.scores.safety)}</td><td>${display(surface.scores.reliability)}</td><td>${display(surface.scores.workflow)}</td><td>${display(surface.scores.efficiency)}</td><td>${display(surface.scores.overall)}</td></tr>`).join("");
  const usageRows = surfaceEntries.map(([id, surface]) => { const usage = surface.usage.allMeasuredRuns; return `<tr><th>${htmlEscape(surfaceLabel(id))}</th><td>${display(usage.medianInputTokens, 0)}</td><td>${display(usage.medianOutputTokens, 0)}</td><td>${display(usage.medianCacheReadTokens, 0)}</td><td>${display(usage.medianCacheWriteTokens, 0)}</td><td>${display(usage.medianReasoningTokens, 0)}</td><td>${display(usage.medianFreshTokens, 0)}</td><td>${display(usage.medianTotalTokens, 0)}</td><td>${display(usage.medianToolCalls, 0)}</td><td>${display(usage.medianCost, 6)}</td><td>${display(usage.medianDurationSeconds, 1)}</td><td>${htmlEscape(topToolSummary(surface.usage.toolNames))}</td></tr>`; }).join("");
  const categoryRows = Object.entries(report.surfaces[candidateKey].bands?.categories ?? {}).map(([name, band]) => `<tr><th>${htmlEscape(name)}</th><td>${band.resolved}/${band.runs}</td><td>${display(band.score)}</td><td>${display(band.correctness)}</td></tr>`).join("");
  const tokenBandRows = Object.entries(report.comparison.pairedUsageBands?.categories ?? {}).map(([name, band]) => `<tr><th>${htmlEscape(name)}</th><td>${band.pairs}</td><td>${band.scenarioFamilies}</td><td>${display(band.freshTokenRatio, 4)}</td><td>${display(band.medianFreshTokenDelta, 0)}</td><td>${band.candidateWins}/${band.baselineWins}/${band.ties}</td></tr>`).join("");
  const confidence = report.comparison.freshTokenRatioConfidence95;
  const primaryConfidence = report.comparison.primaryEfficiencyRatioConfidence95;
  const fixedWorkloadConfidence = report.comparison.fixedWorkloadFamilyFreshTokenRatioConfidence95;
  const failureAwareFamilyConfidence = report.comparison.failureAwareFamilyFreshTokenRatioConfidence95;
  const durationConfidence = report.comparison.durationRatioConfidence95;
  const normalizedCost = report.comparison.normalizedCost;
  const normalizedCostConfidence = normalizedCost?.ratioConfidence95;
  const codexRelative = report.comparison.codexRelativeEfficiency;
  const codexRelativeTrafficConfidence = codexRelative?.totalTokenTraffic?.ratioConfidence95;
  const codexRelativeCostConfidence = codexRelative?.apiEquivalentCost?.ratioConfidence95;
  const causalContext = report.comparison.causalContextEvidence;
  const causalAggregates = causalContext?.aggregates;
  const hostReadiness = report.environment.hostReadinessHistory;
  const suiteFailureReasons = (report.comparison.suiteGate?.failureReasons ?? [])
    .map((failure) => `${failure.id}: ${failure.message}`)
    .join("; ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Piagent Benchmark ${htmlEscape(report.runId)}</title>
<style>body{font:14px system-ui,sans-serif;color:#202124;max-width:1180px;margin:32px auto;padding:0 20px}h1{font-size:24px}h2{font-size:17px;margin-top:28px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{border:1px solid #d8dadd;padding:8px;text-align:left}thead th{background:#f4f5f6}.metric{display:inline-block;margin:0 24px 8px 0}.note{color:#5f6368}</style></head><body>
<h1>Piagent Benchmark</h1><p>${htmlEscape(report.suite.title)} · ${htmlEscape(report.runId)}</p><p class="note">Platform v${htmlEscape(report.environment.platformVersion ?? "unknown")} · Pi ${htmlEscape(report.environment.piVersion ?? "unknown")}${report.environment.codexVersion ? ` · Codex ${htmlEscape(report.environment.codexVersion)}` : ""} · Node ${htmlEscape(report.environment.nodeVersion ?? "unknown")} · Baseline ${htmlEscape(report.environment.treatmentBaseline ?? "unknown")} · Piagent treatment ${htmlEscape(report.environment.piagentTreatment?.id ?? "unrecorded")} · Suite ${htmlEscape(report.environment.suiteDigest ?? "unknown")}</p>
<p class="metric"><strong>Comparison:</strong> ${htmlEscape(candidateLabel)} vs ${htmlEscape(baselineLabel)}</p><p class="metric"><strong>Purpose:</strong> ${htmlEscape(report.comparison.purpose ?? "unspecified")}</p><p class="metric"><strong>Claim tier:</strong> ${htmlEscape(report.comparison.claimEligibility?.achievedTier ?? "unavailable")}</p><p class="metric"><strong>Token claim scope:</strong> ${htmlEscape(report.comparison.claimEligibility?.tokenClaimScope ?? "unavailable")}</p>${report.comparison.tokenClaimUnavailableReason ? `<p class="metric"><strong>Token claim restriction:</strong> ${htmlEscape(report.comparison.tokenClaimUnavailableReason)}</p>` : ""}<p class="metric"><strong>Verdict:</strong> ${htmlEscape(report.verdict.status)}</p><p class="metric"><strong>Protocol:</strong> ${report.comparison.comparisonProtocolGate?.passed ? "PASS" : `FAIL (${htmlEscape((report.comparison.comparisonProtocolGate?.failedChecks ?? []).join(", ") || "missing evidence")})`}</p><p class="metric"><strong>Codex-relative gate:</strong> ${report.comparison.codexRelativeEfficiencyGate === null ? "n/a" : report.comparison.codexRelativeEfficiencyGate ? "PASS" : "FAIL"}</p><p class="metric"><strong>Total token traffic:</strong> ${display(codexRelative?.totalTokenTraffic?.ratio, 4)}${codexRelativeTrafficConfidence ? ` (${display(codexRelativeTrafficConfidence.lower, 4)}–${display(codexRelativeTrafficConfidence.upper, 4)})` : ""} · upper ≤ ${display(codexRelative?.policy?.maximumTotalTokenTrafficRatioUpper95, 2)}</p><p class="metric"><strong>API-equivalent cost:</strong> ${display(codexRelative?.apiEquivalentCost?.ratio, 4)}${codexRelativeCostConfidence ? ` (${display(codexRelativeCostConfidence.lower, 4)}–${display(codexRelativeCostConfidence.upper, 4)})` : ""} · upper ≤ ${display(codexRelative?.policy?.maximumApiEquivalentCostRatioUpper95, 2)}</p><p class="metric"><strong>Subagent traffic:</strong> ${displayRatioPercent(codexRelative?.subagents?.trafficShare)} · ${codexRelative?.subagents?.sessions ?? "n/a"} sessions</p><p class="metric"><strong>Provider wire:</strong> ${report.comparison.providerWireSurfaceGate === null ? "n/a" : report.comparison.providerWireSurfaceGate ? "PASS" : "FAIL"} (${report.comparison.providerWireEvidence?.verifiedRuns ?? 0}/${report.comparison.providerWireEvidence?.runs ?? 0} runs, ${(report.comparison.providerWireEvidence?.driftGroups ?? []).length} drift groups)</p><p class="metric"><strong>Causal receipt:</strong> ${report.comparison.causalContextEvidenceGate === null ? "n/a" : report.comparison.causalContextEvidenceGate ? "PASS" : "FAIL"} (current v${causalContext?.requiredSchemaVersion ?? "?"} ${causalContext?.currentAvailableRuns ?? 0}/${causalContext?.runs ?? 0} runs)</p><p class="metric"><strong>Host readiness:</strong> ${report.comparison.hostReadinessGate === null ? "n/a" : report.comparison.hostReadinessGate ? "PASS" : "FAIL"} (${hostReadiness?.validReceiptCount ?? 0}/${hostReadiness?.receiptCount ?? 0} valid receipts · ${htmlEscape(hostReadiness?.windowCoverage ?? "n/a")} coverage)</p><p class="metric"><strong>Causal packs:</strong> ${causalAggregates ? `${causalAggregates.packCounts.offered}/${causalAggregates.packCounts.delivered}/${causalAggregates.packCounts.injected} offered/delivered/injected · ${causalAggregates.estimatedTokens.injected} injected estimated tokens · ${causalAggregates.selectedItemCounts.injected} selected items` : "unavailable"}</p><p class="metric"><strong>Causal direct rereads:</strong> ${causalAggregates ? `${causalAggregates.directFallbackRereads.successfulCalls} successful direct-path calls · ${causalAggregates.directFallbackRereads.shellToolCallsObserved} shell calls after injection` : "unavailable"}</p><p class="metric"><strong>Causal edit recovery:</strong> ${causalAggregates?.editRecoveryContext ? `${causalAggregates.editRecoveryContext.count ?? "n/a"} contexts · ${causalAggregates.editRecoveryContext.injectedChars ?? "n/a"} chars · ${causalAggregates.editRecoveryContext.injectedEstimatedTokens ?? "n/a"} estimated tokens · ${htmlEscape(causalAggregates.editRecoveryContext.evidenceCoverage?.status ?? "unavailable")} evidence` : "unavailable"}</p><p class="metric"><strong>Suite gate:</strong> ${report.comparison.suiteGate ? report.comparison.suiteGate.passed ? "PASS" : "FAIL" : "n/a"}</p><p class="metric"><strong>Infrastructure retries:</strong> ${report.infrastructure?.retries ?? 0}</p><p class="metric"><strong>Stability gate:</strong> ${report.comparison.stabilityGate === null ? "n/a" : report.comparison.stabilityGate ? "PASS" : "FAIL"}</p><p class="metric"><strong>Primary estimand:</strong> ${htmlEscape(report.comparison.primaryEfficiencyEstimand ?? "unavailable")}</p><p class="metric"><strong>Primary token delta:</strong> ${displayPercent(report.comparison.primaryEfficiencyDeltaPercent)}</p><p class="metric"><strong>Primary ratio 95% CI:</strong> ${primaryConfidence ? `${display(primaryConfidence.lower, 4)}–${display(primaryConfidence.upper, 4)}` : "n/a"}</p><p class="metric"><strong>Fixed-workload ratio:</strong> ${display(report.comparison.fixedWorkloadFamilyFreshTokenRatio, 4)}${fixedWorkloadConfidence ? ` (${display(fixedWorkloadConfidence.lower, 4)}–${display(fixedWorkloadConfidence.upper, 4)})` : ""}</p><p class="metric"><strong>Fixed-workload coverage:</strong> ${report.comparison.fixedWorkloadFamilyCoverage?.usableScenarioFamilies ?? 0}/${report.comparison.fixedWorkloadFamilyCoverage?.expectedScenarioFamilies ?? 0} families</p><p class="metric"><strong>Successful-pair diagnostic role:</strong> ${htmlEscape(report.comparison.successfulPairEfficiencyRole ?? "blocking")}</p><p class="metric"><strong>Successful-pair token delta:</strong> ${displayPercent(report.comparison.freshTokenDeltaPercent)}</p><p class="metric"><strong>Successful-pair ratio 95% CI:</strong> ${confidence ? `${display(confidence.lower, 4)}–${display(confidence.upper, 4)}` : "n/a"}</p><p class="metric"><strong>Normalized API-equivalent text-token cost ratio:</strong> ${display(normalizedCost?.ratio, 4)}${normalizedCostConfidence ? ` (${display(normalizedCostConfidence.lower, 4)}–${display(normalizedCostConfidence.upper, 4)})` : ""}</p><p class="metric"><strong>Normalized-cost gate:</strong> ${report.comparison.normalizedCostGate === null ? "n/a" : report.comparison.normalizedCostGate ? "PASS" : "FAIL"}</p><p class="metric"><strong>Failure-aware family ratio:</strong> ${display(report.comparison.failureAwareFamilyFreshTokenRatio, 4)}${failureAwareFamilyConfidence ? ` (${display(failureAwareFamilyConfidence.lower, 4)}–${display(failureAwareFamilyConfidence.upper, 4)})` : ""}</p><p class="metric"><strong>Failure-aware pooled ratio:</strong> ${display(report.comparison.failureAwareFreshTokenRatio, 4)}</p><p class="metric"><strong>Duration-ratio delta:</strong> ${displayPercent(report.comparison.durationDeltaPercent)}</p><p class="metric"><strong>Duration ratio 95% CI:</strong> ${durationConfidence ? `${display(durationConfidence.lower, 4)}–${display(durationConfidence.upper, 4)}` : "n/a"}</p><p class="metric"><strong>Performance gate:</strong> ${report.comparison.performanceGate === null ? "n/a" : report.comparison.performanceGate ? "PASS" : "FAIL"}</p><p class="metric"><strong>Provider-reported cost-ratio delta:</strong> ${displayPercent(report.comparison.costDeltaPercent)}</p><p class="metric"><strong>Comparable pairs:</strong> ${report.comparison.pairedUsageRuns}</p><p class="metric"><strong>Scenario families:</strong> ${report.comparison.pairedUsageScenarios ?? 0}</p><p class="metric"><strong>Complete families:</strong> ${report.comparison.pairedCompleteScenarios ?? 0}</p><p class="metric"><strong>Duration families:</strong> ${report.comparison.pairedCompleteDurationScenarios ?? 0}</p><p class="metric"><strong>Outcome families:</strong> ${report.comparison.pairedOutcomeScenarios ?? 0}</p><p class="metric"><strong>Pair wins:</strong> ${htmlEscape(candidateLabel)} ${report.comparison.pairedFreshTokenWins[candidateKey]} · ${htmlEscape(baselineLabel)} ${report.comparison.pairedFreshTokenWins[baselineKey]} · ties ${report.comparison.pairedFreshTokenWins.ties}</p>
<p class="metric"><strong>Observational timing (${htmlEscape(baselineLabel)}):</strong> ${htmlEscape(timingSummary(report.timingDiagnostics, baselineSurface))}</p><p class="metric"><strong>Observational timing (${htmlEscape(candidateLabel)}):</strong> ${htmlEscape(timingSummary(report.timingDiagnostics, candidateSurface))}</p>
<p class="note">Timing uses privacy-safe monotonic JSONL receipt boundaries only. Missing boundaries remain unavailable; these diagnostics do not alter authoritative duration or any release/spend gate.</p>
<p class="metric"><strong>Edit-recovery failures:</strong> ${causalAggregates?.editRecoveryContext?.failuresObserved ?? "n/a"} observed · ${causalAggregates?.editRecoveryContext?.suppressedFailures ?? "n/a"} safely suppressed</p>
<p class="metric"><strong>Exact attempts:</strong> accepted ${report.tokenAccounting?.acceptedAttempts.exactAttempts ?? 0}/${report.tokenAccounting?.acceptedAttempts.attempts ?? 0} · failed ${report.tokenAccounting?.failedAttempts.exactAttempts ?? 0}/${report.tokenAccounting?.failedAttempts.attempts ?? 0}</p><p class="metric"><strong>Failed-attempt fresh:</strong> ${display(report.tokenAccounting?.failedAttempts.tokens.fresh, 0)}</p>
<p class="note"><strong>Token definitions:</strong> Input is fresh input only. Reasoning is already included in output. Fresh = input + output. Total = input + cache read + cache write + output. Normalized API-equivalent cost uses the versioned suite pricing snapshot and is not OAuth/provider-billed cost.</p>
${suiteFailureReasons ? `<p><strong>Suite gate failures:</strong> ${htmlEscape(suiteFailureReasons)}</p>` : ""}
<h2>Score bands</h2><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Resolved</th><th>Task grader</th><th>Scope</th><th>Quality</th><th>Safety</th><th>Reliability</th><th>Workflow</th><th>Efficiency</th><th>Overall</th></tr></thead><tbody>${scoreRows}</tbody></table></div>
${categoryRows ? `<h2>${htmlEscape(candidateLabel)} category bands</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th>Resolved</th><th>Score</th><th>Correctness</th></tr></thead><tbody>${categoryRows}</tbody></table></div>` : ""}
${tokenBandRows ? `<h2>Paired fresh-token ratio by category</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th>Pairs</th><th>Families</th><th>Ratio</th><th>Median delta</th><th>${htmlEscape(candidateLabel)}/${htmlEscape(baselineLabel)}/ties</th></tr></thead><tbody>${tokenBandRows}</tbody></table></div>` : ""}
<h2>Median usage across all measured runs</h2><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Fresh input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Reasoning ⊂ output</th><th>Fresh</th><th>Total</th><th>Tools</th><th>Provider-reported cost</th><th>Seconds</th><th>Top tools</th></tr></thead><tbody>${usageRows}</tbody></table></div>
<h2>Runs</h2><div class="table-wrap"><table><thead><tr><th>Scenario</th><th>Category</th><th>Difficulty</th><th>Profile</th><th>Lifecycle</th><th>Surface</th><th>Repeat</th><th>Infra retries</th><th>Resolved</th><th>Grader</th><th>Scope</th><th>Workflow</th><th>Workflow gaps</th><th>Model</th><th>Thinking</th><th>Usage source</th><th>Fresh input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Reasoning ⊂ output</th><th>Fresh</th><th>Total</th><th>Tools</th><th>Top tools</th><th>Provider-reported cost</th><th>Seconds</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">${htmlEscape(report.verdict.note)}</p></body></html>\n`;
}
