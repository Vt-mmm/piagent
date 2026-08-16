import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { inspectTaskResumeState } from "../../piagent-core/runtime/recovery/resume-state.ts";
import { appendTaskControlTransition, inspectTaskControlState, readTaskControlReceipt, recordTaskControlReceipt,
  type DurableControlState } from "../../piagent-core/runtime/inspection/task-control-journal.ts";
import { chatContentDigest, controlActionDigest, type BridgeIdentity, type BridgeRevisions, type ChatReceipt,
  type NewOperationChatCommand, type SameSessionPiBridge } from "./same-session-bridge.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/, PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/,
  REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/,
  DIGEST = /^sha256:[a-f0-9]{64}$/;
type Task = { taskId: string; taskRunId: string; sessionId: string; trace: { outcome: string }; [key: string]: any };
type LifecycleAction = "lifecycle.stop" | "lifecycle.pause" | "lifecycle.resume" | "lifecycle.resume-and-continue";
type Command = { schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "control.lifecycle" | "control.resumeAndContinue"; action: LifecycleAction; actionDigest: string;
  identity: BridgeIdentity; expectedRevisions: BridgeRevisions & { workspacePreimage: null; indexPreimage: null; patchPreimage: null };
  payload: Record<string, unknown> };
type Receipt = { schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string;
  idempotencyKeyDigest: string; action: LifecycleAction; actionDigest: string; identity: BridgeIdentity;
  phase: "accepted" | "settled" | "rejected" | "uncertain"; resultCode: string; requestedAt: string; settledAt: string | null;
  observedRevisionsBefore: BridgeRevisions; observedRevisionsAfter: BridgeRevisions; deduplicated: boolean; auditRef: string | null;
  settlementEvidenceRef: string | null; error: { code: string; message: string; retryable: boolean } | null };
type PendingStop = { task: Task | null; command: Command; operationId: string; pauseState: DurableControlState; resolved: boolean;
  resolve(value: Receipt): void; timer: NodeJS.Timeout };
