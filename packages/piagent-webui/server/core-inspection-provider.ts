import { randomBytes } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";
import { ReadModelNotFound, type SourceView, type StreamEvent, type WebUiReadModelProvider } from "./read-model-provider.ts";
import { projectTranscript } from "./transcript-projection.ts";

const CORE_ROOT = "../../piagent-core";

type RuntimeEvent = { eventCursor: string; [key: string]: unknown };
type EventReplay = {
  state: "current" | "truncated" | "resync-required";
  events: RuntimeEvent[];
  nextCursor: string;
  latestCursor: string;
  reasonCode: string | null;
};
type EventStore = {
  retention(): unknown;
  currentCursor(): string | null;
  resyncRequired(): boolean;
  replay(after: string | null, limit: number): EventReplay;
};

async function loadCoreInspection() {
  const [{ collectFileDiff }, { buildWebUiInspectionProjection }, { matchesProtectedPath }, reviewProjection, reviewStore, mutationProjection, revertProjection, openProjection, commitSummaryProjection, taskIndexProjection, taskTimelineProjection, recoveryHistoryProjection, handoffHistoryProjection, subagentTreeProjection, releaseMonitorProjection, documentWorkspaceProjection] = await Promise.all([
    import(`${CORE_ROOT}/runtime/inspection/diff-projection.ts`),
    import(`${CORE_ROOT}/runtime/inspection/webui-snapshot.ts`),
    import(`${CORE_ROOT}/extensions/policy-core.js`),
    import(`${CORE_ROOT}/runtime/inspection/review-state-projection.ts`),
    import(`${CORE_ROOT}/runtime/inspection/review-state-store.ts`),
    import(`${CORE_ROOT}/runtime/inspection/source-mutation-projection.ts`),
    import(`${CORE_ROOT}/runtime/inspection/source-revert-projection.ts`),
    import(`${CORE_ROOT}/runtime/inspection/source-open-target.ts`),
    import(`${CORE_ROOT}/runtime/inspection/commit-summary-projection.ts`),
    import(`${CORE_ROOT}/runtime/inspection/task-run-index.ts`),
    import(`${CORE_ROOT}/runtime/inspection/task-recovery-timeline.ts`),
    import(`${CORE_ROOT}/runtime/inspection/task-compaction-history.ts`),
    import(`${CORE_ROOT}/runtime/inspection/task-handoff-history.ts`),
    import(`${CORE_ROOT}/runtime/inspection/task-subagent-tree.ts`),
    import("./benchmark-release-monitor.ts"),
    import(`${CORE_ROOT}/runtime/inspection/document-workspace-projection.ts`)
  ]);
  return { collectFileDiff, buildWebUiInspectionProjection, matchesProtectedPath, ...reviewProjection, ...reviewStore, ...mutationProjection, ...revertProjection, ...openProjection, ...commitSummaryProjection, ...taskIndexProjection, ...taskTimelineProjection, ...recoveryHistoryProjection, ...handoffHistoryProjection, ...subagentTreeProjection, ...releaseMonitorProjection, ...documentWorkspaceProjection };
}

export type CoreInspectionInput = {
  cwd: string;
  sessionId: string;
  runtimeInstanceId: string;
  eventStore: EventStore;
  task?: () => unknown;
  activityEvents?: () => unknown[];
  currentActivity?: () => unknown[];
  sessionEntries?: () => unknown[];
  protectedPaths?: () => string[];
  // Extra directories the operator granted through the profile. The document
  // workspace lists them beside the project; without them it shows the project
  // only, which is the same answer a host with no grants gives.
  documentReadRoots?: () => unknown;
  contextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model?: () => { provider?: unknown; id?: unknown; name?: unknown; reasoning?: unknown; input?: unknown; thinkingLevelMap?: unknown; contextWindow?: unknown; maxTokens?: unknown } | undefined;
  thinkingLevel?: () => unknown;
  queueProjection?: () => unknown;
  modelCatalog?: () => unknown;
  attachmentCapability?: () => { kinds: Array<"file" | "image" | "document">; mimeTypes: string[] };
  approvalProjection?: () => { revision: string | null; summary: Record<string, unknown> };
  approvalDetail?: (approvalRef: string) => unknown | null;
  sourceMutationGuardAvailable?: () => boolean;
  sourceOpenAvailable?: () => boolean;
  lifecycleControl?: () => { state: "active" | "pause-requested" | "paused" | "terminal" | "unknown"; controlRevision: string | null;
    dispatchBlocked: boolean; currentPhase: string; pauseEpoch: number; actions: { stop: boolean; pause: boolean; resume: boolean } };
  chatControl?: () => { state: "unbound" | "ready" | "replacement-pending" | "shutdown"; liveness: "idle" | "running" | "unknown";
    taskState: "none" | "active" | "pause-requested" | "paused" | "terminal" | "unknown"; identity: Record<string, any> | null; revisions: Record<string, any> | null;
    heldCount: number; queueRevision: string | null };
};

