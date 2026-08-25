const benchmarkSurfaces = new Set(["raw-pi", "piagent", "codex-cli"]);
const causalCoverageLanesV1 = new Set([
  "telemetry-window", "session-lifecycle", "criterion-initial-pack", "pack-lifecycle", "direct-fallback-rereads", "managed-prefix"
]);
const causalCoverageLanesV2 = new Set([...causalCoverageLanesV1, "edit-recovery-context"]);
const causalCoverageLanesV3 = causalCoverageLanesV2;
const causalMaximumAggregate = 1_000_000_000;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= causalMaximumAggregate;
}

function validCausalTriplet(value) {
  return exactKeys(value, ["offered", "delivered", "injected"])
    && [value.offered, value.delivered, value.injected].every(boundedInteger)
    && value.delivered <= value.offered && value.injected === value.delivered;
}

function validCriterionAggregate(value, aggregate) {
  if (!exactKeys(value, ["attempts", "selectedAttempts", "candidates", "selectedItems", "estimatedTokens", "zeroSelectionReasonCounts", "offered", "delivered", "injected"])
    || ![value.attempts, value.selectedAttempts, value.candidates, value.selectedItems, value.estimatedTokens,
      value.offered, value.delivered, value.injected].every(boundedInteger)
    || !exactKeys(value.zeroSelectionReasonCounts, ["autoContextDisabled", "criterionGraphUnavailable", "noCandidates", "noReadableSelection"])
    || !Object.values(value.zeroSelectionReasonCounts).every(boundedInteger)) return false;
  const zeroAttempts = Object.values(value.zeroSelectionReasonCounts).reduce((sum, count) => sum + count, 0);
  return value.selectedAttempts <= value.attempts
    && value.selectedAttempts === value.offered
    && value.offered === value.delivered && value.delivered === value.injected
    && value.selectedItems >= value.selectedAttempts && value.candidates >= value.selectedItems
    && zeroAttempts === value.attempts - value.selectedAttempts
    && value.offered <= aggregate.packCounts.offered
    && value.selectedItems <= aggregate.selectedItemCounts.offered
    && value.estimatedTokens <= aggregate.estimatedTokens.offered;
}

function validEditRecoveryAggregate(value) {
  if (!exactKeys(value, ["count", "failuresObserved", "suppressedFailures", "injectedChars", "injectedEstimatedTokens", "evidenceCoverage", "definition"])
    || ![value.count, value.failuresObserved, value.suppressedFailures, value.injectedChars, value.injectedEstimatedTokens].every(boundedInteger)
    || value.failuresObserved !== value.count + value.suppressedFailures
    || !exactKeys(value.evidenceCoverage, ["status", "observed", "comparable", "rate"])
    || value.evidenceCoverage.status !== "complete"
    || ![value.evidenceCoverage.observed, value.evidenceCoverage.comparable].every(boundedInteger)
    || value.evidenceCoverage.observed !== value.count || value.evidenceCoverage.comparable !== value.count
    || value.evidenceCoverage.rate !== 1
    || value.definition !== "matched-edit-recovery-context-receipt-v1") return false;
  return value.count === 0
    ? value.injectedChars === 0 && value.injectedEstimatedTokens === 0
    : value.injectedChars > 0 && value.injectedEstimatedTokens > 0;
}

function validRuntimeSection(value, evidenceSource) {
  return exactKeys(value, ["coverageStatus", "observedEvents", "evidenceSource", "aggregate"])
    && ["not-observed", "partial", "complete"].includes(value.coverageStatus)
    && boundedInteger(value.observedEvents)
    && value.evidenceSource === evidenceSource
    && (value.coverageStatus === "not-observed"
      ? value.observedEvents === 0 && value.aggregate === null
      : value.observedEvents > 0 && (value.coverageStatus === "partial") === (value.aggregate === null));
}

