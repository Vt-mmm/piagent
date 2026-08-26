import crypto from "node:crypto";

import { atMostWithinFloatingPrecision } from "./benchmark-statistics.js";
import { exactBenchmarkAttemptUsage } from "./benchmark-usage.js";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function productionV2EarlyDetectionValidationErrors(control, { suiteId, suite } = {}) {
  if (suiteId !== "production-v2") return [];
  if (!suite || suite.id !== suiteId || suite.schemaVersion !== 2 || !Array.isArray(suite.scenarios)) {
    return ["missing-production-v2-suite-for-early-detection-validation"];
  }
  const errors = [];
  const early = control.earlyDetection;
  const stageById = new Map((control.stages ?? []).map((stage) => [stage?.id, stage]));
  const surfaceCount = Array.isArray(control.execution?.surfaces) ? control.execution.surfaces.length : 0;
  const stagePairCount = (stageId) => {
    const sessions = stageById.get(stageId)?.cumulativeSessions;
    return Number.isSafeInteger(sessions) && surfaceCount > 0 && sessions % surfaceCount === 0
      ? sessions / surfaceCount
      : null;
  };
  const ordered = [...suite.scenarios].sort((left, right) => {
    const rank = (scenario) => crypto.createHmac("sha256", control.rootSeed)
      .update(`order\0${1}\0${scenario.id}`).digest("hex");
    return rank(left).localeCompare(rank(right));
  });
  const exactSet = (values) => [...new Set(values)].sort();
  const sameStrings = (left, right) => Array.isArray(left) && Array.isArray(right)
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const smokePairs = stagePairCount(early?.smokeDiversityStageId);
  const familyPairs = stagePairCount(early?.fullFamilyCoverageStageId);
  const categoryPairs = stagePairCount(early?.fullCategoryCoverageStageId);
  if (!Number.isSafeInteger(smokePairs) || smokePairs <= 0) errors.push("invalid-production-v2-smoke-diversity-stage");
  if (!Number.isSafeInteger(familyPairs) || familyPairs <= 0) errors.push("invalid-production-v2-family-coverage-stage");
  if (!Number.isSafeInteger(categoryPairs) || categoryPairs <= 0) errors.push("invalid-production-v2-category-coverage-stage");
  if (Number.isSafeInteger(smokePairs)) {
    const observed = ordered.slice(0, smokePairs);
    if (JSON.stringify(observed.map((scenario) => scenario.id))
      !== JSON.stringify(early?.expectedFirstRepeatScenarioIds)) errors.push("production-v2-smoke-order-mismatch");
    if (!sameStrings(exactSet(observed.map((scenario) => scenario.lifecycle)), early?.requiredLifecycleCoverage)) {
      errors.push("production-v2-smoke-lifecycle-coverage-mismatch");
    }
    if (!sameStrings(exactSet(observed.map((scenario) => scenario.difficulty)), early?.requiredDifficultyCoverage)) {
      errors.push("production-v2-smoke-difficulty-coverage-mismatch");
    }
    if (!sameStrings(exactSet(observed.map((scenario) => scenario.variantRole)), early?.requiredVariantRoleCoverage)) {
      errors.push("production-v2-smoke-variant-role-coverage-mismatch");
    }
  }
  if (Number.isSafeInteger(familyPairs)) {
    const observed = ordered.slice(0, familyPairs);
    if (JSON.stringify(observed.map((scenario) => scenario.id))
      !== JSON.stringify(early?.firstFullFamilyCoverageScenarioIds)) errors.push("production-v2-family-order-mismatch");
    if (new Set(observed.map((scenario) => scenario.familyId)).size !== suite.matrixContract?.familyCount) {
      errors.push("production-v2-family-coverage-mismatch");
    }
  }
  if (Number.isSafeInteger(categoryPairs)) {
    const observed = ordered.slice(0, categoryPairs);
    if (!sameStrings(exactSet(observed.map((scenario) => scenario.category)), early?.requiredCategoryCoverage)) {
      errors.push("production-v2-category-coverage-mismatch");
    }
  }
  return errors;
}

function allAttemptFreshTokens(run) {
  const failures = Array.isArray(run?.infrastructureFailures) ? run.infrastructureFailures : [];
  const ledgerExact = Number.isSafeInteger(run?.infrastructureRetries)
    && Number.isSafeInteger(run?.infrastructureAttempts)
    && failures.length === run.infrastructureRetries
    && run.infrastructureAttempts === run.infrastructureRetries + 1;
  const attempts = [
    { usage: run?.usage, status: run?.usageStatus ?? "measured" },
    ...failures.map((failure) => ({
      usage: failure?.usage,
      status: failure?.usageStatus ?? "unknown-after-provider-start"
    }))
  ];
  const exact = ledgerExact && attempts.every((attempt) => exactBenchmarkAttemptUsage(attempt.usage, attempt.status));
  return {
    exact,
    attempts: attempts.length,
    fresh: exact ? attempts.reduce((sum, attempt) => sum + Number(attempt.usage?.fresh ?? 0), 0) : null
  };
}

