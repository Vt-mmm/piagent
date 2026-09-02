import crypto from "node:crypto";
import { currentWorkspaceRevisionDigest } from "../../extensions/workspace-revision.js";

import { hasDurableContextEvidence } from "../../extensions/context-evidence.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { runtimeAutomaticSourceExecutionReady, sourceExecutionAuthorized, sourcePlanningAuthorized } from "../../extensions/task-lifecycle.js";
import { latestObservedVerification, verificationEvidenceProvesStableTree } from "../../extensions/verification-intelligence.js";
import { workingTreeEvidenceDigest } from "../../extensions/working-tree-digest.js";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory, trajectoryPath } from "./trajectory-state.ts";
import { appendTrajectoryTransition, readTrajectoryStore, writeTrajectoryState } from "./trajectory-store.ts";
import type { TrajectoryRecommendationRef, TrajectorySourceHook, TrajectoryState, TrajectoryTransitionEvent } from "./trajectory-types.ts";
import type { SolverDecision } from "../solver/solver-types.ts";
import { buildOpenAiCodexWireFingerprint } from "../model/provider-wire-fingerprint.ts";

export type TrajectorySyncOptions = {
  sourceHook: TrajectorySourceHook;
  observedAt?: string;
  verificationStarted?: boolean;
  contextObserved?: boolean;
  handoffObserved?: boolean;
  recoveryMutationAllowed?: boolean;
  recoveryRequested?: boolean;
  recommendationRef?: TrajectoryRecommendationRef | null;
};

export type TrajectorySyncResult = {
  status: "ok" | "corrupt";
  initialized: boolean;
  enforcementSafe: boolean;
  state?: TrajectoryState;
  transitions: TrajectoryTransitionEvent[];
  warnings: string[];
};

export type TrajectoryStatus = { taskRunId: string | null; phase: TrajectoryState["currentPhase"] | null; enforcementSafe: boolean; warnings: string[] };

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function trajectoryRecommendationRef(decision: SolverDecision): TrajectoryRecommendationRef {
  return {
    solverPolicyVersion: decision.policyVersion,
    featureHash: decision.featureHash,
    route: decision.route,
    decisionDigest: digest(decision)
  };
}

function latestVerification(task: TaskContract): TaskContract["verifyEvidence"][number] | undefined {
  return latestObservedVerification(task.verifyEvidence) ?? undefined;
}

function stepObserved(task: TaskContract, ids: string[]): boolean {
  return task.workPlan.some((step) => ids.includes(step.id) && step.status !== "pending");
}

function phaseObservation(
  task: TaskContract,
  phase: string,
  options: TrajectorySyncOptions,
  currentTreeDigest?: string | null,
  workspaceRevisionDigest?: string | null
): TrajectoryTransitionEvent["cause"] | undefined {
  const latest = latestVerification(task);
  if (phase === "scout" && (options.contextObserved === true || hasDurableContextEvidence(task) || stepObserved(task, ["scope", "challenge", "scout"]))) return "context-observed";
  if (phase === "plan" && stepObserved(task, ["plan"])) return "plan-observed";
  if (phase === "execute") {
    if (sourceExecutionAuthorized(task)) return "execution-authorized";
    if (task.observedChangedFiles.length > 0) return "mutation-observed";
  }
  if (phase === "verify") {
    if (options.verificationStarted === true) return "verification-started";
    if (verificationEvidenceProvesStableTree(latest, currentTreeDigest, workspaceRevisionDigest)) return "verification-passed";
  }
  if (phase === "review" && stepObserved(task, ["review"])) return "review-observed";
  if (phase === "handoff" && options.handoffObserved === true) return "handoff-observed";
  return undefined;
}

function treeDigest(task: TaskContract): string | null {
  const snapshot = task.finalFileDigests ?? {};
  return Object.keys(snapshot).length > 0 ? workingTreeEvidenceDigest(snapshot) : null;
}

function recordTransition(cwd: string, state: TrajectoryState, event: TrajectoryTransitionEvent): TrajectoryState {
  const next = reduceTrajectory(state, event);
  appendTrajectoryTransition(cwd, event);
  return writeTrajectoryState(cwd, next);
}

