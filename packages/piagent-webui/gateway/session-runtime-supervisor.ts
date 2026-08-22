import { createHmac, randomBytes } from "node:crypto";
import { webUiModelRef, webUiTaskRevision } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { activeSessionTask } from "../../piagent-core/extensions/task-state.js";
import { inspectTaskControlState } from "../../piagent-core/runtime/inspection/task-control-journal.ts";
import { piApprovalBroker, type ApprovalAuthority, type ApprovalBrokerEvent } from "../../piagent-core/runtime/inspection/approval-broker.ts";
import type { SessionOwnerProjection, PiSessionInfo } from "./session-catalog.ts";
import { isUserConversationSession, projectRefForCwd, sessionRefForPath } from "./session-catalog.ts";
import { SessionLeaseStore, type SessionLeaseSnapshot } from "./session-lease-store.ts";
import { GatewayEventStore } from "./gateway-events.ts";
import { GatewaySessionStream } from "./gateway-session-stream.ts";
import { executePermissionCommand, executeRuntimeCommand } from "./runtime-session-controls.ts";
import { configureSessionOptions, effectiveModelRef, effectiveThinkingLevel,
  type EffectiveSessionOptions } from "./session-effective-options.ts";
import { waitForOperationStart } from "./session-operation-start.ts";
import { armSessionOperationWatchdog, bestEffortUnsubscribe, boundedResult, sessionOperationDeadlinePolicy, SessionOperationWatchdog, terminateWatchedSessionOperation,
  type SessionOperationDeadlinePolicy, type SessionOperationWatchdogOptions } from "./session-operation-watchdog.ts";
import { createProductionRuntimeFactory, type RuntimeFactory, type RuntimeHandle } from "./session-runtime-factory.ts";
const MAX_WARM_RUNTIMES = 10;
type ActiveRuntime = { runtime: RuntimeHandle; lease: SessionLeaseSnapshot; info: PiSessionInfo; operationRef: string | null;
  stream: GatewaySessionStream | null; unsubscribe: (() => void) | null; completion: Promise<void> | null; settling: boolean; approvalWaiting: boolean;
  unbindApproval: (() => void) | null; unsubscribeApproval: (() => void) | null; sessionManager: any | null;
  watchdog: SessionOperationWatchdog | null; lastSessionRevision: string | null };
type Projection = { sessionRevision: string; liveState: "offline" | "idle" | "running" | "paused" | "waiting-approval" | "uncertain" };
type RuntimeCommandResult = Awaited<ReturnType<typeof executeRuntimeCommand>>;
export type { EffectiveSessionOptions } from "./session-effective-options.ts";
export type SessionCreateResult = { sessionRef: string; effectiveOptions: EffectiveSessionOptions };
export type CurrentOperationProjection = { operationRef: string; state: "running" | "waiting-approval" | "settling";
  abortable: boolean };
