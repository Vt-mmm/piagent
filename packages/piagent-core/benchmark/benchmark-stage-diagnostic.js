import { benchmarkProviderWireEvidenceMatchesRequest } from "./benchmark-provider-wire.js";
import {
  benchmarkPricingSnapshotValidationErrors,
  normalizeBenchmarkUsageCost
} from "./benchmark-normalized-cost.js";
import { summarizeBenchmarkCausalContextEvidence } from "./benchmark-record-validation.js";
import { atMostWithinFloatingPrecision, geometricMean } from "./benchmark-statistics.js";
import { pairedOutcomeFloorStop } from "./benchmark-stop-policy.js";

const TOKEN_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"]);
const PRODUCTION_STAGE_CONTROL_POLICY = "production-v1-provider-spend-v1";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validStageBoundaries(stageBoundaries) {
  return Array.isArray(stageBoundaries)
    && stageBoundaries.length >= 2
    && stageBoundaries[0] === 0
    && stageBoundaries.every((value, index) => Number.isSafeInteger(value)
      && value >= 0
      && (index === 0 || value > stageBoundaries[index - 1]));
}

export function productionSpendControlValidationErrors(control, { suiteId, expectedSessions } = {}) {
  const errors = [];
  if (!control || typeof control !== "object" || Array.isArray(control)) return ["contract-must-be-an-object"];
  if (control.schemaVersion !== 1) errors.push("unsupported-schema-version");
  if (!nonEmptyString(control.suiteId) || (suiteId !== undefined && control.suiteId !== suiteId)) errors.push("suite-id-mismatch");
  if (!nonEmptyString(control.rootSeed) || control.rootSeed.length > 200) errors.push("invalid-root-seed");

  const execution = control.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) errors.push("missing-execution-contract");
  else {
    if (!Array.isArray(execution.surfaces)
      || execution.surfaces.length !== 2
      || new Set(execution.surfaces).size !== 2
      || execution.surfaces.some((surface) => !nonEmptyString(surface))) errors.push("invalid-execution-surfaces");
    if (execution.model !== null && !nonEmptyString(execution.model)) errors.push("invalid-execution-model");
    if (execution.thinking !== null && !nonEmptyString(execution.thinking)) errors.push("invalid-execution-thinking");
    if (!Number.isSafeInteger(execution.repeats) || execution.repeats <= 0) errors.push("invalid-execution-repeats");
    if (execution.infrastructureRetries !== 0) errors.push("infrastructure-retries-must-be-zero");
    if (execution.stopAfterFailedPair !== true) errors.push("stop-after-failed-pair-must-be-enabled");
  }

  if (!Array.isArray(control.stages) || control.stages.length < 2) errors.push("missing-stage-boundaries");
  else {
    const ids = new Set();
    let previous = 0;
    for (const [index, stage] of control.stages.entries()) {
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
        errors.push(`invalid-stage:${index}`);
        continue;
      }
      if (!nonEmptyString(stage.id) || ids.has(stage.id)) errors.push(`invalid-stage-id:${index}`);
      else ids.add(stage.id);
      if (!Number.isSafeInteger(stage.cumulativeSessions) || stage.cumulativeSessions < 0
        || (index > 0 && stage.cumulativeSessions <= previous)) errors.push(`invalid-stage-cumulative-sessions:${index}`);
      const expectedNewSessions = index === 0 ? 0 : stage.cumulativeSessions - previous;
      if (stage.newSessions !== expectedNewSessions) errors.push(`invalid-stage-new-sessions:${index}`);
      if (index === 0) {
        if (stage.cumulativeSessions !== 0) errors.push("initial-stage-must-start-at-zero");
        if (stage.claimEligible !== false) errors.push("initial-stage-cannot-be-claim-eligible");
      } else if (index === control.stages.length - 1) {
        if (stage.claimEligible !== true) errors.push("final-stage-must-be-claim-eligible");
      } else if (stage.claimEligible !== false) errors.push(`intermediate-stage-cannot-be-claim-eligible:${index}`);
      if (Number.isSafeInteger(stage.cumulativeSessions)) previous = stage.cumulativeSessions;
    }
    const finalSessions = control.stages.at(-1)?.cumulativeSessions;
    if (Number.isSafeInteger(expectedSessions) && finalSessions !== expectedSessions) errors.push("final-stage-session-count-mismatch");
  }
  return errors;
}

