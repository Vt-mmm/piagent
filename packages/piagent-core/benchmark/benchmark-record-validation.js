const benchmarkSurfaces = new Set(["raw-pi", "piagent", "codex-cli"]);

export function completedBenchmarkRecord(record) {
  const nonnegative = (value) => Number.isFinite(value) && value >= 0;
  const hash = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
  const usage = record?.usage;
  return record?.schemaVersion === 1
    && typeof record.runId === "string" && record.runId.length > 0
    && typeof record.attemptId === "string" && record.attemptId.length > 0
    && hash(record.configurationDigest)
    && Number.isInteger(record.orderIndex) && record.orderIndex > 0
    && typeof record.scenarioId === "string" && record.scenarioId.length > 0
    && typeof record.scenarioTitle === "string"
    && typeof record.scenarioKind === "string"
    && typeof record.category === "string"
    && typeof record.difficulty === "string"
    && typeof record.profile === "string"
    && typeof record.lifecycle === "string"
    && benchmarkSurfaces.has(record.surface)
    && Number.isInteger(record.repeat) && record.repeat > 0
    && Number.isInteger(record.infrastructureAttempt) && record.infrastructureAttempt > 0
    && Number.isInteger(record.infrastructureAttempts) && record.infrastructureAttempts > 0
    && typeof record.sessionId === "string" && record.sessionId.length > 0
    && record.abortSuite !== true
    && typeof record.resolved === "boolean"
    && Number.isInteger(record.agent?.exitCode)
    && typeof record.agent?.timedOut === "boolean"
    && hash(record.agent?.stdoutHash) && hash(record.agent?.stderrHash)
    && typeof record.grade?.passed === "boolean" && nonnegative(record.grade?.score) && record.grade.score <= 10 && Array.isArray(record.grade?.checks)
    && typeof record.graderIntegrity?.passed === "boolean"
    && typeof record.scope?.passed === "boolean" && Array.isArray(record.scope?.changedFiles) && Array.isArray(record.scope?.outsideScope)
    && typeof record.outputSafety?.passed === "boolean" && Array.isArray(record.outputSafety?.forbiddenHits)
    && typeof record.outputEvidence?.passed === "boolean" && Number.isInteger(record.outputEvidence?.requiredCount)
    && nonnegative(record.durationSeconds)
    && hash(record.promptHash)
    && typeof record.variant?.generated === "boolean"
    && hash(record.variant?.fixtureDigest)
    && (!record.variant.generated || (hash(record.variant.seedDigest) && hash(record.variant.oracleDigest)))
    && Number.isInteger(usage?.sessions) && usage.sessions > 0
    && nonnegative(usage?.fresh) && usage.fresh > 0
    && ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].every((field) => nonnegative(usage?.[field]))
    && usage.total === usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    && usage.fresh === usage.input + usage.output
    && (nonnegative(usage?.cost) || (usage?.cost === null && usage?.costSource === "unavailable"));
}

export function pairedBenchmarkVariantMatched(record, runs) {
  const pair = runs.find((value) => value.scenarioId === record.scenarioId && value.repeat === record.repeat && value.surface !== record.surface);
  if (!pair) return true;
  return pair.promptHash === record.promptHash
    && pair.variant?.generated === record.variant?.generated
    && pair.variant?.fixtureDigest === record.variant?.fixtureDigest
    && pair.variant?.seedDigest === record.variant?.seedDigest
    && pair.variant?.oracleDigest === record.variant?.oracleDigest;
}

export function expectedBenchmarkRecord(record, index, expected, runId, suite, configurationDigest) {
  const scenario = expected?.scenario;
  return completedBenchmarkRecord(record)
    && record.runId === runId
    && record.configurationDigest === configurationDigest
    && record.orderIndex === index + 1
    && record.scenarioId === scenario?.id
    && record.surface === expected?.surface
    && record.repeat === expected?.repeat
    && record.scenarioTitle === scenario?.title
    && record.scenarioKind === scenario?.kind
    && record.category === (scenario?.category ?? "unspecified")
    && record.difficulty === (scenario?.difficulty ?? "unspecified")
    && record.profile === (scenario?.profile ?? suite.profile)
    && record.lifecycle === (scenario?.lifecycle ?? "steady-state");
}