export class SessionRuntimeSupervisor {
  readonly #gatewayInstanceRef: string;
  readonly #key: Buffer;
  readonly #leases: SessionLeaseStore;
  readonly #listSessions: () => Promise<PiSessionInfo[]>;
  readonly #runtimeFactory: RuntimeFactory;
  readonly #events: GatewayEventStore;
  readonly #host: any | null;
  readonly #operationDeadlinePolicy: SessionOperationDeadlinePolicy;
  readonly #resolveProject: ((projectRef: string) => string | null) | null;
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #opening = new Map<string, Promise<SessionLeaseSnapshot>>();
  readonly #created = new Map<string, PiSessionInfo>();
  #closed = false;
  #readProjection: ((sessionRef: string) => Promise<Projection>) | null = null;
  constructor(options: {
    gatewayInstanceRef: string;
    key: Buffer;
    leases: SessionLeaseStore;
    listSessions(): Promise<PiSessionInfo[]>;
    runtimeFactory?: RuntimeFactory;
    host?: any;
    agentDir?: string;
    packageRoot?: string;
    modelRuntime?: any;
    events?: GatewayEventStore;
    operationWatchdog?: SessionOperationWatchdogOptions;
    resolveProject?(projectRef: string): string | null;
  }) {
    this.#gatewayInstanceRef = options.gatewayInstanceRef;
    this.#key = options.key;
    this.#leases = options.leases;
    this.#listSessions = options.listSessions;
    this.#events = options.events ?? new GatewayEventStore();
    this.#host = options.host ?? null;
    this.#operationDeadlinePolicy = sessionOperationDeadlinePolicy(options.operationWatchdog);
    this.#resolveProject = options.resolveProject ?? null;
    if (options.runtimeFactory) this.#runtimeFactory = options.runtimeFactory;
    else {
      if (!options.host || !options.agentDir || !options.packageRoot) throw new Error("session-runtime-factory-unavailable");
      this.#runtimeFactory = createProductionRuntimeFactory({ host: options.host, agentDir: options.agentDir,
        packageRoot: options.packageRoot, modelRuntime: options.modelRuntime });
    }
  }
  get activeCount(): number { return this.#active.size; }
  setProjectionReader(reader: (sessionRef: string) => Promise<Projection>): void { this.#readProjection = reader; }
  async listSessions(): Promise<PiSessionInfo[]> {
    const persisted = (await this.#listSessions()).filter(isUserConversationSession);
    const paths = new Set(persisted.map((info) => info.path));
    for (const [sessionRef, info] of this.#created) {
      if (paths.has(info.path)) this.#created.delete(sessionRef);
    }
    return [...persisted, ...[...this.#created.values()].filter((info) => !paths.has(info.path))];
  }
  async create(projectRef: string, placeRef: string, modelRef: string | null, thinkingLevel: string): Promise<string> {
    return (await this.createWithReadback(projectRef, placeRef, modelRef, thinkingLevel)).sessionRef;
  }
  async createWithReadback(projectRef: string, placeRef: string, modelRef: string | null,
    thinkingLevel: string): Promise<SessionCreateResult> {
    if (this.#closed || !this.#host) throw new Error("session-create-unavailable");
    if (placeRef !== projectRef) throw new Error("session-place-mismatch");
    const sessions = (await this.#listSessions()).filter(isUserConversationSession);
    const imported = this.#resolveProject?.(projectRef) ?? null;
    const candidates = [...new Set([...sessions.filter((info) => projectRefForCwd(this.#key, info.cwd) === projectRef).map((info) => info.cwd),
      ...(imported ? [imported] : [])])];
    if (candidates.length !== 1 || !candidates[0]) throw new Error(candidates.length ? "session-project-ambiguous" : "session-project-not-found");
    const manager = this.#host.SessionManager.create(candidates[0]);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || typeof manager.getSessionId?.() !== "string") throw new Error("session-create-unavailable");
    const createdAt = new Date();
    const created: PiSessionInfo = { path: sessionFile, id: manager.getSessionId(), cwd: candidates[0], created: createdAt,
      modified: createdAt, messageCount: 0, firstMessage: "(no messages)", allMessagesText: "" };
    const sessionRef = sessionRefForPath(this.#key, sessionFile);
    // Retain identity before fallible runtime work so create receipts never point at an orphan.
    this.#created.set(sessionRef, created);
    try { await this.#activate(sessionRef, created, manager); }
    catch {
      return { sessionRef, effectiveOptions: { state: "unknown", modelRef: null, thinkingLevel: null,
        reasonCode: "session-runtime-open-failed" } };
    }
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!session) return { sessionRef, effectiveOptions: { state: "unknown", modelRef: null, thinkingLevel: null,
      reasonCode: "session-runtime-unavailable" } };
    return { sessionRef, effectiveOptions: await configureSessionOptions(session, modelRef, thinkingLevel) };
  }
  liveSessionManager(sessionRef: string): any | null { return this.#active.get(sessionRef)?.sessionManager ?? null; }
  async acquire(sessionRef: string): Promise<SessionLeaseSnapshot> {
    if (this.#closed) throw new Error("session-runtime-supervisor-closed");
    const active = this.#active.get(sessionRef);
    if (active) return active.lease;
    const pending = this.#opening.get(sessionRef);
    if (pending) return await pending;
    const opening = this.#acquire(sessionRef).finally(() => this.#opening.delete(sessionRef));
    this.#opening.set(sessionRef, opening);
    return await opening;
  }
  async #acquire(sessionRef: string): Promise<SessionLeaseSnapshot> {
    if (this.#active.size + this.#opening.size > MAX_WARM_RUNTIMES) throw new Error("session-runtime-capacity");
    const found = (await this.#listSessions()).filter(isUserConversationSession)
      .filter((info) => sessionRefForPath(this.#key, info.path) === sessionRef);
    if (found.length !== 1) throw new Error(found.length ? "session-ref-ambiguous" : "session-not-found");
    return await this.#activate(sessionRef, found[0]!);
  }
  async #activate(sessionRef: string, info: PiSessionInfo, sessionManager?: any): Promise<SessionLeaseSnapshot> {
    if (this.#active.has(sessionRef)) throw new Error("session-owner-conflict");
    const runtimeInstanceRef = `runtime_${randomBytes(24).toString("base64url")}`;
    const prior = this.#leases.inspect(sessionRef);
    if (prior.state === "gateway-owned" || prior.state === "terminal-owned") {
      try { this.#leases.releaseDeadOwnerForExplicitRecovery(sessionRef); } catch { /* live or unprovable owners stay authoritative */ }
    }
    const lease = this.#leases.acquire(sessionRef, this.#gatewayInstanceRef, runtimeInstanceRef);
    try {
      const runtime = await this.#runtimeFactory(info, runtimeInstanceRef, sessionManager);
      const current = this.#leases.inspect(sessionRef);
      if (current.state !== "gateway-owned" || current.ownerEpoch !== lease.ownerEpoch
        || current.gatewayInstanceRef !== this.#gatewayInstanceRef || current.runtimeInstanceRef !== runtimeInstanceRef) {
        await runtime.dispose().catch(() => undefined);
        throw new Error("session-owner-continuity-lost");
      }
      const active: ActiveRuntime = { runtime, lease: current, info, operationRef: null, stream: null, unsubscribe: null, completion: null,
        settling: false, approvalWaiting: false, unbindApproval: null, unsubscribeApproval: null,
        sessionManager: sessionManager ?? runtime.session?.sessionManager ?? null, watchdog: null, lastSessionRevision: null };
      this.#active.set(sessionRef, active);
      this.#bindApproval(sessionRef, active);
      return current;
    } catch (error) {
      try { this.#leases.requireRecovery(sessionRef, lease.ownerEpoch!, this.#gatewayInstanceRef, runtimeInstanceRef, "session-runtime-open-failed"); }
      catch { /* Existing acquired record still fails closed on the next Gateway. */ }
      throw error;
    }
  }
  async release(sessionRef: string): Promise<SessionLeaseSnapshot> {
    const active = this.#active.get(sessionRef);
    if (!active) {
      const current = this.#leases.inspect(sessionRef);
      if (current.state === "released") return current;
      throw new Error(current.state === "recovery-required" ? "session-recovery-required" : "session-owner-conflict");
    }
    if (active.operationRef) throw new Error("session-runtime-busy");
    if (active.settling && active.completion) await active.completion;
    if (active.operationRef || active.settling) throw new Error("session-runtime-busy");
    this.#active.delete(sessionRef);
    bestEffortUnsubscribe(active.unsubscribeApproval); bestEffortUnsubscribe(active.unbindApproval);
    try { await active.runtime.dispose(); }
    catch (error) {
      try { this.#leases.requireRecovery(sessionRef, active.lease.ownerEpoch!, this.#gatewayInstanceRef,
        active.lease.runtimeInstanceRef!, "session-runtime-dispose-failed"); } catch { /* remains fail closed */ }
      throw error;
    }
    const released = this.#leases.release(sessionRef, active.lease.ownerEpoch!, this.#gatewayInstanceRef, active.lease.runtimeInstanceRef!);
    const transient = this.#created.get(sessionRef);
    if (transient && !(await this.#listSessions()).some((info) => info.path === transient.path)) this.#created.delete(sessionRef);
    return released;
  }
  async restart(sessionRef: string): Promise<SessionLeaseSnapshot> {
    const active = this.#active.get(sessionRef);
    if (!active) return await this.acquire(sessionRef);
    if (active.operationRef || active.settling || !active.runtime.session?.isIdle) throw new Error("session-runtime-busy");
    const info = active.info, manager = active.sessionManager; await this.release(sessionRef);
    return await this.#activate(sessionRef, info, manager ?? undefined);
  }
  currentOperation(sessionRef: string): CurrentOperationProjection | null {
    const active = this.#active.get(sessionRef);
    if (!active?.operationRef) return null;
    return { operationRef: active.operationRef,
      state: active.settling ? "settling" : active.approvalWaiting ? "waiting-approval" : "running",
      abortable: !active.settling };
  }
  currentOperations(): Array<CurrentOperationProjection & { sessionRef: string }> {
    const result: Array<CurrentOperationProjection & { sessionRef: string }> = [];
    for (const sessionRef of this.#active.keys()) {
      const operation = this.currentOperation(sessionRef);
      if (operation) result.push({ sessionRef, ...operation });
    }
    return result;
  }
  ownership(sessionRef: string): SessionOwnerProjection {
    const lease = this.#leases.inspect(sessionRef);
    const active = this.#active.get(sessionRef);
    if (lease.state === "released") return {
      state: "offline", liveState: "offline", composerAvailable: true, needsAttention: false,
      owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "released" },
      reasonCode: null
    };
    if (lease.state === "gateway-owned" && active && active.lease.ownerEpoch === lease.ownerEpoch
      && lease.gatewayInstanceRef === this.#gatewayInstanceRef && active.lease.runtimeInstanceRef === lease.runtimeInstanceRef) return {
      state: "gateway-owned", liveState: active.approvalWaiting ? "waiting-approval" : active.operationRef ? "running" : "idle",
      composerAvailable: true, needsAttention: active.approvalWaiting,
      owner: { kind: "gateway", ownerEpoch: lease.ownerEpoch!, gatewayInstanceRef: lease.gatewayInstanceRef!,
        runtimeInstanceRef: lease.runtimeInstanceRef!, continuity: "exact" }, reasonCode: null
    };
    if (lease.state === "unavailable") return {
      state: "recovery-required", liveState: "uncertain", composerAvailable: false, needsAttention: true,
      owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "unknown" },
      reasonCode: lease.reasonCode ?? "session-lease-unavailable"
    };
    if (lease.state === "terminal-owned") return {
      state: "terminal-owned", liveState: "uncertain", composerAvailable: false, needsAttention: false,
      owner: { kind: "terminal", ownerEpoch: lease.ownerEpoch!,
        gatewayInstanceRef: `terminal_${createHmac("sha256", this.#key).update(lease.gatewayInstanceRef!).digest("base64url").slice(0, 43)}`,
        runtimeInstanceRef: lease.runtimeInstanceRef!, continuity: "exact" },
      reasonCode: "terminal-owner-active"
    };
    return {
      state: "recovery-required", liveState: "uncertain", composerAvailable: false, needsAttention: true,
      owner: { kind: "gateway", ownerEpoch: lease.ownerEpoch!, gatewayInstanceRef: lease.gatewayInstanceRef!,
        runtimeInstanceRef: lease.runtimeInstanceRef!, continuity: "uncertain" },
      reasonCode: lease.reasonCode ?? "session-owner-continuity-unknown"
    };
  }
  async send(sessionRef: string, payload: { delivery: "new-operation" | "follow-up" | "steer"; message: string;
    expectedOperationRef: string | null; images?: unknown[] }, sessionRevision: string):
  Promise<{ resultCode: "started" | "queued" | "steered"; operationRef: string }> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (payload.delivery !== "new-operation") {
      if (!active.operationRef || active.operationRef !== payload.expectedOperationRef || active.settling || !session.isStreaming) throw new Error("session-operation-conflict");
      const images = payload.images?.length ? payload.images : undefined;
      if (payload.delivery === "follow-up") { await session.followUp(payload.message, images); return { resultCode: "queued", operationRef: active.operationRef }; }
      await session.steer(payload.message, images); return { resultCode: "steered", operationRef: active.operationRef };
    }
    if (payload.expectedOperationRef !== null || active.operationRef || active.settling || !session.isIdle) throw new Error("session-operation-conflict");
    const operationRef = `operation_${randomBytes(24).toString("base64url")}`;
    const stream = new GatewaySessionStream({ sessionRef, operationRef, events: this.#events });
    const watchdog = new SessionOperationWatchdog(this.#operationDeadlinePolicy);
    active.operationRef = operationRef; active.stream = stream; active.watchdog = watchdog; active.lastSessionRevision = sessionRevision;
    try {
      active.unsubscribe = armSessionOperationWatchdog({ watchdog, subscribe: (listener) => session.subscribe(listener),
        observe: (event) => stream.observe(event), expire: (reasonCode) => { void this.#terminateOperation(sessionRef,
          operationRef, "error", reasonCode, reasonCode, true).catch(() => undefined); } });
    } catch (error) { stream.markError("session-operation-start-failed");
      await this.#quarantineRuntime(sessionRef, operationRef, active, stream, "session-operation-start-failed"); throw error; }
    this.#events.publish("runtime.changed", { sessionRef, sessionRevision, liveState: "running", operationRef, reasonCode: null });
    const created = this.#created.get(sessionRef);
    if (created && created.firstMessage === "(no messages)") {
      created.firstMessage = payload.message; created.allMessagesText = payload.message; created.messageCount = 1; created.modified = new Date();
    }
    let prompt: Promise<void>;
    try { prompt = session.prompt(payload.message, payload.images?.length ? { images: payload.images } : undefined); }
    catch (error) { stream.markError(); await this.#finishOperation(sessionRef, operationRef, stream); throw error; }
    const started = waitForOperationStart(stream, prompt);
    // `agent_settled` is canonical even when a workflow's outer prompt resolves first.
    const lifecycle = started.then(async (mode) => {
      if (mode === "deferred") await stream.settled();
      else await Promise.race([stream.settled(), prompt]);
    });
    active.completion = lifecycle.then(() => this.#finishOperation(sessionRef, operationRef, stream),
      () => { stream.markError(); return this.#finishOperation(sessionRef, operationRef, stream); });
    try { await started; }
    catch (error) { await active.completion; throw error; }
    return { resultCode: "started", operationRef };
  }
  async abort(sessionRef: string, operationRef: string, clearQueued: boolean): Promise<void> {
    await this.#terminateOperation(sessionRef, operationRef, "aborted", "operation-aborted", "operation-abort-timeout", clearQueued);
  }
  async #terminateOperation(sessionRef: string, operationRef: string, settlement: "aborted" | "error",
    reasonCode: string, forcedReasonCode: string, clearQueued: boolean): Promise<void> {
    const active = this.#active.get(sessionRef), session = active?.runtime.session, stream = active?.stream, watchdog = active?.watchdog;
    if (!active || !session || !stream || !watchdog || active.operationRef !== operationRef) throw new Error("session-operation-conflict");
    if (active.settling && !watchdog.terminating) throw new Error("session-operation-conflict");
    active.settling = true; active.approvalWaiting = false;
    const result = await terminateWatchedSessionOperation({ watchdog, settlement, reasonCode, forcedReasonCode, stream,
      completion: () => active.completion,
      settledCleanly: () => this.#active.get(sessionRef) === active && active.operationRef !== operationRef
        && session.isIdle === true && session.isStreaming !== true,
      cancelApproval: (reason) => { piApprovalBroker.cancelForOperation(active.info.cwd, active.info.id, operationRef, reason); },
      abortHost: () => session.abort(), clearQueue: clearQueued ? () => session.clearQueue() : undefined
    });
    if (result.state === "quarantine") await this.#quarantineRuntime(sessionRef, operationRef, active, stream, result.reasonCode);
    else if (this.#active.get(sessionRef) === active) { active.stream = null; active.watchdog = null; active.settling = false; }
  }
  async #quarantineRuntime(sessionRef: string, operationRef: string, active: ActiveRuntime,
    stream: GatewaySessionStream, reasonCode: string): Promise<void> {
    if (this.#active.get(sessionRef) !== active) return;
    bestEffortUnsubscribe(active.unsubscribe); active.unsubscribe = null; active.watchdog?.close(); active.watchdog = null;
    if (active.operationRef === operationRef) { active.operationRef = null; stream.complete(null); }
    active.stream = null; active.completion = null; active.settling = false; active.approvalWaiting = false;
    this.#active.delete(sessionRef); bestEffortUnsubscribe(active.unsubscribeApproval); bestEffortUnsubscribe(active.unbindApproval);
    try { this.#leases.requireRecovery(sessionRef, active.lease.ownerEpoch!, this.#gatewayInstanceRef,
      active.lease.runtimeInstanceRef!, reasonCode); } catch { /* continuity remains fail closed */ }
    if (active.lastSessionRevision) this.#events.publish("runtime.changed", { sessionRef,
      sessionRevision: active.lastSessionRevision, liveState: "uncertain", operationRef: null, reasonCode });
    await boundedResult(Promise.resolve().then(() => active.runtime.dispose()), this.#operationDeadlinePolicy.terminationTimeoutMs);
  }
  #bindApproval(sessionRef: string, active: ActiveRuntime): void {
    const authority = (): ApprovalAuthority => {
      if (!active.operationRef || active.lease.state !== "gateway-owned" || !active.lease.revision) return null;
      const task = activeSessionTask(active.info.cwd, active.info.id);
      const synthetic = (namespace: string) => `${namespace}_${createHmac("sha256", this.#key)
        .update(`${sessionRef}\0${namespace}`).digest("base64url").slice(0, 43)}`;
      const control = task ? inspectTaskControlState(active.info.cwd, task) : null;
      return {
        identity: {
          projectRef: projectRefForCwd(this.#key, active.info.cwd), runtimeInstanceId: active.lease.runtimeInstanceRef!, sessionRef,
          taskId: task?.taskId ?? synthetic("task"), taskRunId: task?.taskRunId ?? synthetic("task_run"),
          agentOperationId: active.operationRef
        },
        revisions: {
          runtimeRevision: active.lease.revision,
          taskRevision: task ? webUiTaskRevision(task) : synthetic("task_rev"),
          controlRevision: control?.controlRevision ?? synthetic("control_rev")
        },
        taskState: control?.state === "terminal" ? "terminal" : "active"
      };
    };
    active.unbindApproval = piApprovalBroker.bind({ cwd: active.info.cwd, rawSessionId: active.info.id,
      runtimeInstanceId: active.lease.runtimeInstanceRef!, authority });
    active.unsubscribeApproval = piApprovalBroker.subscribe(active.info.cwd, active.info.id, (event: ApprovalBrokerEvent) => {
      active.watchdog?.progress();
      const projection = piApprovalBroker.projection(active.info.cwd, active.info.id);
      active.approvalWaiting = projection.summary.state === "waiting";
      void this.#publishApprovalState(sessionRef, active, event);
    });
  }
  async #publishApprovalState(sessionRef: string, active: ActiveRuntime, event: ApprovalBrokerEvent): Promise<void> {
    try {
      const projection = await this.#readProjection?.(sessionRef);
      if (!projection || this.#active.get(sessionRef) !== active) return;
      active.lastSessionRevision = projection.sessionRevision;
      this.#events.publish("runtime.changed", { sessionRef, sessionRevision: projection.sessionRevision,
        liveState: active.approvalWaiting ? "waiting-approval" : active.operationRef ? "running" : projection.liveState,
        operationRef: active.operationRef, reasonCode: `approval-${event.kind}` });
    } catch { /* approval truth remains available through the canonical inspection route */ }
  }
  async setModel(sessionRef: string, modelRef: string): Promise<"model-changed" | "no-change"> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !session.isIdle) throw new Error("session-runtime-busy");
    const current = effectiveModelRef(session);
    if (current === modelRef) return "no-change";
    const models = session.modelRuntime?.getAvailableSnapshot?.() ?? [];
    const model = models.find((value: any) => webUiModelRef(String(value.provider ?? ""), String(value.id ?? value.modelId ?? "")) === modelRef);
    if (!model) throw new Error("session-model-unavailable");
    await session.setModel(model);
    const effective = effectiveModelRef(session);
    if (!effective) throw new Error("session-model-effect-unknown");
    if (effective !== modelRef) throw new Error("session-model-mismatch");
    this.#touchCreated(sessionRef);
    return "model-changed";
  }
  async setThinking(sessionRef: string, thinkingLevel: string): Promise<"thinking-changed" | "no-change"> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !session.isIdle) throw new Error("session-runtime-busy");
    const current = effectiveThinkingLevel(session);
    if (current === thinkingLevel) return "no-change";
    await session.setThinkingLevel(thinkingLevel);
    const effective = effectiveThinkingLevel(session);
    if (!effective) throw new Error("session-thinking-effect-unknown");
    if (effective !== thinkingLevel) throw new Error("session-thinking-mismatch");
    this.#touchCreated(sessionRef);
    return "thinking-changed";
  }
  async setPermission(sessionRef: string, permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<"permission-changed"> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !session.isIdle) throw new Error("session-runtime-busy");
    await executePermissionCommand(session, permissionMode);
    this.#touchCreated(sessionRef);
    return "permission-changed";
  }
  async runRuntimeCommand(sessionRef: string, command: string): Promise<RuntimeCommandResult> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (active.operationRef || active.settling || !session.isIdle) throw new Error("session-runtime-busy");
    const result = await executeRuntimeCommand(session, command); this.#touchCreated(sessionRef); return result;
  }
  approvalProjection(sessionRef: string): { revision: string | null; summary: Record<string, unknown> } {
    const active = this.#active.get(sessionRef);
    if (!active) return { revision: null, summary: { state: "unknown", pending: [], recent: [],
      health: { state: "unavailable", reasonCode: "approval-broker-unavailable", message: "Approval broker is unavailable" } } };
    return piApprovalBroker.projection(active.info.cwd, active.info.id);
  }
  approvalDetail(sessionRef: string, approvalRef: string): unknown | null {
    const active = this.#active.get(sessionRef);
    return active ? piApprovalBroker.detail(active.info.cwd, active.info.id, approvalRef) : null;
  }
  async decideApproval(approvalRef: string, decision: unknown): Promise<unknown> {
    for (const active of this.#active.values()) {
      if (piApprovalBroker.detail(active.info.cwd, active.info.id, approvalRef)) {
        return await piApprovalBroker.decide(active.info.cwd, active.info.id, approvalRef, decision);
      }
    }
    throw new Error("approval-not-pending");
  }
  async rename(sessionRef: string, title: string): Promise<"renamed" | "no-change"> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session?.sessionManager) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !session.isIdle) throw new Error("session-runtime-busy");
    const current = String(session.sessionManager.getSessionName?.() ?? "").trim();
    if (current === title.trim()) return "no-change";
    session.sessionManager.appendSessionInfo(title);
    this.#touchCreated(sessionRef);
    return "renamed";
  }
  async fork(sessionRef: string, entryRef: string | null, title: string | null): Promise<string> {
    if (!this.#host) throw new Error("session-fork-unavailable");
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), manager = active?.runtime.session?.sessionManager;
    if (!active || !manager) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !active.runtime.session?.isIdle) throw new Error("session-runtime-busy");
    const source = (await this.listSessions()).find((value) => sessionRefForPath(this.#key, value.path) === sessionRef);
    if (!source) throw new Error("session-not-found");
    let forkManager: any;
    if (entryRef) {
      const file = manager.createBranchedSession(entryRef);
      if (!file) throw new Error("session-fork-unavailable");
      forkManager = this.#host.SessionManager.open(file);
    } else {
      forkManager = this.#host.SessionManager.forkFrom(source.path, source.cwd);
    }
    if (title) forkManager.appendSessionInfo(title);
    const file = forkManager.getSessionFile(), id = forkManager.getSessionId?.();
    if (!file || typeof id !== "string") throw new Error("session-fork-unavailable");
    const persisted = (await this.#listSessions()).find((value) => value.path === file);
    const now = new Date(), created = persisted ?? { ...source, path: file, id, name: title ?? source.name,
      created: now, modified: now };
    const forkRef = sessionRefForPath(this.#key, file);
    this.#created.set(forkRef, created);
    return forkRef;
  }
  #touchCreated(sessionRef: string): void { const created = this.#created.get(sessionRef); if (created) created.modified = new Date(); }
  async #finishOperation(sessionRef: string, operationRef: string, stream: GatewaySessionStream): Promise<void> {
    const active = this.#active.get(sessionRef);
    if (!active || active.operationRef !== operationRef) return;
    const restartRequired = stream.runtimeRestartRequired; let projection: Projection | null = null;
    bestEffortUnsubscribe(active.unsubscribe); active.unsubscribe = null; active.watchdog?.close(); active.settling = true;
    try {
      if (this.#readProjection) {
        const read = await boundedResult(this.#readProjection(sessionRef), this.#operationDeadlinePolicy.projectionTimeoutMs);
        if (read.state === "settled") projection = read.value;
        else if (read.state === "timeout") stream.markError("session-projection-timeout");
      }
    } catch { /* Canonical refresh failure cannot be replaced by an invented revision. */ }
    if (this.#active.get(sessionRef) !== active || active.operationRef !== operationRef) return;
    if (this.ownership(sessionRef).state !== "gateway-owned") { stream.markError("session-owner-continuity-lost"); await this.#quarantineRuntime(sessionRef, operationRef, active, stream, "session-owner-continuity-lost"); return; }
    active.operationRef = null;
    if (projection) active.lastSessionRevision = projection.sessionRevision;
    stream.complete(projection?.sessionRevision ?? null);
    if (projection) this.#events.publish("runtime.changed", { sessionRef, sessionRevision: projection.sessionRevision,
      liveState: restartRequired ? "uncertain" : projection.liveState, operationRef: null,
      reasonCode: restartRequired ? "runtime-restart-required" : null });
    if (this.#active.get(sessionRef) === active) { active.completion = null;
      if (!active.watchdog?.terminating) { active.stream = null; active.watchdog = null; active.settling = false; } }
    if (!restartRequired || !projection || this.#active.get(sessionRef) !== active) return;
    let restartAuthority: ActiveRuntime | null = active;
    try {
      await this.restart(sessionRef); restartAuthority = this.#active.get(sessionRef) ?? null;
      const projection = await this.#readProjection?.(sessionRef);
      if (!projection || !restartAuthority || this.#active.get(sessionRef) !== restartAuthority || this.ownership(sessionRef).state !== "gateway-owned") return;
      this.#events.publish("runtime.changed", { sessionRef, sessionRevision: projection.sessionRevision, liveState: projection.liveState, operationRef: null, reasonCode: null });
    } catch {
      if (!restartAuthority || this.#active.get(sessionRef) !== restartAuthority || this.ownership(sessionRef).state !== "gateway-owned") return;
      this.#events.publish("runtime.changed", { sessionRef, sessionRevision: projection.sessionRevision, liveState: "uncertain", operationRef: null, reasonCode: "runtime-restart-failed" });
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#opening.values()]);
    await Promise.allSettled([...this.#active.entries()].filter(([, active]) => active.operationRef)
      .map(([sessionRef, active]) => this.abort(sessionRef, active.operationRef!, true)));
    await Promise.allSettled([...this.#active.keys()].map((sessionRef) => this.release(sessionRef)));
  }
}