function sameLedgerBinding(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function createProductionStageControl({ authorizedThroughRuns, generatedAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    policy: PRODUCTION_STAGE_CONTROL_POLICY,
    state: "window-authorized",
    approvedBoundaryRuns: 0,
    authorizedThroughRuns,
    pendingBoundary: null,
    updatedAt: generatedAt
  };
}

export function pendProductionStageControl(control, { reason, completedRuns, ledger, generatedAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    policy: PRODUCTION_STAGE_CONTROL_POLICY,
    state: "review-pending",
    approvedBoundaryRuns: Number.isSafeInteger(control?.approvedBoundaryRuns) ? control.approvedBoundaryRuns : 0,
    authorizedThroughRuns: control?.authorizedThroughRuns,
    pendingBoundary: {
      reason,
      completedRuns,
      ledger
    },
    updatedAt: generatedAt
  };
}

export function approveProductionStageControl(control, { completedRuns, authorizedThroughRuns, generatedAt = new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    policy: PRODUCTION_STAGE_CONTROL_POLICY,
    state: "window-authorized",
    approvedBoundaryRuns: completedRuns,
    authorizedThroughRuns,
    pendingBoundary: null,
    updatedAt: generatedAt
  };
}

export function productionStageResumeDisposition(control, { completedRuns, ledger, stageBoundaries }) {
  const errors = [];
  if (control?.schemaVersion !== 1 || control?.policy !== PRODUCTION_STAGE_CONTROL_POLICY) errors.push("missing-or-unsupported-stage-control");
  if (!Number.isSafeInteger(completedRuns) || completedRuns < 0) errors.push("invalid-completed-run-count");
  if (!validStageBoundaries(stageBoundaries)) errors.push("invalid-frozen-stage-boundaries");
  const approvedBoundaryRuns = control?.approvedBoundaryRuns;
  const authorizedThroughRuns = control?.authorizedThroughRuns;
  const expectedAuthorizedThroughRuns = validStageBoundaries(stageBoundaries) && Number.isSafeInteger(approvedBoundaryRuns)
    ? stageBoundaries.find((boundary) => boundary > approvedBoundaryRuns)
    : undefined;
  if (!Number.isSafeInteger(approvedBoundaryRuns) || approvedBoundaryRuns < 0
    || approvedBoundaryRuns > completedRuns
    || (validStageBoundaries(stageBoundaries) && approvedBoundaryRuns >= stageBoundaries.at(-1))) errors.push("invalid-approved-boundary");
  if (!Number.isSafeInteger(authorizedThroughRuns) || authorizedThroughRuns <= 0
    || authorizedThroughRuns < completedRuns
    || authorizedThroughRuns !== expectedAuthorizedThroughRuns) errors.push("invalid-authorized-window");
  if (control?.state === "window-authorized") {
    if (control.pendingBoundary !== null) errors.push("authorized-window-has-pending-boundary");
    const atAuthorizedBoundary = completedRuns === authorizedThroughRuns;
    return {
      passed: errors.length === 0,
      requiresStageGate: errors.length === 0 && atAuthorizedBoundary,
      recoveryAllowed: errors.length === 0 && !atAuthorizedBoundary,
      errors
    };
  }
  if (control?.state === "review-pending") {
    const pending = control.pendingBoundary;
    if (!pending || typeof pending.reason !== "string") errors.push("missing-pending-boundary");
    if (pending?.completedRuns !== completedRuns) errors.push("pending-boundary-run-count-mismatch");
    if (Number.isSafeInteger(completedRuns) && Number.isSafeInteger(approvedBoundaryRuns)
      && completedRuns <= approvedBoundaryRuns) errors.push("pending-boundary-has-no-progress");
    if (!sameLedgerBinding(pending?.ledger, ledger)) errors.push("pending-boundary-ledger-mismatch");
    return { passed: errors.length === 0, requiresStageGate: true, recoveryAllowed: false, errors };
  }
  errors.push("invalid-stage-control-state");
  return { passed: false, requiresStageGate: false, recoveryAllowed: false, errors };
}

export function productionStageResumeWindow(control, { completedRuns, stageBoundaries }) {
  if (!validStageBoundaries(stageBoundaries)
    || !Number.isSafeInteger(completedRuns)
    || completedRuns < 0
    || !Number.isSafeInteger(control?.authorizedThroughRuns)) return null;
  const authorizedThroughRuns = completedRuns < control.authorizedThroughRuns
    ? control.authorizedThroughRuns
    : stageBoundaries.find((boundary) => boundary > completedRuns);
  if (!Number.isSafeInteger(authorizedThroughRuns)) {
    return completedRuns === stageBoundaries.at(-1)
      ? { authorizedThroughRuns: completedRuns, remainingSessions: 0 }
      : null;
  }
  const remainingSessions = authorizedThroughRuns - completedRuns;
  if (!Number.isSafeInteger(remainingSessions) || remainingSessions <= 0) return null;
  return { authorizedThroughRuns, remainingSessions };
}

/**
 * Replays the terminal paired-outcome rule over an accepted ledger prefix.
 *
 * The live runner normally evaluates this rule immediately after appending the
 * second record of a pair. A process can still die after the durable append but
 * before that in-memory check. Resume must therefore derive the same terminal
 * result from accepted records before it performs auth, tool preflight, or any
 * additional provider work.
 */
export function durablePairedOutcomeFloorStop({ enabled, suite, runs, fullOrder }) {
  const acceptedRuns = Array.isArray(runs) ? runs : [];
  const expectedRuns = Array.isArray(fullOrder) ? fullOrder : [];
  for (let index = 0; index < expectedRuns.length; index += 1) {
    const terminal = pairedOutcomeFloorStop({
      enabled,
      suite,
      runs: acceptedRuns,
      current: expectedRuns[index],
      next: expectedRuns[index + 1]
    });
    if (terminal) return terminal;
  }
  return null;
}

function runKey(run) {
  return `${run?.scenarioId ?? run?.scenario?.id}\0${run?.surface}\0${run?.repeat}`;
}

function pairKey(value) {
  return `${value?.scenarioId ?? value?.scenario?.id}\0${value?.repeat}`;
}

function publicPairId(value) {
  return `${value?.scenarioId ?? value?.scenario?.id}:r${value?.repeat}`;
}

function expectedPairMap(fullOrder) {
  const pairs = new Map();
  for (const item of fullOrder) {
    const key = pairKey(item);
    const pair = pairs.get(key) ?? {
      scenarioId: item?.scenarioId ?? item?.scenario?.id,
      repeat: item?.repeat,
      expectedSurfaces: new Set(),
      expectedRunKeys: new Set()
    };
    pair.expectedSurfaces.add(item?.surface);
    pair.expectedRunKeys.add(runKey(item));
    pairs.set(key, pair);
  }
  return pairs;
}

function exactUsageIssues(run) {
  const usage = run?.usage;
  const issues = [];
  if (usage?.usageCompleteness !== "exact") issues.push("usage-completeness-not-exact");
  if (!Number.isSafeInteger(usage?.sessions) || usage.sessions <= 0) issues.push("invalid-session-count");
  for (const field of TOKEN_FIELDS) {
    if (!Number.isSafeInteger(usage?.[field]) || usage[field] < 0) issues.push(`invalid-${field}`);
  }
  if (Number.isSafeInteger(usage?.fresh) && Number.isSafeInteger(usage?.input) && Number.isSafeInteger(usage?.output)
    && usage.fresh !== usage.input + usage.output) issues.push("fresh-token-equation-mismatch");
  if ([usage?.total, usage?.input, usage?.cacheRead, usage?.cacheWrite, usage?.output].every(Number.isSafeInteger)
    && usage.total !== usage.input + usage.cacheRead + usage.cacheWrite + usage.output) issues.push("total-token-equation-mismatch");
  if (Number.isSafeInteger(usage?.reasoning) && Number.isSafeInteger(usage?.output) && usage.reasoning > usage.output) {
    issues.push("reasoning-exceeds-output");
  }
  return issues;
}

function providerWireGroups(piRuns) {
  const groups = new Map();
  for (const run of piRuns) {
    const key = `${run.scenarioId}\0${run.profile ?? "unspecified"}\0${run.lifecycle ?? "unspecified"}`;
    const group = groups.get(key) ?? {
      scenarioId: run.scenarioId,
      profile: run.profile ?? "unspecified",
      lifecycle: run.lifecycle ?? "unspecified",
      runs: 0,
      baseInstructionHashes: new Set(),
      orderedToolSurfaceHashes: new Set()
    };
    group.runs += 1;
    for (const hash of run.providerWireEvidence?.baseInstructionHashes ?? []) group.baseInstructionHashes.add(hash);
    for (const hash of run.providerWireEvidence?.orderedToolSurfaceHashes ?? []) group.orderedToolSurfaceHashes.add(hash);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    scenarioId: group.scenarioId,
    profile: group.profile,
    lifecycle: group.lifecycle,
    runs: group.runs,
    baseInstructionHashCount: group.baseInstructionHashes.size,
    orderedToolSurfaceHashCount: group.orderedToolSurfaceHashes.size,
    passed: group.baseInstructionHashes.size === 1 && group.orderedToolSurfaceHashes.size === 1
  })).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
}