function validAdaptiveContextRuntime(value) {
  if (!validRuntimeSection(value, "context-telemetry")) return false;
  if (value.coverageStatus !== "complete") return true;
  const aggregate = value.aggregate;
  const fields = ["projected", "noOp", "cancelled", "deterministicCompactions", "hostSummaryFallbacks",
    "estimatedSavingsTokens", "minimumSavingsTokens", "minimumSavingsMet", "minimumSavingsNotMet",
    "governorProviderCalls", "deterministicCompactionProviderCalls", "protocolIntegrity", "definition"];
  if (!exactKeys(aggregate, fields)
    || !fields.slice(0, -2).every((field) => boundedInteger(aggregate[field]))
    || aggregate.definition !== "adaptive-context-runtime-receipt-v1"
    || !exactKeys(aggregate.protocolIntegrity, ["checks", "intact", "failed", "orphanCalls", "orphanResults"])
    || !Object.values(aggregate.protocolIntegrity).every(boundedInteger)) return false;
  const eventCount = aggregate.projected + aggregate.noOp + aggregate.cancelled
    + aggregate.deterministicCompactions + aggregate.hostSummaryFallbacks;
  const savingsDecisions = aggregate.minimumSavingsMet + aggregate.minimumSavingsNotMet;
  const protocol = aggregate.protocolIntegrity;
  return eventCount === value.observedEvents
    && savingsDecisions <= eventCount
    && aggregate.deterministicCompactionProviderCalls === 0
    && protocol.intact + protocol.failed === protocol.checks
    && (protocol.failed > 0 || protocol.orphanCalls + protocol.orphanResults === 0);
}

function validEditFreshnessRuntime(value) {
  if (!validRuntimeSection(value, "context-telemetry")) return false;
  if (value.coverageStatus !== "complete") return true;
  const aggregate = value.aggregate;
  const fields = ["snapshotObservations", "readSnapshots", "mutationSnapshots", "staleDetections",
    "enforcedStaleDetections", "staleBlocks", "rereadRecoveries", "mutationRecoveries",
    "incompleteRecoveries", "definition"];
  if (!exactKeys(aggregate, fields)
    || !fields.slice(0, -1).every((field) => boundedInteger(aggregate[field]))
    || aggregate.definition !== "edit-freshness-runtime-receipt-v1") return false;
  return aggregate.snapshotObservations + aggregate.staleDetections === value.observedEvents
    && aggregate.readSnapshots + aggregate.mutationSnapshots === aggregate.snapshotObservations
    && aggregate.enforcedStaleDetections <= aggregate.staleDetections
    && aggregate.staleBlocks === aggregate.enforcedStaleDetections
    && aggregate.rereadRecoveries === aggregate.enforcedStaleDetections
    && aggregate.mutationRecoveries <= aggregate.rereadRecoveries
    && aggregate.incompleteRecoveries === 0;
}

function validDelegatedRuntimeSection(value) {
  return validRuntimeSection(value, "provider-free-runtime-conformance")
    && value.coverageStatus === "not-observed";
}

function validRuntimeCausalAggregate(value) {
  return exactKeys(value, ["adaptiveContext", "operationLifecycle", "boundedEmission", "editFreshness"])
    && validAdaptiveContextRuntime(value.adaptiveContext)
    && validDelegatedRuntimeSection(value.operationLifecycle)
    && validDelegatedRuntimeSection(value.boundedEmission)
    && validEditFreshnessRuntime(value.editFreshness);
}

function validCausalAggregates(value, criterionExpected, schemaVersion) {
  const expectedKeys = ["packCounts", "estimatedTokens", "selectedItemEstimatedTokens", "selectedItemCounts", "criterionInitialPack", "directFallbackRereads", "compaction", "managedPrefix"];
  if (schemaVersion >= 2) expectedKeys.splice(6, 0, "editRecoveryContext");
  if (schemaVersion >= 3) expectedKeys.splice(7, 0, "runtimeCausal");
  if (!exactKeys(value, expectedKeys)
    || !validCausalTriplet(value.packCounts)
    || !validCausalTriplet(value.estimatedTokens)
    || !validCausalTriplet(value.selectedItemEstimatedTokens)
    || !validCausalTriplet(value.selectedItemCounts)
    || !exactKeys(value.directFallbackRereads, ["successfulCalls", "shellToolCallsObserved", "definition"])
    || !boundedInteger(value.directFallbackRereads.successfulCalls)
    || !boundedInteger(value.directFallbackRereads.shellToolCallsObserved)
    || value.directFallbackRereads.definition !== "successful-direct-path-tool-call-v1"
    || !exactKeys(value.compaction, ["eventsObserved", "state"])
    || !boundedInteger(value.compaction.eventsObserved)
    || !["observed", "not-observed"].includes(value.compaction.state)
    || (value.compaction.eventsObserved > 0) !== (value.compaction.state === "observed")
    || !exactKeys(value.managedPrefix, ["promptsObserved", "compactedPrompts", "state"])
    || !boundedInteger(value.managedPrefix.promptsObserved) || value.managedPrefix.promptsObserved === 0
    || !boundedInteger(value.managedPrefix.compactedPrompts)
    || value.managedPrefix.compactedPrompts > value.managedPrefix.promptsObserved
    || !["compacted", "uncompacted", "mixed"].includes(value.managedPrefix.state)
    || (schemaVersion >= 2 && !validEditRecoveryAggregate(value.editRecoveryContext))
    || (schemaVersion >= 3 && !validRuntimeCausalAggregate(value.runtimeCausal))) return false;
  const compacted = value.managedPrefix.compactedPrompts;
  const prompts = value.managedPrefix.promptsObserved;
  const expectedState = compacted === 0 ? "uncompacted" : compacted === prompts ? "compacted" : "mixed";
  return value.managedPrefix.state === expectedState
    && validCriterionAggregate(value.criterionInitialPack, value)
    && (criterionExpected !== true || value.criterionInitialPack.attempts > 0);
}

