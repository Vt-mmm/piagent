import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exactFinalOutputGuidance } from "../quality/exact-output-contract.ts";
import { taskPerformanceAssurance } from "../quality/performance-assurance.ts";
import { automaticTaskSummary, boundedRuntimeIntakeMessage } from "../workflows/task-intake.ts";
import { WORKING_TREE_DIGEST_ALGORITHM } from "../../extensions/working-tree-digest.js";
import { createEnvironmentBoundTaskAuthority } from "../policy/task-authority-runtime.ts";
import { authorityReplacementState } from "../policy/authority-resume-policy.ts";
import { compileCriterionGraph, criterionGraphContextSelection, criterionGraphGuidance, criterionGraphMode } from "../../extensions/criterion-graph.js";
import { captureTaskStartBaseline } from "../inspection/task-baseline-start-capture.ts";
type ExtensionContext = any; type TaskContract = any; type TaskStartParameters = any;
function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}
function satisfiesAuthorityReplacement(task: TaskContract, state: ReturnType<typeof authorityReplacementState>): boolean {
  if (!task.authoritySnapshot) return false;
  if (state.reason === "mechanical-rollback-requested") {
    return task.authoritySnapshot.profile === "mechanical-only";
  }
  if (state.reason === "capability-kill-switch-requested") {
    return state.killedCapabilities.length > 0 && state.killedCapabilities.every((capabilityId) => (
      task.authoritySnapshot.capabilities.some((entry: any) => entry.id === capabilityId && entry.authority === "off")
    ));
  }
  return true;
}
export function registerTaskStartTool(pi: ExtensionAPI, deps: Record<string, any>): any {
  const {
    DEFAULT_MAX_TASK_ATTEMPTS, ORCHESTRATION_ROLES, REVIEW_LENSES, StringEnum, Type,
    activateToolGroups, activeSessionTask, activeTaskToolGroups, appendSessionTrace, appendTrace,
    applyRuntimeLifecycleObservation, automaticAcceptanceCriteria, automaticReadOnlyTaskScope, automaticReviewLenses, automaticTaskIntakeMode, automaticTaskMutationPolicy, automaticTaskRiskLane, automaticTaskScope,
    acceptanceBaselineGuidance, acceptanceProofGuidance, bindSessionTask, buildAcceptanceReceipt, compactTaskDetails, contextBudgetConfig, createTaskRunId,
    currentSessionName, defaultWorkPlan, effectiveProtectedPaths, hasGitEvidenceRoot, hasOperatorSessionName,
    loadProfileFromContext, matchesProtectedPath, normalizeReviewLenses, normalizeWorkPlanSteps, nowIso, policy,
    priorTaskAttempts, recordTaskStartCheckpoint, redactText, redactTextArray, registerRuntimeTool,
    repositoryFileManifest, resolveOrchestrationPolicy, resolveTaskScopePatterns, runtimeLifecycleMode, runtimeState, safeTaskId, selectVerificationPlan,
    summarizeAttempt, telemetry, validTaskScopePattern, validateNewWorkPlan, verifierCommandInstructions, workingTreeEvidenceDigest, workingTreeSnapshot, workingTreeSnapshotHasUnavailableEvidence,
    writeTask
  } = deps;
  const taskStartTool = {
    name: "piagent_task_start",
    label: "Piagent Task Start",
    description: "Create a Task Implementation Contract before governed project inspection, command execution, or source changes.",
    promptSnippet: "Start a governed project task and persist the task contract.",
    promptGuidelines: [
      "Call this exactly once before source edits in a project managed by Pi Agent Platform.",
      "Use source-change for project verifier execution or edits. For an assessment, report, or plan with no source changes, set mutationPolicy=forbidden; use read-only when no project verifier needs to execute.",
      "Do not call context, status, policy, evidence-recording, trace, or gate tools first; runtime hooks provide those checks automatically.",
      "Use tiny for a bounded low-risk change, normal for ordinary multi-file work, and high-risk for security, data, release, migration, or external-impact work.",
      "Every scope entry must be a project-relative path or glob such as src/file.ts, src/**, or test/**; never put prose in scope.",
      "Leave workPlan unset for ordinary tiny/normal tasks so runtime automation stays active; pass a custom workPlan only when the operator explicitly requests custom subagent or checkpoint orchestration.",
      "Tiny tasks use automatic lifecycle evidence; normal tasks retain one explicit review step; high-risk/custom plans keep manual checkpoints."
    ],
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ minLength: 1 })),
      summary: Type.String({ minLength: 10 }),
      riskLane: StringEnum(["tiny", "normal", "high-risk"] as const),
      changeMode: Type.Optional(StringEnum(["source-change", "read-only"] as const, {
        description: "Use source-change for project verifier execution or edits; use read-only for bounded inspection."
      })),
      mutationPolicy: Type.Optional(StringEnum(["required", "forbidden"] as const, { description: "Required demands a final diff; forbidden allows exact verification, rejects source mutation, and requires a zero task delta." })),
      maxAttempts: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
      expectedOutput: Type.String({ minLength: 10 }),
      acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 12 }),
      scope: Type.Array(Type.String({
        minLength: 1,
        description: "Project-relative path or glob only (for example src/file.ts, src/**, or test/**); do not use prose."
      }), { minItems: 1 }),
      outOfScope: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      reviewLenses: Type.Optional(Type.Array(StringEnum(REVIEW_LENSES))),
      workPlan: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        title: Type.String({ minLength: 1 }),
        role: Type.Optional(StringEnum(ORCHESTRATION_ROLES)),
        mode: Type.Optional(StringEnum(["read-only", "single-writer", "review"] as const)),
        status: Type.Optional(StringEnum(["pending", "in-progress", "done", "skipped", "failed"] as const)),
        dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        note: Type.Optional(Type.String())
      })))
    }),
    async execute(
      _toolCallId: string,
      params: TaskStartParameters,
      _signal: AbortSignal | undefined,
      _onUpdate: ((update: unknown) => void) | undefined,
      ctx: ExtensionContext
    ) {
      const profile = loadProfileFromContext(ctx);
      const createdAt = nowIso();
      const safeSummary = redactText(params.summary);
      const taskId = safeTaskId(redactText(params.taskId ?? params.summary));
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionName = currentSessionName(ctx);
      const active = activeSessionTask(ctx.cwd, sessionId) as TaskContract | undefined;
      const activeAuthorityReplacement = active ? authorityReplacementState(ctx.cwd, active) : undefined;
      if (activeAuthorityReplacement && !activeAuthorityReplacement.enforcementSafe) {
        return {
          content: [{ type: "text", text: `Task start refused: persisted authority resume state is unsafe (${activeAuthorityReplacement.reason ?? "unknown"}). Inspect the handoff and journal before starting another attempt.` }],
          details: activeAuthorityReplacement,
          isError: true
        };
      }
      const migrationRetry = active?.taskId === taskId
        && active?.workingTreeDigestMigration?.status === "new-attempt-required";
      const authorityRetry = active?.taskId === taskId && activeAuthorityReplacement?.required === true;
      if (active?.trace.outcome === "pending" && !migrationRetry && !authorityRetry) {
        if (active.taskId === taskId) {
          const manifest = repositoryFileManifest(ctx.cwd);
          const currentScopeResolution = resolveTaskScopePatterns(active.scope, manifest);
          const proposedScopeResolution = Array.isArray(params.scope)
            ? resolveTaskScopePatterns(params.scope, manifest)
            : { scope: [], mappings: [], ambiguous: [], unmatched: [] };
          const expectedScope = [...currentScopeResolution.scope].sort();
          const proposedScope = [...proposedScopeResolution.scope].sort();
          const pristine = (active.observedChangedFiles?.length ?? 0) === 0
            && (active.changedFiles?.length ?? 0) === 0
            && (active.verifyEvidence?.length ?? 0) === 0
            && sameStringRecord(active.baselineFileDigests ?? {}, workingTreeSnapshot(ctx.cwd));
          const canonicalRefinement = currentScopeResolution.mappings.length > 0
            && currentScopeResolution.ambiguous.length === 0
            && proposedScopeResolution.ambiguous.length === 0
            && currentScopeResolution.unmatched.length === 0
            && proposedScopeResolution.unmatched.length === 0
            && expectedScope.length === proposedScope.length
            && expectedScope.every((entry, index) => entry === proposedScope[index]);
          if (pristine && canonicalRefinement) {
            const previousScope = [...active.scope];
            active.scope = redactTextArray(currentScopeResolution.scope); active.criterionGraph = compileCriterionGraph({ acceptanceCriteria: active.acceptanceCriteria, scope: active.scope, verifyCommands: active.verifyCommands, changeMode: active.changeMode, mode: active.criterionGraph?.mode ?? "mechanical", createdAt: active.criterionGraph?.createdAt ?? active.createdAt });
            active.updatedAt = createdAt;
            const refined = writeTask(ctx.cwd, active);
            bindSessionTask(ctx.cwd, sessionId, sessionName, refined);
            runtimeState.cacheTaskIdentity(ctx, refined);
            const refinement = currentScopeResolution.mappings.map((item) => `${item.from} -> ${item.to}`);
            appendTrace(ctx.cwd, { taskId, taskRunId: refined.taskRunId, sessionId, sessionName, attempt: refined.attempt, event: "task_scope_refined", previousScope, scope: refined.scope, refinement });
            appendSessionTrace(pi, { taskId, taskRunId: refined.taskRunId, sessionId, sessionName, attempt: refined.attempt, event: "task_scope_refined", previousScope, scope: refined.scope, refinement });
            return {
              content: [{ type: "text", text: `Task ${active.taskId} kept the same run id and refined its pre-mutation scope: ${refinement.join("; ")}.` }],
              details: compactTaskDetails(refined)
            };
          }
          return {
            content: [{ type: "text", text: `Task already active in this session: ${active.taskId} (${active.taskRunId}). Reusing it instead of overwriting state.` }],
            details: compactTaskDetails(active)
          };
        }
        return {
          content: [{ type: "text", text: `Session already has pending task ${active.taskId} (${active.taskRunId}). Complete or stop it before starting another task in this conversation.` }],
          details: active,
          isError: true
        };
      }
      const invalidScope = params.scope.find((entry) => !validTaskScopePattern(entry));
      if (invalidScope) {
        return {
          content: [{
            type: "text",
            text: `Task start refused: scope entries must be project-relative paths or globs; invalid entry ${JSON.stringify(invalidScope)}. Use values such as src/file.ts, src/**, or test/**.`
          }],
          isError: true
        };
      }
      const scopeResolution = resolveTaskScopePatterns(params.scope, repositoryFileManifest(ctx.cwd));
      if (scopeResolution.ambiguous.length > 0) {
        const details = scopeResolution.ambiguous
          .map((item) => `${item.input}: ${item.candidates.join(", ")}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Task start refused: scope is ambiguous (${details}). Use one exact project-relative candidate for each ambiguous entry.` }],
          details: scopeResolution,
          isError: true
        };
      }
      if (scopeResolution.unmatched.length > 0) {
        return {
          content: [{ type: "text", text: `Task start refused: scope entries do not identify an existing repository path (${scopeResolution.unmatched.join(", ")}). Use an exact project-relative path for a new file, such as src/name.ts, instead of a basename or guessed top-level alias.` }],
          details: scopeResolution,
          isError: true
        };
      }
      const resolvedScope = scopeResolution.scope;
      const priorAttempts = priorTaskAttempts(ctx.cwd, taskId) as TaskContract[];
      const authorityStates = new Map(priorAttempts.map((task) => [task.taskRunId, authorityReplacementState(ctx.cwd, task)]));
      const unsafeAuthorityState = [...authorityStates.entries()].find(([, state]) => !state.enforcementSafe);
      if (unsafeAuthorityState) {
        return {
          content: [{ type: "text", text: `Task start refused: prior authority resume state for ${unsafeAuthorityState[0]} is unsafe (${unsafeAuthorityState[1].reason ?? "unknown"}).` }],
          details: unsafeAuthorityState[1],
          isError: true
        };
      }
      const pendingElsewhere = priorAttempts.find((task) => task.trace.outcome === "pending"
        && task.sessionId !== sessionId
        && authorityStates.get(task.taskRunId)?.required !== true);
      if (pendingElsewhere) {
        return {
          content: [{ type: "text", text: `Task ${taskId} is already active in session ${pendingElsewhere.sessionName ?? pendingElsewhere.sessionId} (${pendingElsewhere.taskRunId}).` }],
          details: pendingElsewhere,
          isError: true
        };
      }
      const latestCompleted = priorAttempts.find((task) => task.trace.outcome === "completed");
      if (latestCompleted) {
        return {
          content: [{ type: "text", text: `Task ${taskId} already completed as ${latestCompleted.taskRunId}. Use a distinct taskId for new work instead of replacing its evidence.` }],
          details: latestCompleted,
          isError: true
        };
      }
      const migrationBlocked = priorAttempts.find((task) => task.workingTreeDigestMigration?.status === "new-attempt-required");
      const migrationAlreadyReplaced = migrationBlocked && priorAttempts.some((task) => (
        task.taskRunId !== migrationBlocked.taskRunId
        && task.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM
        && Date.parse(task.createdAt) >= Date.parse(migrationBlocked.workingTreeDigestMigration.recordedAt)
      ));
      const migrationReplacement = migrationBlocked && !migrationAlreadyReplaced;
      const authorityBlocked = priorAttempts.find((task) => authorityStates.get(task.taskRunId)?.required === true);
      const authorityBlockedState = authorityBlocked ? authorityStates.get(authorityBlocked.taskRunId) : undefined;
      const authorityAlreadyReplaced = authorityBlocked && priorAttempts.some((task) => (
        task.taskRunId !== authorityBlocked.taskRunId
        && task.authoritySnapshot !== undefined
        && Date.parse(task.createdAt) >= Date.parse(authorityBlockedState?.recordedAt ?? "")
        && authorityBlockedState !== undefined
        && satisfiesAuthorityReplacement(task, authorityBlockedState)
      ));
      const authorityReplacement = authorityBlocked && !authorityAlreadyReplaced;
      const replacementTask = migrationReplacement ? migrationBlocked : authorityReplacement ? authorityBlocked : undefined;
      const attempt = replacementTask
        ? replacementTask.attempt
        : priorAttempts.reduce((maximum, task) => Math.max(maximum, task.attempt ?? 1), 0) + 1;
      const firstAttempt = priorAttempts.find((task) => task.attempt === 1)
        ?? [...priorAttempts].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
      const maxAttempts = firstAttempt
        ? firstAttempt.maxAttempts
        : Number.isInteger(params.maxAttempts)
          ? Math.max(1, Math.min(10, params.maxAttempts))
          : DEFAULT_MAX_TASK_ATTEMPTS;
      if (attempt > maxAttempts) {
        return {
          content: [{ type: "text", text: `Task ${taskId} reached its retry limit (${attempt - 1}/${maxAttempts}). Report the blocker or ask the operator to create a new scoped task.` }],
          details: { taskId, attempt, maxAttempts, previousAttempts: priorAttempts.map(summarizeAttempt) },
          isError: true
        };
      }
      const orchestration = resolveOrchestrationPolicy(profile, policy);
      const changeMode = params.changeMode === "read-only" ? "read-only" : "source-change";
      const mutationPolicy = changeMode === "read-only" || params.mutationPolicy === "forbidden" ? "forbidden" : "required";
      if (changeMode === "read-only" && params.mutationPolicy === "required") return { content: [{ type: "text", text: "Task start refused: read-only tasks cannot require source mutation." }], isError: true };
      if (changeMode === "source-change" && !hasGitEvidenceRoot(ctx.cwd)) {
        return {
          content: [{ type: "text", text: "Task start refused: source-change tasks require a Git working tree, or a workspace parent with direct child Git repositories, so changed-file evidence cannot silently disappear. Initialize Git, open the parent that contains the repos, or use read-only mode." }],
          isError: true
        };
      }
      const verifyPlan = selectVerificationPlan(profile, params.verifyGroup, changeMode, ctx.cwd, resolvedScope);
      if (verifyPlan.error) {
        return {
          content: [{ type: "text", text: `Task start refused: ${verifyPlan.error}` }],
          details: { verifyGroup: verifyPlan.group, verifyCommands: verifyPlan.commands },
          isError: true
        };
      }
      const reviewLenses = normalizeReviewLenses(params.reviewLenses, orchestration.defaultReviewLenses);
      const providedWorkPlan = normalizeWorkPlanSteps(params.workPlan);
      const defaultPlanLane = params.intakeMode === "runtime" && params.riskLane === "normal" ? "tiny" : params.riskLane;
      const workPlan = providedWorkPlan.length ? providedWorkPlan : defaultWorkPlan(safeSummary, defaultPlanLane, changeMode, mutationPolicy);
      const workPlanError = validateNewWorkPlan(workPlan);
      if (workPlanError) {
        return { content: [{ type: "text", text: `Task start refused: ${workPlanError}.` }], details: workPlan, isError: true };
      }
      const firstReady = workPlan.find((step) => (step.dependsOn ?? []).length === 0);
      if (!firstReady) {
        return { content: [{ type: "text", text: "Task start refused: work plan has no dependency-ready first step." }], details: workPlan, isError: true };
      }
      firstReady.status = "in-progress";
      firstReady.updatedAt = createdAt;
      const taskRunId = createTaskRunId(taskId, sessionId, createdAt);
      const baselineFileDigests = workingTreeSnapshot(ctx.cwd) as Record<string, string>;
      if (changeMode === "source-change" && workingTreeSnapshotHasUnavailableEvidence(baselineFileDigests)) {
        return { content: [{ type: "text", text: "Task start refused: the baseline contains unavailable working-tree content evidence. Restore readable repository files before starting source changes." }], isError: true };
      }
      if (changeMode === "source-change") {
        const protectedPaths = effectiveProtectedPaths(policy, profile).readProtectedPaths;
        try {
          await captureTaskStartBaseline({ projectRoot: ctx.cwd, taskId, taskRunId, sessionId, capturedAt: createdAt,
            baselineTreeDigest: workingTreeEvidenceDigest(baselineFileDigests), protectedPaths, matchesProtectedPath });
        } catch {
          return { content: [{ type: "text", text: "Task start refused: the private Task Baseline Manifest could not be captured safely. Inspect local-state permissions and retry before editing." }], isError: true };
        }
      }
      const acceptance = buildAcceptanceReceipt({
        summary: safeSummary,
        expectedOutput: redactText(params.expectedOutput),
        acceptanceCriteria: redactTextArray(params.acceptanceCriteria),
        changeMode,
        source: params.intakeMode === "runtime" ? "runtime" : "model",
        generatedAt: createdAt
      });
      const criterionGraph = compileCriterionGraph({ acceptanceCriteria: acceptance.acceptanceCriteria, scope: resolvedScope,
        verifyCommands: verifyPlan.commands, changeMode, mode: criterionGraphMode(), createdAt });
      const maxManifestFiles = contextBudgetConfig(policy).maxManifestFiles, plannedContext = criterionGraphContextSelection(criterionGraph, repositoryFileManifest(ctx.cwd), [], maxManifestFiles), observedContext = criterionGraphContextSelection(undefined, [], runtimeState.preTaskContext(ctx), maxManifestFiles);
      const task: TaskContract = {
        schemaVersion: 2,
        taskRunId,
        taskId,
        sessionId,
        sessionName,
        changeMode,
        mutationPolicy,
        attempt,
        maxAttempts,
        previousAttempts: priorAttempts.filter((task) => task.trace.outcome !== "pending").slice(0, 10).reverse().map(summarizeAttempt),
        summary: safeSummary,
        riskLane: params.riskLane,
        intakeMode: params.intakeMode === "runtime" ? "runtime" : "model",
        expectedOutput: redactText(params.expectedOutput),
        acceptanceCriteria: acceptance.acceptanceCriteria,
        criterionGraph,
        scope: redactTextArray(resolvedScope),
        outOfScope: redactTextArray(params.outOfScope),
        protectedPaths: profile.protectedPaths ?? [],
        requiredContext: profile.requiredContext ?? [],
        contextManifest: observedContext,
        memoryCitations: [],
        mcpCapabilities: profile.mcpCapabilities ?? [],
        verifyGroup: verifyPlan.group,
        verifyCommands: verifyPlan.commands,
        workPlan,
        reviewLenses,
        acceptanceReceipt: acceptance.receipt as TaskContract["acceptanceReceipt"],
        authoritySnapshot: createEnvironmentBoundTaskAuthority({ taskId, taskRunId, createdAt, profile: profile.authorityProfile }),
        workingTreeDigestAlgorithm: WORKING_TREE_DIGEST_ALGORITHM,
        orchestration: {
          mode: orchestration.defaultMode,
          subagents: "not-used",
          reason: "Task starts in solo-first mode; use bounded subagents only for independent scout, planning, or review work.",
          fieldGuidePath: orchestration.fieldGuide.enabled ? orchestration.fieldGuide.path : undefined,
          modelRoles: orchestration.roleModelGuidance
        },
        baselineChangedFiles: Object.keys(baselineFileDigests).sort(),
        baselineFileDigests,
        observedChangedFiles: [],
        finalWorkingTreeFiles: [],
        finalFileDigests: {},
        changedFiles: [],
        verifyEvidence: [],
        trace: { outcome: "pending" },
        createdAt,
        updatedAt: createdAt
      };
      if (mutationPolicy === "forbidden" && observedContext.length > 0) {
        applyRuntimeLifecycleObservation(task, "context-complete", createdAt);
      }
      const written = writeTask(ctx.cwd, task);
      runtimeState.promotePreTaskContext(ctx, written.taskRunId, observedContext);
      const baselineGuidance = changeMode === "source-change" && mutationPolicy === "required"
        ? acceptanceBaselineGuidance(written, { cwd: ctx.cwd })
        : [];
      const exactOutputGuidance = mutationPolicy === "forbidden"
        ? exactFinalOutputGuidance(written.summary)
        : [];
      bindSessionTask(ctx.cwd, sessionId, sessionName, written);
      runtimeState.cacheTaskIdentity(ctx, written);
      if (written.intakeMode !== "runtime") {
        // Intake classification defines the cache-stable surface for this agent turn.
        // A model may choose a narrower lane than the prompt classifier; never remove
        // schemas mid-turn, but add recovery tools when the chosen lane requires them.
        activateToolGroups(ctx, activeTaskToolGroups(written), true);
      }
      const lifecycleMode = runtimeLifecycleMode(written);
      const scopeMappings = scopeResolution.mappings.map((item) => `${item.from} -> ${item.to}`);
      appendTrace(ctx.cwd, { taskId, taskRunId, sessionId, sessionName, attempt, event: "task_start", turnId: runtimeState.currentTurn(ctx)?.turnId, summary: task.summary, riskLane: params.riskLane, intakeMode: task.intakeMode, changeMode: task.changeMode, mutationPolicy: task.mutationPolicy, lifecycleMode, criterionGraphMode: written.criterionGraph.mode, criterionGraphDigest: written.criterionGraph.graphDigest, authorityProfile: written.authoritySnapshot.profile, authoritySnapshotDigest: written.authoritySnapshot.snapshotDigest, scopeMappings, plannedContext: plannedContext.map((item) => item.path), observedContext: observedContext.map((item) => item.path) });
      appendSessionTrace(pi, { taskId, taskRunId, sessionId, sessionName, attempt, event: "task_start", turnId: runtimeState.currentTurn(ctx)?.turnId, summary: task.summary, riskLane: params.riskLane, intakeMode: task.intakeMode, changeMode: task.changeMode, mutationPolicy: task.mutationPolicy, lifecycleMode, criterionGraphMode: written.criterionGraph.mode, criterionGraphDigest: written.criterionGraph.graphDigest, authorityProfile: written.authoritySnapshot.profile, authoritySnapshotDigest: written.authoritySnapshot.snapshotDigest, scopeMappings, plannedContext: plannedContext.map((item) => item.path), observedContext: observedContext.map((item) => item.path) });
      telemetry(ctx, { event: "turn_task_bound", turnId: runtimeState.currentTurn(ctx)?.turnId, taskRunId });
      recordTaskStartCheckpoint(ctx, written, firstReady.id, lifecycleMode);
      return {
        content: [{
          type: "text",
          text: [
            `Task ${taskId} started (${params.riskLane}, ${lifecycleMode}; attempt ${attempt}/${maxAttempts}).`,
            ...(scopeMappings.length > 0 ? [`Canonical scope: ${scopeMappings.join("; ")}.`] : []),
            written.verifyCommands.length > 0
              ? ["Exact verifier commands:", ...verifierCommandInstructions(written.verifyCommands)].join("\n")
              : "Verify: none (read-only).",
            written.acceptanceCriteria.length > 0
              ? ["Acceptance focus:", ...written.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`)].join("\n")
              : "Acceptance focus: not recorded.",
            ...(criterionGraphGuidance(written.criterionGraph).length > 0
              ? [["Execution map (planning only; verifier remains authoritative):", ...criterionGraphGuidance(written.criterionGraph).map((line: string) => `- ${line}`)].join("\n")]
              : []),
            ...exactOutputGuidance,
            ...(changeMode === "source-change" && mutationPolicy === "required" && acceptanceProofGuidance(written).length > 0
              ? [["Critical behavioral proof:", ...acceptanceProofGuidance(written).map((item: string) => `- ${item}`), "Map every proof item above to a live focused assertion or explicit test matrix before the verifier; happy-path coverage and prose claims are insufficient."].join("\n")]
              : []),
            ...(baselineGuidance.length > 0
              ? [["Existing public contract:", ...baselineGuidance.map((item: string) => `- ${item}`)].join("\n")]
              : []),
            lifecycleMode === "automatic-readonly"
              ? "Runtime records targeted reads and final completion automatically. Stay read-only and report cited evidence."
              : lifecycleMode === "assisted-readonly"
                ? "Runtime records read-only evidence automatically; complete only the explicit evidence-review step before handoff."
                : mutationPolicy === "forbidden" ? "Runtime permits bounded inspection and exact configured verifier commands only. Source mutation is blocked, and completion requires a zero task delta."
                : lifecycleMode === "automatic"
              ? "Runtime will record reads, changes, exact verifier results, and final completion automatically. Continue with ordinary read/edit/bash work."
                  : lifecycleMode === "assisted"
                    ? `Runtime records objective evidence automatically; after verification, complete only step \`review\` with piagent_task_progress using taskId \`${written.taskId}\` and stepId \`review\`.`
                    : "Use the active progress/recovery tools for the custom or high-risk checkpoints."
          ].join("\n")
        }],
        details: compactTaskDetails(written)
      };
    }
  };
  registerRuntimeTool(pi, taskStartTool);
  async function maybeStartAutomaticTask(prompt: string, ctx: ExtensionContext): Promise<{ started: boolean; text: string; task?: TaskContract; plannedContext?: Array<{ path: string; reason: string }> } | undefined> {
    const profile = loadProfileFromContext(ctx);
    const readProtectedPaths = effectiveProtectedPaths(policy, profile).readProtectedPaths;
    const intakeMode = automaticTaskIntakeMode(prompt, readProtectedPaths);
    if (!intakeMode) return undefined;
    const mutationPolicy = automaticTaskMutationPolicy(prompt, intakeMode), active = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
    if (active?.trace.outcome === "pending") return undefined;
    const summary = redactText(automaticTaskSummary(prompt));
    const sessionName = currentSessionName(ctx);
    const projectFiles = repositoryFileManifest(ctx.cwd);
    const scope = intakeMode === "read-only"
      ? automaticReadOnlyTaskScope(prompt, runtimeState.preTaskContext(ctx))
      : automaticTaskScope(prompt, runtimeState.preTaskContext(ctx), projectFiles);
    const started = await taskStartTool.execute(
      `runtime-intake-${ctx.sessionManager.getSessionId()}`,
      {
        taskId: active && active.trace.outcome !== "pending" ? summary : hasOperatorSessionName(sessionName) ? sessionName : summary,
        summary,
        riskLane: automaticTaskRiskLane(prompt),
        intakeMode: "runtime",
        changeMode: intakeMode,
        mutationPolicy,
        expectedOutput: mutationPolicy === "forbidden" ? "The requested read-only investigation is answered from observed project evidence without mutating files."
          : "The requested bounded change is implemented and passes the configured verification.",
        acceptanceCriteria: automaticAcceptanceCriteria(prompt, mutationPolicy === "forbidden" ? "read-only" : intakeMode),
        scope,
        outOfScope: ["Unrelated files and behavior outside the operator request."],
        reviewLenses: automaticReviewLenses(prompt)
      },
      undefined,
      undefined,
      ctx
    );
    if (started.isError) {
      activateToolGroups(ctx, ["intake"], true);
      const reason = started.content?.[0]?.text ?? "runtime intake could not create a task contract";
      return {
        started: false,
        text: `Piagent runtime intake paused: ${reason}\nUse piagent_task_start once with explicit project-relative scope before mutation.`
      };
    }
    const task = activeSessionTask(ctx.cwd, ctx.sessionManager.getSessionId()) as TaskContract | undefined;
    if (!task) {
      activateToolGroups(ctx, ["intake"], true);
      return {
        started: false,
        text: "Piagent runtime intake did not persist a task contract. Use piagent_task_start once before mutation."
      };
    }
    const assurance = taskPerformanceAssurance(task);
    const plannedContext = criterionGraphContextSelection(task.criterionGraph, projectFiles, [], contextBudgetConfig(policy).maxManifestFiles);
    const baselineGuidance = task.changeMode === "source-change" && task.mutationPolicy !== "forbidden"
      ? acceptanceBaselineGuidance(task, { cwd: ctx.cwd })
      : [];
    const exactOutputGuidance = task.changeMode === "read-only" || task.mutationPolicy === "forbidden" ? exactFinalOutputGuidance(task.summary) : [];
    return {
      started: true,
      task,
      plannedContext,
      text: boundedRuntimeIntakeMessage([
        `Piagent runtime task: ${task.taskId}; scope: ${task.scope.join(", ")}.`,
        "The complete operator request above is the authoritative acceptance contract; runtime keeps its full criteria, so do not restate or re-scout it.",
        `Assurance: ${assurance.tier} (${assurance.reasonCodes.join(", ") || "bounded-runtime"}).`,
        ...(task.changeMode === "source-change" && task.mutationPolicy !== "forbidden" && acceptanceProofGuidance(task).length > 0
          ? [["Critical behavioral proof:", ...acceptanceProofGuidance(task).map((item: string) => `- ${item}`), "Map every proof item above to a live focused assertion or explicit test matrix before the verifier; happy-path coverage is insufficient."].join("\n")]
          : []),
        ...(baselineGuidance.length > 0
          ? [["Existing public contract:", ...baselineGuidance.map((item: string) => `- ${item}`)].join("\n")]
          : []),
        ...exactOutputGuidance,
        "Exact verifier commands:",
        ...(task.verifyCommands.length > 0 ? verifierCommandInstructions(task.verifyCommands) : ["none"]),
        ...(criterionGraphGuidance(task.criterionGraph).length > 0 ? [["Execution map (planning only):", ...criterionGraphGuidance(task.criterionGraph).map((line: string) => `- ${line}`)].join("\n")] : []),
        "Root project instructions are loaded. Do not re-read root AGENTS.md or inspect Piagent/platform files; work directly in relevant source/tests with ordinary tools.",
        task.changeMode === "read-only" || task.mutationPolicy === "forbidden"
          ? task.changeMode === "source-change" ? "Stay mutation-free. Runtime permits bounded inspection and the exact configured verifier, records completion evidence, and requires a zero task delta."
            : "Stay read-only. Runtime records targeted reads and completion evidence; do not call task-management tools."
          : task.criterionGraph?.mode === "criterion-graph"
            ? "Follow the execution map: batch context reads by target, implement dependency-ready criteria, then run the exact verifier once; rerun only after a later mutation. The map plans work but never overrides the operator request or verifier."
            : "Before mutating, privately map every operator criterion to implementation and focused-test coverage; batch independent reads or writes. Finish intended edits and one criterion-by-criterion self-review, then run the exact verifier once; rerun only after a later mutation. Runtime records evidence and completion; do not call task-management tools."
      ].join("\n"))
    };
  }
  return maybeStartAutomaticTask;
}