function diagnosticCheck(id, passed, details = {}) {
  return { id, passed: passed === true, ...details };
}

function pairRatioEvidence(pairRecords, valueFor) {
  const records = pairRecords.map(({ pair, candidate, baseline }) => {
    const values = valueFor({ candidate, baseline });
    const baselineValue = values?.baseline;
    const candidateValue = values?.candidate;
    const comparable = Number.isFinite(baselineValue) && baselineValue > 0
      && Number.isFinite(candidateValue) && candidateValue > 0
      && (!Array.isArray(values?.issues) || values.issues.length === 0);
    return {
      pairId: pair.id,
      scenarioId: pair.scenarioId,
      repeat: pair.repeat,
      comparable,
      issues: comparable ? [] : values?.issues?.length ? values.issues : ["non-positive-or-unavailable-value"],
      baseline: Number.isFinite(baselineValue) ? baselineValue : null,
      candidate: Number.isFinite(candidateValue) ? candidateValue : null,
      ratio: comparable ? candidateValue / baselineValue : null
    };
  });
  const familyMap = new Map();
  for (const record of records) {
    const values = familyMap.get(record.scenarioId) ?? [];
    values.push(record);
    familyMap.set(record.scenarioId, values);
  }
  const families = [...familyMap.entries()].map(([scenarioId, values]) => {
    const comparable = values.length > 0 && values.every((value) => value.comparable);
    return {
      scenarioId,
      observedPairs: values.length,
      comparable,
      ratio: comparable ? geometricMean(values.map((value) => value.ratio)) : null,
      issues: comparable ? [] : ["one-or-more-observed-pairs-incomparable"]
    };
  }).sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
  return {
    records,
    families,
    incomparablePairs: records.filter((record) => !record.comparable),
    pairRegressions: records.filter((record) => Number.isFinite(record.ratio) && !atMostWithinFloatingPrecision(record.ratio, 1)),
    familyRegressions: families.filter((family) => Number.isFinite(family.ratio) && !atMostWithinFloatingPrecision(family.ratio, 1))
  };
}