export function validBenchmarkCausalContextReceipt(receipt, surface) {
  if (!exactKeys(receipt, ["schemaVersion", "evidenceSource", "applicability", "available", "coverage", "aggregates"])
    || ![1, 2, 3].includes(receipt.schemaVersion) || typeof receipt.available !== "boolean"
    || !exactKeys(receipt.coverage, ["status", "telemetryTruncated", "telemetryIntegrityFailures", "recoverableTailBytes", "criterionExpected", "sessionEventsObserved", "observedLanes", "requiredLanes", "missingLanes"])) return false;
  const coverage = receipt.coverage;
  if (surface !== "piagent") return receipt.schemaVersion === 1 && receipt.evidenceSource === "not-applicable"
    && receipt.applicability === "not-applicable" && receipt.available === false && receipt.aggregates === null
    && coverage.status === "not-applicable" && coverage.telemetryTruncated === false
    && coverage.telemetryIntegrityFailures === 0 && coverage.recoverableTailBytes === 0
    && coverage.criterionExpected === false && coverage.sessionEventsObserved === 0
    && coverage.observedLanes === 0 && coverage.requiredLanes === 0
    && Array.isArray(coverage.missingLanes) && coverage.missingLanes.length === 0;
  const coverageLanes = receipt.schemaVersion === 3 ? causalCoverageLanesV3
    : receipt.schemaVersion === 2 ? causalCoverageLanesV2 : causalCoverageLanesV1;
  const evidenceSource = `context-telemetry-closed-aggregate-v${receipt.schemaVersion}`;
  if (receipt.evidenceSource !== evidenceSource || receipt.applicability !== "piagent"
    || typeof coverage.telemetryTruncated !== "boolean" || typeof coverage.criterionExpected !== "boolean"
    || ![coverage.telemetryIntegrityFailures, coverage.recoverableTailBytes, coverage.sessionEventsObserved,
      coverage.observedLanes, coverage.requiredLanes].every(boundedInteger)
    || coverage.requiredLanes !== coverageLanes.size || !Array.isArray(coverage.missingLanes)
    || new Set(coverage.missingLanes).size !== coverage.missingLanes.length
    || coverage.missingLanes.some((lane) => !coverageLanes.has(lane))
    || coverage.observedLanes + coverage.missingLanes.length !== coverage.requiredLanes) return false;
  if (receipt.available) return coverage.status === "complete" && coverage.missingLanes.length === 0
    && coverage.telemetryTruncated === false && coverage.telemetryIntegrityFailures === 0
    && coverage.recoverableTailBytes === 0 && coverage.sessionEventsObserved > 0
    && validCausalAggregates(receipt.aggregates, coverage.criterionExpected, receipt.schemaVersion);
  return ["partial", "unavailable"].includes(coverage.status)
    && coverage.missingLanes.length > 0 && receipt.aggregates === null;
}

