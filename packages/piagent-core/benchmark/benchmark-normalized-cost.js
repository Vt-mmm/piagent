import {
  atMostWithinFloatingPrecision,
  geometricMean,
  geometricMeanConfidence95,
  geometricMeanConfidence95Raw,
  rounded
} from "./benchmark-statistics.js";

const SNAPSHOT_FIELDS = new Set([
  "schemaVersion", "id", "model", "currency", "unitTokens", "rates",
  "cacheWrite", "longContext", "source"
]);
const RATE_FIELDS = new Set(["freshInput", "cachedInput", "output"]);
const CACHE_WRITE_FIELDS = new Set(["basis", "multiplier"]);
const LONG_CONTEXT_FIELDS = new Set(["thresholdInputTokens", "condition", "inputMultiplier", "outputMultiplier"]);
const SOURCE_FIELDS = new Set(["url", "retrievedAt"]);
const USAGE_BUCKETS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);
const BAND_DIMENSIONS = Object.freeze({
  categories: "category",
  profiles: "profile",
  lifecycles: "lifecycle",
  difficulties: "difficulty"
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unsupportedFields(value, allowed, label, errors) {
  if (!plainObject(value)) return;
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} has unsupported field ${field}`);
  }
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

/** Validate the immutable API-equivalent pricing input used by benchmark reports. */
export function benchmarkPricingSnapshotValidationErrors(snapshot) {
  if (!plainObject(snapshot)) return ["pricingSnapshot must be an object"];
  const errors = [];
  unsupportedFields(snapshot, SNAPSHOT_FIELDS, "pricingSnapshot", errors);
  if (snapshot.schemaVersion !== 1) errors.push("pricingSnapshot.schemaVersion must be 1");
  if (typeof snapshot.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(snapshot.id)) {
    errors.push("pricingSnapshot.id must use lowercase kebab-case");
  }
  if (typeof snapshot.model !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(snapshot.model)) {
    errors.push("pricingSnapshot.model must use provider/model form");
  }
  if (snapshot.currency !== "USD") errors.push("pricingSnapshot.currency must be USD");
  if (snapshot.unitTokens !== 1_000_000) errors.push("pricingSnapshot.unitTokens must be 1000000");

  if (!plainObject(snapshot.rates)) errors.push("pricingSnapshot.rates must be an object");
  else {
    unsupportedFields(snapshot.rates, RATE_FIELDS, "pricingSnapshot.rates", errors);
    for (const field of RATE_FIELDS) {
      if (!positiveFinite(snapshot.rates[field])) errors.push(`pricingSnapshot.rates.${field} must be greater than 0`);
    }
  }

  if (!plainObject(snapshot.cacheWrite)) errors.push("pricingSnapshot.cacheWrite must be an object");
  else {
    unsupportedFields(snapshot.cacheWrite, CACHE_WRITE_FIELDS, "pricingSnapshot.cacheWrite", errors);
    if (snapshot.cacheWrite.basis !== "fresh-input") errors.push("pricingSnapshot.cacheWrite.basis must be fresh-input");
    if (!positiveFinite(snapshot.cacheWrite.multiplier)) errors.push("pricingSnapshot.cacheWrite.multiplier must be greater than 0");
  }

  if (!plainObject(snapshot.longContext)) errors.push("pricingSnapshot.longContext must be an object");
  else {
    unsupportedFields(snapshot.longContext, LONG_CONTEXT_FIELDS, "pricingSnapshot.longContext", errors);
    if (!Number.isSafeInteger(snapshot.longContext.thresholdInputTokens) || snapshot.longContext.thresholdInputTokens <= 0) {
      errors.push("pricingSnapshot.longContext.thresholdInputTokens must be a positive safe integer");
    }
    if (snapshot.longContext.condition !== "per-request-input-greater-than") {
      errors.push("pricingSnapshot.longContext.condition must be per-request-input-greater-than");
    }
    for (const field of ["inputMultiplier", "outputMultiplier"]) {
      if (!positiveFinite(snapshot.longContext[field])) errors.push(`pricingSnapshot.longContext.${field} must be greater than 0`);
    }
  }

  if (!plainObject(snapshot.source)) errors.push("pricingSnapshot.source must be an object");
  else {
    unsupportedFields(snapshot.source, SOURCE_FIELDS, "pricingSnapshot.source", errors);
    if (typeof snapshot.source.url !== "string" || !snapshot.source.url.startsWith("https://developers.openai.com/")) {
      errors.push("pricingSnapshot.source.url must be an official developers.openai.com HTTPS URL");
    }
    if (typeof snapshot.source.retrievedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.source.retrievedAt)) {
      errors.push("pricingSnapshot.source.retrievedAt must use YYYY-MM-DD");
    }
  }
  return errors;
}

function exactUsageIssue(usage, snapshot) {
  if (!plainObject(usage) || usage.usageCompleteness !== "exact") return "usage-not-exact";
  if (!Number.isSafeInteger(usage.sessions) || usage.sessions <= 0) return "usage-session-count-not-exact";
  for (const field of USAGE_BUCKETS) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) return `usage-${field}-not-exact`;
  }
  if (!Number.isSafeInteger(usage.fresh) || usage.fresh !== usage.input + usage.output) return "usage-fresh-invariant-failed";
  if (!Number.isSafeInteger(usage.total)
    || usage.total !== usage.input + usage.cacheRead + usage.cacheWrite + usage.output) {
    return "usage-total-invariant-failed";
  }
  if (usage.model !== snapshot.model) return "pricing-model-mismatch";
  return null;
}

/**
 * Convert exact token buckets to an API-equivalent amount without treating it as
 * OAuth/provider-billed cost. Aggregate prompt usage at or below the threshold
 * is a valid upper bound for every constituent request. Above it, aggregate-only
 * evidence cannot identify which per-request multiplier applies, so we fail closed.
 */
export function normalizeBenchmarkUsageCost(usage, snapshot) {
  const snapshotErrors = benchmarkPricingSnapshotValidationErrors(snapshot);
  if (snapshotErrors.length > 0) {
    return { status: "unavailable", reason: "pricing-snapshot-invalid", errors: snapshotErrors };
  }
  const usageIssue = exactUsageIssue(usage, snapshot);
  if (usageIssue) return { status: "unavailable", reason: usageIssue, errors: [] };
  const aggregatePromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (aggregatePromptTokens > snapshot.longContext.thresholdInputTokens) {
    return {
      status: "unavailable",
      reason: "long-context-per-request-usage-unavailable",
      errors: [],
      aggregatePromptTokens,
      thresholdInputTokens: snapshot.longContext.thresholdInputTokens,
      pricingApplicability: "unknown"
    };
  }
  const cacheWriteRate = snapshot.rates.freshInput * snapshot.cacheWrite.multiplier;
  const amount = (
    (usage.input * snapshot.rates.freshInput)
    + (usage.cacheRead * snapshot.rates.cachedInput)
    + (usage.cacheWrite * cacheWriteRate)
    + (usage.output * snapshot.rates.output)
  ) / snapshot.unitTokens;
  return {
    status: "measured",
    source: "versioned-api-equivalent-text-token-pricing",
    pricingSnapshotId: snapshot.id,
    pricingApplicability: "standard-context-proven-by-aggregate-upper-bound",
    currency: snapshot.currency,
    amount,
    amountUsd: rounded(amount, 9),
    aggregatePromptTokens,
    thresholdInputTokens: snapshot.longContext.thresholdInputTokens,
    buckets: Object.fromEntries(USAGE_BUCKETS.map((field) => [field, usage[field]]))
  };
}

function pairRecord(pair, snapshot) {
  const baseline = normalizeBenchmarkUsageCost(pair.baseline?.usage, snapshot);
  const candidate = normalizeBenchmarkUsageCost(pair.candidate?.usage, snapshot);
  const issues = [];
  if (baseline.status !== "measured") issues.push(`baseline:${baseline.reason}`);
  if (candidate.status !== "measured") issues.push(`candidate:${candidate.reason}`);
  if (pair.baseline?.usage?.thinkingLevel !== pair.candidate?.usage?.thinkingLevel) issues.push("thinking-mismatch");
  const comparable = issues.length === 0 && baseline.amount > 0 && candidate.amount > 0;
  if (issues.length === 0 && !comparable) issues.push("non-positive-normalized-cost");
  return {
    scenarioId: pair.candidate?.scenarioId ?? pair.baseline?.scenarioId ?? null,
    repeat: pair.candidate?.repeat ?? pair.baseline?.repeat ?? null,
    resolved: pair.baseline?.resolved === true && pair.candidate?.resolved === true,
    comparable,
    issues,
    baseline,
    candidate,
    ratio: comparable ? candidate.amount / baseline.amount : null
  };
}

function bandReport(suite, familyRatios) {
  return Object.fromEntries(Object.entries(BAND_DIMENSIONS).map(([dimension, field]) => {
    const bands = new Map();
    for (const scenario of suite.scenarios) {
      const name = scenario[field] ?? "unspecified";
      const item = bands.get(name) ?? { expectedScenarioFamilies: 0, ratios: [], missingScenarioIds: [] };
      item.expectedScenarioFamilies += 1;
      const family = familyRatios.find((candidate) => candidate.scenarioId === scenario.id);
      if (Number.isFinite(family?.ratio)) item.ratios.push(family.ratio);
      else item.missingScenarioIds.push(scenario.id);
      bands.set(name, item);
    }
    return [dimension, Object.fromEntries([...bands.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, item]) => [name, {
      expectedScenarioFamilies: item.expectedScenarioFamilies,
      comparableScenarioFamilies: item.ratios.length,
      complete: item.missingScenarioIds.length === 0,
      ratio: item.missingScenarioIds.length === 0 ? geometricMean(item.ratios) : null,
      missingScenarioIds: item.missingScenarioIds
    }]))];
  }));
}

/** Build the independent normalized-cost evidence and family-clustered estimand. */
export function normalizedCostComparison({ suite, allPairs, repeats }) {
  const snapshot = suite.pricingSnapshot;
  const snapshotErrors = benchmarkPricingSnapshotValidationErrors(snapshot);
  const records = allPairs.map((pair) => pairRecord(pair, snapshot));
  const resolvedComparable = records.filter((record) => record.resolved && record.comparable);
  const recordsByScenario = new Map();
  for (const record of resolvedComparable) {
    const family = recordsByScenario.get(record.scenarioId) ?? [];
    family.push(record);
    recordsByScenario.set(record.scenarioId, family);
  }
  const familyRatios = suite.scenarios.map((scenario) => {
    const records = recordsByScenario.get(scenario.id) ?? [];
    const observedRepeats = new Set(records.map((record) => record.repeat));
    const complete = Number.isInteger(repeats) && repeats > 0
      && records.length === repeats && observedRepeats.size === repeats;
    return {
      scenarioId: scenario.id,
      pairs: records.length,
      complete,
      ratio: complete ? geometricMean(records.map((record) => record.ratio)) : null,
      issues: complete ? [] : ["missing-comparable-normalized-cost"]
    };
  });
  const completeFamilies = familyRatios.filter((family) => family.complete);
  const ratio = completeFamilies.length === suite.scenarios.length
    ? geometricMean(completeFamilies.map((family) => family.ratio))
    : null;
  const confidence95 = completeFamilies.length === suite.scenarios.length
    ? geometricMeanConfidence95(completeFamilies.map((family) => family.ratio))
    : null;
  const confidence95Raw = completeFamilies.length === suite.scenarios.length
    ? geometricMeanConfidence95Raw(completeFamilies.map((family) => family.ratio))
    : null;
  const applicabilityFailures = records
    .filter((record) => !record.comparable)
    .map((record) => ({ scenarioId: record.scenarioId, repeat: record.repeat, issues: record.issues }));
  const expectedPairs = suite.scenarios.length * repeats;
  const exactAndApplicable = snapshotErrors.length === 0
    && records.length === expectedPairs
    && records.length > 0
    && applicabilityFailures.length === 0;
  const complete = exactAndApplicable && completeFamilies.length === suite.scenarios.length;
  const amounts = records.filter((record) => record.comparable);
  return {
    schemaVersion: 1,
    source: "versioned-api-equivalent-text-token-pricing",
    billedCost: false,
    scope: "model-text-token-input-cache-output-only",
    pricingSnapshot: snapshotErrors.length === 0 ? {
      id: snapshot.id,
      model: snapshot.model,
      currency: snapshot.currency,
      source: snapshot.source
    } : null,
    snapshotErrors,
    expectedPairs,
    observedPairs: allPairs.length,
    comparablePairs: records.filter((record) => record.comparable).length,
    resolvedComparablePairs: resolvedComparable.length,
    exactUsageAndPricingApplicability: exactAndApplicable,
    applicabilityFailures,
    complete,
    expectedScenarioFamilies: suite.scenarios.length,
    completeScenarioFamilies: completeFamilies.length,
    ratio: complete ? ratio : null,
    ratioConfidence95: complete ? confidence95 : null,
    ratioConfidence95Raw: complete ? confidence95Raw : null,
    deltaPercent: complete ? (ratio - 1) * 100 : null,
    familyRatios,
    bands: bandReport(suite, familyRatios),
    totals: {
      baselineUsd: rounded(amounts.reduce((sum, record) => sum + record.baseline.amount, 0), 9),
      candidateUsd: rounded(amounts.reduce((sum, record) => sum + record.candidate.amount, 0), 9)
    }
  };
}

export function normalizedCostGate(comparison, thresholds) {
  const evidenceGate = comparison.complete === true;
  const applicabilityGate = comparison.exactUsageAndPricingApplicability === true;
  const confidenceGate = evidenceGate
    && Number.isFinite(comparison.ratioConfidence95Raw?.upper)
    && atMostWithinFloatingPrecision(comparison.ratioConfidence95Raw.upper, thresholds.maximumRatioUpper95);
  const bandFailures = [];
  for (const [dimension, bands] of Object.entries(comparison.bands ?? {})) {
    for (const [name, band] of Object.entries(bands)) {
      if (!Number.isFinite(band.ratio) || !atMostWithinFloatingPrecision(band.ratio, thresholds.maximumBandRatio)) {
        bandFailures.push({
          dimension,
          name,
          ratio: Number.isFinite(band.ratio) ? band.ratio : null,
          reason: Number.isFinite(band.ratio) ? "ratio-above-limit" : "missing-comparable-normalized-cost",
          missingScenarioIds: band.missingScenarioIds ?? []
        });
      }
    }
  }
  const familyFailures = (comparison.familyRatios ?? [])
    .filter((family) => !Number.isFinite(family.ratio)
      || !atMostWithinFloatingPrecision(family.ratio, thresholds.maximumFamilyRatio))
    .map((family) => ({
      scenarioId: family.scenarioId,
      ratio: Number.isFinite(family.ratio) ? family.ratio : null,
      reason: Number.isFinite(family.ratio) ? "ratio-above-limit" : "missing-comparable-normalized-cost"
    }));
  return {
    evidenceGate,
    applicabilityGate,
    confidenceGate,
    bandGate: bandFailures.length === 0,
    familyGate: familyFailures.length === 0,
    bandFailures,
    familyFailures,
    passed: evidenceGate && applicabilityGate && confidenceGate && bandFailures.length === 0 && familyFailures.length === 0
  };
}