function candidateOutcomeFailures(pairRecords, floor) {
  return pairRecords.map(({ pair, candidate }) => {
    const failures = [];
    if (candidate?.resolved !== true) failures.push("unresolved-outcome");
    if (candidate?.scope?.passed !== true) failures.push("scope-safety-evidence-failed");
    if (candidate?.outputSafety?.passed !== true) failures.push("output-safety-evidence-failed");
    if (candidate?.scenarioKind === "safety-refusal") {
      if (candidate?.grade?.passed !== true) failures.push("safety-refusal-grade-failed");
    } else {
      if (candidate?.grade?.passed !== true) failures.push("quality-grade-failed");
      if (candidate?.graderIntegrity?.passed !== true) failures.push("grader-integrity-failed");
      if (candidate?.outputEvidence?.passed === false) failures.push("output-evidence-failed");
      if (!Number.isFinite(candidate?.grade?.score) || candidate.grade.score <= floor) failures.push("quality-outcome-floor");
      if (!Number.isFinite(candidate?.workflow?.score) || candidate.workflow.score <= floor) failures.push("workflow-outcome-floor");
    }
    return {
      pairId: pair.id,
      failures,
      resolved: candidate?.resolved === true,
      gradeScore: Number.isFinite(candidate?.grade?.score) ? candidate.grade.score : null,
      workflowScore: Number.isFinite(candidate?.workflow?.score) ? candidate.workflow.score : null
    };
  }).filter((item) => item.failures.length > 0);
}

/**
 * Builds a provider-free, claim-ineligible decision aid for a paused benchmark.
 * Future, entirely unstarted pairs are intentionally not blockers. A partially
 * observed pair is a blocker because stage decisions must be made at pair
 * boundaries.
 */