type PendingPause = { task: Task; command: Command; epoch: number; abortIssued: boolean; preTreeDigest: string | null };
export type LifecycleEvent = { kind: "control.changed" | "command.receipt"; action: LifecycleAction | null; resultCode: string;
  controlState: DurableControlState; commandId: string | null; receipt?: Receipt; fact?: string; fromControlState?: DurableControlState;
  toControlState?: DurableControlState; requestSequence?: number; parentSequence?: number | null; expectedControlRevision?: string;
  idempotencyKeyDigest?: string; agentOperationId?: string | null; preWorkingTreeDigest?: string | null; postWorkingTreeDigest?: string | null };

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value); return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function derivedRef(prefix: string, command: Command): string {
  return `${prefix}.${createHash("sha256").update(`${command.commandId}\0${command.actionDigest}`).digest("hex")}`;
}
function evidence(value: unknown): string { return `control-state.${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function exactKeys(value: unknown, keys: string[]): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value)
  && same(Object.keys(value as Record<string, unknown>).sort(), [...keys].sort())); }
function timestamp(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function clone<T>(value: T): T { return structuredClone(value); }
function wireRevisions(value: BridgeRevisions): BridgeRevisions { return { runtimeRevision: value.runtimeRevision, taskRevision: value.taskRevision,
  controlRevision: value.controlRevision, workspaceRevision: value.workspaceRevision, indexRevision: value.indexRevision,
  approvalRevision: value.approvalRevision, sessionOptionRevision: value.sessionOptionRevision, queueRevision: value.queueRevision }; }
function storedReceipt(value: unknown): value is Receipt {
  if (!exactKeys(value, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKeyDigest", "action", "actionDigest", "identity",
    "phase", "resultCode", "requestedAt", "settledAt", "observedRevisionsBefore", "observedRevisionsAfter", "deduplicated", "auditRef",
    "settlementEvidenceRef", "error"])) return false;
  const item = value as Receipt, revisions = (candidate: unknown) => { if (!exactKeys(candidate,
    ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"])) return false;
    const current = candidate as Record<string, unknown>; return REVISION.test(String(current.runtimeRevision ?? ""))
      && Object.entries(current).filter(([key]) => key !== "runtimeRevision").every(([, item]) => item === null || REVISION.test(String(item))); };
  const identity = item.identity, validIdentity = exactKeys(identity,
    ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
    && [identity.projectRef, identity.runtimeInstanceId, identity.sessionRef].every((entry) => REF.test(String(entry)))
    && (identity.taskId === null || PUBLIC_REF.test(String(identity.taskId))) && (identity.taskRunId === null || PUBLIC_REF.test(String(identity.taskRunId)))
    && (identity.agentOperationId === null || REF.test(String(identity.agentOperationId))) && identity.toolCallId === null;
  if (item.schemaVersion !== 1 || item.version !== "piagent-webui-control-v1" || item.messageType !== "receipt" || !REF.test(item.commandId)
    || !DIGEST.test(item.idempotencyKeyDigest) || !DIGEST.test(item.actionDigest) || !timestamp(item.requestedAt)
    || !["lifecycle.stop", "lifecycle.pause", "lifecycle.resume", "lifecycle.resume-and-continue"].includes(item.action) || !revisions(item.observedRevisionsBefore)
    || !revisions(item.observedRevisionsAfter) || !validIdentity || typeof item.deduplicated !== "boolean"
    || !(item.auditRef === null || REF.test(item.auditRef))) return false;
  if (item.phase === "accepted") return (item.action === "lifecycle.pause" && item.resultCode === "pause-requested"
    || item.action === "lifecycle.resume-and-continue" && item.resultCode === "dispatch-requested") && item.settledAt === null
    && item.settlementEvidenceRef === null && item.error === null;
  if (!timestamp(item.settledAt)) return false;
  const results = item.action === "lifecycle.stop" ? ["stopped", "emergency-stop"]
    : item.action === "lifecycle.pause" ? ["paused", "already-pausing", "already-paused"]
      : item.action === "lifecycle.resume" ? ["resumed", "already-active", "pause-cancelled"] : ["dispatch-observed"];
  if (item.phase === "settled") return results.includes(item.resultCode) && item.error === null
    && typeof item.settlementEvidenceRef === "string" && REF.test(item.settlementEvidenceRef);
  const validError = Boolean(item.error && /^[a-z0-9][a-z0-9.-]{0,95}$/.test(item.error.code)
    && item.error.message.length > 0 && item.error.message.length <= 500 && typeof item.error.retryable === "boolean");
  return item.settlementEvidenceRef === null && validError && (item.phase === "uncertain" && item.action === "lifecycle.stop"
    && item.resultCode === "settlement-unknown" || item.phase === "rejected" && item.action === "lifecycle.resume" && item.resultCode === "resume-rejected"
    || item.phase === "uncertain" && item.action === "lifecycle.resume-and-continue"
      && ["dispatch-unknown", "resumed-not-dispatched"].includes(item.resultCode));
}

export class LifecycleController {
  readonly #bridge: SameSessionPiBridge;
  readonly #runtimeInstanceId: string;
  readonly #task: (ctx: ExtensionContext) => Task | null;
  readonly #abort: (ctx: ExtensionContext) => void;
  readonly #cancelApprovals: (ctx: ExtensionContext, taskRunId: string) => void;
  readonly #treeDigest: (ctx: ExtensionContext) => string | null;
  readonly #listeners = new Set<(event: LifecycleEvent) => void>();
  #ctx: ExtensionContext | null = null;
  #toolDepth = 0;
  #phase: "idle" | "model" | "tool" | "other" | "unknown" = "unknown";
  #pauseGeneration = 0;
  #pendingPause: PendingPause | null = null;
  #pendingStop: PendingStop | null = null;
  readonly #ephemeralReceipts = new Map<string, Receipt>();
  #serial: Promise<unknown> = Promise.resolve();

  constructor(input: { bridge: SameSessionPiBridge; runtimeInstanceId: string; task(ctx: ExtensionContext): Task | null;
    abort(ctx: ExtensionContext): void; cancelApprovals(ctx: ExtensionContext, taskRunId: string): void; treeDigest?(ctx: ExtensionContext): string | null }) {
    this.#bridge = input.bridge; this.#runtimeInstanceId = input.runtimeInstanceId; this.#task = input.task;
    this.#abort = input.abort; this.#cancelApprovals = input.cancelApprovals; this.#treeDigest = input.treeDigest ?? (() => null);
  }

  bind(ctx: ExtensionContext): void { this.#ctx = ctx; this.#toolDepth = 0; this.#phase = ctx.isIdle() ? "idle" : "other";
    this.#pendingPause = null; this.#clearStop(false); this.#pauseGeneration += 1; }
  replacementPending(): void { this.#pauseGeneration += 1; this.#pendingPause = null; this.#clearStop(true); this.#phase = "unknown"; }
  shutdown(): void { this.#pauseGeneration += 1; this.#pendingPause = null; this.#clearStop(true); this.#ctx = null; this.#phase = "unknown"; }
  subscribe(listener: (event: LifecycleEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(event: LifecycleEvent): void { for (const listener of this.#listeners) { try { listener(clone(event)); } catch { /* projection is fail-soft */ } } }
  #sameSession(ctx: ExtensionContext): boolean { return Boolean(this.#ctx && this.#ctx.cwd === ctx.cwd
    && this.#ctx.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()); }

  snapshot(): { state: DurableControlState; controlRevision: string | null; dispatchBlocked: boolean; currentPhase: string; pauseEpoch: number;
    actions: { stop: boolean; pause: boolean; resume: boolean } } {
    const ctx = this.#ctx, task = ctx ? this.#task(ctx) : null;
    if (!ctx || !task) return { state: task?.trace.outcome === "pending" ? "unknown" : "active", controlRevision: null,
      dispatchBlocked: Boolean(this.#pendingStop), currentPhase: this.#phase, pauseEpoch: 0, actions: { stop: false, pause: false, resume: false } };
    const control = inspectTaskControlState(ctx.cwd, task);
    const running = this.#bridge.snapshot().liveness === "running";
    return { ...control, dispatchBlocked: control.dispatchBlocked || Boolean(this.#pendingStop), currentPhase: this.#phase,
      actions: { stop: running && Boolean(this.#bridge.snapshot().identity?.agentOperationId), pause: control.state === "active",
        resume: control.state === "paused" || control.state === "pause-requested" } };
  }

  dispatchAllowed(ctx?: ExtensionContext): boolean {
    const current = ctx ?? this.#ctx; if (!current || !this.#sameSession(current)) return false;
    const task = this.#task(current); if (!task) return !this.#pendingStop;
    return !inspectTaskControlState(current.cwd, task).dispatchBlocked && !this.#pendingStop;
  }

  inputAllowed(ctx?: ExtensionContext): boolean {
    const current = ctx ?? this.#ctx; if (!current || !this.#sameSession(current) || this.#pendingStop) return false;
    const task = this.#task(current); if (!task) return true;
    const state = inspectTaskControlState(current.cwd, task).state;
    return state === "active" || state === "terminal";
  }

  toolAllowed(toolName: string, ctx?: ExtensionContext): boolean {
    if (this.dispatchAllowed(ctx)) return true;
    const current = ctx ?? this.#ctx; if (!current || !this.#sameSession(current) || this.#pendingStop) return false;
    const task = this.#task(current);
    return toolName === "piagent_task_start" && Boolean(task)
      && inspectTaskControlState(current.cwd, task).state === "terminal";
  }

  observeAgentStart(ctx: ExtensionContext): void { if (!this.#sameSession(ctx)) return; this.#phase = "model"; }
  observeToolStart(ctx: ExtensionContext): void { if (!this.#sameSession(ctx)) return; this.#toolDepth += 1; this.#phase = "tool"; }
  observeToolEnd(ctx: ExtensionContext): void { if (!this.#sameSession(ctx)) return; this.#toolDepth = Math.max(0, this.#toolDepth - 1);
    this.#phase = this.#toolDepth ? "tool" : "model"; if (!this.#toolDepth) this.#advancePause(); }
  observeAgentSettled(ctx: ExtensionContext, operationId: string | null): void {
    if (!this.#sameSession(ctx)) return; this.#phase = "idle";
    if (this.#pendingStop && operationId === this.#pendingStop.operationId) this.#settleStop();
    if (this.#pendingPause) this.#settlePause();
  }

  execute(value: unknown): Promise<Receipt> { const run = this.#serial.then(() => this.#execute(value), () => this.#execute(value));
    this.#serial = run.catch(() => undefined); return run; }
  async #execute(value: unknown): Promise<Receipt> {
    const ctx = this.#ctx, command = value as Command, structural = this.#validate(value), bridge = this.#bridge.snapshot();
    if (!ctx || bridge.state !== "ready" || !bridge.identity || !bridge.revisions) return this.#reject(command, "resync-required", "lifecycle-binding-unavailable");
    if (structural) return this.#reject(command, "invalid-command", structural);
    const task = this.#task(ctx), keyDigest = sha(command.idempotencyKey);
    const durable = task ? readTaskControlReceipt(ctx.cwd, task, { commandId: command.commandId, idempotencyKeyDigest: keyDigest,
      actionDigest: command.actionDigest }) : null;
    const ephemeral = task ? null : [...this.#ephemeralReceipts.values()].find((item) => item.commandId === command.commandId
      || item.idempotencyKeyDigest === keyDigest) ?? null;
    if (durable?.invalid || durable && !storedReceipt(durable.receipt)) return this.#reject(command, "resync-required", "task-control-receipt-corrupt");
    if (durable?.conflict || ephemeral && (ephemeral.actionDigest !== command.actionDigest || ephemeral.commandId === command.commandId
      && ephemeral.idempotencyKeyDigest !== keyDigest)) return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch");
    const stored = durable?.receipt as Receipt | undefined ?? ephemeral;
    if (stored) {
      const current = bridge.identity, prior = stored.identity;
      if (prior.projectRef !== current.projectRef || prior.runtimeInstanceId !== current.runtimeInstanceId || prior.sessionRef !== current.sessionRef
        || prior.taskId !== current.taskId || prior.taskRunId !== current.taskRunId) return this.#reject(command, "identity-mismatch", "runtime-or-session-replaced");
      return { ...stored, deduplicated: true };
    }
    const now = Date.now();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future");
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired");
    if (!same(command.identity, bridge.identity)) return this.#reject(command, "identity-mismatch", "identity-mismatch");
    const lifecycleRevisions = command.action === "lifecycle.stop" && !task ? ["runtimeRevision"] as const
      : ["runtimeRevision", "taskRevision", "controlRevision"] as const;
    if (lifecycleRevisions.some((name) => command.expectedRevisions[name] !== bridge.revisions![name]))
      return this.#reject(command, "stale-revision", "stale-revision");
    if (command.action !== "lifecycle.stop" && (!task || task.taskId !== command.identity.taskId || task.taskRunId !== command.identity.taskRunId))
      return this.#reject(command, "identity-mismatch", "task-identity-mismatch");
    if (command.action === "lifecycle.stop") return this.#stop(ctx, task?.trace.outcome === "pending" ? task : null, command);
    if (task && task.trace.outcome !== "pending") return this.#reject(command, "capability-unavailable", "task-terminal");
    if (!task) return this.#reject(command, "identity-mismatch", "task-identity-mismatch");
    if (command.action === "lifecycle.pause") return this.#pause(ctx, task, command);
    if (command.action === "lifecycle.resume-and-continue") return this.#resumeAndContinue(ctx, task, command);
    return this.#resume(ctx, task, command);
  }

  async #resumeAndContinue(ctx: ExtensionContext, task: Task, command: Command): Promise<Receipt> {
    const control = inspectTaskControlState(ctx.cwd, task), before = this.#bridge.snapshot();
    if (!["paused", "pause-requested"].includes(control.state))
      return this.#reject(command, "capability-unavailable", `control-state-${control.state}`);
    if (before.liveness !== "idle" || before.identity?.agentOperationId)
      return this.#reject(command, "capability-unavailable", "agent-not-idle");
    const resumeCommand: Command = { ...clone(command), commandId: derivedRef("compound-resume", command),
      idempotencyKey: derivedRef("compound-resume-key", command), capabilityScope: "control.lifecycle", action: "lifecycle.resume", payload: {} };
    resumeCommand.actionDigest = controlActionDigest(resumeCommand);
    const resume = this.#resume(ctx, task, resumeCommand);
    if (resume.phase !== "settled" || !["resumed", "pause-cancelled", "already-active"].includes(resume.resultCode))
      return this.#reject(command, "capability-unavailable", resume.error?.code ?? "resume-before-dispatch-failed");
    const ready = this.#bridge.snapshot();
    if (ready.state !== "ready" || ready.liveness !== "idle" || !ready.identity || !ready.revisions
      || ready.taskState !== "active" || ready.identity.agentOperationId)
      return this.#finish(task, this.#receipt(command, "uncertain", "resumed-not-dispatched", null,
        "post-resume-dispatch-gate-closed", false));
    const chat: NewOperationChatCommand = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command",
      commandId: derivedRef("compound-chat", command), idempotencyKey: derivedRef("compound-chat-key", command),
      requestedAt: command.requestedAt, expiresAt: command.expiresAt, capabilityScope: "control.chat", action: "chat.send", actionDigest: "",
      identity: clone(ready.identity), expectedRevisions: { ...clone(ready.revisions), workspacePreimage: null, indexPreimage: null, patchPreimage: null },
      payload: command.payload as NewOperationChatCommand["payload"] };
    chat.actionDigest = controlActionDigest(chat);
    const dispatched = await this.#bridge.execute(chat);
    if (dispatched.resultCode === "dispatch-observed" && dispatched.phase === "settled")
      return this.#finish(task, this.#receipt(command, "settled", "dispatch-observed", dispatched.settlementEvidenceRef,
        null, false, dispatched.identity));
    if (dispatched.resultCode === "dispatch-requested" && ["requested", "accepted"].includes(dispatched.phase))
      return this.#finish(task, this.#receipt(command, "accepted", "dispatch-requested", null, null, false, dispatched.identity));
    if (dispatched.resultCode === "dispatch-unknown" || dispatched.phase === "uncertain")
      return this.#finish(task, this.#receipt(command, "uncertain", "dispatch-unknown", null,
        dispatched.error?.code ?? "dispatch-acknowledgement-ambiguous", false, dispatched.identity));
    return this.#finish(task, this.#receipt(command, "uncertain", "resumed-not-dispatched", null,
      dispatched.error?.code ?? "dispatch-after-resume-rejected", false));
  }

  #stop(ctx: ExtensionContext, task: Task | null, command: Command): Promise<Receipt> {
    const bridge = this.#bridge.snapshot(), operationId = bridge.identity?.agentOperationId;
    if (!operationId || bridge.liveness !== "running") return Promise.resolve(this.#reject(command, "capability-unavailable", "agent-not-running"));
    if (this.#pendingStop) return Promise.resolve(this.#reject(command, "capability-unavailable", "stop-already-pending"));
    const control = task ? inspectTaskControlState(ctx.cwd, task) : { state: "active" as const, pauseEpoch: 0 };
    const transition = task ? this.#transition(task, command, "task-control.stop-requested", "stop",
      [control.state], control.state, "stop-requested", operationId, control.pauseEpoch) : { ok: true, reasonCode: null };
    if (!transition.ok) return Promise.resolve(this.#reject(command, transition.reasonCode === "stale-control-revision" ? "stale-revision" : "capability-unavailable", transition.reasonCode ?? "stop-request-rejected"));
    return new Promise<Receipt>((resolve) => {
      const timer = setTimeout(() => { if (!this.#pendingStop || this.#pendingStop.resolved) return; this.#pendingStop.resolved = true;
        const receipt = this.#receipt(command, "uncertain", "settlement-unknown", null, "stop-settlement-not-observed", false);
        this.#store(task, receipt); this.#emitReceipt(receipt); resolve(receipt); }, 5_000); timer.unref();
      this.#pendingStop = { task, command: clone(command), operationId, pauseState: control.state, resolved: false, resolve, timer };
      try { this.#abort(ctx); } catch { this.#settleStop("abort-rejected"); }
    });
  }

  #pause(ctx: ExtensionContext, task: Task, command: Command): Receipt {
    const control = inspectTaskControlState(ctx.cwd, task);
    if (control.state === "pause-requested") return this.#finish(task, this.#receipt(command, "settled", "already-pausing", control.journalHead ?? evidence(control), null, false));
    if (control.state === "paused") return this.#finish(task, this.#receipt(command, "settled", "already-paused", control.journalHead ?? evidence(control), null, false));
    if (control.state !== "active") return this.#reject(command, "capability-unavailable", control.reasonCode ?? `control-state-${control.state}`);
    const epoch = control.pauseEpoch + 1, preTreeDigest = this.#treeDigest(ctx), transition = this.#transition(task, command,
      "task-control.pause-requested", "pause", ["active"], "pause-requested", "pause-requested", command.identity.agentOperationId, epoch,
      null, { preWorkingTreeDigest: preTreeDigest, postWorkingTreeDigest: null });
    if (!transition.ok) return this.#reject(command, transition.reasonCode === "stale-control-revision" ? "stale-revision" : "capability-unavailable", transition.reasonCode ?? "pause-request-rejected");
    const generation = ++this.#pauseGeneration; this.#pendingPause = { task, command: clone(command), epoch, abortIssued: false,
      preTreeDigest };
    this.#cancelApprovals(ctx, task.taskRunId);
    if (generation !== this.#pauseGeneration || !this.#pendingPause) return this.#reject(command, "resync-required", "pause-worker-cancelled");
    const bridge = this.#bridge.snapshot(), safeNow = bridge.liveness === "idle" && this.#toolDepth === 0
      && !(typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages());
    if (safeNow) { const settled = this.#settlePause(); if (settled) return settled; }
    else this.#advancePause();
    return this.#finish(task, this.#receipt(command, "accepted", "pause-requested", null, null, false));
  }

  #resume(ctx: ExtensionContext, task: Task, command: Command): Receipt {
    const control = inspectTaskControlState(ctx.cwd, task);
    if (control.state === "active") return this.#finish(task, this.#receipt(command, "settled", "already-active", control.journalHead ?? evidence(control), null, false));
    if (control.state === "pause-requested") {
      this.#pauseGeneration += 1; this.#pendingPause = null;
      const transition = this.#transition(task, command, "task-control.pause-cancelled", "resume", ["pause-requested"], "active",
        "pause-cancelled", command.identity.agentOperationId, control.pauseEpoch);
      return transition.ok ? this.#finish(task, this.#receipt(command, "settled", "pause-cancelled", transition.evidenceRef, null, false))
        : this.#reject(command, transition.reasonCode === "stale-control-revision" ? "stale-revision" : "resume-rejected", transition.reasonCode ?? "pause-cancel-rejected");
    }
    if (control.state !== "paused") return this.#reject(command, "resume-rejected", control.reasonCode ?? `control-state-${control.state}`);
    const resumeTreeDigest = this.#treeDigest(ctx), requested = this.#transition(task, command, "task-control.resume-requested", "resume", ["paused"], "paused",
      "resume-requested", command.identity.agentOperationId, control.pauseEpoch, null, { preWorkingTreeDigest: resumeTreeDigest });
    if (!requested.ok) return this.#reject(command, requested.reasonCode === "stale-control-revision" ? "stale-revision" : "resume-rejected", requested.reasonCode ?? "resume-request-rejected");
    let recovery: ReturnType<typeof inspectTaskResumeState>;
    try { recovery = inspectTaskResumeState(ctx.cwd, task as any, task.sessionId); }
    catch { recovery = { enforcementSafe: false, decision: "blocked", reason: "Resume evidence is unavailable" } as any; }
    const current = inspectTaskControlState(ctx.cwd, task);
    if (!recovery.enforcementSafe || !["resume", "retry"].includes(recovery.decision)) {
      this.#transition(task, { ...command, expectedRevisions: { ...command.expectedRevisions, controlRevision: current.controlRevision } },
        "task-control.resume-rejected", "resume", ["paused"], "paused", "resume-rejected", command.identity.agentOperationId, control.pauseEpoch,
        String(recovery.reason ?? "resume-evidence-unsafe"));
      return this.#finish(task, this.#receipt(command, "rejected", "resume-rejected", null, "resume-evidence-unsafe", false));
    }
    const resumed = this.#transition(task, { ...command, expectedRevisions: { ...command.expectedRevisions, controlRevision: current.controlRevision } },
      "task-control.resumed", "resume", ["paused"], "active", "resumed", command.identity.agentOperationId, control.pauseEpoch, null,
      { preWorkingTreeDigest: resumeTreeDigest, postWorkingTreeDigest: this.#treeDigest(ctx) });
    return resumed.ok ? this.#finish(task, this.#receipt(command, "settled", "resumed", resumed.evidenceRef, null, false))
      : this.#reject(command, "resume-rejected", resumed.reasonCode ?? "resume-commit-rejected");
  }

  #advancePause(): void {
    const pending = this.#pendingPause, ctx = this.#ctx; if (!pending || !ctx || pending.abortIssued || this.#toolDepth > 0) return;
    const current = inspectTaskControlState(ctx.cwd, pending.task);
    if (current.state !== "pause-requested" || current.pauseEpoch !== pending.epoch) { this.#pendingPause = null; return; }
    pending.abortIssued = true;
    try { this.#abort(ctx); } catch { /* state stays pause-requested until a safe point is proved */ }
  }

  #settlePause(): Receipt | null {
    const pending = this.#pendingPause, ctx = this.#ctx; if (!pending || !ctx) return null;
    const current = inspectTaskControlState(ctx.cwd, pending.task);
    if (current.state !== "pause-requested" || current.pauseEpoch !== pending.epoch) { this.#pendingPause = null; return null; }
    const command = { ...pending.command, expectedRevisions: { ...pending.command.expectedRevisions, controlRevision: current.controlRevision } };
    const postTreeDigest = this.#treeDigest(ctx); if (!postTreeDigest) return null;
    const transition = this.#transition(pending.task, command, "task-control.paused", "pause", ["pause-requested"], "paused",
      "paused", pending.command.identity.agentOperationId, pending.epoch, null,
      { preWorkingTreeDigest: pending.preTreeDigest, postWorkingTreeDigest: postTreeDigest });
    if (!transition.ok) return null;
    this.#pendingPause = null; const receipt = this.#finish(pending.task, this.#receipt(pending.command, "settled", "paused", transition.evidenceRef, null, false));
    this.#emit({ kind: "control.changed", action: "lifecycle.pause", resultCode: "paused", controlState: "paused", commandId: pending.command.commandId });
    return receipt;
  }

  #settleStop(reason?: string): void {
    const pending = this.#pendingStop; if (!pending) return;
    clearTimeout(pending.timer); const current = pending.task ? inspectTaskControlState(this.#ctx?.cwd ?? "", pending.task) : null;
    const command = current ? { ...pending.command, expectedRevisions: { ...pending.command.expectedRevisions, controlRevision: current.controlRevision } } : pending.command;
    const transition = this.#ctx && pending.task && current ? this.#transition(pending.task, command, "task-control.stop-settled", "stop", [current.state], current.state,
      reason ? "settlement-unknown" : "stopped", pending.operationId, current.pauseEpoch, reason ?? null) : null;
    const success = !reason && (!pending.task || transition?.ok);
    const receipt = success ? this.#receipt(pending.command, "settled", pending.task ? "stopped" : "emergency-stop",
      transition?.evidenceRef ?? evidence([pending.operationId, "emergency-stop"]), null, false)
      : this.#receipt(pending.command, "uncertain", "settlement-unknown", null, reason ?? "stop-settlement-unavailable", false);
    this.#store(pending.task, receipt); this.#emitReceipt(receipt); if (!pending.resolved) pending.resolve(receipt);
    this.#pendingStop = null;
  }

  #transition(task: Task, command: Command, fact: string, action: "stop" | "pause" | "resume", expectedStates: DurableControlState[],
    toState: DurableControlState, resultCode: string, operationId: string | null, pauseEpoch: number, reasonCode: string | null = null,
    tree: { preWorkingTreeDigest?: string | null; postWorkingTreeDigest?: string | null } = {}) {
    const result = appendTaskControlTransition({ cwd: this.#ctx!.cwd, task, runtimeInstanceId: this.#runtimeInstanceId, commandId: command.commandId,
      idempotencyKeyDigest: sha(command.idempotencyKey), actionDigest: command.actionDigest, fact, action,
      expectedControlRevision: command.expectedRevisions.controlRevision!, expectedStates, toState, agentOperationId: operationId,
      resultCode, reasonCode, pauseEpoch, ...tree });
    if (result.ok && !result.duplicate) this.#emit({ kind: "control.changed", action: command.action, resultCode,
      controlState: result.after.state, commandId: command.commandId, fact: fact.replace("task-control.", ""), fromControlState: result.before.state,
      toControlState: result.after.state, requestSequence: fact.endsWith("-requested") ? result.after.sequence : result.before.sequence,
      parentSequence: fact.endsWith("-requested") ? null : result.before.sequence, expectedControlRevision: command.expectedRevisions.controlRevision!,
      idempotencyKeyDigest: sha(command.idempotencyKey), agentOperationId: operationId,
      preWorkingTreeDigest: tree.preWorkingTreeDigest ?? null, postWorkingTreeDigest: tree.postWorkingTreeDigest ?? null });
    return result;
  }
  #finish(task: Task, receipt: Receipt): Receipt { this.#store(task, receipt); this.#emitReceipt(receipt); return receipt; }
  #store(task: Task | null, receipt: Receipt): void { if (!task) { this.#ephemeralReceipts.set(receipt.commandId, clone(receipt));
      if (this.#ephemeralReceipts.size > 256) this.#ephemeralReceipts.delete(this.#ephemeralReceipts.keys().next().value as string); return; }
    try { recordTaskControlReceipt(this.#ctx!.cwd, task, receipt.commandId, receipt.idempotencyKeyDigest, receipt.actionDigest,
      receipt as unknown as Record<string, unknown>); } catch { /* transition evidence remains authoritative */ } }
  #emitReceipt(receipt: Receipt): void { this.#emit({ kind: "command.receipt", action: receipt.action, resultCode: receipt.resultCode,
    controlState: this.snapshot().state, commandId: receipt.commandId, receipt }); }
  #clearStop(resolve: boolean): void { if (!this.#pendingStop) return; clearTimeout(this.#pendingStop.timer);
    if (resolve && !this.#pendingStop.resolved) this.#pendingStop.resolve(this.#receipt(this.#pendingStop.command, "uncertain", "settlement-unknown", null, "runtime-replaced", false));
    this.#pendingStop = null; }

  #receipt(command: Command, phase: Receipt["phase"], resultCode: string, evidenceRef: string | null, errorCode: string | null,
    deduplicated: boolean, identityOverride?: BridgeIdentity): Receipt {
    const snapshot = this.#bridge.snapshot(), after = snapshot.revisions ?? command.expectedRevisions;
    const settled = phase === "accepted" ? null : new Date().toISOString();
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: command.commandId,
      idempotencyKeyDigest: sha(command.idempotencyKey), action: command.action, actionDigest: command.actionDigest,
      identity: clone(identityOverride ?? command.identity),
      phase, resultCode, requestedAt: command.requestedAt, settledAt: settled, observedRevisionsBefore: wireRevisions(command.expectedRevisions),
      observedRevisionsAfter: wireRevisions(after), deduplicated, auditRef: evidenceRef, settlementEvidenceRef: phase === "settled" ? evidenceRef : null,
      error: errorCode ? { code: errorCode.replace(/[^a-z0-9.-]/g, "-").slice(0, 96) || "lifecycle-error",
        message: `Lifecycle control could not complete: ${errorCode.replace(/[-.]/g, " ").slice(0, 400)}`, retryable: false } : null };
  }
  #reject(value: Partial<Command> | undefined, resultCode: string, errorCode: string): Receipt {
    const snapshot = this.#bridge.snapshot(), fallbackIdentity = snapshot.identity ?? { projectRef: "project.unavailable", runtimeInstanceId: this.#runtimeInstanceId,
      sessionRef: "session.unavailable", taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
    const fallbackRevisions = snapshot.revisions ?? { runtimeRevision: "runtime-rev.unavailable", taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    const action: LifecycleAction = ["lifecycle.stop", "lifecycle.pause", "lifecycle.resume", "lifecycle.resume-and-continue"].includes(String(value?.action))
      ? value!.action as LifecycleAction : "lifecycle.pause";
    const identity = value?.identity && exactKeys(value.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      ? value.identity : fallbackIdentity;
    const command = { commandId: REF.test(String(value?.commandId ?? "")) ? String(value!.commandId) : "command.invalid",
      idempotencyKey: IDEMPOTENCY.test(String(value?.idempotencyKey ?? "")) ? String(value!.idempotencyKey) : "invalid-command-key-0000000000000000",
      requestedAt: timestamp(value?.requestedAt) ? value!.requestedAt : new Date().toISOString(), action,
      actionDigest: /^sha256:[a-f0-9]{64}$/.test(String(value?.actionDigest ?? "")) ? String(value!.actionDigest) : sha(canonical(value ?? null)),
      identity, expectedRevisions: fallbackRevisions } as Command;
    const receipt = this.#receipt(command, "rejected", resultCode, null, errorCode, false); this.#emitReceipt(receipt); return receipt;
  }
  #validate(value: unknown): string | null {
    if (!exactKeys(value, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope", "action", "actionDigest", "identity", "expectedRevisions", "payload"])) return "unknown-command-field";
    const command = value as Command;
    if (command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1" || command.messageType !== "command"
      || !["lifecycle.stop", "lifecycle.pause", "lifecycle.resume", "lifecycle.resume-and-continue"].includes(command.action)
      || command.capabilityScope !== (command.action === "lifecycle.resume-and-continue" ? "control.resumeAndContinue" : "control.lifecycle")) return "unsupported-command-shape";
    if (!REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt) || !timestamp(command.expiresAt)
      || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000) return "invalid-command-metadata";
    if (!exactKeys(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      || !exactKeys(command.expectedRevisions, ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision", "workspacePreimage", "indexPreimage", "patchPreimage"])) return "invalid-authority-binding";
    if (command.expectedRevisions.workspacePreimage !== null || command.expectedRevisions.indexPreimage !== null || command.expectedRevisions.patchPreimage !== null
      || command.action !== "lifecycle.stop" && (command.expectedRevisions.taskRevision === null || command.expectedRevisions.controlRevision === null)) return "invalid-authority-binding";
    if (command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    if (command.action === "lifecycle.stop") return exactKeys(command.payload, ["requestedScope"]) && command.payload.requestedScope === "current-agent-operation"
      && REF.test(String(command.identity.agentOperationId ?? "")) ? null : "invalid-stop-payload";
    if (!command.identity.taskId || !command.identity.taskRunId) return "task-identity-required";
    if (command.action === "lifecycle.pause") return exactKeys(command.payload, ["safePointPolicy"])
      && command.payload.safePointPolicy === "after-current-atomic-unit" ? null : "invalid-pause-payload";
    if (command.action === "lifecycle.resume-and-continue") {
      const payload = command.payload as NewOperationChatCommand["payload"];
      return exactKeys(payload, ["messageRequestId", "capabilityAction", "delivery", "text", "attachmentRefs", "contentDigest"])
        && REF.test(String(payload.messageRequestId ?? "")) && payload.capabilityAction === "send" && payload.delivery === "new-operation"
        && typeof payload.text === "string" && payload.text.length > 0 && Buffer.byteLength(payload.text) <= 65_536 && !payload.text.includes("\0")
        && Array.isArray(payload.attachmentRefs) && payload.attachmentRefs.length <= 4
        && new Set(payload.attachmentRefs).size === payload.attachmentRefs.length && payload.attachmentRefs.every((item) => REF.test(String(item)))
        && payload.contentDigest === chatContentDigest(payload) && command.expectedRevisions.queueRevision !== null
        && command.identity.agentOperationId === null ? null : "invalid-resume-and-continue-payload";
    }
    return exactKeys(command.payload, []) ? null : "invalid-resume-payload";
  }
}