export function summarizeBenchmarkCausalContextEvidence(runs, { required = false } = {}) {
  const piagentRuns = Array.isArray(runs) ? runs.filter((run) => run?.surface === "piagent") : [];
  const complete = piagentRuns.filter((run) => validBenchmarkCausalContextReceipt(run.causalContextReceipt, run.surface)
    && run.causalContextReceipt.available === true
    && run.causalContextReceipt.coverage.status === "complete"
    && run.causalContextReceipt.aggregates);
  const fullyCovered = piagentRuns.length > 0 && complete.length === piagentRuns.length;
  const recoveryComplete = complete.filter((run) => run.causalContextReceipt.schemaVersion >= 2);
  const recoveryFullyCovered = fullyCovered && recoveryComplete.length === piagentRuns.length;
  const sum = (select) => complete.reduce((total, run) => total + select(run.causalContextReceipt.aggregates), 0);
  const sumRecovery = (select) => recoveryComplete.reduce((total, run) => total + select(run.causalContextReceipt.aggregates.editRecoveryContext), 0);
  const triplet = (field) => Object.fromEntries(["offered", "delivered", "injected"]
    .map((lane) => [lane, sum((value) => value[field][lane])]));
  const criterion = fullyCovered ? complete.reduce((total, run) => {
    const value = run.causalContextReceipt.aggregates.criterionInitialPack;
    for (const field of ["attempts", "selectedAttempts", "candidates", "selectedItems", "estimatedTokens", "offered", "delivered", "injected"]) {
      total[field] += value[field];
    }
    for (const field of Object.keys(total.zeroSelectionReasonCounts)) {
      total.zeroSelectionReasonCounts[field] += value.zeroSelectionReasonCounts[field];
    }
    return total;
  }, {
    attempts: 0, selectedAttempts: 0, candidates: 0, selectedItems: 0, estimatedTokens: 0,
    zeroSelectionReasonCounts: { autoContextDisabled: 0, criterionGraphUnavailable: 0, noCandidates: 0, noReadableSelection: 0 },
    offered: 0, delivered: 0, injected: 0
  }) : null;
  return {
    required,
    runs: piagentRuns.length,
    availableRuns: complete.length,
    unavailableRuns: piagentRuns.length - complete.length,
    coverageStatus: fullyCovered ? "complete" : complete.length > 0 ? "partial" : "unavailable",
    requiredSchemaVersion: 2,
    currentAvailableRuns: recoveryComplete.length,
    currentUnavailableRuns: piagentRuns.length - recoveryComplete.length,
    currentCoverageStatus: recoveryFullyCovered ? "complete" : recoveryComplete.length > 0 ? "partial" : "unavailable",
    aggregates: fullyCovered ? {
      packCounts: triplet("packCounts"),
      estimatedTokens: triplet("estimatedTokens"),
      selectedItemEstimatedTokens: triplet("selectedItemEstimatedTokens"),
      selectedItemCounts: triplet("selectedItemCounts"),
      criterionInitialPack: criterion,
      directFallbackRereads: {
        successfulCalls: sum((value) => value.directFallbackRereads.successfulCalls),
        shellToolCallsObserved: sum((value) => value.directFallbackRereads.shellToolCallsObserved),
        definition: "successful-direct-path-tool-call-v1"
      },
      editRecoveryContext: {
        count: recoveryFullyCovered ? sumRecovery((value) => value.count) : null,
        failuresObserved: recoveryFullyCovered ? sumRecovery((value) => value.failuresObserved) : null,
        suppressedFailures: recoveryFullyCovered ? sumRecovery((value) => value.suppressedFailures) : null,
        injectedChars: recoveryFullyCovered ? sumRecovery((value) => value.injectedChars) : null,
        injectedEstimatedTokens: recoveryFullyCovered ? sumRecovery((value) => value.injectedEstimatedTokens) : null,
        evidenceCoverage: {
          status: recoveryFullyCovered ? "complete" : recoveryComplete.length > 0 ? "partial" : "unavailable",
          runs: piagentRuns.length,
          comparableRuns: recoveryComplete.length,
          rate: piagentRuns.length > 0 ? recoveryComplete.length / piagentRuns.length : 0
        },
        definition: "matched-edit-recovery-context-receipt-v1"
      },
      compactionEventsObserved: sum((value) => value.compaction.eventsObserved),
      managedPrefixPromptsObserved: sum((value) => value.managedPrefix.promptsObserved),
      managedPrefixCompactedPrompts: sum((value) => value.managedPrefix.compactedPrompts)
    } : null
  };
}

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
    && validBenchmarkCausalContextReceipt(record.causalContextReceipt, record.surface)
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
