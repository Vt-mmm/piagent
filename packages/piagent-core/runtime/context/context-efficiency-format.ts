type ContextEfficiencyReport = {
  metrics: {
    contextWasteScore: number | null;
    contextWasteScoreEstimate: number;
    contextWasteScoreEvidenceCoverage: number;
    averageActiveTools: number;
    toolSchemaPrefixShare: number;
    toolSchemaToSystemRatio: number;
    duplicateReads: number;
    comparableReadCalls: number;
    readCalls: number;
    readEvidenceCoverage: number;
    contextFallbackRereads: number;
    contextSelections: number;
    duplicateOutputRate: number;
    lowConfidencePacks: number;
  };
  coverage: { wasteScore: { status: string } };
  sample: { contextPacks: number };
  recommendations: string[];
};

export function formatContextEfficiencyReport(
  report: ContextEfficiencyReport,
  formatPercent: (value: number) => string
): string {
  const wasteScore = report.metrics.contextWasteScore === null
    ? `unavailable (diagnostic estimate ${report.metrics.contextWasteScoreEstimate}/100; evidence ${formatPercent(report.metrics.contextWasteScoreEvidenceCoverage)}, ${report.coverage.wasteScore.status})`
    : `${report.metrics.contextWasteScore}/100 (lower is better; evidence ${formatPercent(report.metrics.contextWasteScoreEvidenceCoverage)}, ${report.coverage.wasteScore.status})`;
  return [
    `contextWasteScore: ${wasteScore}`,
    `activeTools: ${report.metrics.averageActiveTools}`,
    `toolSchemaPrefixShare: ${formatPercent(report.metrics.toolSchemaPrefixShare)}`,
    `toolSchemaToSystemRatio: ${report.metrics.toolSchemaToSystemRatio}`,
    `duplicateReads: ${report.metrics.duplicateReads}/${report.metrics.comparableReadCalls} comparable (${report.metrics.readCalls} observed; coverage ${formatPercent(report.metrics.readEvidenceCoverage)})`,
    `fallbackRereads: ${report.metrics.contextFallbackRereads}/${report.metrics.contextSelections}`,
    `duplicateOutput: ${formatPercent(report.metrics.duplicateOutputRate)}`,
    `lowConfidencePacks: ${report.metrics.lowConfidencePacks}/${report.sample.contextPacks}`,
    ...report.recommendations.map((recommendation) => `- ${recommendation}`)
  ].join("\n");
}
