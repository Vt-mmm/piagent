import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { durableContextEvidenceEntries, isRuntimeOwnedContextEvidenceEntry } from "../../extensions/context-evidence.js";
import { mergeObservedTaskContext } from "../../extensions/task-contract-view.js";
import { buildHandoffProjection, writeHandoffProjection } from "../recovery/handoff-projection.ts";
import { buildCompletionReceiptView } from "../product/operator-projections.ts";
import { semanticRepairProvenance } from "../recovery/semantic-repair-handshake.ts";
import { taskAuthorityDecision } from "../policy/task-authority-runtime.ts";
import { readTrajectoryStore } from "../trajectory/trajectory-store.ts";

type TaskContract = any;


export function registerTaskCompletionTools(pi: ExtensionAPI, deps: Record<string, any>): void {
  const {
    StringEnum, Type, allVerifyCommandsPassCurrentTree, appendSessionTrace, appendTrace,
    applyAcceptanceRecoveryProvenance, applyRuntimeLifecycleObservation, bashResults, candidateFileBudget, classifyVerificationFailure, commandMatchesVerifyPlan,
    compactTaskDetails, contextBudgetConfig, evaluateTaskGate, findMatchingObservedBashResult, loadProfileFromContext,
    normalizeRelative, nowIso, observedBashLedgerPath, policy, readObservedBashResults,
    readTask, recordCompletionAudit, recordVerificationCheckpoint, redactForStorage, redactText, runtimeState,
    refreshAcceptanceReceipt, registerPiagentTool, resolveRuntimePolicy, runtimeLifecycleMode, semanticRepairCompletionBlock, taskChangedFileEvidence,
    uniqueStrings, verifierCommandInstructions, workingTreeEvidenceDigest, workingTreeSnapshot, writeTask
  } = deps;
  registerPiagentTool(pi, {
    name: "piagent_context_record",
    label: "Piagent Context Record",
    description: "Record context files read for a governed task.",
    promptSnippet: "Record required context files that were read for the task.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      files: Type.Array(Type.Object({
        path: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 })
      }), { minItems: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const runtime = resolveRuntimePolicy(profile);
      const budget = contextBudgetConfig(policy);
      const task = readTask(ctx.cwd, params.taskId, ctx.sessionManager.getSessionId());
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${params.taskId}` }], isError: true };
      }
      if (task.trace.outcome !== "pending") {
        return { content: [{ type: "text", text: `Task ${task.taskId} is immutable after ${task.trace.outcome}; context evidence was not changed.` }], details: task, isError: true };
      }
      const activeIdentity = runtimeState.taskIdentity(ctx);
      if (!activeIdentity || activeIdentity.taskId !== task.taskId || activeIdentity.taskRunId !== task.taskRunId) {
        return {
          content: [{ type: "text", text: `Context evidence rejected for ${task.taskId}: the active runtime task identity does not match this session task.` }],
          details: { reasonCode: "context-evidence-task-identity-mismatch" },
          isError: true
        };
      }
      const observedPaths = new Set(runtimeState.observedContext(ctx)
        .map((entry: { path: string }) => normalizeRelative(ctx.cwd, entry.path))
        .filter((filePath: string | undefined): filePath is string => Boolean(filePath)));
      const qualifiedByPath = new Map<string, { path: string; reason: string }>();
      for (const entry of runtimeState.qualifiedContextEvidence(ctx, task.taskRunId)) {
        const filePath = normalizeRelative(ctx.cwd, entry.path);
        if (filePath && isRuntimeOwnedContextEvidenceEntry(entry)) qualifiedByPath.set(filePath, entry);
      }
      const qualifiedFiles = new Map<string, { path: string; reason: string }>();
      const unprovenPaths: string[] = [];
      for (const file of params.files) {
        const filePath = normalizeRelative(ctx.cwd, file.path);
        const evidence = filePath ? qualifiedByPath.get(filePath) : undefined;
        if (!filePath || !observedPaths.has(filePath) || !evidence) {
          unprovenPaths.push(redactText(file.path));
          continue;
        }
        qualifiedFiles.set(filePath, { path: filePath, reason: evidence.reason });
      }
      if (unprovenPaths.length > 0) {
        return {
          content: [{ type: "text", text: `Context evidence rejected for ${task.taskId}: no runtime-observed read or host-confirmed delivery exists in this task/session for ${unprovenPaths.join(", ")}. Read the exact file successfully in this task or rely on automatic delivery confirmation.` }],
          details: { reasonCode: "context-evidence-unproven", paths: unprovenPaths },
          isError: true
        };
      }
      const safeFiles = [...qualifiedFiles.values()];
      const evidencePaths = new Set(durableContextEvidenceEntries(task).map((item) => item.path));
      const projectedManifestFiles = evidencePaths.size + new Set(safeFiles.map((item) => item.path).filter((filePath) => !evidencePaths.has(filePath))).size;
      if (runtime.contextBudget !== "off" && projectedManifestFiles > budget.maxManifestFiles) {
        return {
          content: [{ type: "text", text: `Context manifest budget exceeded: ${projectedManifestFiles} files > ${budget.maxManifestFiles}` }],
          isError: true
        };
      }
      const fileBudget = safeFiles.map((file) => candidateFileBudget(ctx.cwd, file.path, budget));
      const overLimit = fileBudget.filter((item) => item.overLimit);
      if (runtime.contextBudget === "enforce" && overLimit.length > 0) {
        return {
          content: [{ type: "text", text: `Context file budget exceeded: ${overLimit.map((item) => `${item.path}=${item.chars}`).join(", ")}` }],
          details: { budget, fileBudget },
          isError: true
        };
      }
      mergeObservedTaskContext(task, safeFiles, budget.maxManifestFiles, (value) => value);
      const lifecycle = task.changeMode === "read-only" || task.mutationPolicy === "forbidden"
        ? applyRuntimeLifecycleObservation(task, "context-complete", nowIso())
        : { changed: false, mode: runtimeLifecycleMode(task) };
      const written = writeTask(ctx.cwd, task);
      appendTrace(ctx.cwd, { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId, event: "context_record", files: safeFiles, lifecycleMode: lifecycle.mode, lifecycleAdvanced: lifecycle.changed });
      appendSessionTrace(pi, { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId, event: "context_record", files: safeFiles, lifecycleMode: lifecycle.mode, lifecycleAdvanced: lifecycle.changed });

      return {
        content: [{ type: "text", text: `Context recorded for ${task.taskId}: ${safeFiles.length} runtime-qualified file(s)` }],
        details: compactTaskDetails(written)
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_verify_record",
    label: "Piagent Verify Record",
    description: "Record verification command evidence for a governed task.",
    promptSnippet: "Record actual verify command result before final.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      command: Type.String({ minLength: 1 }),
      exitCode: Type.Number(),
      summary: Type.String({ minLength: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = readTask(ctx.cwd, params.taskId, ctx.sessionManager.getSessionId());
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${params.taskId}` }], isError: true };
      }
      if (task.trace.outcome !== "pending") {
        return { content: [{ type: "text", text: `Task ${task.taskId} is immutable after ${task.trace.outcome}; verify evidence was not changed.` }], details: task, isError: true };
      }

      const observedEntries = [
        ...readObservedBashResults(observedBashLedgerPath(ctx.cwd), { maxEntries: 10000, projectRoot: ctx.cwd }),
        ...bashResults.list()
      ];
      const observed = findMatchingObservedBashResult(observedEntries, {
        cwd: ctx.cwd,
        command: params.command,
        notBefore: task.createdAt,
        exitCode: params.exitCode
      });
      if (!observed.ok) {
        return {
          content: [{ type: "text", text: `Verify evidence rejected: ${observed.reason}` }],
          details: redactForStorage(observed),
          isError: true
        };
      }

      const safeCommand = redactText(params.command);
      const safeSummary = redactText(params.summary);
      const matchedProfileCommand = commandMatchesVerifyPlan(params.command, task.verifyCommands);
      const currentDigests = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
      const workingTreeDigest = workingTreeEvidenceDigest(currentDigests);
      const duplicate = task.verifyEvidence.some((evidence) => (
        evidence.command.trim() === safeCommand.trim()
        && evidence.exitCode === params.exitCode
        && evidence.workingTreeDigest === workingTreeDigest
        && evidence.observedAt === observed.entry.recordedAt
      ));
      if (!duplicate) {
        task.verifyEvidence.push({
          command: safeCommand,
          exitCode: params.exitCode,
          summary: safeSummary,
          recordedAt: nowIso(),
          observed: true,
          observedAt: observed.entry.recordedAt,
          isError: observed.entry.isError,
          matchedProfileCommand,
          workingTreeDigest
        });
        task.verifyEvidence = task.verifyEvidence.slice(-100);
      }
      const hasChanges = taskChangedFileEvidence(ctx.cwd, task, currentDigests).expected.length > 0;
      const allPassing = matchedProfileCommand && hasChanges && allVerifyCommandsPassCurrentTree(task, workingTreeDigest);
      if (matchedProfileCommand && hasChanges) {
        applyRuntimeLifecycleObservation(task, allPassing ? "verification-complete" : "verification-pending", nowIso());
      }
      const acceptance = refreshAcceptanceReceipt(task, {
        cwd: ctx.cwd,
        changedFiles: taskChangedFileEvidence(ctx.cwd, task, currentDigests).expected,
        currentWorkingTreeDigest: workingTreeDigest
      });
      task.acceptanceReceipt = acceptance.task.acceptanceReceipt;
      const written = writeTask(ctx.cwd, task);
      appendTrace(ctx.cwd, { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId, event: "verify_record", command: safeCommand, exitCode: params.exitCode, observedAt: observed.entry.recordedAt, matchedProfileCommand, workingTreeDigest, duplicate });
      appendSessionTrace(pi, { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId, event: "verify_record", command: safeCommand, exitCode: params.exitCode, observedAt: observed.entry.recordedAt, matchedProfileCommand, workingTreeDigest, duplicate });
      const classification = classifyVerificationFailure(params.summary, params.exitCode);
      recordVerificationCheckpoint(ctx, written, {
        commandHash: observed.entry.commandHash,
        observedAt: observed.entry.recordedAt,
        workingTreeDigest,
        exitCode: params.exitCode,
        evidence: {
          command: safeCommand,
          exitCode: params.exitCode,
          category: classification.category,
          retryable: classification.retryable,
          failureClassification: classification,
          workingTreeDigest
        }
      });

      const advisorySuffix = matchedProfileCommand ? "" : " Advisory only: command does not exactly match task verifyCommands and will not satisfy the passing final gate.";
      return {
        content: [{ type: "text", text: `Verify evidence recorded for ${task.taskId}: observed exit ${params.exitCode}.${advisorySuffix}` }],
        details: {
          task: compactTaskDetails(written),
          evidence: {
            command: safeCommand,
            exitCode: params.exitCode,
            observed: true,
            matchedProfileCommand,
            workingTreeDigest
          },
          duplicate
        }
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_memory_citation_record",
    label: "Piagent Memory Citation Record",
    description: "Record memory files used as advisory context for a governed task.",
    promptSnippet: "Record memory citations when project memory materially influenced planning or implementation.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      files: Type.Array(Type.Object({
        path: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 })
      }), { minItems: 1 })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = readTask(ctx.cwd, params.taskId, ctx.sessionManager.getSessionId());
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${params.taskId}` }], isError: true };
      }
      if (task.trace.outcome !== "pending") {
        return { content: [{ type: "text", text: `Task ${task.taskId} is immutable after ${task.trace.outcome}; memory evidence was not changed.` }], details: task, isError: true };
      }

      const safeFiles = params.files.map((file) => ({
        path: file.path,
        reason: redactText(file.reason)
      }));
      const seen = new Set(task.memoryCitations.map((item) => `${item.path}\u0000${item.reason}`));
      for (const file of safeFiles) {
        const key = `${file.path}\u0000${file.reason}`;
        if (!seen.has(key)) task.memoryCitations.push(file);
      }
      writeTask(ctx.cwd, task);
      appendTrace(ctx.cwd, { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId, event: "memory_citation_record", files: safeFiles });
      appendSessionTrace(pi, { taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId, event: "memory_citation_record", files: safeFiles });

      return {
        content: [{ type: "text", text: `Memory citations recorded for ${task.taskId}: ${params.files.length} file(s)` }],
        details: task
      };
    }
  });

  registerPiagentTool(pi, {
    name: "piagent_trace_record",
    label: "Piagent Trace Record",
    description: "Record final task trace and handoff evidence.",
    promptSnippet: "Record final trace before claiming task completion.",
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      outcome: StringEnum(["completed", "blocked", "partial", "failed"] as const),
      changedFiles: Type.Optional(Type.Array(Type.String())),
      friction: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      failedAt: Type.Optional(StringEnum(["research", "plan", "execute", "verify", "review"] as const)),
      ruledOut: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const profile = loadProfileFromContext(ctx);
      const runtime = resolveRuntimePolicy(profile);
      const task = readTask(ctx.cwd, params.taskId, ctx.sessionManager.getSessionId());
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${params.taskId}` }], isError: true };
      }
      if (task.trace.outcome !== "pending") {
        return { content: [{ type: "text", text: `Task ${task.taskId} is immutable after ${task.trace.outcome}; its final trace was not replaced.` }], details: task, isError: true };
      }
      if (params.outcome !== "completed" && !params.friction?.trim() && !task.failureReason?.trim()) {
        return { content: [{ type: "text", text: `Trace ${params.outcome} requires a concrete friction/reason so the next attempt does not repeat the same work.` }], details: task, isError: true };
      }
      if (params.outcome === "failed" && !params.failedAt && !task.failedAt) {
        return { content: [{ type: "text", text: "A failed trace requires failedAt to identify the lifecycle phase." }], details: task, isError: true };
      }

      const rawChangedFiles = params.changedFiles ?? task.changedFiles;
      const normalizedChangedFiles = rawChangedFiles.map((file) => normalizeRelative(ctx.cwd, file));
      if (normalizedChangedFiles.some((file) => !file || file === "." || file === ".." || file.startsWith("../") || file.startsWith(".pi/piagent-state/"))) {
        return {
          content: [{ type: "text", text: "Trace refused: changedFiles must be project-relative paths outside .pi/piagent-state/." }],
          isError: true
        };
      }
      const finalFileDigests = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
      let nextTask: TaskContract = {
        ...task,
        changedFiles: uniqueStrings(normalizedChangedFiles as string[]).sort(),
        finalWorkingTreeFiles: Object.keys(finalFileDigests).sort(),
        finalFileDigests,
        failedAt: params.outcome === "completed" ? undefined : params.failedAt ?? task.failedAt,
        failureReason: params.outcome === "completed" ? undefined : params.friction ? redactText(params.friction) : task.failureReason,
        ruledOut: params.outcome === "completed" ? undefined : params.ruledOut ? redactText(params.ruledOut).slice(0, 1000) : task.ruledOut,
        trace: {
          outcome: params.outcome,
          friction: params.friction ? redactText(params.friction) : undefined,
          notes: params.notes ? redactText(params.notes) : undefined,
          recordedAt: nowIso()
        }
      };
      nextTask = refreshAcceptanceReceipt(nextTask, {
        cwd: ctx.cwd,
        changedFiles: nextTask.changedFiles,
        currentWorkingTreeDigest: workingTreeEvidenceDigest(finalFileDigests)
      }).task as TaskContract;
      let gate = evaluateTaskGate(ctx.cwd, nextTask, policy, {
        currentDigests: finalFileDigests,
        currentWorkingTreeDigest: workingTreeEvidenceDigest(finalFileDigests)
      });
      const semanticBlock = taskAuthorityDecision(nextTask, "CAP-13", "block").allowed ? semanticRepairCompletionBlock?.(ctx.cwd, nextTask.taskRunId) : undefined;
      if (semanticBlock) gate = { ...gate, decision: "fail", missing: [...new Set([...gate.missing, semanticBlock])] };
      if (params.outcome === "completed" && (semanticBlock || (runtime.finalGate === "enforce" && gate.decision === "fail"))) {
        const blockedTrace = {
          taskId: nextTask.taskId,
          taskRunId: nextTask.taskRunId,
          sessionId: nextTask.sessionId,
          event: "completion_gate_blocked",
          missing: gate.missing,
          changedFiles: nextTask.changedFiles
        };
        appendTrace(ctx.cwd, blockedTrace);
        appendSessionTrace(pi, blockedTrace);
        recordCompletionAudit(ctx, nextTask, {
          outcome: "blocked",
          evidence: { missing: gate.missing, missingVerifyCommands: gate.missingVerifyCommands }
        });
        try {
          writeHandoffProjection(ctx.cwd, buildHandoffProjection(ctx.cwd, nextTask, {
            gate,
            currentDigests: finalFileDigests,
            recovery: null
          }));
        } catch (error) {
          ctx.ui.notify(`Piagent handoff projection could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return {
          content: [{
            type: "text",
            text: [
              `Final gate blocked completion: missing ${gate.missing.join(", ")}`,
              ...verifierCommandInstructions(gate.missingVerifyCommands)
            ].join("\n")
          }],
          details: { gate, task: nextTask },
          isError: true
        };
      }

      let handoffPreview: any;
      try {
        handoffPreview = buildHandoffProjection(ctx.cwd, nextTask, {
          gate,
          currentDigests: finalFileDigests,
          recovery: null
        });
      } catch {
        // A corrupt optional projection cannot rewrite acceptance truth or block
        // an otherwise valid terminal Task Contract record.
      }
      nextTask = applyAcceptanceRecoveryProvenance(nextTask, {
        outcome: params.outcome,
        gateDecision: gate.decision,
        recoveryHistory: runtimeState.recoveryHistory(nextTask.taskId),
        trajectoryTransitions: readTrajectoryStore(ctx.cwd, nextTask.taskRunId).events,
        semanticRepair: semanticRepairProvenance(ctx.cwd, nextTask.taskRunId),
        failureClassification: handoffPreview?.failure.classification,
        recoveryDecision: handoffPreview?.failure.recovery,
        handoffRef: `.pi/piagent-state/handoffs/${nextTask.taskRunId}.json`
      }) as TaskContract;
      const written = writeTask(ctx.cwd, nextTask);
      const trace = {
        taskId: nextTask.taskId,
        taskRunId: nextTask.taskRunId,
        sessionId: nextTask.sessionId,
        event: "trace_record",
        outcome: params.outcome,
        changedFiles: nextTask.changedFiles,
        friction: nextTask.trace.friction,
        notes: nextTask.trace.notes,
        failedAt: nextTask.failedAt,
        ruledOut: nextTask.ruledOut
      };
      appendTrace(ctx.cwd, trace);
      appendSessionTrace(pi, trace);
      recordCompletionAudit(ctx, written, {
        outcome: params.outcome,
        phase: params.failedAt ?? "review",
        evidence: {
          outcome: params.outcome,
          changedFiles: written.changedFiles,
          failedAt: written.failedAt,
          ruledOut: written.ruledOut
        }
      });
      try {
        writeHandoffProjection(ctx.cwd, buildHandoffProjection(ctx.cwd, written, {
          gate,
          currentDigests: finalFileDigests,
          recovery: null
        }));
      } catch (error) {
        ctx.ui.notify(`Piagent handoff projection could not be written: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }

      return {
        content: [{ type: "text", text: `Trace recorded for ${nextTask.taskId}: ${params.outcome}${gate.decision === "fail" ? ` (gate warning: missing ${gate.missing.join(", ")})` : ""}` }],
        details: { task: written, gate, completionReceipt: buildCompletionReceiptView(written, { cwd: ctx.cwd, gate }) }
      };
    }
  });

}