export function buildBenchmarkStageDiagnostic({
  runId,
  reason,
  runs,
  fullOrder,
  candidateSurface,
  baselineSurface,
  requestedModel,
  requestedThinking,
  suite,
  manifest,
  generatedAt = new Date().toISOString()
}) {
  const acceptedRuns = Array.isArray(runs) ? runs : [];
  const expectedRuns = Array.isArray(fullOrder) ? fullOrder : [];
  const pairs = expectedPairMap(expectedRuns);
  const expectedRunKeys = new Set(expectedRuns.map(runKey));
  const observedByRunKey = new Map();
  const duplicateRuns = [];
  const unexpectedRuns = [];
  for (const run of acceptedRuns) {
    const key = runKey(run);
    if (!expectedRunKeys.has(key)) unexpectedRuns.push(key.replaceAll("\0", ":"));
    if (observedByRunKey.has(key)) duplicateRuns.push(key.replaceAll("\0", ":"));
    else observedByRunKey.set(key, run);
  }

  const completePairs = [];
  const incompleteObservedPairs = [];
  const unstartedPairs = [];
  for (const pair of pairs.values()) {
    const observed = [...pair.expectedSurfaces].filter((surface) => observedByRunKey.has(`${pair.scenarioId}\0${surface}\0${pair.repeat}`));
    const missing = [...pair.expectedSurfaces].filter((surface) => !observed.includes(surface));
    const summary = {
      id: publicPairId(pair),
      scenarioId: pair.scenarioId,
      repeat: pair.repeat,
      expectedSurfaces: [...pair.expectedSurfaces],
      observedSurfaces: observed,
      missingSurfaces: missing
    };
    if (observed.length === 0) unstartedPairs.push(summary);
    else if (missing.length === 0) completePairs.push(summary);
    else incompleteObservedPairs.push(summary);
  }

  const pairRecords = completePairs.map((pair) => ({
    pair,
    candidate: observedByRunKey.get(`${pair.scenarioId}\0${candidateSurface}\0${pair.repeat}`),
    baseline: observedByRunKey.get(`${pair.scenarioId}\0${baselineSurface}\0${pair.repeat}`)
  }));
  const malformedCompletePairs = pairRecords.filter(({ candidate, baseline }) => !candidate || !baseline).map(({ pair }) => pair.id);
  const baselineOnlyRegressions = pairRecords
    .filter(({ candidate, baseline }) => baseline?.resolved === true && candidate?.resolved !== true)
    .map(({ pair, candidate, baseline }) => ({
      pairId: pair.id,
      baselineResolved: baseline.resolved,
      candidateResolved: candidate?.resolved === true,
      candidateFailure: candidate?.failure ?? null
    }));
  const noBaselineOnlyRegressionPassed = completePairs.length > 0
    && malformedCompletePairs.length === 0
    && baselineOnlyRegressions.length === 0;
  const pairedGradeComparabilityFailures = pairRecords.filter(({ candidate, baseline }) => (
    !Number.isFinite(candidate?.grade?.score) || !Number.isFinite(baseline?.grade?.score)
  )).map(({ pair }) => pair.id);
  const pairedGradeRegressions = pairRecords.filter(({ candidate, baseline }) => (
    Number.isFinite(candidate?.grade?.score)
    && Number.isFinite(baseline?.grade?.score)
    && !atMostWithinFloatingPrecision(baseline.grade.score, candidate.grade.score)
  )).map(({ pair, candidate, baseline }) => ({
    pairId: pair.id,
    baselineGradeScore: baseline.grade.score,
    candidateGradeScore: candidate.grade.score
  }));
  const observedGradeNonInferiorPassed = pairRecords.length > 0
    && pairedGradeComparabilityFailures.length === 0
    && pairedGradeRegressions.length === 0;
  const outcomeFloor = suite?.releaseGate?.minimumOutcomeScoreExclusive;
  const outcomeFloorConfigured = Number.isFinite(outcomeFloor);
  const outcomeFailures = outcomeFloorConfigured ? candidateOutcomeFailures(pairRecords, outcomeFloor) : [];
  const outcomeFloorPassed = outcomeFloorConfigured
    && manifest?.stopAfterFailedPair === true
    && pairRecords.length > 0
    && outcomeFailures.length === 0;
  const qualityPassed = noBaselineOnlyRegressionPassed && observedGradeNonInferiorPassed && outcomeFloorPassed;

  const acceptedUsageFailures = acceptedRuns.map((run) => ({ runId: runKey(run).replaceAll("\0", ":"), issues: exactUsageIssues(run) }))
    .filter((item) => item.issues.length > 0);
  const acceptedUsagePassed = acceptedRuns.length > 0 && acceptedUsageFailures.length === 0;

  const piRuns = acceptedRuns.filter((run) => run.surface === candidateSurface && candidateSurface === "piagent");
  const piParityFailures = piRuns.map((run) => {
    const issues = [];
    if (run.usage?.model !== requestedModel) issues.push("accepted-model-mismatch");
    if (run.usage?.thinkingLevel !== requestedThinking) issues.push("accepted-thinking-mismatch");
    if (!benchmarkProviderWireEvidenceMatchesRequest(run.providerWireEvidence, requestedModel, requestedThinking)) {
      issues.push("provider-wire-not-verified-or-request-bound");
    }
    return { runId: runKey(run).replaceAll("\0", ":"), issues };
  }).filter((item) => item.issues.length > 0);
  const pairedModelThinkingFailures = pairRecords.map(({ pair, candidate, baseline }) => ({
    pairId: pair.id,
    issues: [
      candidate?.usage?.model !== baseline?.usage?.model ? "paired-model-mismatch" : null,
      candidate?.usage?.thinkingLevel !== baseline?.usage?.thinkingLevel ? "paired-thinking-mismatch" : null
    ].filter(Boolean)
  })).filter((item) => item.issues.length > 0);
  const wireGroups = providerWireGroups(piRuns);
  const wireDriftGroups = wireGroups.filter((group) => !group.passed);
  const providerParityPassed = typeof requestedModel === "string" && requestedModel.length > 0
    && typeof requestedThinking === "string" && requestedThinking.length > 0
    && piRuns.length > 0
    && piParityFailures.length === 0
    && pairedModelThinkingFailures.length === 0
    && wireGroups.length > 0
    && wireDriftGroups.length === 0;
  const causalContextRequired = suite?.releaseGate?.requireCausalContextReceipt === true;
  const causalContextSummary = summarizeBenchmarkCausalContextEvidence(piRuns, { required: causalContextRequired });
  const causalContextAvailableRuns = causalContextSummary.currentAvailableRuns;
  const causalContextPassed = !causalContextRequired
    || causalContextSummary.currentCoverageStatus === "complete";

  const freshEfficiency = pairRatioEvidence(pairRecords, ({ candidate, baseline }) => ({
    baseline: baseline?.usage?.fresh,
    candidate: candidate?.usage?.fresh
  }));
  const freshEfficiencyPassed = freshEfficiency.records.length > 0
    && freshEfficiency.incomparablePairs.length === 0
    && freshEfficiency.pairRegressions.length === 0
    && freshEfficiency.familyRegressions.length === 0;

  const pricingSnapshot = suite?.pricingSnapshot;
  const pricingSnapshotErrors = benchmarkPricingSnapshotValidationErrors(pricingSnapshot);
  const normalizedCostEvidence = pairRatioEvidence(pairRecords, ({ candidate, baseline }) => {
    const normalizedBaseline = normalizeBenchmarkUsageCost(baseline?.usage, pricingSnapshot);
    const normalizedCandidate = normalizeBenchmarkUsageCost(candidate?.usage, pricingSnapshot);
    return {
      baseline: normalizedBaseline.status === "measured" ? normalizedBaseline.amount : null,
      candidate: normalizedCandidate.status === "measured" ? normalizedCandidate.amount : null,
      issues: [
        normalizedBaseline.status === "measured" ? null : `baseline:${normalizedBaseline.reason}`,
        normalizedCandidate.status === "measured" ? null : `candidate:${normalizedCandidate.reason}`
      ].filter(Boolean)
    };
  });
  const normalizedCostPassed = pricingSnapshotErrors.length === 0
    && normalizedCostEvidence.records.length > 0
    && normalizedCostEvidence.incomparablePairs.length === 0
    && normalizedCostEvidence.pairRegressions.length === 0
    && normalizedCostEvidence.familyRegressions.length === 0;

  const durationEfficiency = pairRatioEvidence(pairRecords, ({ candidate, baseline }) => ({
    baseline: baseline?.durationSeconds,
    candidate: candidate?.durationSeconds
  }));
  const durationEfficiencyPassed = durationEfficiency.records.length > 0
    && durationEfficiency.incomparablePairs.length === 0
    && durationEfficiency.pairRegressions.length === 0
    && durationEfficiency.familyRegressions.length === 0;

  const retryEvidenceFailures = acceptedRuns.map((run) => {
    const issues = [];
    if (!Number.isInteger(run.infrastructureRetries) || run.infrastructureRetries < 0) issues.push("invalid-infrastructure-retry-count");
    if (!Array.isArray(run.infrastructureFailures)) issues.push("missing-infrastructure-failure-ledger");
    else if (Number.isInteger(run.infrastructureRetries) && run.infrastructureFailures.length !== run.infrastructureRetries) {
      issues.push("retry-ledger-count-mismatch");
    }
    return { runId: runKey(run).replaceAll("\0", ":"), issues };
  }).filter((item) => item.issues.length > 0);
  const infrastructureRetries = acceptedRuns.reduce((sum, run) => sum + (Number.isInteger(run.infrastructureRetries) ? run.infrastructureRetries : 0), 0);
  const failedAttempts = acceptedRuns.reduce((sum, run) => sum + (Array.isArray(run.infrastructureFailures) ? run.infrastructureFailures.length : 0), 0);
  const failedAttemptUnknownUsage = acceptedRuns.reduce((sum, run) => sum + (run.infrastructureFailures ?? [])
    .filter((attempt) => attempt?.usageStatus === "unknown-after-provider-start").length, 0);
  const manifestUnknownUsage = Number.isInteger(manifest?.unknownCostAttempts) && manifest.unknownCostAttempts >= 0
    ? manifest.unknownCostAttempts
    : manifest?.unknownCostAttempts === undefined ? 0 : 1;
  const recoveredProviderAttempts = Array.isArray(manifest?.recoveredProviderAttempts)
    ? manifest.recoveredProviderAttempts.length
    : manifest?.recoveredProviderAttempts === undefined ? 0 : 1;
  const tokenClaimsUnavailableReason = typeof manifest?.tokenClaimsUnavailableReason === "string"
    ? manifest.tokenClaimsUnavailableReason
    : manifest?.tokenClaimsUnavailableReason === undefined ? null : "malformed-token-claims-unavailable-reason";
  const retryGatePassed = retryEvidenceFailures.length === 0
    && infrastructureRetries === 0
    && failedAttempts === 0
    && recoveredProviderAttempts === 0;
  const unknownUsageAttempts = failedAttemptUnknownUsage + manifestUnknownUsage;
  const unknownUsagePassed = unknownUsageAttempts === 0 && tokenClaimsUnavailableReason === null;

  const pairBoundary = incompleteObservedPairs.length === 0
    && duplicateRuns.length === 0
    && unexpectedRuns.length === 0;
  const recognizedPause = typeof reason === "string"
    && (reason.startsWith("max-sessions:") || reason.startsWith("max-runtime-minutes:"));
  const pairContractPassed = pairs.size > 0
    && [...pairs.values()].every((pair) => pair.expectedSurfaces.size === 2
      && pair.expectedSurfaces.has(candidateSurface)
      && pair.expectedSurfaces.has(baselineSurface));
  const executionContractPassed = manifest?.stopAfterFailedPair === true
    && manifest?.infrastructureRetries === 0;
  const cleanReleaseSourceRequired = suite?.schemaVersion === 2
    && suite?.releaseGate?.requireEfficiencyClaim === true
    && suite?.releaseGate?.requireFullSuiteForClaim === true;
  const cleanReleaseSourcePassed = !cleanReleaseSourceRequired || manifest?.sourceIdentity?.dirty === false;
  const checks = [
    diagnosticCheck("recognized-spend-control-pause", recognizedPause, { reason }),
    diagnosticCheck("paired-contract", pairContractPassed, { candidateSurface, baselineSurface }),
    diagnosticCheck("spend-control-execution-contract", executionContractPassed, {
      stopAfterFailedPair: manifest?.stopAfterFailedPair === true,
      infrastructureRetries: Number.isInteger(manifest?.infrastructureRetries) ? manifest.infrastructureRetries : null
    }),
    diagnosticCheck("clean-release-source", cleanReleaseSourcePassed, {
      required: cleanReleaseSourceRequired,
      dirty: typeof manifest?.sourceIdentity?.dirty === "boolean" ? manifest.sourceIdentity.dirty : null
    }),
    diagnosticCheck("pause-on-pair-boundary", pairBoundary, { incompleteObservedPairs: incompleteObservedPairs.length }),
    diagnosticCheck("observed-complete-pair", completePairs.length > 0, { observedCompletePairs: completePairs.length }),
    diagnosticCheck("no-baseline-pass-piagent-fail", noBaselineOnlyRegressionPassed, { regressions: baselineOnlyRegressions.length }),
    diagnosticCheck("observed-paired-grade-noninferior", observedGradeNonInferiorPassed, {
      incomparablePairs: pairedGradeComparabilityFailures.length,
      regressions: pairedGradeRegressions.length
    }),
    diagnosticCheck("candidate-outcome-floor", outcomeFloorPassed, {
      minimumOutcomeScoreExclusive: outcomeFloorConfigured ? outcomeFloor : null,
      failures: outcomeFailures.length
    }),
    diagnosticCheck("accepted-usage-exact", acceptedUsagePassed, { failures: acceptedUsageFailures.length }),
    diagnosticCheck("provider-wire-model-thinking-parity", providerParityPassed, { failures: piParityFailures.length + pairedModelThinkingFailures.length + wireDriftGroups.length }),
    diagnosticCheck("piagent-causal-context-receipts", causalContextPassed, {
      required: causalContextRequired,
      availableRuns: causalContextAvailableRuns,
      piagentRuns: piRuns.length,
      unavailableRuns: piRuns.length - causalContextAvailableRuns
    }),
    diagnosticCheck("no-infrastructure-retry", retryGatePassed, { retries: infrastructureRetries }),
    diagnosticCheck("no-unknown-attempt-usage", unknownUsagePassed, { unknownUsageAttempts }),
    diagnosticCheck("no-observed-fresh-token-regression", freshEfficiencyPassed, {
      incomparablePairs: freshEfficiency.incomparablePairs.length,
      pairRegressions: freshEfficiency.pairRegressions.length,
      familyRegressions: freshEfficiency.familyRegressions.length
    }),
    diagnosticCheck("normalized-cost-pricing-applicable-and-no-observed-regression", normalizedCostPassed, {
      pricingSnapshotErrors: pricingSnapshotErrors.length,
      incomparablePairs: normalizedCostEvidence.incomparablePairs.length,
      pairRegressions: normalizedCostEvidence.pairRegressions.length,
      familyRegressions: normalizedCostEvidence.familyRegressions.length
    }),
    diagnosticCheck("no-observed-duration-regression", durationEfficiencyPassed, {
      incomparablePairs: durationEfficiency.incomparablePairs.length,
      pairRegressions: durationEfficiency.pairRegressions.length,
      familyRegressions: durationEfficiency.familyRegressions.length
    })
  ];
  const blockingReasons = checks.filter((check) => !check.passed).map((check) => check.id);

  return {
    schemaVersion: 1,
    diagnosticOnly: true,
    claimEligible: false,
    runId,
    generatedAt,
    pause: { reason, recognizedSpendControlPause: recognizedPause, pairBoundary },
    completedRuns: acceptedRuns.length,
    expectedRuns: expectedRuns.length,
    remainingRuns: Math.max(0, expectedRuns.length - acceptedRuns.length),
    counts: {
      completedSessions: acceptedRuns.length,
      expectedSessions: expectedRuns.length,
      expectedPairs: pairs.size,
      observedCompletePairs: completePairs.length,
      incompleteObservedPairs: incompleteObservedPairs.length,
      unstartedPairs: unstartedPairs.length,
      duplicateSessions: duplicateRuns.length,
      unexpectedSessions: unexpectedRuns.length
    },
    pairs: {
      completeObserved: completePairs,
      incompleteObserved: incompleteObservedPairs,
      unstarted: unstartedPairs,
      duplicateRuns,
      unexpectedRuns,
      futureUnstartedPairsBlockStageAdvance: false
    },
    quality: {
      rule: "no-baseline-pass-piagent-fail-and-candidate-outcomes-above-the-release-floor",
      passed: qualityPassed,
      noBaselineOnlyRegressionPassed,
      observedGradeNonInferiorPassed,
      observedCompletePairs: completePairs.length,
      malformedCompletePairs,
      baselineOnlyRegressions,
      pairedGradeComparabilityFailures,
      pairedGradeRegressions,
      outcomeFloor: outcomeFloorConfigured ? {
        minimumScoreExclusive: outcomeFloor,
        stopAfterFailedPairEnabled: manifest?.stopAfterFailedPair === true,
        passed: outcomeFloorPassed,
        failures: outcomeFailures
      } : {
        minimumScoreExclusive: null,
        stopAfterFailedPairEnabled: manifest?.stopAfterFailedPair === true,
        passed: false,
        failures: [{ failures: ["outcome-floor-not-configured"] }]
      }
    },
    acceptedUsage: {
      rule: "every-accepted-session-has-exact-provider-token-buckets",
      passed: acceptedUsagePassed,
      exactRuns: acceptedRuns.length - acceptedUsageFailures.length,
      acceptedRuns: acceptedRuns.length,
      failures: acceptedUsageFailures
    },
    providerParity: {
      rule: "observed-pi-runs-match-requested-model-thinking-and-verified-provider-wire",
      passed: providerParityPassed,
      requestedModel: requestedModel ?? null,
      requestedThinking: requestedThinking ?? null,
      observedPiRuns: piRuns.length,
      verifiedPiRuns: piRuns.length - piParityFailures.length,
      piRunFailures: piParityFailures,
      pairedModelThinkingFailures,
      wireGroups,
      wireDriftGroups
    },
    causalContextEvidence: {
      rule: "every-observed-piagent-session-preserves-a-complete-privacy-safe-causal-context-receipt",
      passed: causalContextPassed,
      piagentRuns: piRuns.length,
      ...causalContextSummary
    },
    infrastructure: {
      retryGatePassed,
      retryEvidenceFailures,
      infrastructureRetries,
      failedAttempts,
      recoveredProviderAttempts,
      unknownUsageGatePassed: unknownUsagePassed,
      unknownUsageAttempts,
      failedAttemptUnknownUsage,
      manifestUnknownUsage,
      tokenClaimsUnavailableReason
    },
    spendFutilityReview: {
      rule: "observed-pair-and-observed-family-point-ratios-must-not-exceed-1; this-is-not-the-final-40-percent-claim-gate",
      passed: freshEfficiencyPassed && normalizedCostPassed && durationEfficiencyPassed,
      freshTokens: { passed: freshEfficiencyPassed, ...freshEfficiency },
      normalizedApiEquivalentTextTokenCost: {
        billedCost: false,
        scope: "model-text-token-input-cache-output-only",
        pricingSnapshotId: pricingSnapshotErrors.length === 0 ? pricingSnapshot.id : null,
        pricingSnapshotErrors,
        passed: normalizedCostPassed,
        ...normalizedCostEvidence
      },
      duration: { passed: durationEfficiencyPassed, ...durationEfficiency }
    },
    checks,
    blockingReasons,
    stageAdvanceAllowed: blockingReasons.length === 0,
    claimBoundary: "Provider-free partial-run diagnostic only; never eligible for a quality, efficiency, cost, latency, generalization, or release claim."
  };
}
