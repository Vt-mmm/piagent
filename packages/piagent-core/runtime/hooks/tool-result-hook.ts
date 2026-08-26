import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { estimateContextTokens, toolResultFingerprint } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { changedSnapshotFiles, taskDeltaFilesFromSnapshot } from "../../extensions/task-contract-view.js";
import { classifyVerificationFailure } from "../../extensions/verification-intelligence.js";
import { redactForStorage } from "../../extensions/redaction-core.js";
import { appendObservedBashResult, hashEvidenceCommand, observedBashResultFromToolResultEvent } from "../../extensions/runtime-evidence.js";
import { workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../extensions/task-state.js";
import { workingTreeObservation } from "../../extensions/working-tree-digest.js";
import { recordObservedContextEvidence } from "../context/context-evidence-qualification.ts";
import { confirmContextDeliveryFromToolResult, type ContextDeliveryConfirmationDependencies } from "../context/context-delivery.ts";
import { recordMutationResult } from "../inspection/mutation-provenance-recorder.ts";
import { classifyToolFailure } from "../inspection/tool-failure-classification.ts";
import { classifyDirectSubagentResult, type DirectSubagentResult } from "../orchestration/subagent-tool-policy.ts";
import { boundedGitDiffReview } from "../quality/performance-assurance.ts";
import { currentFileContentDigests } from "../quality/model-mutation-proof.ts";
import { boundedPerformanceReviewResultText } from "../quality/performance-review-evidence.ts";
import { buildEditRecoveryContext, type EditRecoveryContext } from "../recovery/edit-recovery-context.ts";
import { EditRecoveryDeliveryState } from "../recovery/edit-recovery-delivery.ts";
import { attachToolResultCompactionDetails, compactToolResultDetails, compactToolResultTextContent, type ToolResultCaptureSummary } from "../session/tool-result-compaction.ts";
import type { ObservedTaskContext } from "../session/runtime-state.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import { filterGrepProtectedContent, filterProtectedPathListContent } from "./tool-result-content-guards.ts";
import { patchLineStats } from "./tool-result-metadata.ts";
import { appendToolResultText, boundedToolResultText, countChangedStringLeaves, isPlainRecord, numericExitCode, redactToolResultTextContent, successfulToolResult } from "./tool-result-value-helpers.ts";

export { filterGrepProtectedContent, filterProtectedPathListContent };
type ToolResultEvent = { toolCallId?: string; toolName: string; input?: unknown; content?: unknown; details?: unknown; isError?: boolean; usage?: unknown };
type ObservedBashResult = NonNullable<ReturnType<typeof observedBashResultFromToolResultEvent>>;
type ObservedVerificationResult = ObservedBashResult & { outputText?: string };
type WorkingTreeObservation = ReturnType<typeof workingTreeObservation>;

type ToolResultHookDependencies = ContextDeliveryConfirmationDependencies & {
  readProtectedPaths: (ctx: ExtensionContext) => string[];
  recordObservedBash: (observed: ObservedBashResult) => void;
  observedBashLedgerPath: (cwd: string) => string;
  redactText: (input: string) => string;
  observedTaskContext: (
    cwd: string,
    event: ToolResultEvent,
    readProtectedPaths: string[]
  ) => ObservedTaskContext | undefined;
  recordObservedTaskChanges: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    event: ToolResultEvent,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number,
    shellSnapshotBefore?: Record<string, string>, eventTree?: WorkingTreeObservation
  ) => unknown;
  recordObservedTaskVerification: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    observed: ObservedVerificationResult,
    pendingContext: ObservedTaskContext[],
    maxManifestFiles: number, shellSnapshotBefore?: Record<string, string>, eventTree?: WorkingTreeObservation,
    readProtectedPaths?: string[]
  ) => unknown;
  extractLikelyPath: (cwd: string, input: Record<string, unknown>) => string | undefined;
  mutationTargets: (cwd: string, toolName: string, input: Record<string, unknown>) => string[];
  isShellTool: (toolName: string) => boolean;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  activity?: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
  now: () => string;
  observeEditFreshness?: (
    ctx: ExtensionContext,
    event: ToolResultEvent,
    metadata: { taskRunId?: string; successful: boolean; targetPath?: string; mutationTargets: string[] }
  ) => void;
  completeSemanticRepair?: (
    ctx: ExtensionContext,
    event: ToolResultEvent,
    metadata: {
      toolCallId: string;
      success: boolean;
      exitCode: number;
      currentWorkingTreeDigest: string;
      changedPaths: string[]; authoredChangedPaths: string[];
      retryableFailure: boolean; correctiveFailure: boolean;
    }
  ) => TrajectorySyncResult | undefined;
  syncTrajectory?: (ctx: ExtensionContext, contextObserved: boolean) => TrajectorySyncResult | undefined;
  recordSubagentResult?: (
    ctx: ExtensionContext,
    event: ToolResultEvent,
    result: DirectSubagentResult
  ) => void;
};

