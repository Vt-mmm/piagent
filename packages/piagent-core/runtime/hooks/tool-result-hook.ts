import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { estimateContextTokens, toolResultFingerprint } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { changedSnapshotFiles, taskDeltaFilesFromSnapshot } from "../../extensions/task-contract-view.js";
import { classifyVerificationFailure } from "../../extensions/verification-intelligence.js";
import { redactForStorage, redactSensitiveText } from "../../extensions/redaction-core.js";
import { appendObservedBashResult, hashEvidenceCommand, observedBashResultFromToolResultEvent } from "../../extensions/runtime-evidence.js";
import { workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../extensions/task-state.js";
import { workingTreeObservation } from "../../extensions/working-tree-digest.js";
import { recordObservedContextEvidence } from "../context/context-evidence-qualification.ts";
import { confirmContextDeliveryFromToolResult, type ContextDeliveryConfirmationDependencies } from "../context/context-delivery.ts";
import { recordMutationResult } from "../inspection/mutation-provenance-recorder.ts";
import { classifyToolFailure } from "../inspection/tool-failure-classification.ts";
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
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function numericExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

function successfulToolResult(event: ToolResultEvent): boolean {
  if (event.isError === true) return false;
  const details = isPlainRecord(event.details) ? event.details : {};
  const exitCode = numericExitCode(details.exitCode ?? details.status);
  return exitCode === undefined || exitCode === 0;
}

function boundedToolResultText(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
          .map((block) => String((block as { text?: unknown }).text ?? ""))
          .join("\n")
      : "";
  return text.slice(-20_000);
}

function countChangedStringLeaves(before: unknown, after: unknown): number {
  if (typeof before === "string" && typeof after === "string") return before === after ? 0 : 1;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.reduce((total, item, index) => total + countChangedStringLeaves(item, after[index]), 0);
  }
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return 0;
  return Object.entries(before as Record<string, unknown>).reduce(
    (total, [key, value]) => total + countChangedStringLeaves(value, (after as Record<string, unknown>)[key]),
    0
  );
}

function redactToolResultTextContent(content: unknown): { content: unknown; redacted: number } {
  if (!Array.isArray(content)) return { content, redacted: 0 };
  let redacted = 0;
  const safeContent = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") return block;
    const safeText = redactSensitiveText(typed.text);
    if (!safeText.redacted) return block;
    redacted += 1;
    return { ...block, text: safeText.text };
  });
  return { content: safeContent, redacted };
}

function appendToolResultText(content: unknown, text: string): unknown[] {
  const block = { type: "text", text };
  if (Array.isArray(content)) return [...content, block];
  if (typeof content === "string" && content) return [{ type: "text", text: content }, block];
  return [block];
}

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
    const failureReasonCode = classifyToolFailure(event.toolName, event.isError === true, event.content, event.input);
    const performanceReviewOutputText = boundedPerformanceReviewResultText(event.content);
    const observedExitCode = observed?.exitCode
      ?? numericExitCode(isPlainRecord(event.details) ? event.details.exitCode ?? event.details.status : undefined)
      ?? (event.isError === true ? 1 : 0);
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
    const resultTarget = dependencies.extractLikelyPath(ctx.cwd, isPlainRecord(event.input) ? event.input : {});
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
      reasonCode: failureReasonCode,
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
    if (repeated && ["read", "grep", "find", "ls"].includes(event.toolName) && fingerprint.outputChars > 0) {
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
    const editRecoveryFailure = ["edit-anchor-not-unique", "edit-anchor-stale"].includes(String(failureReasonCode));
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
      isError: event.isError,
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
