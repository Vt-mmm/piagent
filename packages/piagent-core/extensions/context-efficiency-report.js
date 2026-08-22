import fs from "node:fs";

import {
  editRecoveryContextMetrics,
  injectionEfficiencyMetrics,
  prefixEfficiencyMetrics,
  readEfficiencyMetrics
} from "./context-efficiency-metrics.js";
import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}
function evidenceStatus(observed, comparable) {
  if (observed === 0) return "not-observed";
  if (comparable === 0) return "unavailable";
  return comparable === observed ? "complete" : "partial";
}
export function writeContextEfficiencyReport(cwd, events, dependencies) {
  const prompts = events.filter((event) => event.event === "agent_prompt"), toolCalls = events.filter((event) => event.event === "tool_call"), toolResults = events.filter((event) => event.event === "tool_result"), packs = events.filter((event) => event.event === "context_pack");
  const offeredPacks = events.filter((event) => event.event === "context_pack_offered"), injectedPacks = events.filter((event) => event.event === "context_pack_injected");
  const compactions = events.filter((event) => event.event === "session_compact");
  const readMetrics = readEfficiencyMetrics(events);
  const comparableToolResults = toolResults.filter((event) => Number.isFinite(event.outputChars)
    && event.outputChars >= 0 && typeof event.repeated === "boolean");
  const toolResultEvidenceCoverage = ratio(comparableToolResults.length, toolResults.length);
  const outputChars = comparableToolResults.reduce((sum, event) => sum + event.outputChars, 0);
  const duplicateOutputChars = comparableToolResults.reduce((sum, event) => sum + (event.repeated ? event.outputChars : 0), 0);
  const activeToolPrompts = prompts.filter((event) => Number.isFinite(Number(event.activeTools)));
  const schemaPrompts = prompts.filter((event) => Number.isFinite(Number(event.systemPromptTokens)) && Number.isFinite(Number(event.toolSchemaTokens)));
  const averageActiveTools = activeToolPrompts.length > 0
    ? activeToolPrompts.reduce((sum, event) => sum + Number(event.activeTools), 0) / activeToolPrompts.length
    : 0;
  const averageSystemPromptTokens = schemaPrompts.length > 0
    ? schemaPrompts.reduce((sum, event) => sum + Number(event.systemPromptTokens), 0) / schemaPrompts.length
    : 0;
  const averageToolSchemaTokens = schemaPrompts.length > 0
    ? schemaPrompts.reduce((sum, event) => sum + Number(event.toolSchemaTokens), 0) / schemaPrompts.length
    : 0;
  const comparableConfidencePacks = packs.filter((event) => ["none", "low", "medium", "high"].includes(event.confidence));
  const contextPackEvidenceCoverage = ratio(comparableConfidencePacks.length, packs.length);
  const lowConfidencePacks = comparableConfidencePacks.filter((event) => ["none", "low"].includes(event.confidence)).length;
  const feedback = dependencies.retrievalFeedback();
  const prefixMetrics = prefixEfficiencyMetrics(events), injectionMetrics = injectionEfficiencyMetrics(events);
  const editRecoveryMetrics = editRecoveryContextMetrics(events);
  const duplicateOutputRate = ratio(duplicateOutputChars, outputChars);
  const schemaToSystemRatio = ratio(averageToolSchemaTokens, averageSystemPromptTokens);
  const schemaPrefixShare = ratio(averageToolSchemaTokens, averageSystemPromptTokens + averageToolSchemaTokens);
  const lowConfidenceRate = ratio(lowConfidencePacks, comparableConfidencePacks.length);
  const activeToolPenalty = Math.max(0, Math.min(1, (averageActiveTools - 12) / 24));
  const wasteScore = Math.round(100 * (
    readMetrics.duplicateReadRate * 0.3
    + duplicateOutputRate * 0.25
    + Math.min(1, schemaPrefixShare * 3) * 0.2
    + lowConfidenceRate * 0.15
    + activeToolPenalty * 0.1
  ));
  const scoreEvidenceCoverage = (
    readMetrics.readEvidenceCoverage * 0.3
    + toolResultEvidenceCoverage * 0.25
    + ratio(schemaPrompts.length, prompts.length) * 0.2
    + contextPackEvidenceCoverage * 0.15
    + ratio(activeToolPrompts.length, prompts.length) * 0.1
  );
  const scoreEvidenceComplete = scoreEvidenceCoverage >= 1 - 1e-12;
  const scoreEvidenceStatus = scoreEvidenceComplete ? "complete" : scoreEvidenceCoverage === 0 ? "unavailable" : "partial";
  const recommendations = [];
  if (readMetrics.comparableReadCalls > 0 && readMetrics.duplicateReadRate > 0.2) recommendations.push("Repeated reads are high within comparable task/session partitions; reuse the current working set before searching again.");
  if (duplicateOutputRate > 0.15) recommendations.push("Repeated tool output is high; prefer delta results and narrower verification.");
  if (schemaPrefixShare > 0.15 || averageActiveTools > 20) recommendations.push("Tool surface is large; activate only the workflow groups needed for the next turn.");
  if (lowConfidenceRate > 0.4) recommendations.push("Retrieval confidence is low; rebuild the index or run one bounded finder pass.");
  if (feedback.selected >= 4 && feedback.utilizationRate < 0.45) recommendations.push("Few injected paths receive successful mutation evidence; reduce pack breadth or improve task-specific ranking signals.");
  if (feedback.selected >= 4 && feedback.fallbackRereadRate > 0.35) recommendations.push("Injected paths are frequently read again; improve snapshot completeness instead of treating fallback reads as positive retrieval feedback.");
  if (readMetrics.readCalls > 0 && readMetrics.readEvidenceCoverage < 1) recommendations.push("Read telemetry coverage is incomplete; duplicate-read rates exclude calls without task/session/input identity.");
  if (toolResults.length > 0 && toolResultEvidenceCoverage < 1) recommendations.push("Tool-result telemetry coverage is incomplete; duplicate-output rates exclude results without finite output size and an explicit repeated classification.");
  if (packs.length > 0 && contextPackEvidenceCoverage < 1) recommendations.push("Context-pack telemetry coverage is incomplete; low-confidence rates exclude packs without a recognized confidence value.");
  if (injectionMetrics.injectionReceipts > 0 && injectionMetrics.injectionReceiptCoverage < 1) recommendations.push("Injection receipt coverage is incomplete; zero duplicate injection waste is not established for unattributed receipts.");
  if (injectionMetrics.injectedPathOccurrences > 0 && injectionMetrics.injectionItemCoverage < 1) recommendations.push("Injection item coverage is incomplete; duplicate injection rates exclude selected paths without canonical content and payload receipts.");
  if (editRecoveryMetrics.editRecoveryContextEvents > 0 && editRecoveryMetrics.editRecoveryContextEvidenceCoverage < 1) recommendations.push("Edit-recovery telemetry coverage is incomplete; recovery context totals exclude malformed or unbounded recovery receipts.");
  if (editRecoveryMetrics.editRecoveryFailures > 0 && editRecoveryMetrics.editRecoveryFailureEvidenceCoverage < 1) recommendations.push("Edit-recovery failure classification coverage is incomplete; a missing recovery context cannot be interpreted as a policy decision.");
  if (!scoreEvidenceComplete) recommendations.push("Context-waste score is unavailable because one or more weighted telemetry lanes have incomplete evidence; do not interpret missing observations as zero waste.");
  if (recommendations.length === 0) recommendations.push("No dominant context waste signal was detected in the sampled events.");
  const report = {
    schemaVersion: 3,
    source: "piagent",
    generatedAt: dependencies.nowIso(),
    sample: {
      events: events.length,
      prompts: prompts.length,
      toolCalls: toolCalls.length,
      toolResults: toolResults.length,
      contextPacks: packs.length,
      contextPacksOffered: offeredPacks.length, contextPacksInjected: injectedPacks.length,
      compactions: compactions.length,
      editRecoveryContexts: editRecoveryMetrics.editRecoveryContextEvents,
      editRecoveryFailures: editRecoveryMetrics.editRecoveryFailures
    },
    metrics: {
      averageActiveTools: Number(averageActiveTools.toFixed(2)),
      averageSystemPromptTokens: Math.round(averageSystemPromptTokens),
      averageToolSchemaTokens: Math.round(averageToolSchemaTokens),
      toolSchemaShare: Number(schemaPrefixShare.toFixed(4)),
      toolSchemaPrefixShare: Number(schemaPrefixShare.toFixed(4)),
      toolSchemaToSystemRatio: Number(schemaToSystemRatio.toFixed(4)),
      ...Object.fromEntries(Object.entries(readMetrics).map(([key, value]) => [key, Number(value.toFixed(4))])),
      outputChars,
      duplicateOutputChars,
      duplicateOutputRate: Number(duplicateOutputRate.toFixed(4)),
      comparableToolResults: comparableToolResults.length,
      uncomparableToolResults: Math.max(0, toolResults.length - comparableToolResults.length),
      toolResultEvidenceCoverage: Number(toolResultEvidenceCoverage.toFixed(4)),
      lowConfidencePacks,
      lowConfidenceRate: Number(lowConfidenceRate.toFixed(4)),
      comparableConfidencePacks: comparableConfidencePacks.length,
      uncomparableConfidencePacks: Math.max(0, packs.length - comparableConfidencePacks.length),
      contextPackEvidenceCoverage: Number(contextPackEvidenceCoverage.toFixed(4)),
      contextSelections: feedback.selected,
      contextSelectionsUsed: feedback.used,
      contextSelectionsMutationCredited: feedback.used,
      contextSelectionsUnused: feedback.unused,
      contextUtilizationRate: Number(feedback.utilizationRate.toFixed(4)),
      contextFallbackRereads: feedback.fallbackRereads,
      contextFallbackRereadRate: Number(feedback.fallbackRereadRate.toFixed(4)),
      ...Object.fromEntries(Object.entries({ ...prefixMetrics, ...injectionMetrics }).map(([key, value]) => [key, Number(value.toFixed(4))])),
      ...Object.fromEntries(Object.entries(editRecoveryMetrics).map(([key, value]) => [key, Number(value.toFixed(4))])),
      contextWasteScore: scoreEvidenceComplete ? wasteScore : null,
      contextWasteScoreEstimate: wasteScore,
      contextWasteScoreEvidenceCoverage: Number(scoreEvidenceCoverage.toFixed(4))
    },
    coverage: {
      reads: { status: evidenceStatus(readMetrics.readCalls, readMetrics.comparableReadCalls), observed: readMetrics.readCalls, comparable: readMetrics.comparableReadCalls, rate: Number(readMetrics.readEvidenceCoverage.toFixed(4)) },
      toolResults: { status: evidenceStatus(toolResults.length, comparableToolResults.length), observed: toolResults.length, comparable: comparableToolResults.length, rate: Number(toolResultEvidenceCoverage.toFixed(4)) },
      contextPacks: { status: evidenceStatus(packs.length, comparableConfidencePacks.length), observed: packs.length, comparable: comparableConfidencePacks.length, rate: Number(contextPackEvidenceCoverage.toFixed(4)) },
      prefixPrompts: { status: evidenceStatus(prefixMetrics.prefixPrompts, prefixMetrics.comparablePrefixPrompts), observed: prefixMetrics.prefixPrompts, comparable: prefixMetrics.comparablePrefixPrompts, rate: Number(prefixMetrics.prefixEvidenceCoverage.toFixed(4)) },
      injectionReceipts: { status: evidenceStatus(injectionMetrics.injectionReceipts, injectionMetrics.comparableInjectionReceipts), observed: injectionMetrics.injectionReceipts, comparable: injectionMetrics.comparableInjectionReceipts, rate: Number(injectionMetrics.injectionReceiptCoverage.toFixed(4)) },
      injectionItems: { status: evidenceStatus(injectionMetrics.injectedPathOccurrences, injectionMetrics.comparableInjectionItems), observed: injectionMetrics.injectedPathOccurrences, comparable: injectionMetrics.comparableInjectionItems, rate: Number(injectionMetrics.injectionItemCoverage.toFixed(4)) },
      editRecoveryContexts: { status: evidenceStatus(editRecoveryMetrics.editRecoveryContextEvents, editRecoveryMetrics.comparableEditRecoveryContextEvents), observed: editRecoveryMetrics.editRecoveryContextEvents, comparable: editRecoveryMetrics.comparableEditRecoveryContextEvents, rate: Number(editRecoveryMetrics.editRecoveryContextEvidenceCoverage.toFixed(4)) },
      editRecoveryFailures: { status: evidenceStatus(editRecoveryMetrics.editRecoveryFailures, editRecoveryMetrics.comparableEditRecoveryFailures), observed: editRecoveryMetrics.editRecoveryFailures, comparable: editRecoveryMetrics.comparableEditRecoveryFailures, rate: Number(editRecoveryMetrics.editRecoveryFailureEvidenceCoverage.toFixed(4)) },
      retrievalSelections: { status: evidenceStatus(feedback.observedSelected, feedback.selected), observed: feedback.observedSelected, comparable: feedback.selected, rate: Number(ratio(feedback.selected, feedback.observedSelected).toFixed(4)) },
      wasteScore: { status: scoreEvidenceStatus, rate: Number(scoreEvidenceCoverage.toFixed(4)) }
    },
    methodology: {
      scoreRange: "0-100; lower is better; contextWasteScore is null unless all weighted telemetry lanes are complete, while contextWasteScoreEstimate remains explicitly diagnostic",
      weights: {
        duplicateReads: 0.3,
        duplicateOutput: 0.25,
        toolSchemaPrefixShare: 0.2,
        lowConfidenceRetrieval: 0.15,
        activeToolExcess: 0.1
      },
      retrievalFeedback: "Positive-only reranking consumes host-confirmed context_pack_injected events and credits a path only after a successful direct mutation result (or explicit changed-path evidence) in the same session/task/model/thinking partition. Fallback reads are reported separately and never increase ranking.",
      readMetrics: "Duplicate reads require the same tool and exact inputHash within one session, task, model, and thinking-level partition. targetHash is not used as a substitute. Calls lacking comparable identity remain visible in coverage and are excluded from the rate.",
      outputMetrics: "Duplicate-output rates use only tool results with a finite non-negative outputChars value and an explicit boolean repeated classification. Coverage exposes every excluded result instead of treating missing evidence as zero output or non-duplicate output.",
      confidenceMetrics: "Low-confidence rates use only context-pack events with a recognized none/low/medium/high confidence value. Coverage exposes missing or unknown confidence instead of counting it as a non-low result.",
      prefixMetrics: "Canonical provider tool schemas are compared only within session, task, model, and thinking-level partitions. First-turn task attribution uses turn_task_bound. Coverage distinguishes missing prefix evidence from a stable prefix.", injectionMetrics: "Duplicates require the same path, file hash, payload hash, representation, ranges, and generation within one task/session partition. Unconfirmed and post-compaction rehydration events are excluded from duplicate attribution; coverage exposes excluded receipts/items.",
      editRecoveryMetrics: "Recovery count, characters, and estimated tokens require one versioned session capability marker plus an exact standalone edit_recovery_context receipt/tool_result pair. Original tool-result outputChars stays separate, so the failed tool output and the returned current-file snapshot are never added together.",
      schemaMetrics: "toolSchemaPrefixShare is tool schema tokens divided by system-plus-tool-schema tokens. toolSchemaToSystemRatio preserves the former tool/system diagnostic explicitly; toolSchemaShare is a compatibility alias for the corrected prefix share.",
      note: "This is an operational signal, not a quality verdict. Compare it with task acceptance and verification results."
    },
    recommendations
  };
  const paths = dependencies.contextEnginePaths();
  ensurePrivateStateDirectory(cwd, paths.root, "Context report directory");
  const reportPath = resolveLocalStatePath(cwd, paths.report, { label: "Context efficiency report" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