export class TrajectoryRuntime {
  status(cwd: string, taskRunId: string | undefined): TrajectoryStatus {
    if (!taskRunId) return { taskRunId: null, phase: null, enforcementSafe: true, warnings: [] };
    const stored = readTrajectoryStore(cwd, taskRunId);
    return { taskRunId, phase: stored.state?.currentPhase ?? null, enforcementSafe: stored.enforcementSafe, warnings: stored.warnings };
  }

  syncOptional(cwd: string, sessionId: string, task: TaskContract | undefined, options: TrajectorySyncOptions): TrajectorySyncResult | undefined {
    return task ? this.sync(cwd, sessionId, task, options) : undefined;
  }

  sync(cwd: string, sessionId: string, task: TaskContract, options: TrajectorySyncOptions): TrajectorySyncResult {
    try { return this.syncDurable(cwd, sessionId, task, options); }
    catch (error) {
      wireSessions.get(wireKey(cwd, sessionId))?.invalidate("trajectory-sync-failed");
      throw error;
    }
  }

  private syncDurable(cwd: string, sessionId: string, task: TaskContract, options: TrajectorySyncOptions): TrajectorySyncResult {
    const stored = readTrajectoryStore(cwd, task.taskRunId);
    if (!stored.enforcementSafe) {
      wireSessions.get(wireKey(cwd, sessionId))?.invalidate("trajectory-store-corrupt");
      return { status: "corrupt", initialized: false, enforcementSafe: false, transitions: [], warnings: stored.warnings };
    }
    let initialized = false;
    let state = stored.state;
    if (!state) {
      state = createTrajectoryState({
        taskId: task.taskId,
        taskRunId: task.taskRunId,
        sessionId,
        changeMode: task.changeMode,
        riskLane: task.riskLane,
        recommendationRef: options.recommendationRef ?? null,
        createdAt: task.createdAt
      });
      state = writeTrajectoryState(cwd, state);
      initialized = true;
    } else if (stored.recoveredEvents > 0) {
      state = writeTrajectoryState(cwd, state);
    }
    if (state.recommendationRef === null && options.recommendationRef) {
      state = writeTrajectoryState(cwd, { ...state, recommendationRef: options.recommendationRef });
    }
    const transitions: TrajectoryTransitionEvent[] = [];
    const observedAt = options.observedAt ?? new Date().toISOString();
    const taskDigest = digest(task), currentTreeDigest = treeDigest(task);
    const workspaceRevisionDigest = currentWorkspaceRevisionDigest(cwd);
    const latest = latestVerification(task);
    if (state.currentPhase === "intake" && sourcePlanningAuthorized(task)) {
      const path = trajectoryPath(state.changeMode, state.riskLane);
      const planIndex = path.indexOf("plan");
      const skippedPhases = planIndex > 1 ? path.slice(1, planIndex) : [];
      if (skippedPhases.length > 0) {
        const event = createTrajectoryTransition(state, {
          to: "plan",
          cause: "explicit-skip",
          sourceHook: options.sourceHook,
          taskDigest,
          treeDigest: currentTreeDigest,
          skippedPhases,
          skipReason: "The persisted work plan starts with a manual plan checkpoint and defines no separate scout checkpoint.",
          observedAt
        });
        state = recordTransition(cwd, state, event);
        transitions.push(event);
      }
    }
    if (state.currentPhase === "intake" && runtimeAutomaticSourceExecutionReady(task)) {
      const path = trajectoryPath(state.changeMode, state.riskLane);
      const executeIndex = path.indexOf("execute");
      const skippedPhases = executeIndex > 0 ? path.slice(1, executeIndex) : [];
      const event = createTrajectoryTransition(state, {
        to: "execute",
        cause: "execution-authorized",
        sourceHook: options.sourceHook,
        taskDigest,
        treeDigest: currentTreeDigest,
        skippedPhases,
        skipReason: skippedPhases.length > 0
          ? "Runtime-owned automatic work plan has no manual plan checkpoint and its contract, scope, and exact verifier are ready."
          : null,
        observedAt
      });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    if (
      options.recoveryRequested === true
      && options.recoveryMutationAllowed === true
      && ["execute", "verify", "review"].includes(state.currentPhase)
    ) {
      const event = createTrajectoryTransition(state, {
        to: "repair",
        cause: "recovery-requested",
        sourceHook: options.sourceHook,
        taskDigest,
        treeDigest: currentTreeDigest,
        observedAt
      });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    const verificationFailed = Boolean(latest && latest.observed === true && (latest.isError === true || latest.exitCode !== 0));
    if (verificationFailed && options.recoveryMutationAllowed !== false && ["execute", "verify", "review"].includes(state.currentPhase)) {
      const event = createTrajectoryTransition(state, { to: "repair", cause: "verification-failed", sourceHook: options.sourceHook, taskDigest, treeDigest: currentTreeDigest, observedAt });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    const passingVerifierAfterRepair = verificationEvidenceProvesStableTree(latest, currentTreeDigest, workspaceRevisionDigest)
      && Date.parse(String(latest?.observedAt ?? latest?.recordedAt)) >= Date.parse(state.updatedAt);
    if (state.currentPhase === "repair" && (options.verificationStarted || passingVerifierAfterRepair)) {
      const event = createTrajectoryTransition(state, { to: "verify", cause: "verification-started", sourceHook: options.sourceHook, taskDigest, treeDigest: currentTreeDigest, observedAt });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    const path = trajectoryPath(state.changeMode, state.riskLane);
    while (state.currentPhase !== "terminal") {
      const currentIndex = path.indexOf(state.currentPhase);
      const next = currentIndex >= 0 ? path[currentIndex + 1] : undefined;
      const cause = next && next !== "terminal" ? phaseObservation(task, next, options, currentTreeDigest, workspaceRevisionDigest) : undefined;
      if (!next || next === "terminal" || !cause) break;
      const event = createTrajectoryTransition(state, { to: next, cause, sourceHook: options.sourceHook, taskDigest, treeDigest: currentTreeDigest, observedAt });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    if (task.trace.outcome !== "pending" && state.currentPhase !== "terminal") {
      const currentIndex = path.indexOf(state.currentPhase);
      const skippedPhases = currentIndex >= 0 ? path.slice(currentIndex + 1, -1) : [];
      const terminalRef = { taskRunId: task.taskRunId, taskUpdatedAt: task.updatedAt, taskDigest };
      const event = createTrajectoryTransition(state, {
        to: "terminal",
        cause: "task-terminal",
        sourceHook: options.sourceHook,
        taskDigest,
        treeDigest: currentTreeDigest,
        skippedPhases,
        skipReason: skippedPhases.length > 0 ? "Task Contract reached a terminal outcome before remaining trajectory phases." : null,
        observedAt,
        terminalTaskOutcomeRef: terminalRef
      });
      state = recordTransition(cwd, state, event);
      transitions.push(event);
    }
    observeHostWireTrajectory(cwd, sessionId, task, state, transitions, initialized);
    return { status: "ok", initialized, enforcementSafe: true, state, transitions, warnings: stored.warnings };
  }

  syncToolCall(cwd: string, sessionId: string, task: TaskContract, event: { toolName: string; input?: unknown }, observedAt?: string): TrajectorySyncResult {
    const input = event.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input as Record<string, unknown> : {};
    const command = String(input.command ?? input.cmd ?? "").trim();
    const verificationStarted = command.length > 0 && task.verifyCommands.some((candidate) => candidate.trim() === command);
    const handoffObserved = event.toolName === "piagent_trace_record";
    return this.sync(cwd, sessionId, task, { sourceHook: "tool-call", observedAt, verificationStarted, handoffObserved });
  }

  syncOptionalToolCall(cwd: string, sessionId: string, task: TaskContract | undefined, event: { toolName: string; input?: unknown }, observedAt?: string): TrajectorySyncResult | undefined {
    return task ? this.syncToolCall(cwd, sessionId, task, event, observedAt) : undefined;
  }
}

export const HOST_WIRE_PHASE_EDGES: Record<string, string[]> = {
  intake: ["scout", "plan", "execute", "review", "handoff", "terminal"],
  scout: ["plan", "review", "handoff", "terminal"], plan: ["execute", "review", "handoff", "terminal"],
  execute: ["verify", "repair", "handoff", "terminal"], verify: ["repair", "review", "handoff", "terminal"],
  repair: ["verify", "handoff", "terminal"], review: ["repair", "handoff", "terminal"], handoff: ["terminal"], terminal: []
};
for (const targets of Object.values(HOST_WIRE_PHASE_EDGES)) Object.freeze(targets);
Object.freeze(HOST_WIRE_PHASE_EDGES);
type WireRecord = Record<string, any>;
export type HostWireSessionOptions = {
  cwd: string; sessionId: string; runtimeInstanceRef: string; manifest: WireRecord;
  signReceipt: (material: string) => string;
  record: (envelope: { material: string; signature: string }) => void | Promise<void>;
};
export type HostWireOperation = { operationRef: string; messageRequestId: string; inputText: string };
export type HostWireSession = {
  beginOperation(input: HostWireOperation): (reason: string) => void;
  validatePayload(input: { payload: unknown; model: { provider?: string; id?: string }; hookErrors: number }): Promise<void>;
  dispose(): void;
};
type WireInput = { turnId: string; promptHash: string; text: string; source: string; hasImages: boolean };
type WireState = {
  invalidate(reason: string): void;
  observeInput(input: WireInput): void;
  observeTrajectory(task: TaskContract, state: TrajectoryState, events: TrajectoryTransitionEvent[], initialized: boolean): void;
};
const WIRE_REGISTRY_KEY = Symbol.for("piagent.host-wire-session.v1");
const wireRoot = globalThis as typeof globalThis & { [WIRE_REGISTRY_KEY]?: Map<string, WireState> };
const wireSessions = wireRoot[WIRE_REGISTRY_KEY] ??= new Map<string, WireState>();
const wireKey = (cwd: string, sessionId: string) => `${cwd}\0${sessionId}`;
const wireHash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const wireId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 2048 && !value.includes("\0");
const wireAssert = (condition: unknown, reason: string): void => { if (!condition) throw new Error(`host-wire-${reason}`); };

export function observeHostWireInput(cwd: string, sessionId: string, input: WireInput): void {
  wireSessions.get(wireKey(cwd, sessionId))?.observeInput(input);
}

function observeHostWireTrajectory(cwd: string, sessionId: string, task: TaskContract,
  state: TrajectoryState, events: TrajectoryTransitionEvent[], initialized: boolean): void {
  wireSessions.get(wireKey(cwd, sessionId))?.observeTrajectory(task, state, events, initialized);
}

/** Host callbacks are capabilities; neither a transcript entry nor a serialized task can invoke them. */
export function createHostWireSession(options: HostWireSessionOptions): HostWireSession {
  const manifest = structuredClone(options.manifest), key = wireKey(options.cwd, options.sessionId);
  wireAssert(!wireSessions.has(key), "session-already-bound");
  wireAssert(wireId(options.sessionId) && wireId(options.runtimeInstanceRef), "runtime-identity-missing");
  wireAssert(manifest.schemaVersion === 1 && manifest.protocol === "phase-valid-configuration-v1"
    && manifest.source === "pinned-host-definitions" && manifest.workingDirectory === options.cwd, "manifest-invalid");
  wireAssert([manifest.candidateDigest, manifest.configurationDigest, manifest.definitionDigest]
    .every((value) => /^[a-f0-9]{64}$/.test(value ?? "")), "manifest-identity-missing");
  wireAssert(manifest.requestedTier === "fast" && manifest.requestTier === "priority", "requested-tier-mismatch");
  wireAssert(JSON.stringify(manifest.allowedEdges) === JSON.stringify(HOST_WIRE_PHASE_EDGES), "phase-policy-mismatch");
  wireAssert(Array.isArray(manifest.states) && manifest.states.length > 0 && manifest.states.length <= 4096, "states-invalid");
  const selectors = new Set<string>(), stateIds = new Set<string>();
  for (const state of manifest.states) {
    wireAssert(state && wireId(state.id) && !stateIds.has(state.id), "state-id-invalid"); stateIds.add(state.id);
    wireAssert([state.operatorInputHash, state.inputHash].every((value) => /^[a-f0-9]{64}$/.test(value ?? "")), "input-hash-invalid");
    wireAssert((state.taskPresence === "none" && state.phase === null)
      || (state.taskPresence === "current" && Object.hasOwn(HOST_WIRE_PHASE_EDGES, state.phase)), "state-phase-invalid");
    const selector = JSON.stringify([state.operatorInputHash, state.inputHash, state.taskPresence, state.phase]);
    wireAssert(!selectors.has(selector), "state-selector-ambiguous"); selectors.add(selector);
    wireAssert(state.fingerprint?.state === "known" && /^[a-f0-9]{64}$/.test(state.fingerprint.requestPrefixFingerprint), "fingerprint-invalid");
  }
  const publicKey = crypto.createPublicKey({ key: Buffer.from(manifest.receiptPublicKey, "base64"), format: "der", type: "spki" });
  wireAssert(publicKey.asymmetricKeyType === "ed25519" && typeof options.signReceipt === "function"
    && typeof options.record === "function", "receipt-authority-missing");
  const manifestDigest = wireHash(JSON.stringify(manifest));
  let operation: (HostWireOperation & { operatorInputHash: string; token: string }) | undefined;
  let accepted: (WireInput & { inputHash: string }) | undefined;
  let task: { taskId: string; taskRunId: string; phase: string; sequence: number; outcome: string; stateDigest: string } | undefined;
  let disposed = false, pending = false, fault: string | undefined, sequence = 0, previousReceiptHash: string | null = null;
  const events: WireRecord[] = [];
  const fail = (reason: string): never => { fault = reason; throw new Error(`host-wire-${reason}`); };
  const live = () => { if (disposed || wireSessions.get(key) !== state) fail("runtime-retired"); if (fault) fail(fault); };
  const enqueue = (event: WireRecord) => { if (events.length >= 1024) fail("event-budget-exhausted"); events.push(structuredClone(event)); };
  const assertCurrentTrajectory = () => {
    if (!task) return;
    const stored = readTrajectoryStore(options.cwd, task.taskRunId);
    if (!stored.enforcementSafe || !stored.state || digest(stored.state) !== task.stateDigest) fail("trajectory-custody-changed");
  };
  const state: WireState = {
    invalidate(reason) { fault = reason; },
    observeInput(input) {
      live(); if (!operation || accepted) fail("input-not-admitted");
      if (input.hasImages !== false) fail("input-images-unprojected");
      if (!wireId(input.turnId) || !["rpc", "interactive", "extension"].includes(input.source)) fail("input-identity-invalid");
      const inputHash = wireHash(input.text.trim());
      if (!manifest.states.some((row: WireRecord) => row.operatorInputHash === operation!.operatorInputHash && row.inputHash === inputHash)) fail("input-not-in-manifest");
      accepted = { ...input, inputHash };
      enqueue({ type: "input-accepted", operationRef: operation.operationRef, messageRequestId: operation.messageRequestId,
        operatorInputHash: operation.operatorInputHash, inputHash, turnId: input.turnId, source: input.source });
    },
    observeTrajectory(observedTask, observedState, transitions, initialized) {
      if (!operation || !accepted) return;
      live();
      const stored = readTrajectoryStore(options.cwd, observedTask.taskRunId);
      if (!stored.enforcementSafe || JSON.stringify(stored.state) !== JSON.stringify(observedState)) fail("trajectory-readback-mismatch");
      if (observedTask.sessionId !== options.sessionId || observedState.taskId !== observedTask.taskId || observedState.taskRunId !== observedTask.taskRunId
        || observedState.sessionHash !== wireHash(options.sessionId)) fail("task-identity-mismatch");
      if (!task || task.taskRunId !== observedTask.taskRunId) {
        if (task && task.outcome === "pending") fail("pending-task-replaced");
        if (!initialized || transitions.length === 0 && observedState.sequence !== 0) fail("task-attachment-unproven");
        task = { taskId: observedTask.taskId, taskRunId: observedTask.taskRunId, phase: "intake", sequence: 0, outcome: "pending", stateDigest: "" };
        enqueue({ type: "task-attached", initialState: createTrajectoryState({ taskId: task.taskId, taskRunId: task.taskRunId,
          sessionId: options.sessionId, changeMode: observedState.changeMode, riskLane: observedState.riskLane,
          recommendationRef: observedState.recommendationRef, createdAt: observedState.createdAt }) });
      }
      for (const event of transitions) {
        if (event.taskRunId !== task.taskRunId || event.taskId !== task.taskId || event.from !== task.phase
          || event.sequence !== task.sequence + 1 || !HOST_WIRE_PHASE_EDGES[event.from]?.includes(event.to)) fail("trajectory-edge-invalid");
        enqueue({ type: "phase-transition", event }); task.phase = event.to; task.sequence = event.sequence;
      }
      if (task.phase !== observedState.currentPhase || task.sequence !== observedState.sequence) fail("trajectory-observation-gap");
      task.outcome = observedTask.trace.outcome;
      task.stateDigest = digest(observedState);
    }
  };
  wireSessions.set(key, state);
  return {
    beginOperation(input) {
      live(); if (operation || pending) fail("operation-already-active");
      if (!wireId(input.operationRef) || !wireId(input.messageRequestId) || !input.inputText.trim()) fail("operation-identity-invalid");
      const current = { ...input, operatorInputHash: wireHash(input.inputText.trim()), token: crypto.randomUUID() };
      if (!manifest.states.some((row: WireRecord) => row.operatorInputHash === current.operatorInputHash)) fail("operation-not-in-manifest");
      operation = current; accepted = undefined;
      if (task && task.outcome !== "pending" && task.phase === "terminal") {
        enqueue({ type: "task-detached", taskId: task.taskId, taskRunId: task.taskRunId, outcome: task.outcome }); task = undefined;
      }
      enqueue({ type: "operation-accepted", operationRef: current.operationRef, messageRequestId: current.messageRequestId,
        operatorInputHash: current.operatorInputHash, predecessorReceiptHash: previousReceiptHash });
      return (reason) => {
        if (operation !== current) return;
        enqueue({ type: "operation-closed", operationRef: current.operationRef, messageRequestId: current.messageRequestId, reason });
        operation = undefined; accepted = undefined;
      };
    },
    async validatePayload(input) {
      live(); if (!operation || !accepted || pending) fail("payload-without-current-input");
      assertCurrentTrajectory();
      if (input.hookErrors !== 0) fail("extension-hook-error");
      const current = operation, currentInput = accepted, phase = task?.phase ?? null, taskSequence = task?.sequence ?? 0;
      const selected = manifest.states.find((row: WireRecord) => row.operatorInputHash === current.operatorInputHash
        && row.inputHash === currentInput.inputHash && row.taskPresence === (task ? "current" : "none") && row.phase === phase);
      if (!selected) fail("state-not-in-manifest");
      const fingerprint = buildOpenAiCodexWireFingerprint({ payload: input.payload, provider: input.model.provider,
        modelId: input.model.id, workingDirectory: options.cwd, platformRoot: manifest.platformRoot });
      if (`${input.model.provider}/${input.model.id}` !== manifest.model || fingerprint.state !== "known"
        || fingerprint.reasoningEffort !== manifest.thinking || (input.payload as WireRecord)?.service_tier !== manifest.requestTier
        || JSON.stringify(fingerprint) !== JSON.stringify(selected.fingerprint)) fail("final-payload-drift");
      const material = JSON.stringify({ schemaVersion: 1, protocol: manifest.protocol, manifestDigest, sequence: sequence + 1,
        previousReceiptHash, sessionId: options.sessionId, workingDirectory: options.cwd, runtimeInstanceRef: options.runtimeInstanceRef,
        operationRef: current.operationRef, messageRequestId: current.messageRequestId, operatorInputHash: current.operatorInputHash,
        inputHash: currentInput.inputHash, turnId: currentInput.turnId, taskId: task?.taskId ?? null, taskRunId: task?.taskRunId ?? null,
        phase, trajectorySequence: taskSequence, stateId: selected.id, fingerprint, events: structuredClone(events) });
      const envelope = { material, signature: options.signReceipt(material) };
      if (!crypto.verify(null, Buffer.from(material), publicKey, Buffer.from(envelope.signature, "base64"))) fail("receipt-signature-invalid");
      pending = true;
      try {
        await options.record(structuredClone(envelope)); live(); assertCurrentTrajectory();
        if (operation !== current || accepted !== currentInput || task?.phase !== (phase ?? undefined)
          || (task?.sequence ?? 0) !== taskSequence) fail("payload-binding-superseded");
        previousReceiptHash = wireHash(JSON.stringify(envelope)); sequence += 1; events.length = 0;
      } catch (error) { fault ??= "receipt-not-durable"; throw error; }
      finally { pending = false; }
    },
    dispose() { disposed = true; operation = undefined; accepted = undefined; if (wireSessions.get(key) === state) wireSessions.delete(key); }
  };
}