export class CoreInspectionProvider implements WebUiReadModelProvider {
  readonly #input: CoreInspectionInput;
  readonly #listeners = new Set<(event: StreamEvent) => void>();
  #cachedProjection: { at: number; value: any } | null = null;
  #invalidationEpoch = 0;
  readonly #diffCache = new Map<string, { at: number; value: unknown }>();
  #documentCache: { at: number; value: unknown } | null = null;
  readonly #sourceRevertConfirmationKey = randomBytes(32);

  constructor(input: CoreInspectionInput) { this.#input = input; }

  invalidate(): void {
    this.#invalidationEpoch += 1;
    this.#cachedProjection = null;
    this.#diffCache.clear();
    this.#documentCache = null;
  }

  async #projection() {
    if (this.#cachedProjection && Date.now() - this.#cachedProjection.at <= 200) return this.#cachedProjection.value;
    const projectionEpoch = this.#invalidationEpoch;
    const { buildWebUiInspectionProjection } = await loadCoreInspection();
    const retention = this.#input.eventStore.retention();
    const value = await buildWebUiInspectionProjection({
      cwd: this.#input.cwd, sessionId: this.#input.sessionId, runtimeInstanceId: this.#input.runtimeInstanceId,
      task: this.#input.task?.(), events: this.#input.activityEvents?.() ?? [], current: this.#input.currentActivity?.() ?? [],
      sessionEntries: this.#input.sessionEntries?.() ?? [], protectedPaths: this.#input.protectedPaths?.() ?? [],
      contextUsage: this.#input.contextUsage?.(), model: this.#input.model?.(), thinkingLevel: this.#input.thinkingLevel?.(),
      eventCursor: this.#input.eventStore.currentCursor(), resyncRequired: this.#input.eventStore.resyncRequired(), eventReplay: retention
    });
    // What the host will accept as an attachment is a property of the machine and
    // the model, not of chat control. The Gateway drives sessions without a chat
    // bridge at all, and a capability published only alongside that bridge left
    // its composer believing no file type was supported.
    if (this.#input.attachmentCapability) {
      const attachment = this.#input.attachmentCapability();
      value.snapshot.capabilities.capabilities.attachments = { status: "available", version: 1, reason: null,
        kinds: attachment.kinds, mimeTypes: attachment.mimeTypes };
      Object.assign(value.snapshot.capabilities.limits, { maxRequestBodyBytes: 11_250_000, maxAttachmentCount: 4,
        maxAttachmentFileBytes: 8_388_608, maxAttachmentTotalBytes: 16_777_216 });
    }
    const control = this.#input.chatControl?.();
    if (control?.state === "ready" && control.identity && control.revisions && !this.#input.eventStore.resyncRequired()) {
      const available = { available: true, reasonCode: null }, disabled = (reasonCode: string) => ({ available: false, reasonCode });
      const lifecycle = this.#input.lifecycleControl?.(), terminal = control.taskState === "terminal";
      const dispatchBlocked = lifecycle?.dispatchBlocked === true && lifecycle.state !== "terminal";
      value.snapshot.identity = structuredClone(control.identity);
      value.snapshot.capabilities.identity = structuredClone(control.identity);
      for (const name of ["runtimeRevision", "taskRevision", "controlRevision", "sessionOptionRevision", "queueRevision"])
        value.snapshot.revision[name] = control.revisions[name];
      value.snapshot.capabilities.mode = "control-enabled";
      value.snapshot.capabilities.capabilities["control.chat"] = {
        status: "available", version: 1, reason: null, queuePersistence: "runtime-lifetime",
        actions: { send: dispatchBlocked ? disabled("task-control-gate-closed") : available, hold: available, editHeld: available,
          deleteHeld: available, dispatchHeld: dispatchBlocked ? disabled("task-control-gate-closed") : available,
          interruptAndSend: dispatchBlocked ? disabled("task-control-gate-closed") : control.liveness === "running" ? available : disabled("agent-not-running") }
      };
      let modelCatalog: any;
      try { modelCatalog = this.#input.modelCatalog?.(); }
      catch { modelCatalog = null; }
      if (modelCatalog?.state === "ready" && modelCatalog.identity?.sessionRef === control.identity.sessionRef
        && modelCatalog.revision?.sessionOptionRevision === control.revisions.sessionOptionRevision) {
        const idle = control.liveness === "idle" && !dispatchBlocked, optionAvailability = idle ? available : disabled(dispatchBlocked ? "task-control-gate-closed" : "agent-not-idle");
        value.snapshot.capabilities.capabilities["control.sessionOptions"] = {
          status: "available", version: 1, reason: null, effectScope: "session-and-user-default",
          allowedLifecyclePoints: ["idle", "pre-fresh-task"], actions: { setModel: optionAvailability, setThinking: optionAvailability }
        };
      }
      value.snapshot.session.operation = { liveness: control.liveness, operationRef: control.identity.agentOperationId,
        hostPhase: control.liveness === "unknown" ? { state: "unknown", value: null, evidence: null, reasonCode: "bridge-liveness-unavailable" }
          : { state: "known", value: control.liveness === "idle" ? "idle" : "other", evidence: "observed", reasonCode: null },
        startedAt: null, settledAt: null, reasonCode: control.liveness === "unknown" ? "bridge-liveness-unavailable" : null };
      value.snapshot.session.queue = { state: "known", hasPending: control.heldCount > 0, heldCount: control.heldCount,
        revision: control.queueRevision ?? control.revisions.queueRevision, reasonCode: null };
      if (lifecycle) {
        value.snapshot.session.controlState = lifecycle.state;
        if (value.snapshot.task) value.snapshot.task.controlState = lifecycle.state;
        value.snapshot.revision.controlRevision = lifecycle.controlRevision ?? control.revisions.controlRevision;
        const phases = ["idle", "input-preflight", "model", "tool-preflight", "waiting-approval", "tool", "retry", "compaction", "branch-summary", "direct-bash", "settling", "other", "unknown"];
        const stopPhaseSupport = Object.fromEntries(phases.map((phase) => [phase, phase === lifecycle.currentPhase && lifecycle.actions.stop
          ? { stop: "supported", reasonCode: null } : { stop: phase === lifecycle.currentPhase ? "unsupported" : "unknown", reasonCode: phase === lifecycle.currentPhase ? "no-current-operation" : "phase-not-observed" }]));
        value.snapshot.capabilities.capabilities["control.lifecycle"] = { status: "available", version: 1, reason: null,
          currentPhase: phases.includes(lifecycle.currentPhase) ? lifecycle.currentPhase : "unknown",
          actions: { pause: lifecycle.actions.pause ? available : disabled(lifecycle.state === "terminal" ? "task-terminal" : `control-state-${lifecycle.state}`),
            resume: lifecycle.actions.resume ? available : disabled(lifecycle.state === "active" ? "already-active" : `control-state-${lifecycle.state}`) }, stopPhaseSupport };
        value.snapshot.capabilities.capabilities["control.resumeAndContinue"] = lifecycle.actions.resume && control.liveness === "idle"
          && Boolean(control.revisions.queueRevision) ? { status: "available", version: 1, reason: null, delivery: "new-operation",
            requires: ["control.lifecycle", "control.chat"] }
          : { status: "unavailable", version: null, reason: { code: lifecycle.actions.resume ? "agent-not-idle" : `control-state-${lifecycle.state}`,
            message: "Resume & Continue requires a paused task and an idle Pi session." } };
      }
      const approval = this.#input.approvalProjection?.();
      if (approval?.revision) {
        value.snapshot.revision.approvalRevision = approval.revision;
        value.snapshot.approvals = structuredClone(approval.summary);
        value.snapshot.session.approvalState = (approval.summary as any).state;
        value.snapshot.capabilities.capabilities.approve = { status: "available", version: 1, reason: null,
          decisions: ["allow", "deny"], arbitration: "first-valid-cas" };
      }
      if (control.identity.taskId && control.identity.taskRunId && control.revisions.taskRevision && value.snapshot.revision.workspaceRevision) {
        const mutationGuardAvailable = this.#input.sourceMutationGuardAvailable?.() === true;
        const chatSend = value.snapshot.capabilities.capabilities["control.chat"]?.status === "available"
          && value.snapshot.capabilities.capabilities["control.chat"].actions.send.available;
        value.snapshot.capabilities.capabilities.reviewActions = { status: "available", version: 1, reason: null, actions: {
          reviewMark: available,
          stage: control.liveness === "idle" && !terminal && mutationGuardAvailable ? available
            : disabled(terminal ? "task-terminal" : control.liveness !== "idle" ? "agent-not-idle" : "mutation-guard-unavailable"),
          unstage: control.liveness === "idle" && !terminal && mutationGuardAvailable ? available
            : disabled(terminal ? "task-terminal" : control.liveness !== "idle" ? "agent-not-idle" : "mutation-guard-unavailable"),
          revert: control.liveness === "idle" && !terminal && mutationGuardAvailable ? available
            : disabled(terminal ? "task-terminal" : control.liveness !== "idle" ? "agent-not-idle" : "mutation-guard-unavailable"),
          openInVsCode: this.#input.sourceOpenAvailable?.() === true ? available : disabled("vscode-cli-unavailable"),
          generateCommitSummaryDeterministic: available,
          generateCommitSummaryModel: chatSend && control.liveness === "idle" && !terminal ? available
            : disabled(terminal ? "task-terminal" : control.liveness !== "idle" ? "agent-not-idle" : "chat-dispatch-unavailable")
        } };
      }
    }
    if (projectionEpoch === this.#invalidationEpoch) this.#cachedProjection = { at: Date.now(), value };
    return value;
  }

  async snapshot(): Promise<unknown> { return (await this.#projection()).snapshot; }
  async sourceChanges(view: SourceView): Promise<unknown> {
    const source = (await this.#projection()).sourceViews;
    return view === "working-tree" ? source.workingTree : source[view];
  }
  // The listing walks the project and every granted root, so it costs real
  // filesystem work — hundreds of milliseconds on a large repository. It also
  // changes only when files change, so a short cache keeps a browser that
  // re-renders from re-walking the disk, without holding a stale view long
  // enough for the operator to notice.
  async documents(): Promise<unknown> {
    const cached = this.#documentCache;
    if (cached && Date.now() - cached.at <= 2_000) return cached.value;
    const core = await loadCoreInspection();
    const value = core.projectDocumentWorkspaceListing(this.#documentWorkspaceInput(core.matchesProtectedPath));
    this.#documentCache = { at: Date.now(), value };
    return value;
  }

  async document(documentRef: string): Promise<unknown> {
    const core = await loadCoreInspection();
    return core.projectDocumentWorkspaceDocument({ ...this.#documentWorkspaceInput(core.matchesProtectedPath), documentRef });
  }

  #documentWorkspaceInput(matchesProtectedPath: (candidate: string, patterns: string[]) => unknown) {
    const protectedPaths = this.#input.protectedPaths?.() ?? [];
    return { cwd: this.#input.cwd, profileRoots: this.#input.documentReadRoots?.(),
      environmentRoots: process.env.PIAGENT_ADDITIONAL_READ_ROOTS,
      isProtectedPath: (candidate: string) => Boolean(matchesProtectedPath(candidate, protectedPaths)) };
  }

  async activity(): Promise<unknown> { return (await this.#projection()).snapshot.activity; }
  async logPreview(activityRef: string): Promise<unknown> {
    const activity = (await this.#projection()).snapshot.activity;
    const item = [...activity.running, ...activity.recent].find((candidate: Record<string, unknown>) => candidate.activityRef === activityRef);
    if (!item) throw new ReadModelNotFound();
    return { activityRef, state: "available", preview: String((item as Record<string, unknown>).preview ?? "").slice(0, 65_536), truncated: false, reasonCode: null };
  }
  async transcript(beforeCursor: string | null, limit: number): Promise<unknown> {
    const snapshot = await this.snapshot() as any;
    return projectTranscript({ identity: { projectRef: snapshot.identity.projectRef, runtimeInstanceId: snapshot.identity.runtimeInstanceId,
      sessionRef: snapshot.identity.sessionRef, taskId: snapshot.identity.taskId, taskRunId: snapshot.identity.taskRunId, agentOperationId: null, toolCallId: null },
      revision: { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
        controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
        indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
        sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision },
      eventCursor: snapshot.revision.eventCursor, entries: this.#input.sessionEntries?.() ?? [], beforeCursor, limit,
      generatedAt: snapshot.generatedAt });
  }
  async queue(): Promise<unknown> {
    if (!this.#input.queueProjection) throw new ReadModelNotFound();
    return this.#input.queueProjection();
  }
  async modelCatalog(): Promise<unknown> {
    if (!this.#input.modelCatalog) throw new ReadModelNotFound();
    return this.#input.modelCatalog();
  }
  async approval(approvalRef: string): Promise<unknown> {
    const value = this.#input.approvalDetail?.(approvalRef); if (!value) throw new ReadModelNotFound(); return value;
  }
  async diff(view: SourceView, fileRef: string): Promise<unknown> {
    const cacheKey = `${view}:${fileRef}`;
    const cached = this.#diffCache.get(cacheKey);
    if (cached && Date.now() - cached.at <= 200) return cached.value;
    const { collectFileDiff, matchesProtectedPath } = await loadCoreInspection();
    const projection = await this.#projection();
    const source = view === "working-tree" ? projection.sourceViews.workingTree : projection.sourceViews[view];
    const file = source?.files.find((candidate: any) => candidate.fileRef === fileRef) as Record<string, any> | undefined;
    if (!source || !file) throw new ReadModelNotFound();
    const identity = projection.snapshot.identity;
    const protectedPaths = this.#input.protectedPaths?.() ?? [];
    const value = await collectFileDiff({
      cwd: this.#input.cwd, identity, sourceView: source, fileRef,
      precondition: { expectedViewRevision: source.viewRevision, expectedFileRevision: file.fileRevision,
        expectedBaseDigest: file.baseDigest ?? null, expectedCurrentDigest: file.currentDigest ?? null },
      taskRevision: projection.snapshot.revision.taskRevision,
      redactLine: (text: string) => redactSensitiveText(text),
      revalidationMode: "selected-file",
      selectedRepoPaths: file.pathDisplay === "exact-safe" ? [file.oldPath, file.path].filter((value: unknown): value is string => typeof value === "string") : undefined,
      isProtectedPath: (_root: string, repoPath: string) => Boolean(matchesProtectedPath(repoPath, protectedPaths))
    });
    this.#diffCache.set(cacheKey, { at: Date.now(), value });
    if (this.#diffCache.size > 128) this.#diffCache.delete(this.#diffCache.keys().next().value as string);
    return value;
  }

  async review(view: SourceView, fileRef: string): Promise<unknown> {
    // Review is authority-bearing evidence. Never reuse the short UI projection
    // cache when deriving its exact Git/task preimage.
    this.invalidate();
    const projection = await this.#projection(), snapshot = projection.snapshot;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    if (!identity.taskId || !identity.taskRunId || !snapshot.revision.taskRevision || !snapshot.revision.workspaceRevision) throw new ReadModelNotFound();
    const diff = await this.diff(view, fileRef) as any;
    const { deriveReviewTarget, projectReviewState, readReviewEvidence } = await loadCoreInspection();
    const target = deriveReviewTarget({ diff, taskId: identity.taskId, taskRunId: identity.taskRunId,
      taskRevision: snapshot.revision.taskRevision, workspaceRevision: snapshot.revision.workspaceRevision,
      indexRevision: snapshot.revision.indexRevision });
    const evidence = readReviewEvidence(this.#input.cwd, identity.taskRunId);
    return projectReviewState({ identity, target, records: evidence.records, corruptions: evidence.corruptions,
      unavailableReason: diff.availability?.reasonCode ?? diff.fallback?.reasonCode ?? "review-target-unavailable" });
  }

  async #sourceMutation(action: "source.stage" | "source.unstage", fileRef: string) {
    this.invalidate();
    const projection = await this.#projection(), snapshot = projection.snapshot;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    if (!identity.taskId || !identity.taskRunId || !snapshot.revision.taskRevision || !snapshot.revision.workspaceRevision || !snapshot.revision.indexRevision)
      throw new ReadModelNotFound();
    const view: SourceView = action === "source.stage" ? "working-tree" : "staged";
    const source = view === "working-tree" ? projection.sourceViews.workingTree : projection.sourceViews.staged;
    if (!source?.files.some((file: any) => file.fileRef === fileRef)) throw new ReadModelNotFound();
    const diff = await this.diff(view, fileRef) as any;
    const { collectSourceMutationPreview, matchesProtectedPath } = await loadCoreInspection();
    const protectedPaths = this.#input.protectedPaths?.() ?? [];
    return collectSourceMutationPreview({ cwd: this.#input.cwd, identity, action, sourceView: source, diff,
      taskRevision: snapshot.revision.taskRevision, workspaceRevision: snapshot.revision.workspaceRevision,
      indexRevision: snapshot.revision.indexRevision,
      guardAvailable: this.#input.sourceMutationGuardAvailable?.() === true,
      isProtectedPath: (_root: string, repoPath: string) => Boolean(matchesProtectedPath(repoPath, protectedPaths)) });
  }

  async sourceMutation(action: "source.stage" | "source.unstage", fileRef: string): Promise<unknown> {
    return (await this.#sourceMutation(action, fileRef)).projection;
  }

  async sourceMutationAuthority(action: "source.stage" | "source.unstage", fileRef: string) {
    return this.#sourceMutation(action, fileRef);
  }

  async #sourceRevert(fileRef: string, hunkRef: string | null) {
    this.invalidate();
    const projection = await this.#projection(), snapshot = projection.snapshot;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    if (!identity.taskId || !identity.taskRunId || !snapshot.revision.taskRevision || !snapshot.revision.workspaceRevision || !snapshot.revision.indexRevision)
      throw new ReadModelNotFound();
    const source = projection.sourceViews.workingTree, taskView = projection.sourceViews.task ?? null;
    if (!source?.files.some((file: any) => file.fileRef === fileRef)) throw new ReadModelNotFound();
    const diff = await this.diff("working-tree", fileRef) as any;
    const { collectSourceRevertPreview, matchesProtectedPath } = await loadCoreInspection();
    const protectedPaths = this.#input.protectedPaths?.() ?? [];
    return collectSourceRevertPreview({ cwd: this.#input.cwd, identity, sourceView: source, taskView, diff,
      taskRevision: snapshot.revision.taskRevision, workspaceRevision: snapshot.revision.workspaceRevision,
      indexRevision: snapshot.revision.indexRevision, selectedHunkRefs: hunkRef ? [hunkRef] : [],
      confirmationKey: this.#sourceRevertConfirmationKey,
      guardAvailable: this.#input.sourceMutationGuardAvailable?.() === true,
      isProtectedPath: (_root: string, repoPath: string) => Boolean(matchesProtectedPath(repoPath, protectedPaths)) });
  }

  async sourceRevert(fileRef: string, hunkRef: string | null): Promise<unknown> {
    return (await this.#sourceRevert(fileRef, hunkRef)).projection;
  }

  async sourceRevertAuthority(fileRef: string, hunkRefs: string[]) {
    if (hunkRefs.length > 1) throw new ReadModelNotFound();
    return this.#sourceRevert(fileRef, hunkRefs[0] ?? null);
  }

  async sourceOpenAuthority(fileRef: string) {
    this.invalidate(); const projection = await this.#projection(), snapshot = projection.snapshot;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    if (!identity.taskId || !identity.taskRunId || !snapshot.revision.taskRevision || !snapshot.revision.workspaceRevision) return null;
    const { resolveSourceOpenTarget, matchesProtectedPath } = await loadCoreInspection(), protectedPaths = this.#input.protectedPaths?.() ?? [];
    return resolveSourceOpenTarget({ cwd: this.#input.cwd, identity, sourceView: projection.sourceViews.workingTree, fileRef,
      taskRevision: snapshot.revision.taskRevision, workspaceRevision: snapshot.revision.workspaceRevision,
      isProtectedPath: (_root: string, repoPath: string) => Boolean(matchesProtectedPath(repoPath, protectedPaths)) });
  }

  async commitSummary(): Promise<unknown> {
    this.invalidate(); const projection = await this.#projection(), snapshot = projection.snapshot;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    if (!identity.taskId || !identity.taskRunId || !snapshot.revision.taskRevision || !snapshot.revision.indexRevision) throw new ReadModelNotFound();
    const { projectDeterministicCommitSummary } = await loadCoreInspection();
    return projectDeterministicCommitSummary({ identity, sourceView: projection.sourceViews.staged,
      taskRevision: snapshot.revision.taskRevision, indexRevision: snapshot.revision.indexRevision });
  }

  async taskIndex(): Promise<unknown> {
    this.invalidate(); const snapshot = await this.snapshot() as any;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    const { projectTaskRunIndex } = await loadCoreInspection();
    return projectTaskRunIndex({ cwd: this.#input.cwd, identity, currentSessionId: this.#input.sessionId });
  }

  async taskTimeline(runRef: string): Promise<unknown> {
    this.invalidate(); const snapshot = await this.snapshot() as any;
    const { projectTaskRecoveryTimeline, resolveTaskRunRef } = await loadCoreInspection();
    const task = resolveTaskRunRef(this.#input.cwd, runRef); if (!task) throw new ReadModelNotFound();
    const identity = { ...snapshot.identity, taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
    return projectTaskRecoveryTimeline({ cwd: this.#input.cwd, identity, task });
  }

  async recoveryHistory(runRef: string): Promise<unknown> {
    this.invalidate(); const snapshot = await this.snapshot() as any;
    const { projectTaskCompactionHistory, resolveTaskRunRef } = await loadCoreInspection();
    const task = resolveTaskRunRef(this.#input.cwd, runRef); if (!task) throw new ReadModelNotFound();
    const identity = { ...snapshot.identity, taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
    return projectTaskCompactionHistory({ cwd: this.#input.cwd, identity, task });
  }

  async handoffHistory(runRef: string): Promise<unknown> {
    this.invalidate(); const snapshot = await this.snapshot() as any;
    const { projectTaskHandoffHistory, resolveTaskRunRef } = await loadCoreInspection();
    const task = resolveTaskRunRef(this.#input.cwd, runRef); if (!task) throw new ReadModelNotFound();
    const identity = { ...snapshot.identity, taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
    return projectTaskHandoffHistory({ cwd: this.#input.cwd, identity, task });
  }

  async subagentTree(runRef: string): Promise<unknown> {
    this.invalidate(); const snapshot = await this.snapshot() as any;
    const { projectTaskSubagentTree, resolveTaskRunRef } = await loadCoreInspection();
    const task = resolveTaskRunRef(this.#input.cwd, runRef); if (!task) throw new ReadModelNotFound();
    const identity = { ...snapshot.identity, taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
    return projectTaskSubagentTree({ cwd: this.#input.cwd, identity, task });
  }

  async releaseMonitor(): Promise<unknown> {
    const snapshot = await this.snapshot() as any;
    const identity = { ...snapshot.identity, agentOperationId: null, toolCallId: null };
    const { projectBenchmarkReleaseMonitor } = await loadCoreInspection();
    return projectBenchmarkReleaseMonitor({ cwd: this.#input.cwd, identity });
  }

  async canonicalRevisions(): Promise<Record<string, string | null>> {
    this.invalidate(); return structuredClone((await this.#projection()).snapshot.revision);
  }

  replay(after: string | null, limit: number) {
    const replay = this.#input.eventStore.replay(after, limit);
    if (replay.state !== "current") {
      this.#cachedProjection = null;
      this.#diffCache.clear();
    }
    return { ...replay, events: replay.events.map((event) => ({ cursor: event.eventCursor, value: event })) };
  }
  subscribe(listener: (event: StreamEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  publishObserved(event: RuntimeEvent): void {
    this.invalidate();
    const item = { cursor: event.eventCursor, value: event };
    for (const listener of this.#listeners) listener(item);
  }
}
