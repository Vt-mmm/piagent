import { hierarchicalMatrixRatioSample } from "./benchmark-comparison.js";
import {
  geometricMean,
  geometricMeanConfidence95,
  geometricMeanConfidence95Raw
} from "./benchmark-statistics.js";

export function hierarchicalMatrixRatioSummary({
  suite,
  completeScenarioFreshRatios,
  scenarioFreshRatios,
  allSuccessfulPairsFreshRatio,
  completeScenarioDurationRatios,
  scenarioDurationRatios,
  durationRatios
}) {
  const freshSample = hierarchicalMatrixRatioSample(suite, completeScenarioFreshRatios);
  const confidenceFreshRatios = freshSample.matrix
    ? freshSample.samples
    : suite.schemaVersion === 2 ? completeScenarioFreshRatios : scenarioFreshRatios;
  const freshRatio = freshSample.matrix || suite.schemaVersion === 2
    ? geometricMean(confidenceFreshRatios.map((item) => item.ratio))
    : allSuccessfulPairsFreshRatio;
  const durationSample = hierarchicalMatrixRatioSample(suite, completeScenarioDurationRatios);
  const confidenceDurationRatios = durationSample.matrix
    ? durationSample.samples
    : suite.schemaVersion === 2 ? completeScenarioDurationRatios : scenarioDurationRatios;
  const durationRatio = durationSample.matrix
    ? geometricMean(confidenceDurationRatios.map((item) => item.ratio))
    : geometricMean(durationRatios);
  return {
    hierarchicalFreshRatioSample: freshSample,
    confidenceScenarioRatios: confidenceFreshRatios,
    freshRatio,
    freshRatioConfidence95: geometricMeanConfidence95(confidenceFreshRatios.map((item) => item.ratio)),
    freshRatioConfidence95Raw: geometricMeanConfidence95Raw(confidenceFreshRatios.map((item) => item.ratio)),
    hierarchicalDurationRatioSample: durationSample,
    confidenceScenarioDurationRatios: confidenceDurationRatios,
    durationRatio,
    durationRatioConfidence95: geometricMeanConfidence95(confidenceDurationRatios.map((item) => item.ratio)),
    durationRatioConfidence95Raw: geometricMeanConfidence95Raw(confidenceDurationRatios.map((item) => item.ratio))
  };
}

export function primaryEfficiencyMatrixSummary(matrixHierarchy, scenarioRatios) {
  const scenarioIds = matrixHierarchy
    ? [...new Set(scenarioRatios.flatMap((item) => item.scenarioIds ?? []))]
    : scenarioRatios.map((item) => item.scenarioId);
  const familyIds = matrixHierarchy
    ? scenarioRatios.flatMap((item) => typeof item.familyId === "string" ? [item.familyId] : [])
    : [];
  return {
    scenarioIds,
    familyIds,
    completeScenarios: scenarioIds.length,
    completeSamples: matrixHierarchy ? familyIds.length : scenarioIds.length
  };
}

export function hierarchicalMatrixReportSummary({
  suite,
  matrixHierarchy,
  hierarchicalFreshRatioSample,
  confidenceScenarioRatios,
  hierarchicalDurationRatioSample,
  confidenceScenarioDurationRatios,
  primaryEfficiencyScenarioRatios,
  primaryEfficiencyScenarioIds,
  primaryEfficiencyFamilyIds,
  primaryEfficiencyCompleteScenarios,
  primaryUsesFixedWorkload,
  familyClusteredFailureAware,
  familyClusteredFixedWorkload
}) {
  return {
    suiteFields: matrixHierarchy ? { matrixContract: suite.matrixContract } : {},
    estimatorFields: {
      usageEstimator: matrixHierarchy
        ? "paired-geometric-mean-ratio-clustered-by-repeat-variant-task-family"
        : "paired-geometric-mean-ratio",
      durationEstimator: matrixHierarchy
        ? "paired-geometric-mean-ratio-clustered-by-repeat-variant-task-family"
        : "paired-geometric-mean-ratio-clustered-by-scenario-family"
    },
    fixedWorkloadEstimatorVersion: matrixHierarchy ? 2 : 1,
    failureAwareCoverageFields: matrixHierarchy ? {
      expectedTaskFamilies: familyClusteredFailureAware.expectedTaskFamilies,
      usableTaskFamilies: familyClusteredFailureAware.usableTaskFamilies,
      expectedVariants: familyClusteredFailureAware.expectedVariants,
      usableVariants: familyClusteredFailureAware.usableVariants,
      familyIds: familyClusteredFailureAware.familyIds
    } : {},
    fixedWorkloadCoverageFields: matrixHierarchy ? {
      expectedTaskFamilies: familyClusteredFixedWorkload.expectedTaskFamilies,
      usableTaskFamilies: familyClusteredFixedWorkload.usableTaskFamilies,
      expectedVariants: familyClusteredFixedWorkload.expectedVariants,
      usableVariants: familyClusteredFixedWorkload.usableVariants,
      expectedAttemptsPerVariant: familyClusteredFixedWorkload.expectedAttemptsPerVariant,
      familyIds: familyClusteredFixedWorkload.familyIds
    } : {},
    freshTokenRatioSample: matrixHierarchy ? {
      sampleUnit: hierarchicalFreshRatioSample.sampleUnit,
      sampleCount: confidenceScenarioRatios.length,
      taskFamilyCount: confidenceScenarioRatios.length,
      variantCount: hierarchicalFreshRatioSample.scenarioIds.length,
      scenarioCount: hierarchicalFreshRatioSample.scenarioIds.length,
      familyIds: hierarchicalFreshRatioSample.familyIds,
      scenarioIds: hierarchicalFreshRatioSample.scenarioIds
    } : {
      sampleUnit: "scenario-family",
      scenarioCount: confidenceScenarioRatios.length,
      scenarioIds: confidenceScenarioRatios.map((item) => item.scenarioId)
    },
    primaryEfficiencySample: matrixHierarchy ? {
      sampleUnit: suite.matrixContract.confidenceSampleUnit,
      sampleCount: primaryEfficiencyScenarioRatios.length,
      taskFamilyCount: primaryEfficiencyScenarioRatios.length,
      variantCount: primaryEfficiencyCompleteScenarios,
      scenarioCount: primaryEfficiencyCompleteScenarios,
      familyIds: primaryEfficiencyFamilyIds,
      scenarioIds: primaryEfficiencyScenarioIds,
      outcomeConditioning: primaryUsesFixedWorkload ? "none" : "resolved-outcome-conditioned"
    } : {
      sampleUnit: "scenario-family",
      scenarioCount: primaryEfficiencyCompleteScenarios,
      scenarioIds: primaryEfficiencyScenarioIds,
      outcomeConditioning: primaryUsesFixedWorkload ? "none" : "resolved-outcome-conditioned"
    },
    durationRatioSampleFields: matrixHierarchy ? {
      durationRatioSample: {
        sampleUnit: hierarchicalDurationRatioSample.sampleUnit,
        sampleCount: confidenceScenarioDurationRatios.length,
        taskFamilyCount: confidenceScenarioDurationRatios.length,
        variantCount: hierarchicalDurationRatioSample.scenarioIds.length,
        scenarioCount: hierarchicalDurationRatioSample.scenarioIds.length,
        familyIds: hierarchicalDurationRatioSample.familyIds,
        scenarioIds: hierarchicalDurationRatioSample.scenarioIds
      }
    } : {}
  };
}
