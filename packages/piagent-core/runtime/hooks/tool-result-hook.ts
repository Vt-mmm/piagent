import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toolResultFingerprint } from "../../extensions/context-engine.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { changedSnapshotFiles, taskDeltaFilesFromSnapshot } from "../../extensions/task-contract-view.js";
import { classifyVerificationFailure } from "../../extensions/verification-intelligence.js";
import { redactForStorage, redactSensitiveText } from "../../extensions/redaction-core.js";
import { appendObservedBashResult, hashEvidenceCommand, observedBashResultFromToolResultEvent } from "../../extensions/runtime-evidence.js";
import { workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence } from "../../extensions/task-state.js";
import { workingTreeObservation } from "../../extensions/working-tree-digest.js";
import { recordMutationResult } from "../inspection/mutation-provenance-recorder.ts";
import { boundedGitDiffReview } from "../quality/performance-assurance.ts";
import { currentFileContentDigests } from "../quality/model-mutation-proof.ts";
import { boundedPerformanceReviewResultText } from "../quality/performance-review-evidence.ts";
import { attachToolResultCompactionDetails, compactToolResultDetails, compactToolResultTextContent, type ToolResultCaptureSummary } from "../session/tool-result-compaction.ts";
import { RuntimeSessionState, type ObservedTaskContext } from "../session/runtime-state.ts";
import { observeTrajectorySync } from "../trajectory/trajectory-observability.ts";
import type { TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import { patchLineStats } from "./tool-result-metadata.ts";

type ToolResultEvent = { toolCallId?: string; toolName: string; input?: unknown; content?: unknown; details?: unknown; isError?: boolean; usage?: unknown };
type ObservedBashResult = NonNullable<ReturnType<typeof observedBashResultFromToolResultEvent>>;
type ObservedVerificationResult = ObservedBashResult & { outputText?: string };
type WorkingTreeObservation = ReturnType<typeof workingTreeObservation>;

type ToolResultHookDependencies = {
  state: RuntimeSessionState;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  maxManifestFiles: number;
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
      changedPaths: string[];
      retryableFailure: boolean; correctiveFailure: boolean;
    }
  ) => TrajectorySyncResult | undefined;
  syncTrajectory?: (ctx: ExtensionContext, contextObserved: boolean) => TrajectorySyncResult | undefined;
};

function normalizeRelative(cwd: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return undefined;
  let raw = candidate.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    if (!raw.toLowerCase().startsWith("file://")) return undefined;
    try {
      raw = fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

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

function filterTextBlocks(
  content: unknown,
  blocked: (line: string) => boolean,
  emptyText: string,
  noticeText: (count: number) => string
): { changed: boolean; content?: unknown; redactedLines: number } {
  if (!Array.isArray(content)) return { changed: false, redactedLines: 0 };
  let changed = false;
  let redactedLines = 0;
  const filtered = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if ((block as { type?: unknown }).type !== "text" || typeof text !== "string") return block;
    const kept: string[] = [];
    let blockRedactedLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (blocked(line)) {
        changed = true;
        redactedLines += 1;
        blockRedactedLines += 1;
      } else {
        kept.push(line);
      }
    }
    if (blockRedactedLines === 0) return block;
    const notice = noticeText(blockRedactedLines);
    const nextText = kept.join("\n").trim().length > 0
      ? `${kept.join("\n")}\n${notice}`
      : `${emptyText}\n${notice}`;
    return { ...block, text: nextText };
  });
  return { changed, content: filtered, redactedLines };
}

export function filterGrepProtectedContent(content: unknown, protectedPatterns: string[]) {
  return filterTextBlocks(
    content,
    (line) => {
      const linePath = line.match(/^(.+?)(?::\d+:|-\d+-)/)?.[1];
      return Boolean(linePath && matchesProtectedPath(linePath, protectedPatterns));
    },
    "No matches found in non-protected paths.",
    (count) => `[Piagent Pi guard redacted ${count} protected grep line${count === 1 ? "" : "s"}.]`
  );
}

export function filterProtectedPathListContent(
  cwd: string,
  content: unknown,
  protectedPatterns: string[],
  basePath: string,
  toolName: string
) {
  return filterTextBlocks(
    content,
    (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("No ") || trimmed === "(empty directory)") return false;
      const entry = trimmed.replace(/[\\/]+$/, "");
      const candidates = new Set<string>();
      const direct = normalizeRelative(cwd, entry);
      const underBase = normalizeRelative(cwd, path.posix.join(basePath || ".", entry));
      if (direct !== undefined) candidates.add(direct);
      if (underBase !== undefined) candidates.add(underBase);
      return [...candidates].some((candidate) => matchesProtectedPath(candidate, protectedPatterns));
    },
    "No entries found in non-protected paths.",
    (count) => `[Piagent Pi guard redacted ${count} protected ${toolName} line${count === 1 ? "" : "s"}.]`
  );
}

export function registerToolResultHook(pi: ExtensionAPI, dependencies: ToolResultHookDependencies): void {
  pi.on("tool_result", async (event, ctx) => {
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
    if (observedContextEntry) dependencies.state.rememberObservedContext(ctx, observedContextEntry);
    const pendingContext = dependencies.state.observedContext(ctx);
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

    const resultFingerprintId = event.toolCallId ?? fingerprint.key;
    const record = dependencies.activity ?? dependencies.telemetry;
    const resultTarget = dependencies.extractLikelyPath(ctx.cwd, isPlainRecord(event.input) ? event.input : {});
    const lineStats = patchLineStats(event.details);
    record(ctx, {
      activityId: `result:${resultFingerprintId}`,
      event: "tool_result",
      recordedAt: dependencies.now(),
      toolCallId: resultFingerprintId,
      toolName: event.toolName,
      targetPath: resultTarget ? dependencies.redactText(resultTarget) : undefined,
      inputHash: fingerprint.inputHash,
      outputHash: fingerprint.outputHash,
      outputChars: fingerprint.outputChars,
      outputLines: fingerprint.outputLines,
      repeated,
      compacted: compactionCaptures.length > 0,
      compactedCaptures: compactionCaptures.length,
      sensitiveValuesRedacted,
      isError: event.isError,
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