function partialSpendFamilyResolver(suite) {
  if (!suite?.matrixContract || typeof suite.matrixContract !== "object" || Array.isArray(suite.matrixContract)) {
    return { sampleUnit: "scenario", byScenarioId: null, passed: true, issues: [] };
  }
  const issues = [];
  const byScenarioId = new Map();
  if (suite.matrixContract.confidenceSampleUnit !== "task-family") {
    issues.push("unsupported-matrix-family-sample-unit");
  }
  if (!Array.isArray(suite.scenarios) || suite.scenarios.length === 0) {
    issues.push("missing-matrix-scenarios");
  } else {
    for (const scenario of suite.scenarios) {
      const scenarioId = nonEmptyString(scenario?.id) ? scenario.id : null;
      const familyId = nonEmptyString(scenario?.familyId) ? scenario.familyId : null;
      if (!scenarioId) {
        issues.push("invalid-matrix-scenario-id");
        continue;
      }
      if (!familyId) issues.push(`missing-family-id:${scenarioId}`);
      if (byScenarioId.has(scenarioId)) issues.push(`duplicate-matrix-scenario-id:${scenarioId}`);
      else byScenarioId.set(scenarioId, familyId);
    }
  }
  return {
    sampleUnit: "task-family",
    byScenarioId,
    passed: issues.length === 0,
    issues
  };
}

export function partialCatastrophicSpendEvidence(pairRecords, {
  maximumPooledFreshRatio,
  maximumObservedFamilyFreshRatio,
  suite
}) {
  const familyResolver = partialSpendFamilyResolver(suite);
  const records = pairRecords.map(({ pair, candidate, baseline }) => {
    const candidateUsage = allAttemptFreshTokens(candidate);
    const baselineUsage = allAttemptFreshTokens(baseline);
    const familyId = familyResolver?.byScenarioId
      ? familyResolver.byScenarioId.get(pair.scenarioId)
      : pair.scenarioId;
    const familyResolved = nonEmptyString(familyId);
    const exact = familyResolved && candidateUsage.exact && baselineUsage.exact
      && baselineUsage.fresh > 0 && candidateUsage.fresh >= 0;
    return {
      pairId: pair.id,
      scenarioId: pair.scenarioId,
      familyId: familyResolved ? familyId : null,
      familyResolved,
      repeat: pair.repeat,
      exact,
      baselineFresh: exact ? baselineUsage.fresh : null,
      candidateFresh: exact ? candidateUsage.fresh : null,
      baselineAttempts: baselineUsage.attempts,
      candidateAttempts: candidateUsage.attempts
    };
  });
  const familyResolutionIssues = [
    ...(familyResolver?.issues ?? []),
    ...[...new Set(records
      .filter((record) => !record.familyResolved)
      .map((record) => `unresolved-family:${record.scenarioId}`))]
  ];
  const familyResolutionPassed = familyResolver?.passed !== false
    && familyResolutionIssues.length === 0;
  const exact = records.length > 0 && familyResolutionPassed && records.every((record) => record.exact);
  const baselineFresh = exact ? records.reduce((sum, record) => sum + record.baselineFresh, 0) : null;
  const candidateFresh = exact ? records.reduce((sum, record) => sum + record.candidateFresh, 0) : null;
  const pooledRatio = exact && baselineFresh > 0 ? candidateFresh / baselineFresh : null;
  const byFamily = new Map();
  for (const record of records) {
    const familyKey = record.familyId ?? `unresolved:${record.scenarioId}`;
    const family = byFamily.get(familyKey) ?? { familyId: record.familyId, records: [] };
    family.records.push(record);
    byFamily.set(familyKey, family);
  }
  const families = [...byFamily.values()].map((family) => {
    const familyExact = nonEmptyString(family.familyId)
      && family.records.length > 0
      && family.records.every((record) => record.exact);
    const baseline = familyExact ? family.records.reduce((sum, record) => sum + record.baselineFresh, 0) : null;
    const candidate = familyExact ? family.records.reduce((sum, record) => sum + record.candidateFresh, 0) : null;
    return {
      familyId: family.familyId,
      scenarioIds: [...new Set(family.records.map((record) => record.scenarioId))].sort(),
      observedPairs: family.records.length,
      exact: familyExact,
      ratio: familyExact && baseline > 0 ? candidate / baseline : null
    };
  }).sort((left, right) => String(left.familyId).localeCompare(String(right.familyId)));
  const familyFailures = families.filter((family) => !family.exact
    || !Number.isFinite(family.ratio)
    || !atMostWithinFloatingPrecision(family.ratio, maximumObservedFamilyFreshRatio));
  const passed = exact
    && Number.isFinite(pooledRatio)
    && atMostWithinFloatingPrecision(pooledRatio, maximumPooledFreshRatio)
    && familyFailures.length === 0;
  return {
    schemaVersion: 1,
    sampleUnit: familyResolver?.sampleUnit ?? "scenario",
    aggregation: "ratio-of-exact-all-attempt-fresh-sums-by-family",
    familyResolutionPassed,
    familyResolutionIssues,
    exactUsageIncludingFailedAttempts: exact,
    maximumPooledFreshRatio,
    maximumObservedFamilyFreshRatio,
    pooledRatio,
    baselineFresh,
    candidateFresh,
    familyFailures,
    families,
    records,
    passed
  };
}
