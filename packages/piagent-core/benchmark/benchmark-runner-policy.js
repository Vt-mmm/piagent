export function applyBenchmarkExecutionDefaults(options, suite) {
  options.repeats ??= suite.defaultRepeats;
  options.infrastructureRetries ??= suite.releaseGate?.maximumInfrastructureRetries
    ?? (suite.schemaVersion === 2 ? 2 : 0);
  options.retryDelaySeconds ??= suite.schemaVersion === 2 && options.infrastructureRetries > 0 ? 60 : 0;
  options.timeoutSeconds ??= suite.timeoutSeconds;
  const contract = suite.executionContract;
  if (!contract) return;
  for (const [field, expected] of [
    ["surfaces", contract.surfaces], ["model", contract.model], ["thinking", contract.thinking], ["codexMode", contract.codexMode]
  ]) {
    const actual = options[field];
    if (actual === undefined) options[field] = Array.isArray(expected) ? [...expected] : expected;
    else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Suite ${suite.id} locks ${field} to ${Array.isArray(expected) ? expected.join(",") : expected}`);
    }
  }
}

export function benchmarkSuiteCoverage(declaredScenarios, selectedScenarios) {
  return {
    declaredScenarios,
    selectedScenarios,
    fullSuite: selectedScenarios === declaredScenarios
  };
}
