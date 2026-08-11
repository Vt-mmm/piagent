import { performance } from "node:perf_hooks";

import type { AuthenticatedModelCatalog } from "../packages/piagent-core/runtime/model/authenticated-catalog.ts";
import { routeParentModel } from "../packages/piagent-core/runtime/model/model-route-policy.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";
import { gradeModelRouteDecision, validateModelRouteCorpus } from "../packages/piagent-core/benchmark/model-route-grader.ts";

function catalog(kind: "full" | "target-missing" | "offline" | "reordered"): AuthenticatedModelCatalog {
  const models = [
    { provider: "openai-codex", modelId: "gpt-5.6-luna", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["low", "medium"] },
    { provider: "openai-codex", modelId: "gpt-5.6-terra", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["medium", "high"] },
    { provider: "openai-codex", modelId: "gpt-5.6-sol", contextWindow: 200000, reasoning: true, imageInput: true, supportedThinkingLevels: ["medium", "high", "xhigh"] }
  ];
  return {
    schemaVersion: 1, capturedAt: "2026-08-08T00:00:00.000Z", source: "authenticated-catalog",
    availability: kind === "offline" ? "offline" : "authenticated",
    models: kind === "target-missing" || kind === "offline" ? [] : kind === "reordered" ? [...models].reverse() : models,
    warnings: []
  };
}

function percentile(values: number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(values.length * percent / 100) - 1))];
}

export function evaluateModelRouteCorpus(input: unknown) {
  const corpus = validateModelRouteCorpus(input), records: Array<Record<string, unknown>> = [], durations: number[] = [];
  for (const template of corpus.templates) {
    for (const variant of corpus.variants) {
      const features = extractTaskFeatures({ ...structuredClone(corpus.defaults), ...structuredClone(template.overrides), request: template.request });
      const policyInput = {
        features, catalog: catalog(variant.catalog), mode: variant.mode, objective: variant.objective,
        selectionSource: variant.selectionSource,
        current: { provider: "openai-codex", modelId: "gpt-5.6-sol", effort: "high" },
        freshTaskBoundary: variant.freshTaskBoundary, hostBoundary: variant.hostBoundary
      } as const;
      const started = performance.now(), decision = routeParentModel(policyInput); durations.push(performance.now() - started);
      const replay = routeParentModel(policyInput);
      records.push({
        caseId: `${template.id}:${variant.id}`, family: template.family, split: template.split, locale: template.locale,
        minimumFloor: template.minimumFloor, blocked: template.blocked, variantId: variant.id, featureHash: features.featureHash,
        capabilityBand: decision.capabilityBand, safetyFloor: decision.safetyFloor, disposition: decision.disposition,
        selectionSource: decision.selectionSource, modelId: decision.modelId, effort: decision.effort,
        enforced: decision.enforced, decisionDigest: decision.decisionDigest, deterministicReplay: decision.decisionDigest === replay.decisionDigest,
        violations: gradeModelRouteDecision(decision, template, variant)
      });
    }
  }
  const violationRecords = records.filter((record) => (record.violations as string[]).length > 0);
  const serialized = JSON.stringify(records);
  const rawPromptFindings = corpus.templates.filter((template) => serialized.includes(template.request)).length;
  const metrics = {
    labeledCases: records.length,
    eligibleDecisionCoverage: records.filter((record) => Boolean(record.decisionDigest)).length / records.length,
    deterministicReplay: records.filter((record) => record.deterministicReplay).length / records.length,
    highRiskFalseLow: records.filter((record) => (record.violations as string[]).includes("high-risk-false-low")).length,
    explicitPinViolations: records.filter((record) => (record.violations as string[]).includes("explicit-pin-violation")).length,
    silentSubstitutions: records.filter((record) => (record.violations as string[]).includes("silent-substitution")).length,
    unknownProvenanceEnforcements: records.filter((record) => (record.violations as string[]).includes("unknown-provenance-enforced")).length,
    unsupportedHostEnforcements: records.filter((record) => (record.violations as string[]).includes("unsupported-host-enforced")).length,
    rawPromptFindings,
    policyP95Ms: percentile(durations, 95),
    policyMaxMs: durations.length ? Math.max(...durations) : null
  };
  const gates = {
    labeledCases: metrics.labeledCases >= 240,
    eligibleDecisionCoverage: metrics.eligibleDecisionCoverage === 1,
    deterministicReplay: metrics.deterministicReplay === 1,
    noInvariantViolations: violationRecords.length === 0,
    highRiskFalseLow: metrics.highRiskFalseLow === 0,
    explicitPinsPreserved: metrics.explicitPinViolations === 0,
    noSilentSubstitution: metrics.silentSubstitutions === 0,
    unknownProvenanceFailsClosed: metrics.unknownProvenanceEnforcements === 0,
    unsupportedHostFailsClosed: metrics.unsupportedHostEnforcements === 0,
    privacy: metrics.rawPromptFindings === 0,
    policyP95: (metrics.policyP95Ms ?? Infinity) < 50
  };
  return { schemaVersion: 1, id: corpus.id, policyVersion: corpus.policyVersion, mappingVersion: corpus.mappingVersion, generatedAt: new Date().toISOString(), methodology: { providerCalls: 0, rawPromptsStored: false, expansion: `${corpus.templates.length} templates × ${corpus.variants.length} policy/catalog variants`, labelsHiddenFromPolicy: true }, sample: { templates: corpus.templates.length, variants: corpus.variants.length, records: records.length, locales: { en: corpus.templates.filter((item) => item.locale === "en").length, vi: corpus.templates.filter((item) => item.locale === "vi").length }, splits: Object.fromEntries(["train", "validation", "holdout"].map((split) => [split, corpus.templates.filter((item) => item.split === split).length])) }, metrics, gates, violations: violationRecords, records };
}
