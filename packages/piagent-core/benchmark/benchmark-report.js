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
      + `${display(usage.medianReasoningTokens, 0)}`.padEnd(11)
      + `${display(usage.medianFreshTokens, 0)}`.padEnd(11)
      + `${display(usage.medianToolCalls, 0)}`.padEnd(7)
      + display(usage.medianCost, 6);
  };
  const categoryLines = Object.entries(candidate.bands?.categories ?? {}).map(([name, band]) => (
    `  ${name}`.padEnd(30) + `${band.resolved}/${band.runs}`.padEnd(11) + display(band.score)
  ));
  const usageBandLines = pairedUsageBandLines(report.comparison.pairedUsageBands?.categories);
  const confidence = report.comparison.freshTokenRatioConfidence95;
  const lines = [
    `Piagent Benchmark — ${report.suite.title}`,
    `Run: ${report.runId} | ${report.runCount} sessions | ${report.repeats} repeat(s)`,
    runtimeParts.join(" | "),
    `Treatment baseline: ${report.environment.treatmentBaseline ?? "unknown"}`,
    `Piagent treatment: ${report.environment.piagentTreatment?.id ?? "unrecorded"}`,
    `Comparison: ${candidateLabel} vs ${baselineLabel}`,
    `Comparison purpose: ${report.comparison.purpose ?? "unspecified"}`,
    `Claim tier: ${report.comparison.claimEligibility?.achievedTier ?? "unavailable"} (declared ${report.comparison.claimEligibility?.declaredTier ?? "unavailable"})`,
    `Suite digest: ${report.environment.suiteDigest ?? "unknown"} | Source: ${report.environment.source?.kind ?? "unknown"}${report.environment.source?.dirty === true ? " (dirty)" : ""}`,
    `Infrastructure: ${report.infrastructure?.attempts ?? report.runCount} attempts | ${report.infrastructure?.retries ?? 0} retries across ${report.infrastructure?.retriedRuns ?? 0} measured runs`,
    "",
    "Surface     Resolved   Task grade    Scope     Quality  Safety  Reliability  Workflow  Efficiency  Overall",
    scoreLine(baselineLabel, baseline),
    scoreLine(candidateLabel, candidate),
    "",
    "Median usage across all measured runs",
    "Surface     Input      Output     Cache read  Reasoning  Fresh      Tools  Cost",
    usageLine(baselineLabel, baseline),
    usageLine(candidateLabel, candidate),
    `${baselineLabel} tools: ${topToolSummary(baseline.usage.toolNames)}`,
    `${candidateLabel} tools: ${topToolSummary(candidate.usage.toolNames)}`,
    `Piagent workflow gaps: ${workflowGapSummary(report.runs.filter((run) => run.surface === "piagent"))}`,
    "",
    `Paired successful runs: ${report.comparison.pairedSuccessfulRuns}`,
    `Paired runs with comparable usage: ${report.comparison.pairedUsageRuns}`,
    `Independent paired scenario families: ${report.comparison.pairedUsageScenarios ?? 0}`,
    `Complete paired scenario families: ${report.comparison.pairedCompleteScenarios ?? 0}`,
    `Complete paired outcome families: ${report.comparison.pairedOutcomeScenarios ?? 0}`,
    `Usage estimator: ${report.comparison.usageEstimator}`,
    `Fresh-token pair wins: ${candidateLabel} ${report.comparison.pairedFreshTokenWins[candidateKey]} | ${baselineLabel} ${report.comparison.pairedFreshTokenWins[baselineKey]} | ties ${report.comparison.pairedFreshTokenWins.ties}`,
    `Median paired fresh-token delta: ${display(report.comparison.medianPairedFreshTokenDelta, 0)} tok (negative favors ${candidateLabel})`,
    `Fresh-token ratio 95% CI: ${confidence ? `${display(confidence.lower, 4)}..${display(confidence.upper, 4)}` : "n/a"}`,
    `Failure-aware fresh tokens/resolved outcome: ${candidateLabel} ${display(report.comparison.freshTokensPerResolvedOutcome?.[candidateKey], 2)} | ${baselineLabel} ${display(report.comparison.freshTokensPerResolvedOutcome?.[baselineKey], 2)} | ratio ${display(report.comparison.failureAwareFreshTokenRatio, 4)}`,
    `Paired resolved outcomes: ${pairedOutcomeSummary(report.comparison.pairedOutcomes?.resolved, candidateLabel, baselineLabel)}`,
    `Paired quality outcomes: ${pairedOutcomeSummary(report.comparison.pairedOutcomes?.quality, candidateLabel, baselineLabel)}`,
    `Paired safety outcomes: ${pairedOutcomeSummary(report.comparison.pairedOutcomes?.safety, candidateLabel, baselineLabel)}`,
    `Comparison protocol gate: ${report.comparison.comparisonProtocolGate?.passed ? "pass" : `fail (${(report.comparison.comparisonProtocolGate?.failedChecks ?? []).join(", ") || "missing evidence"})`}`,
    `Paired outcome evidence gate: ${report.comparison.outcomeEvidenceGate ? "pass" : "fail"}`,
    `Efficiency evidence gate: ${report.comparison.efficiencyEvidenceGate ? "pass" : "fail"}`,
    `Efficiency category coverage: ${report.comparison.efficiencyBandCoverageGate ? "pass" : `fail (${(report.comparison.efficiencyCategoryCoverage?.missing ?? []).join(", ") || "missing evidence"})`}`,
    `Failure-aware efficiency gate: ${report.comparison.failureAwareEfficiencyGate ? "pass" : "fail"}`,
    `Paired candidate-regression gate: ${report.comparison.pairedRegressionGate ? "pass" : "fail"}`,
    `Repeat-count gate: ${report.comparison.repeatGate === null ? "n/a" : report.comparison.repeatGate ? "pass" : "fail"}`,
    `Efficiency confidence gate: ${report.comparison.efficiencyConfidenceGate === null ? "n/a" : report.comparison.efficiencyConfidenceGate ? "pass" : "fail"}`,
    `Quality gate: ${report.comparison.qualityGate ? "pass" : "fail"}`,
    `Reliability gate: ${report.comparison.reliabilityGate ? "pass" : "fail"}`,
    `Fresh-token delta: ${displayPercent(report.comparison.freshTokenDeltaPercent)} (negative favors ${candidateLabel})`,
    `Cost delta: ${displayPercent(report.comparison.costDeltaPercent)} (negative favors ${candidateLabel})`,
    `Workflow gate: ${report.comparison.workflowGate === null ? "n/a" : report.comparison.workflowGate ? "pass" : "fail"}`,
    `Category gate: ${report.comparison.categoryGate === null ? "n/a" : report.comparison.categoryGate ? "pass" : "fail"}`,
    `Every outcome score > floor: ${report.comparison.outcomeScoreGate === null ? "n/a" : report.comparison.outcomeScoreGate ? "pass" : `fail (${(report.comparison.outcomeScoreFailures ?? []).map((item) => `${item.id}=${item.score ?? "n/a"}`).join(", ")})`}`,
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
  const rows = report.runs.map((run) => `<tr><td>${htmlEscape(run.scenarioId)}</td><td>${htmlEscape(run.category ?? "unspecified")}</td><td>${htmlEscape(run.difficulty ?? "unspecified")}</td><td>${htmlEscape(run.profile ?? "unspecified")}</td><td>${htmlEscape(run.lifecycle ?? "unspecified")}</td><td>${htmlEscape(run.surface)}</td><td>${run.repeat}</td><td>${run.infrastructureRetries ?? 0}</td><td>${run.resolved ? "PASS" : "FAIL"}</td><td>${run.grade?.passed ? "PASS" : "FAIL"}</td><td>${run.scope?.passed ? "PASS" : "FAIL"}</td><td>${display(run.workflow?.score)}</td><td>${htmlEscape((run.workflow?.checks ?? []).filter((check) => !check.passed).map((check) => check.id).join(", ") || "none")}</td><td>${htmlEscape(run.usage?.model ?? "unknown")}</td><td>${htmlEscape(run.usage?.thinkingLevel ?? "unknown")}</td><td>${display(run.usage?.input, 0)}</td><td>${display(run.usage?.output, 0)}</td><td>${display(run.usage?.cacheRead, 0)}</td><td>${display(run.usage?.reasoning, 0)}</td><td>${display(run.usage?.fresh, 0)}</td><td>${display(run.usage?.toolCalls, 0)}</td><td>${htmlEscape(topToolSummary(run.usage?.toolNames, 5))}</td><td>${display(run.usage?.cost, 6)}</td><td>${display(run.durationSeconds, 1)}</td><td>${htmlEscape(run.failure ?? "")}</td></tr>`).join("");
  const scoreRows = surfaceEntries.map(([id, surface]) => `<tr><th>${htmlEscape(surfaceLabel(id))}</th><td>${surface.resolved}/${surface.runs}</td><td>${surface.qualityCorrect}/${surface.qualityRuns}</td><td>${surface.scopePassed}/${surface.runs}</td><td>${display(surface.scores.quality)}</td><td>${display(surface.scores.safety)}</td><td>${display(surface.scores.reliability)}</td><td>${display(surface.scores.workflow)}</td><td>${display(surface.scores.efficiency)}</td><td>${display(surface.scores.overall)}</td></tr>`).join("");
  const usageRows = surfaceEntries.map(([id, surface]) => { const usage = surface.usage.allMeasuredRuns; return `<tr><th>${htmlEscape(surfaceLabel(id))}</th><td>${display(usage.medianInputTokens, 0)}</td><td>${display(usage.medianOutputTokens, 0)}</td><td>${display(usage.medianCacheReadTokens, 0)}</td><td>${display(usage.medianReasoningTokens, 0)}</td><td>${display(usage.medianFreshTokens, 0)}</td><td>${display(usage.medianToolCalls, 0)}</td><td>${display(usage.medianCost, 6)}</td><td>${display(usage.medianDurationSeconds, 1)}</td><td>${htmlEscape(topToolSummary(surface.usage.toolNames))}</td></tr>`; }).join("");
  const categoryRows = Object.entries(report.surfaces[candidateKey].bands?.categories ?? {}).map(([name, band]) => `<tr><th>${htmlEscape(name)}</th><td>${band.resolved}/${band.runs}</td><td>${display(band.score)}</td><td>${display(band.correctness)}</td></tr>`).join("");
  const tokenBandRows = Object.entries(report.comparison.pairedUsageBands?.categories ?? {}).map(([name, band]) => `<tr><th>${htmlEscape(name)}</th><td>${band.pairs}</td><td>${band.scenarioFamilies}</td><td>${display(band.freshTokenRatio, 4)}</td><td>${display(band.medianFreshTokenDelta, 0)}</td><td>${band.candidateWins}/${band.baselineWins}/${band.ties}</td></tr>`).join("");
  const confidence = report.comparison.freshTokenRatioConfidence95;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Piagent Benchmark ${htmlEscape(report.runId)}</title>
<style>body{font:14px system-ui,sans-serif;color:#202124;max-width:1180px;margin:32px auto;padding:0 20px}h1{font-size:24px}h2{font-size:17px;margin-top:28px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{border:1px solid #d8dadd;padding:8px;text-align:left}thead th{background:#f4f5f6}.metric{display:inline-block;margin:0 24px 8px 0}.note{color:#5f6368}</style></head><body>
<h1>Piagent Benchmark</h1><p>${htmlEscape(report.suite.title)} · ${htmlEscape(report.runId)}</p><p class="note">Platform v${htmlEscape(report.environment.platformVersion ?? "unknown")} · Pi ${htmlEscape(report.environment.piVersion ?? "unknown")}${report.environment.codexVersion ? ` · Codex ${htmlEscape(report.environment.codexVersion)}` : ""} · Node ${htmlEscape(report.environment.nodeVersion ?? "unknown")} · Baseline ${htmlEscape(report.environment.treatmentBaseline ?? "unknown")} · Piagent treatment ${htmlEscape(report.environment.piagentTreatment?.id ?? "unrecorded")} · Suite ${htmlEscape(report.environment.suiteDigest ?? "unknown")}</p>
<p class="metric"><strong>Comparison:</strong> ${htmlEscape(candidateLabel)} vs ${htmlEscape(baselineLabel)}</p><p class="metric"><strong>Purpose:</strong> ${htmlEscape(report.comparison.purpose ?? "unspecified")}</p><p class="metric"><strong>Claim tier:</strong> ${htmlEscape(report.comparison.claimEligibility?.achievedTier ?? "unavailable")}</p><p class="metric"><strong>Verdict:</strong> ${htmlEscape(report.verdict.status)}</p><p class="metric"><strong>Protocol:</strong> ${report.comparison.comparisonProtocolGate?.passed ? "PASS" : `FAIL (${htmlEscape((report.comparison.comparisonProtocolGate?.failedChecks ?? []).join(", ") || "missing evidence")})`}</p><p class="metric"><strong>Infrastructure retries:</strong> ${report.infrastructure?.retries ?? 0}</p><p class="metric"><strong>Paired token-ratio delta:</strong> ${displayPercent(report.comparison.freshTokenDeltaPercent)}</p><p class="metric"><strong>Token ratio 95% CI:</strong> ${confidence ? `${display(confidence.lower, 4)}–${display(confidence.upper, 4)}` : "n/a"}</p><p class="metric"><strong>Failure-aware ratio:</strong> ${display(report.comparison.failureAwareFreshTokenRatio, 4)}</p><p class="metric"><strong>Paired cost-ratio delta:</strong> ${displayPercent(report.comparison.costDeltaPercent)}</p><p class="metric"><strong>Comparable pairs:</strong> ${report.comparison.pairedUsageRuns}</p><p class="metric"><strong>Scenario families:</strong> ${report.comparison.pairedUsageScenarios ?? 0}</p><p class="metric"><strong>Complete families:</strong> ${report.comparison.pairedCompleteScenarios ?? 0}</p><p class="metric"><strong>Outcome families:</strong> ${report.comparison.pairedOutcomeScenarios ?? 0}</p><p class="metric"><strong>Pair wins:</strong> ${htmlEscape(candidateLabel)} ${report.comparison.pairedFreshTokenWins[candidateKey]} · ${htmlEscape(baselineLabel)} ${report.comparison.pairedFreshTokenWins[baselineKey]} · ties ${report.comparison.pairedFreshTokenWins.ties}</p>
<h2>Score bands</h2><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Resolved</th><th>Task grader</th><th>Scope</th><th>Quality</th><th>Safety</th><th>Reliability</th><th>Workflow</th><th>Efficiency</th><th>Overall</th></tr></thead><tbody>${scoreRows}</tbody></table></div>
${categoryRows ? `<h2>${htmlEscape(candidateLabel)} category bands</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th>Resolved</th><th>Score</th><th>Correctness</th></tr></thead><tbody>${categoryRows}</tbody></table></div>` : ""}
${tokenBandRows ? `<h2>Paired fresh-token ratio by category</h2><div class="table-wrap"><table><thead><tr><th>Category</th><th>Pairs</th><th>Families</th><th>Ratio</th><th>Median delta</th><th>${htmlEscape(candidateLabel)}/${htmlEscape(baselineLabel)}/ties</th></tr></thead><tbody>${tokenBandRows}</tbody></table></div>` : ""}
<h2>Median usage across all measured runs</h2><div class="table-wrap"><table><thead><tr><th>Surface</th><th>Input</th><th>Output</th><th>Cache read</th><th>Reasoning</th><th>Fresh</th><th>Tools</th><th>Cost</th><th>Seconds</th><th>Top tools</th></tr></thead><tbody>${usageRows}</tbody></table></div>
<h2>Runs</h2><div class="table-wrap"><table><thead><tr><th>Scenario</th><th>Category</th><th>Difficulty</th><th>Profile</th><th>Lifecycle</th><th>Surface</th><th>Repeat</th><th>Infra retries</th><th>Resolved</th><th>Grader</th><th>Scope</th><th>Workflow</th><th>Workflow gaps</th><th>Model</th><th>Thinking</th><th>Input</th><th>Output</th><th>Cache read</th><th>Reasoning</th><th>Fresh</th><th>Tools</th><th>Top tools</th><th>Cost</th><th>Seconds</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">${htmlEscape(report.verdict.note)}</p></body></html>\n`;
}
