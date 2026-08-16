import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";

import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { webUiTaskRevision } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { activeSessionTask } from "../../piagent-core/extensions/task-state.js";
import { inspectTaskControlState } from "../../piagent-core/runtime/inspection/task-control-journal.ts";
import { piApprovalBroker, type ApprovalAuthority, type ApprovalBrokerEvent } from "../../piagent-core/runtime/inspection/approval-broker.ts";
import type { SessionOwnerProjection, PiSessionInfo } from "./session-catalog.ts";
import { projectRefForCwd, sessionRefForPath } from "./session-catalog.ts";
import { SessionLeaseStore, type SessionLeaseSnapshot } from "./session-lease-store.ts";
import { GatewayEventStore } from "./gateway-events.ts";
import { GatewaySessionStream } from "./gateway-session-stream.ts";
import { GATEWAY_RUNTIME_UI_MARKER } from "../ownership/gateway-runtime-context.ts";
import { preferAuthoritativePiagentGuard } from "./extension-authority.ts";

const MAX_WARM_RUNTIMES = 10;

type RuntimeHandle = { dispose(): Promise<void>; session?: any };
type RuntimeFactory = (info: PiSessionInfo, runtimeInstanceRef: string, sessionManager?: any) => Promise<RuntimeHandle>;
type ActiveRuntime = { runtime: RuntimeHandle; lease: SessionLeaseSnapshot; info: PiSessionInfo; operationRef: string | null;
  unsubscribe: (() => void) | null; completion: Promise<void> | null; settling: boolean; approvalWaiting: boolean;
  unbindApproval: (() => void) | null; unsubscribeApproval: (() => void) | null };
type Projection = { sessionRevision: string; liveState: "offline" | "idle" | "running" | "paused" | "waiting-approval" | "uncertain" };

function rpcUiContext(): object {
  const plain = (text: unknown): string => String(text ?? "");
  const theme = Object.freeze({
    fg: (_color: unknown, text: unknown) => plain(text),
    bg: (_color: unknown, text: unknown) => plain(text),
    bold: plain,
    italic: plain,
    underline: plain,
    inverse: plain,
    strikethrough: plain,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => plain,
    getBashModeBorderColor: () => plain
  });
  return new Proxy({}, {
    get(_target, property) {
      if (property === GATEWAY_RUNTIME_UI_MARKER) return true;
      if (property === "theme") return theme;
      if (property === "confirm") return () => new Promise<boolean>(() => undefined);
      if (property === "select" || property === "input") return async () => undefined;
      return () => undefined;
    }
  });
}

function productionRuntimeFactory(options: { host: any; agentDir: string; packageRoot: string; modelRuntime?: any }): RuntimeFactory {
  return async (info, _runtimeInstanceRef, sessionManager) => {
    const guard = path.join(options.packageRoot, "packages", "piagent-core", "extensions", "piagent-guard.ts");
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
      const services = await options.host.createAgentSessionServices({
        cwd, agentDir, modelRuntime: options.modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [guard],
          extensionsOverride: preferAuthoritativePiagentGuard(guard)
        }
      });
      const extensionErrors = services.resourceLoader.getExtensions().errors;
      if (extensionErrors.length) throw new Error("session-runtime-extension-load-failed");
      const created = await options.host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const manager = sessionManager ?? options.host.SessionManager.open(info.path);
    const runtime = await options.host.createAgentSessionRuntime(createRuntime, {
      cwd: info.cwd,
      agentDir: options.agentDir,
      sessionManager: manager,
      sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: info.path }
    });
    const bind = async (session: any) => session.bindExtensions({ mode: "rpc", uiContext: rpcUiContext() });
    runtime.setRebindSession(bind);
    try { await bind(runtime.session); }
    catch (error) { await runtime.dispose().catch(() => undefined); throw error; }
    return runtime;
  };
}