export function registerToolResultHook(pi: ExtensionAPI, dependencies: ToolResultHookDependencies): void {
  const editRecoveryDelivery = new EditRecoveryDeliveryState();
  pi.on("session_compact", async (_event, ctx) => editRecoveryDelivery.advanceEpoch(ctx));
  pi.on("session_shutdown", async (_event, ctx) => editRecoveryDelivery.clearSession(ctx));
  pi.on("tool_result", async (event, ctx) => {
    confirmContextDeliveryFromToolResult(pi, ctx, event, dependencies);
    const taskIdentity = dependencies.state.taskIdentity(ctx);
    const resultToolCallId = event.toolCallId ?? toolResultFingerprint(event.toolName, event.input, []).key;
    const readProtectedPaths = dependencies.readProtectedPaths(ctx);
    const observed = observedBashResultFromToolResultEvent(event, ctx.cwd);
    if (observed) {
      dependencies.recordObservedBash(observed);
      try {
        appendObservedBashResult(dependencies.observedBashLedgerPath(ctx.cwd), {
          ...observed,
          redactedCommand: dependencies.redactText(observed.command)
        }, { projectRoot: ctx.cwd });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Piagent Pi guard could not persist bash evidence ledger: ${message}`, "warn");
      }
    }

    const observedContextEntry = dependencies.observedTaskContext(ctx.cwd, event, readProtectedPaths);
    recordObservedContextEvidence(ctx, observedContextEntry, taskIdentity, dependencies);
    const pendingContext = dependencies.state.qualifiedTaskContext(ctx);
    const shellSnapshotBefore = dependencies.isShellTool(event.toolName)
      ? dependencies.state.consumeShellMutationSnapshot(ctx, event.toolName, event.input)
      : undefined;
    const currentTask = dependencies.activeTask(ctx);
    const subagentResult = classifyDirectSubagentResult({
      toolName: event.toolName,
      toolInput: event.input,
      content: event.content,
      details: event.details,
      isError: event.isError
    });
    if (subagentResult) dependencies.recordSubagentResult?.(ctx, event, subagentResult);
    const effectiveToolError = event.isError === true || subagentResult?.failed === true;
    const eventTree = currentTask
      ? workingTreeObservation(workingTreeSnapshot(ctx.cwd) as Record<string, string>)
      : undefined;
    dependencies.recordObservedTaskChanges(pi, ctx, event, pendingContext, dependencies.maxManifestFiles, shellSnapshotBefore, eventTree);
    if (observed) {
      dependencies.recordObservedTaskVerification(
        pi,
        ctx,
        { ...observed, toolCallId: observed.toolCallId ?? resultToolCallId, outputText: boundedToolResultText(event.content) },
        pendingContext,
        dependencies.maxManifestFiles, shellSnapshotBefore, eventTree, readProtectedPaths
      );
    }

    const normalizedToolName = String(event.toolName ?? "").toLowerCase();
    const directMutationTool = ["edit", "write", "apply_patch"].includes(normalizedToolName);
    const directMutationTargets = directMutationTool
      ? dependencies.mutationTargets(ctx.cwd, event.toolName, isPlainRecord(event.input) ? event.input : {})
      : [];
    const modelMutationIdentity = taskIdentity
      ? { ...taskIdentity, sessionId: ctx.sessionManager.getSessionId() }
      : undefined;
    const currentSnapshot = taskIdentity ? eventTree?.snapshot : undefined;
    const currentTreeDigest = taskIdentity ? eventTree?.digest : undefined;
    const directMutationResult = modelMutationIdentity && currentSnapshot
      ? dependencies.state.completeAuthorizedModelMutationEvidence(
          modelMutationIdentity,
          resultToolCallId,
          successfulToolResult(event),
          currentSnapshot,
          currentFileContentDigests(ctx.cwd, directMutationTargets)
        )
      : { changedPaths: [] as string[], recordedDigests: {} as Record<string, string>, beforeSnapshot: null,
          targetPaths: [] as string[], recordedContentDigests: {} as Record<string, string>, proofModes: {} as Record<string, "full-content" | "exact-replacement"> };
    const shellChangedPaths = taskIdentity && currentSnapshot && shellSnapshotBefore
      ? changedSnapshotFiles(shellSnapshotBefore, currentSnapshot)
      : [];
    if (modelMutationIdentity && shellChangedPaths.length > 0) {
      dependencies.state.invalidateSuccessfulModelMutationPaths(modelMutationIdentity, shellChangedPaths);
    }
    if (modelMutationIdentity && currentSnapshot) {
      try {
        recordMutationResult({
          projectRoot: ctx.cwd, identity: modelMutationIdentity, toolCallId: resultToolCallId, toolName: event.toolName,
          recordedAt: dependencies.now(), successful: successfulToolResult(event), currentSnapshot,
          completion: directMutationResult, shellSnapshotBefore, shellChangedPaths, protectedPaths: readProtectedPaths
        });
      } catch (error) {
        ctx.ui.notify(`Piagent could not persist mutation provenance: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    }
    const outputText = boundedToolResultText(event.content);
    const toolFailureReasonCode = classifyToolFailure(event.toolName, effectiveToolError, event.content, event.input);
    const failureReasonCode = subagentResult?.reasonCode ?? toolFailureReasonCode;
    const performanceReviewOutputText = boundedPerformanceReviewResultText(event.content);
    const observedExitCode = observed?.exitCode
      ?? numericExitCode(isPlainRecord(event.details) ? event.details.exitCode ?? event.details.status : undefined)
      ?? (effectiveToolError ? 1 : 0);
    const failure = observedExitCode === 0
      ? undefined
      : classifyVerificationFailure(outputText, observedExitCode);
    const performanceResult = taskIdentity && currentSnapshot && currentTreeDigest
      ? dependencies.state.completePerformanceReviewTool(taskIdentity.taskRunId, resultToolCallId, {
          success: successfulToolResult(event),
          postWorkingTreeDigest: currentTreeDigest,
          postWorkingTreeSnapshot: currentSnapshot,
          exitCode: observedExitCode,
          failure
        })
      : "unmatched";
    const semanticRepairSync = currentTreeDigest
      ? dependencies.completeSemanticRepair?.(ctx, event, {
          toolCallId: resultToolCallId,
          success: successfulToolResult(event),
          exitCode: observedExitCode,
          currentWorkingTreeDigest: currentTreeDigest,
          changedPaths: [...new Set([...directMutationResult.changedPaths, ...shellChangedPaths])].sort(),
          authoredChangedPaths: Object.keys(directMutationResult.recordedDigests).sort(),
          retryableFailure: failure?.retryable === true, correctiveFailure: failure?.sourceMutationPermission === "eligible-in-scope" && failure?.confidence === "high"
        })
      : undefined;
    observeTrajectorySync(ctx, semanticRepairSync, dependencies.telemetry);

    const checkpointAfterResult = taskIdentity ? dependencies.state.performanceReviewCheckpoint(taskIdentity.taskRunId) : undefined;
    const unexpectedTreeChange = directMutationResult.changedPaths.length > 0
      || shellChangedPaths.length > 0
      || Boolean(checkpointAfterResult && currentTreeDigest && checkpointAfterResult.workingTreeDigest !== currentTreeDigest);
    if (taskIdentity && performanceResult === "unmatched" && unexpectedTreeChange && dependencies.state.performanceReviewCheckpoint(taskIdentity.taskRunId)) {
      dependencies.state.invalidatePerformanceReviewCheckpoint(taskIdentity.taskRunId);
    }
    const reviewCandidate = currentTask?.trace.outcome === "pending"
      && currentSnapshot
      && !workingTreeSnapshotHasUnavailableEvidence(currentSnapshot)
      && performanceReviewOutputText !== undefined
      ? boundedGitDiffReview({
          toolName: event.toolName,
          input: event.input,
          changedFiles: taskDeltaFilesFromSnapshot(currentTask, currentSnapshot),
          outputText: performanceReviewOutputText,
          authoredFileDigests: modelMutationIdentity && currentSnapshot
            ? dependencies.state.successfulModelMutationDigests(modelMutationIdentity, currentSnapshot)
            : undefined,
          currentFileDigests: currentSnapshot
        })
      : undefined;
    const existingCredit = taskIdentity && currentTreeDigest
      ? dependencies.state.performanceReviewCredit(taskIdentity.taskRunId, currentTreeDigest)
      : undefined;
    const successfulDirectMutation = successfulToolResult(event)
      && directMutationTool;
    const shellTreeChanged = shellChangedPaths.length > 0;
    if (taskIdentity && currentTreeDigest && (reviewCandidate || existingCredit || successfulDirectMutation || shellSnapshotBefore)) {
      if (shellTreeChanged || directMutationResult.changedPaths.length > 0) {
        dependencies.state.invalidatePerformanceReviewCredit(taskIdentity.taskRunId);
      }
      if (reviewCandidate && successfulToolResult(event) && currentTask) {
        const commandHash = hashEvidenceCommand(reviewCandidate.command);
        if (commandHash) {
          const credit = {
            workingTreeDigest: currentTreeDigest,
            commandHash,
            reviewedPaths: reviewCandidate.reviewedPaths,
            recordedAt: dependencies.now()
          };
          dependencies.state.rememberPerformanceReviewCredit(taskIdentity.taskRunId, credit);
          dependencies.telemetry(ctx, {
            event: "performance_review_credit_recorded",
            taskId: currentTask.taskId,
            taskRunId: currentTask.taskRunId,
            workingTreeDigest: currentTreeDigest,
            commandHash,
            reviewedPaths: reviewCandidate.reviewedPaths
          });
        }
      }
    }
    observeTrajectorySync(ctx, dependencies.syncTrajectory?.(ctx, Boolean(observedContextEntry)), dependencies.telemetry);

    let resultContent: unknown = event.content;
    let resultDetails: unknown = event.details;
    let resultChanged = false;
    let editRecovery: EditRecoveryContext | undefined;
    if (subagentResult) {
      const classification = {
        schemaVersion: 1,
        spawned: subagentResult.spawned,
        failed: subagentResult.failed,
        reasonCode: subagentResult.reasonCode,
        disposition: subagentResult.disposition,
        role: subagentResult.role,
        requestRef: subagentResult.requestRef,
        calls: subagentResult.calls,
        tokens: subagentResult.tokens
      };
      resultDetails = isPlainRecord(resultDetails)
        ? { ...resultDetails, piagentSubagentOutcome: classification }
        : { ...(resultDetails === undefined ? {} : { value: resultDetails }), piagentSubagentOutcome: classification };
      if (subagentResult.failed) {
        resultContent = appendToolResultText(
          resultContent,
          `[Piagent helper outcome: failed (${subagentResult.reasonCode ?? "helper-run-failed"}). Treat this result as insufficient evidence; continue in the parent and do not retry the helper.]`
        );
      }
      resultChanged = true;
    }
    const resultTarget = dependencies.extractLikelyPath(ctx.cwd, isPlainRecord(event.input) ? event.input : {});
    dependencies.observeEditFreshness?.(ctx, event, {
      taskRunId: taskIdentity?.taskRunId,
      successful: successfulToolResult(event),
      targetPath: resultTarget,
      mutationTargets: directMutationTargets
    });
    if (event.toolName === "grep") {
      const filtered = filterGrepProtectedContent(resultContent, readProtectedPaths);
      if (filtered.changed) {
        resultContent = filtered.content;
        resultDetails = isPlainRecord(resultDetails)
          ? { ...resultDetails, protectedMatchesRedacted: filtered.redactedLines }
          : { protectedMatchesRedacted: filtered.redactedLines };
        resultChanged = true;
      }
    }
    if (event.toolName === "find" || event.toolName === "ls") {
      const input = isPlainRecord(event.input) ? event.input : {};
      const basePath = dependencies.extractLikelyPath(ctx.cwd, input) || ".";
      const filtered = filterProtectedPathListContent(ctx.cwd, resultContent, readProtectedPaths, basePath, event.toolName);
      if (filtered.changed) {
        resultContent = filtered.content;
        resultDetails = isPlainRecord(resultDetails)
          ? { ...resultDetails, protectedPathsRedacted: filtered.redactedLines }
          : { protectedPathsRedacted: filtered.redactedLines };
        resultChanged = true;
      }
    }

    const recovery = buildEditRecoveryContext({
      cwd: ctx.cwd,
      targetPath: resultTarget,
      reasonCode: toolFailureReasonCode,
      protectedPaths: readProtectedPaths
    });
    if (recovery) {
      if (editRecoveryDelivery.reserve(ctx, taskIdentity?.taskRunId ?? "", recovery.key)) {
        editRecovery = recovery;
        const injectedChars = recovery.text.length;
        const injectedEstimatedTokens = estimateContextTokens(recovery.text);
        const recoveryDetails = {
          schemaVersion: 1,
          targetPath: dependencies.redactText(recovery.targetPath),
          contentHash: recovery.contentHash,
          originalChars: recovery.originalChars,
          injectedChars,
          injectedEstimatedTokens,
          sensitiveContentRedacted: recovery.redacted
        };
        resultDetails = isPlainRecord(resultDetails)
          ? { ...resultDetails, piagentEditRecovery: recoveryDetails }
          : { ...(resultDetails === undefined ? {} : { value: resultDetails }), piagentEditRecovery: recoveryDetails };
        resultChanged = true;
        dependencies.telemetry(ctx, {
          event: "edit_recovery_context",
          toolCallId: resultToolCallId,
          taskRunId: taskIdentity?.taskRunId,
          targetPath: dependencies.redactText(recovery.targetPath),
          contentHash: recovery.contentHash,
          originalChars: recovery.originalChars,
          injectedChars,
          injectedEstimatedTokens,
          sensitiveContentRedacted: recovery.redacted
        });
      }
    }

    const safeContent = redactToolResultTextContent(resultContent);
    const safeDetails = redactForStorage(resultDetails);
    const sensitiveValuesRedacted = safeContent.redacted + countChangedStringLeaves(resultDetails, safeDetails);
    if (sensitiveValuesRedacted > 0) {
      resultContent = safeContent.content;
      resultDetails = isPlainRecord(safeDetails) ? { ...safeDetails, sensitiveValuesRedacted } : safeDetails;
      resultChanged = true;
    }

    const fingerprint = toolResultFingerprint(event.toolName, event.input, resultContent);
    const previousFingerprint = dependencies.state.previousToolResult(ctx, fingerprint.key);
    const repeated = previousFingerprint?.outputHash === fingerprint.outputHash;
    dependencies.state.rememberToolResult(ctx, fingerprint.key, {
      outputHash: fingerprint.outputHash,
      recordedAt: dependencies.now()
    });
    if (repeated && ["read", "grep", "find", "ls", "subagent"].includes(event.toolName) && fingerprint.outputChars > 0) {
      resultContent = [{
        type: "text",
        text: `[Piagent delta: unchanged ${event.toolName} result; ${fingerprint.outputChars} chars / ${fingerprint.outputLines} lines match the previous identical call.]`
      }];
      const delta = {
        unchanged: true,
        previousRecordedAt: previousFingerprint?.recordedAt,
        outputHash: fingerprint.outputHash,
        originalChars: fingerprint.outputChars,
        originalLines: fingerprint.outputLines
      };
      resultDetails = isPlainRecord(resultDetails)
        ? { ...resultDetails, piagentDelta: delta }
        : { value: resultDetails, piagentDelta: delta };
      resultChanged = true;
    }

    const captureCache = new Map<string, ToolResultCaptureSummary>();
    const compactedContent = compactToolResultTextContent(ctx.cwd, event, ctx, resultContent, captureCache);
    const compactionCaptures = [...compactedContent.captures];
    if (compactedContent.captures.length > 0) {
      resultContent = compactedContent.content;
      resultChanged = true;
    }
    if (resultDetails !== undefined) {
      const compactedDetails = compactToolResultDetails(ctx.cwd, event, ctx, resultDetails, captureCache, compactionCaptures);
      if (compactionCaptures.length > compactedContent.captures.length) {
        resultDetails = compactedDetails;
        resultChanged = true;
      }
    }
    if (compactionCaptures.length > 0) {
      resultDetails = attachToolResultCompactionDetails(resultDetails, compactionCaptures);
    }
    // Compact the original error independently, then append the already bounded
    // and sanitized recovery snapshot. Otherwise a small but line-dense file can
    // be compacted into a preview and cease to be a complete one-shot recovery.
    if (editRecovery) {
      resultContent = appendToolResultText(resultContent, editRecovery.text);
      resultChanged = true;
    }

    const resultFingerprintId = event.toolCallId ?? fingerprint.key;
    const record = dependencies.activity ?? dependencies.telemetry;
    const changedPaths = [...new Set([...directMutationResult.changedPaths, ...shellChangedPaths])]
      .filter((filePath) => !matchesProtectedPath(filePath, readProtectedPaths))
      .map((filePath) => dependencies.redactText(filePath))
      .sort();
    const lineStats = patchLineStats(event.details);
    const editRecoveryFailure = ["edit-anchor-not-unique", "edit-anchor-stale"].includes(String(toolFailureReasonCode));
    record(ctx, {
      activityId: `result:${resultFingerprintId}`,
      event: "tool_result",
      recordedAt: dependencies.now(),
      toolCallId: resultFingerprintId,
      toolName: event.toolName,
      targetPath: resultTarget ? dependencies.redactText(resultTarget) : undefined,
      changedPaths: changedPaths.length > 0 ? changedPaths : undefined,
      inputHash: fingerprint.inputHash,
      outputHash: fingerprint.outputHash,
      outputChars: fingerprint.outputChars,
      outputLines: fingerprint.outputLines,
      repeated,
      compacted: compactionCaptures.length > 0,
      compactedCaptures: compactionCaptures.length,
      sensitiveValuesRedacted,
      isError: effectiveToolError,
      reasonCode: failureReasonCode,
      // An explicit false is evidence too: it proves that every classified
      // edit-anchor failure passed through the recovery policy even when the
      // target was too large, private, protected, or otherwise ineligible.
      editRecoveryContext: editRecoveryFailure ? Boolean(editRecovery) : undefined,
      editRecoveryInjectedChars: editRecovery?.text.length,
      editRecoveryEstimatedTokens: editRecovery ? estimateContextTokens(editRecovery.text) : undefined,
      exitCode: observed?.exitCode ?? (dependencies.isShellTool(event.toolName) ? event.isError ? 1 : 0 : undefined),
      exitCodeExact: observed?.exitCode !== undefined,
      ...lineStats,
      usage: event.usage
    });

    if (resultChanged) {
      return resultDetails === undefined
        ? { content: resultContent }
        : { content: resultContent, details: resultDetails };
    }
  });
}