export class SessionRuntimeSupervisor {
  readonly #gatewayInstanceRef: string;
  readonly #key: Buffer;
  readonly #leases: SessionLeaseStore;
  readonly #listSessions: () => Promise<PiSessionInfo[]>;
  readonly #runtimeFactory: RuntimeFactory;
  readonly #events: GatewayEventStore;
  readonly #host: any | null;
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
    resolveProject?(projectRef: string): string | null;
  }) {
    this.#gatewayInstanceRef = options.gatewayInstanceRef;
    this.#key = options.key;
    this.#leases = options.leases;
    this.#listSessions = options.listSessions;
    this.#events = options.events ?? new GatewayEventStore();
    this.#host = options.host ?? null;
    this.#resolveProject = options.resolveProject ?? null;
    if (options.runtimeFactory) this.#runtimeFactory = options.runtimeFactory;
    else {
      if (!options.host || !options.agentDir || !options.packageRoot) throw new Error("session-runtime-factory-unavailable");
      this.#runtimeFactory = productionRuntimeFactory({ host: options.host, agentDir: options.agentDir,
        packageRoot: options.packageRoot, modelRuntime: options.modelRuntime });
    }
  }

  get activeCount(): number { return this.#active.size; }

  setProjectionReader(reader: (sessionRef: string) => Promise<Projection>): void { this.#readProjection = reader; }

  async listSessions(): Promise<PiSessionInfo[]> {
    const persisted = await this.#listSessions();
    const paths = new Set(persisted.map((info) => info.path));
    for (const [sessionRef, info] of this.#created) {
      if (paths.has(info.path)) this.#created.delete(sessionRef);
    }
    return [...persisted, ...[...this.#created.values()].filter((info) => !paths.has(info.path))];
  }

  async create(projectRef: string, placeRef: string, modelRef: string | null, thinkingLevel: string): Promise<string> {
    if (this.#closed || !this.#host) throw new Error("session-create-unavailable");
    if (placeRef !== projectRef) throw new Error("session-place-mismatch");
    const sessions = await this.#listSessions();
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
    await this.#activate(sessionRef, created, manager);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!session) throw new Error("session-runtime-unavailable");
    if (modelRef) {
      const models = session.modelRuntime?.getAvailableSnapshot?.() ?? [];
      const model = models.find((value: any) => webUiModelRef(String(value.provider ?? ""), String(value.id ?? "")) === modelRef);
      if (!model) throw new Error("session-model-unavailable");
      await session.setModel(model);
    }
    session.setThinkingLevel(thinkingLevel);
    this.#created.set(sessionRef, created);
    return sessionRef;
  }

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
    const found = (await this.#listSessions()).filter((info) => sessionRefForPath(this.#key, info.path) === sessionRef);
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
      const active: ActiveRuntime = { runtime, lease: current, info, operationRef: null, unsubscribe: null, completion: null,
        settling: false, approvalWaiting: false, unbindApproval: null, unsubscribeApproval: null };
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
    active.unsubscribeApproval?.(); active.unbindApproval?.();
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

  ownership(sessionRef: string): SessionOwnerProjection {
    const lease = this.#leases.inspect(sessionRef);
    const active = this.#active.get(sessionRef);
    if (lease.state === "released") return {
      state: "offline", liveState: "offline", composerAvailable: true, needsAttention: false,
      owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "released" },
      reasonCode: null
    };
    if (lease.state === "gateway-owned" && active && active.lease.ownerEpoch === lease.ownerEpoch
      && lease.gatewayInstanceRef === this.#gatewayInstanceRef) return {
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
    expectedOperationRef: string | null }, sessionRevision: string): Promise<{ resultCode: "started" | "queued" | "steered"; operationRef: string }> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (payload.delivery !== "new-operation") {
      if (!active.operationRef || active.operationRef !== payload.expectedOperationRef || !session.isStreaming) throw new Error("session-operation-conflict");
      if (payload.delivery === "follow-up") { await session.followUp(payload.message); return { resultCode: "queued", operationRef: active.operationRef }; }
      await session.steer(payload.message); return { resultCode: "steered", operationRef: active.operationRef };
    }
    if (payload.expectedOperationRef !== null || active.operationRef || active.settling || !session.isIdle) throw new Error("session-operation-conflict");
    const operationRef = `operation_${randomBytes(24).toString("base64url")}`;
    const stream = new GatewaySessionStream({ sessionRef, operationRef, events: this.#events });
    active.operationRef = operationRef;
    active.unsubscribe = session.subscribe((event: unknown) => stream.observe(event));
    this.#events.publish("runtime.changed", { sessionRef, sessionRevision, liveState: "running", operationRef, reasonCode: null });
    const created = this.#created.get(sessionRef);
    if (created && created.firstMessage === "(no messages)") {
      created.firstMessage = payload.message; created.allMessagesText = payload.message; created.messageCount = 1; created.modified = new Date();
    }
    let prompt: Promise<void>;
    try { prompt = session.prompt(payload.message); }
    catch (error) { await this.#finishOperation(sessionRef, operationRef, stream); throw error; }
    active.completion = prompt.then(() => this.#finishOperation(sessionRef, operationRef, stream),
      () => this.#finishOperation(sessionRef, operationRef, stream));
    await Promise.race([
      stream.started(),
      prompt.then(() => { throw new Error("session-operation-start-unobserved"); }, (error: unknown) => { throw error; })
    ]);
    return { resultCode: "started", operationRef };
  }

  async abort(sessionRef: string, operationRef: string, clearQueued: boolean): Promise<void> {
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session || active.operationRef !== operationRef) throw new Error("session-operation-conflict");
    const completion = active.completion;
    await session.abort();
    if (clearQueued) session.clearQueue();
    await completion;
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
      const projection = piApprovalBroker.projection(active.info.cwd, active.info.id);
      active.approvalWaiting = projection.summary.state === "waiting";
      void this.#publishApprovalState(sessionRef, active, event);
    });
  }

  async #publishApprovalState(sessionRef: string, active: ActiveRuntime, event: ApprovalBrokerEvent): Promise<void> {
    try {
      const projection = await this.#readProjection?.(sessionRef);
      if (!projection || this.#active.get(sessionRef) !== active) return;
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
    const current = session.model && typeof session.model === "object"
      ? webUiModelRef(String(session.model.provider ?? ""), String(session.model.id ?? session.model.modelId ?? "")) : null;
    if (current === modelRef) return "no-change";
    const models = session.modelRuntime?.getAvailableSnapshot?.() ?? [];
    const model = models.find((value: any) => webUiModelRef(String(value.provider ?? ""), String(value.id ?? "")) === modelRef);
    if (!model) throw new Error("session-model-unavailable");
    await session.setModel(model);
    this.#touchCreated(sessionRef);
    return "model-changed";
  }

  async setThinking(sessionRef: string, thinkingLevel: string): Promise<"thinking-changed" | "no-change"> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !session.isIdle) throw new Error("session-runtime-busy");
    const current = String(session.thinkingLevel ?? session.getThinkingLevel?.() ?? "unknown");
    if (current === thinkingLevel) return "no-change";
    session.setThinkingLevel(thinkingLevel);
    this.#touchCreated(sessionRef);
    return "thinking-changed";
  }

  async setPermission(sessionRef: string, permissionMode: "read-only" | "workspace-write" | "trusted-full-access"):
    Promise<"permission-changed"> {
    await this.acquire(sessionRef);
    const active = this.#active.get(sessionRef), session = active?.runtime.session;
    if (!active || !session) throw new Error("session-runtime-unavailable");
    if (active.operationRef || !session.isIdle) throw new Error("session-runtime-busy");
    const before = Array.isArray(session.messages) ? session.messages.length : 0;
    await session.prompt(`/permission ${permissionMode}`);
    const messages = Array.isArray(session.messages) ? session.messages.slice(before) : [];
    const observed = messages.reverse().find((message: any) => message?.role === "custom"
      && message.customType === "piagent-permission-profile");
    const profile = observed?.details?.permissionProfile;
    if (!profile || profile.mode !== permissionMode || profile.warning) throw new Error("session-permission-unavailable");
    this.#touchCreated(sessionRef);
    return "permission-changed";
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

  #touchCreated(sessionRef: string): void {
    const created = this.#created.get(sessionRef);
    if (created) created.modified = new Date();
  }

  async #finishOperation(sessionRef: string, operationRef: string, stream: GatewaySessionStream): Promise<void> {
    const active = this.#active.get(sessionRef);
    if (!active || active.operationRef !== operationRef) return;
    active.unsubscribe?.(); active.unsubscribe = null; active.operationRef = null; active.settling = true;
    try {
      const projection = await this.#readProjection?.(sessionRef);
      if (!projection) return;
      stream.complete(projection.sessionRevision);
      this.#events.publish("runtime.changed", { sessionRef, sessionRevision: projection.sessionRevision,
        liveState: projection.liveState, operationRef: null, reasonCode: null });
    } catch { /* Canonical refresh failure cannot be replaced by an invented revision. */ }
    finally {
      if (this.#active.get(sessionRef) === active) { active.settling = false; active.completion = null; }
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
