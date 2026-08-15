import { createHmac, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { redactSensitiveText } from "../../extensions/redaction-core.js";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PENDING = 32, MAX_RECENT = 64, DEFAULT_TTL_MS = 5 * 60_000;

type Identity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string;
  agentOperationId: string; toolCallId: string };
type TreePrecondition = { workspaceRevision: string; indexRevision: string | null; preimageDigest: string };
type Revisions = { runtimeRevision: string; taskRevision: string; controlRevision: string; approvalRevision: string;
  treePrecondition: TreePrecondition | null };
type ReceiptRevisions = Omit<Revisions, "treePrecondition">;
export type ApprovalAuthority = { identity: Omit<Identity, "toolCallId">; revisions: Omit<ReceiptRevisions, "approvalRevision">;
  taskState: "active" | "terminal" } | null;
export type ApprovalActionDraft = {
  kind: "external-provider-action" | "filesystem-write" | "filesystem-delete" | "workspace-patch" | "source-stage" | "source-unstage" | "source-revert";
  preconditionClass: "runtime-only" | "workspace-tree" | "workspace-index";
  toolName: string; rawAction: unknown; commandPreview?: string | null; parameterPreview?: string; targetPaths?: string[];
  targetSummaries?: string[]; provider?: string | null; urlOrigin?: string | null; requestedScope: string; reason: string;
  riskClass: "low" | "medium" | "high" | "critical"; allowConsequence: string; denyConsequence: string;
  treePrecondition?: TreePrecondition | null;
};
type Request = { schemaVersion: 1; version: "piagent-webui-approval-v1"; recordType: "request"; approvalRef: string; decisionToken: string;
  identity: Identity; action: Record<string, unknown>; expectedRevisions: Revisions; state: "waiting"; requestedAt: string; expiresAt: string;
  executor: "pi-guard"; directExecution: false };
type Receipt = { schemaVersion: 1; version: "piagent-webui-approval-v1"; recordType: "receipt"; approvalRef: string; decisionId: string | null;
  identity: Identity; actionDigest: string; state: "resolved" | "expired" | "cancelled"; decision: "allow" | "deny" | null;
  winnerSurface: "webui" | "terminal" | "runtime-expiry" | "runtime-control" | "runtime-restart"; resolutionReason: string | null;
  resolvedAt: string; preRevisions: Revisions; postRevisions: ReceiptRevisions; permit: Record<string, unknown>; deduplicated: boolean;
  auditRef: string; executor: "pi-guard"; directExecution: false };
type Binding = { cwd: string; rawSessionId: string; runtimeInstanceId: string; secret: Buffer; authority(): ApprovalAuthority;
  listeners: Set<(event: ApprovalBrokerEvent) => void>; pending: Map<string, Pending>; requests: Map<string, Request>; recent: Receipt[];
  approvalCounter: number; approvalRevision: string };
type Pending = { request: Request; resolve(value: ApprovalGuardDecision): void; receipt: Receipt | null; timer: NodeJS.Timeout;
  finalWaiters: Array<(receipt: Receipt) => void>; recheck(): boolean };
export type ApprovalBrokerEvent = { kind: "requested" | "resolved" | "expired" | "cancelled"; approvalRef: string; request?: Request; receipt?: Receipt };
export type ApprovalGuardDecision = { allowed: boolean; brokered: boolean; receipt: Receipt | null;
  consume(): boolean; cancel(reasonCode?: string): void };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function exactKeys(value: unknown, keys: string[]): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && canonical(Object.keys(value as Record<string, unknown>).sort()) === canonical([...keys].sort()));
}
function ref(prefix: string, secret: Buffer, value: unknown): string {
  return `${prefix}.${createHmac("sha256", secret).update(canonical(value)).digest("hex")}`;
}
function digest(secret: Buffer, value: unknown): string { return `sha256:${createHmac("sha256", secret).update(canonical(value)).digest("hex")}`; }
function safe(value: unknown, maximum: number): { text: string; redacted: boolean; truncated: boolean } {
  const raw = String(value ?? ""); const redacted = redactSensitiveText(raw);
  const clean = redacted.text.replace(/\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim();
  return { text: clean.slice(0, maximum), redacted: redacted.redacted, truncated: clean.length > maximum };
}
function publicId(value: string): string { const clean = safe(value, 160).text.replace(/[^A-Za-z0-9._:@~-]/g, "-"); return PUBLIC_REF.test(clean) ? clean : "unknown"; }
function reasonCode(value: string, fallback: string): string { const clean = safe(value, 96).text.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, ""); return clean || fallback; }
function key(cwd: string, rawSessionId: string): string { return `${cwd}\0${rawSessionId}`; }
function clone<T>(value: T): T { return structuredClone(value); }

export class PiApprovalBroker {
  readonly #bindings = new Map<string, Binding>();

  bind(input: { cwd: string; rawSessionId: string; runtimeInstanceId: string; authority(): ApprovalAuthority }): () => void {
    const bindingKey = key(input.cwd, input.rawSessionId), prior = this.#bindings.get(bindingKey);
    if (prior && prior.runtimeInstanceId !== input.runtimeInstanceId) this.#cancelBinding(prior, "runtime-replaced", "runtime-restart");
    if (prior?.runtimeInstanceId === input.runtimeInstanceId) { prior.authority = input.authority; return () => this.unbind(input); }
    const secret = randomBytes(32);
    const binding: Binding = { ...input, secret, listeners: new Set(), pending: new Map(), requests: new Map(), recent: [], approvalCounter: 0,
      approvalRevision: ref("approval-rev", secret, [input.runtimeInstanceId, 0]) };
    this.#bindings.set(bindingKey, binding);
    return () => this.unbind(input);
  }

  unbind(input: { cwd: string; rawSessionId: string; runtimeInstanceId: string }): void {
    const bindingKey = key(input.cwd, input.rawSessionId), binding = this.#bindings.get(bindingKey);
    if (!binding || binding.runtimeInstanceId !== input.runtimeInstanceId) return;
    this.#cancelBinding(binding, "runtime-stopped", "runtime-restart"); this.#bindings.delete(bindingKey);
  }

  subscribe(cwd: string, rawSessionId: string, listener: (event: ApprovalBrokerEvent) => void): () => void {
    const binding = this.#bindings.get(key(cwd, rawSessionId)); if (!binding) return () => undefined;
    binding.listeners.add(listener); return () => binding.listeners.delete(listener);
  }

  cancelForControl(cwd: string, rawSessionId: string, taskRunId: string, reason = "task-pausing"): number {
    const binding = this.#bindings.get(key(cwd, rawSessionId)); if (!binding) return 0;
    const targets = [...binding.pending.entries()].filter(([, pending]) => pending.request.identity.taskRunId === taskRunId);
    for (const [approvalRef] of targets) this.#cancelPending(binding, approvalRef, reason, "runtime-control", "cancelled");
    return targets.length;
  }

  projection(cwd: string, rawSessionId: string): { revision: string | null; summary: Record<string, unknown> } {
    const binding = this.#bindings.get(key(cwd, rawSessionId));
    if (!binding) return { revision: null, summary: { state: "unknown", pending: [], recent: [],
      health: { state: "unavailable", reasonCode: "approval-broker-unavailable", message: "Approval broker is unavailable" } } };
    const pending = [...binding.pending.values()].filter((item) => !item.receipt).map((item) => this.#summary(item.request));
    const recent = binding.recent.slice(-MAX_RECENT).reverse().map((item) => this.#summary(item));
    const latest = binding.recent.at(-1);
    const state = pending.length ? "waiting" : !latest ? "none" : latest.state === "expired" ? "expired" : "resolved";
    return { revision: binding.approvalRevision, summary: { state, pending, recent: state === "none" ? [] : recent,
      health: { state: "ok", reasonCode: null, message: null } } };
  }

  detail(cwd: string, rawSessionId: string, approvalRef: string): Request | null {
    if (!REF.test(approvalRef)) return null;
    const pending = this.#bindings.get(key(cwd, rawSessionId))?.pending.get(approvalRef);
    return pending && !pending.receipt ? clone(pending.request) : null;
  }

  async request(input: { cwd: string; rawSessionId: string; toolCallId: string; action: ApprovalActionDraft;
    expectedTask?: { taskId: string; taskRunId: string } | null; terminalConfirm(): Promise<boolean>; recheck?(): boolean; ttlMs?: number }): Promise<ApprovalGuardDecision> {
    const binding = this.#bindings.get(key(input.cwd, input.rawSessionId));
    const authority = binding?.authority();
    if (!binding || !authority || authority.taskState !== "active" || input.expectedTask && (authority.identity.taskId !== input.expectedTask.taskId || authority.identity.taskRunId !== input.expectedTask.taskRunId)
      || !REF.test(authority.identity.agentOperationId)
      || !REF.test(input.toolCallId) || binding.pending.size >= MAX_PENDING) return this.#terminalOnly(input.terminalConfirm);
    const now = Date.now(), requestedAt = new Date(now).toISOString(), expiresAt = new Date(now + Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 5_000), DEFAULT_TTL_MS)).toISOString();
    const approvalRef = ref("approval", binding.secret, [input.toolCallId, now, randomUUID()]);
    const decisionToken = randomBytes(32).toString("base64url");
    const nextRevision = this.#nextRevision(binding, "requested", approvalRef);
    const identity: Identity = { ...authority.identity, toolCallId: input.toolCallId };
    const action = this.#action(binding, input.action, input.cwd);
    const expectedRevisions: Revisions = { ...authority.revisions, approvalRevision: nextRevision,
      treePrecondition: input.action.preconditionClass === "runtime-only" ? null : input.action.treePrecondition ?? null };
    if ((input.action.preconditionClass !== "runtime-only" && !expectedRevisions.treePrecondition)
      || !this.#validTree(expectedRevisions.treePrecondition)) return this.#terminalOnly(input.terminalConfirm);
    const request: Request = { schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "request", approvalRef, decisionToken,
      identity, action, expectedRevisions, state: "waiting", requestedAt, expiresAt, executor: "pi-guard", directExecution: false };
    const result = new Promise<ApprovalGuardDecision>((resolve) => {
      const timer = setTimeout(() => this.#expire(binding, approvalRef), Date.parse(expiresAt) - Date.now()); timer.unref();
      binding.pending.set(approvalRef, { request, resolve, receipt: null, timer, finalWaiters: [], recheck: input.recheck ?? (() => true) }); binding.requests.set(approvalRef, request);
      while (binding.requests.size > MAX_PENDING + MAX_RECENT) binding.requests.delete(binding.requests.keys().next().value as string);
    });
    this.#emit(binding, { kind: "requested", approvalRef, request: clone(request) });
    void Promise.resolve().then(input.terminalConfirm).then(
      (allow) => this.#settle(binding, approvalRef, allow ? "allow" : "deny", "terminal", ref("decision", binding.secret, [approvalRef, "terminal", now])),
      () => this.#settle(binding, approvalRef, "deny", "terminal", ref("decision", binding.secret, [approvalRef, "terminal-error", now]))
    );
    return result;
  }

  async decide(cwd: string, rawSessionId: string, approvalRef: string, value: unknown): Promise<Receipt> {
    const binding = this.#bindings.get(key(cwd, rawSessionId)); if (!binding || !REF.test(approvalRef)) throw new Error("approval-unavailable");
    const pending = binding.pending.get(approvalRef);
    if (!pending) {
      const prior = binding.recent.find((item) => item.approvalRef === approvalRef);
      const request = binding.requests.get(approvalRef);
      if (prior && request && this.#validDecision(value, request, null) && (value as any).decisionId === prior.decisionId) return { ...clone(prior), deduplicated: true };
      throw new Error("approval-not-pending");
    }
    if (!this.#validDecision(value, pending.request, null)) throw new Error("approval-decision-invalid");
    const decision = value as any;
    if (pending.receipt) {
      if (decision.decisionId !== pending.receipt.decisionId) throw new Error("approval-already-resolved");
      if (pending.receipt.permit.status === "provisional") return new Promise<Receipt>((resolve) => pending.finalWaiters.push((receipt) => resolve({ ...receipt, deduplicated: true })));
      return { ...clone(pending.receipt), deduplicated: true };
    }
    if (Date.now() >= Date.parse(pending.request.expiresAt)) { this.#expire(binding, approvalRef); throw new Error("approval-expired"); }
    const final = new Promise<Receipt>((resolve) => pending.finalWaiters.push(resolve));
    this.#settle(binding, approvalRef, decision.decision, "webui", decision.decisionId);
    if (decision.decision === "deny") return clone(binding.recent.at(-1)!);
    return final;
  }

  #terminalOnly(confirm: () => Promise<boolean>): Promise<ApprovalGuardDecision> {
    return Promise.resolve().then(confirm).then((allowed) => ({ allowed, brokered: false, receipt: null,
      consume: () => allowed, cancel: () => undefined }), () => ({ allowed: false, brokered: false, receipt: null,
      consume: () => false, cancel: () => undefined }));
  }

  #action(binding: Binding, draft: ApprovalActionDraft, cwd: string): Record<string, unknown> {
    const command = draft.commandPreview === null || draft.commandPreview === undefined ? null : safe(draft.commandPreview, 4_000);
    const parameter = safe(draft.parameterPreview ?? "No additional parameters", 4_000);
    const targetPaths = (draft.targetPaths ?? []).slice(0, 32).map((item) => safe(item, 500)).filter((item) => item.text).map((item) => item.text);
    const targetSummaries = (draft.targetSummaries ?? []).slice(0, 32).map((item) => safe(item, 500)).filter((item) => item.text).map((item) => item.text);
    const removed = [command, parameter].filter((item) => item?.redacted).length;
    const truncated = Boolean(command?.truncated || parameter.truncated || (draft.targetPaths?.length ?? 0) > 32 || (draft.targetSummaries?.length ?? 0) > 32);
    const provider = draft.provider ? safe(draft.provider, 160).text : "";
    const targetProvided = targetPaths.length > 0 || targetSummaries.length > 0;
    return { kind: draft.kind, preconditionClass: draft.preconditionClass, toolName: publicId(draft.toolName),
      actionDigest: digest(binding.secret, draft.rawAction), canonicalization: "digest-bound-action-v1", previewPolicy: "redacted-no-secrets-v1",
      commandPreview: command?.text || null, parameterPreview: parameter.text || "No additional parameters",
      targetEvidence: targetProvided ? { state: "provided", reasonCode: null } : { state: "redacted", reasonCode: "target-not-exposed" },
      cwdRef: ref("cwd", binding.secret, cwd), cwdDisplay: safe(path.basename(cwd), 500).text || null,
      targetRefs: [], targetPaths, targetSummaries, providerRef: provider ? ref("provider", binding.secret, provider) : null,
      urlOrigin: /^https?:\/\/(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(?::[0-9]{1,5})?$/.test(draft.urlOrigin ?? "") ? draft.urlOrigin : null,
      requestedScope: reasonCode(draft.requestedScope, "one-action"), reason: safe(draft.reason, 500).text || "Human confirmation is required",
      riskClass: draft.riskClass, consequences: { allow: safe(draft.allowConsequence, 500).text || "Allow this exact action once",
        deny: safe(draft.denyConsequence, 500).text || "Block this action" },
      redaction: { applied: removed > 0, valuesRemoved: removed, truncated } };
  }

  #validDecision(value: unknown, request?: Request, receipt?: Receipt | null): boolean {
    if (!exactKeys(value, ["schemaVersion", "version", "recordType", "approvalRef", "decisionId", "decisionToken", "identity", "actionDigest",
      "expectedRevisions", "decision", "reason", "decidedAt", "expiresAt", "decisionSurface", "executor", "directExecution"])) return false;
    const item = value as any;
    if (item.schemaVersion !== 1 || item.version !== "piagent-webui-approval-v1" || item.recordType !== "decision"
      || !REF.test(item.approvalRef) || !REF.test(item.decisionId) || typeof item.decisionToken !== "string" || item.decisionToken.length < 32
      || !["allow", "deny"].includes(item.decision) || !exactTimestamp(item.decidedAt) || !exactTimestamp(item.expiresAt)
      || item.decisionSurface !== "webui" || item.executor !== "pi-guard" || item.directExecution !== false
      || !(item.reason === null || typeof item.reason === "string" && item.reason.length <= 500)) return false;
    if (request) return item.approvalRef === request.approvalRef && item.decisionToken === request.decisionToken
      && item.actionDigest === request.action.actionDigest && canonical(item.identity) === canonical(request.identity)
      && canonical(item.expectedRevisions) === canonical(request.expectedRevisions) && item.expiresAt === request.expiresAt
      && Date.parse(item.decidedAt) >= Date.parse(request.requestedAt) - 1_000 && Date.parse(item.decidedAt) <= Date.now() + 1_000;
    return Boolean(receipt && item.approvalRef === receipt.approvalRef && item.decisionId === receipt.decisionId
      && item.actionDigest === receipt.actionDigest && canonical(item.identity) === canonical(receipt.identity));
  }

  #validTree(value: TreePrecondition | null): boolean {
    return value === null || Boolean(REVISION.test(value.workspaceRevision) && (value.indexRevision === null || REVISION.test(value.indexRevision)) && DIGEST.test(value.preimageDigest));
  }

  #settle(binding: Binding, approvalRef: string, decision: "allow" | "deny", surface: "webui" | "terminal", decisionId: string): void {
    const pending = binding.pending.get(approvalRef); if (!pending || pending.receipt) return;
    clearTimeout(pending.timer); const resolvedAt = new Date().toISOString();
    const postRevision = this.#nextRevision(binding, "resolved", [approvalRef, decision, surface]);
    const receipt: Receipt = { schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "receipt", approvalRef, decisionId,
      identity: clone(pending.request.identity), actionDigest: String(pending.request.action.actionDigest), state: "resolved", decision,
      winnerSurface: surface, resolutionReason: null, resolvedAt, preRevisions: clone(pending.request.expectedRevisions),
      postRevisions: { runtimeRevision: pending.request.expectedRevisions.runtimeRevision, taskRevision: pending.request.expectedRevisions.taskRevision,
        controlRevision: pending.request.expectedRevisions.controlRevision, approvalRevision: postRevision },
      permit: decision === "allow" ? { status: "provisional", issuedAt: resolvedAt, consumedAt: null, reasonCode: null }
        : { status: "not-issued", issuedAt: null, consumedAt: null, reasonCode: null }, deduplicated: false,
      auditRef: ref("approval-audit", binding.secret, [approvalRef, resolvedAt, surface, decision]), executor: "pi-guard", directExecution: false };
    pending.receipt = receipt; binding.recent.push(receipt); binding.recent = binding.recent.slice(-MAX_RECENT);
    this.#emit(binding, { kind: "resolved", approvalRef, receipt: clone(receipt) });
    const decisionResult: ApprovalGuardDecision = { allowed: decision === "allow", brokered: true, receipt: clone(receipt),
      consume: () => this.#consume(binding, receipt), cancel: (reason = "guard-cancelled") => this.#cancelPermit(binding, receipt, reason) };
    pending.resolve(decisionResult);
    if (decision === "deny") this.#finish(binding, pending, receipt);
  }

  #consume(binding: Binding, receipt: Receipt): boolean {
    if (receipt.permit.status !== "provisional") return receipt.permit.status === "consumed";
    const authority = binding.authority();
    const pending = binding.pending.get(receipt.approvalRef);
    const expectedIdentity = { projectRef: receipt.identity.projectRef, runtimeInstanceId: receipt.identity.runtimeInstanceId,
      sessionRef: receipt.identity.sessionRef, taskId: receipt.identity.taskId, taskRunId: receipt.identity.taskRunId,
      agentOperationId: receipt.identity.agentOperationId };
    if (!authority || authority.taskState !== "active" || !pending?.recheck() || canonical(authority.identity) !== canonical(expectedIdentity)) {
      this.#cancelPermit(binding, receipt, "authority-changed"); return false;
    }
    const expected = receipt.preRevisions;
    if (authority.revisions.runtimeRevision !== expected.runtimeRevision || authority.revisions.taskRevision !== expected.taskRevision
      || authority.revisions.controlRevision !== expected.controlRevision || binding.approvalRevision !== receipt.postRevisions.approvalRevision) {
      this.#cancelPermit(binding, receipt, "revision-changed"); return false;
    }
    const consumedAt = new Date().toISOString(); receipt.permit = { status: "consumed", issuedAt: receipt.permit.issuedAt, consumedAt, reasonCode: null };
    receipt.postRevisions.approvalRevision = this.#nextRevision(binding, "permit-consumed", receipt.approvalRef);
    if (pending) this.#finish(binding, pending, receipt);
    this.#emit(binding, { kind: "resolved", approvalRef: receipt.approvalRef, receipt: clone(receipt) }); return true;
  }

  #cancelPermit(binding: Binding, receipt: Receipt, reason: string): void {
    if (receipt.permit.status !== "provisional") return;
    receipt.permit = { status: "cancelled", issuedAt: receipt.permit.issuedAt, consumedAt: null, reasonCode: reasonCode(reason, "guard-cancelled") };
    receipt.postRevisions.approvalRevision = this.#nextRevision(binding, "permit-cancelled", [receipt.approvalRef, reason]);
    const pending = binding.pending.get(receipt.approvalRef); if (pending) this.#finish(binding, pending, receipt);
    this.#emit(binding, { kind: "cancelled", approvalRef: receipt.approvalRef, receipt: clone(receipt) });
  }

  #expire(binding: Binding, approvalRef: string): void { this.#cancelPending(binding, approvalRef, "approval-expired", "runtime-expiry", "expired"); }
  #cancelBinding(binding: Binding, reason: string, surface: "runtime-restart" | "runtime-control"): void {
    for (const approvalRef of [...binding.pending.keys()]) this.#cancelPending(binding, approvalRef, reason, surface, "cancelled");
  }
  #cancelPending(binding: Binding, approvalRef: string, reason: string, surface: "runtime-expiry" | "runtime-restart" | "runtime-control", state: "expired" | "cancelled"): void {
    const pending = binding.pending.get(approvalRef); if (!pending || pending.receipt) return; clearTimeout(pending.timer);
    const resolvedAt = new Date().toISOString(), post = this.#nextRevision(binding, state, approvalRef);
    const receipt: Receipt = { schemaVersion: 1, version: "piagent-webui-approval-v1", recordType: "receipt", approvalRef, decisionId: null,
      identity: clone(pending.request.identity), actionDigest: String(pending.request.action.actionDigest), state, decision: null, winnerSurface: surface,
      resolutionReason: reasonCode(reason, "approval-cancelled"), resolvedAt, preRevisions: clone(pending.request.expectedRevisions),
      postRevisions: { runtimeRevision: pending.request.expectedRevisions.runtimeRevision, taskRevision: pending.request.expectedRevisions.taskRevision,
        controlRevision: pending.request.expectedRevisions.controlRevision, approvalRevision: post },
      permit: { status: state === "expired" ? "expired" : "cancelled", issuedAt: null, consumedAt: null, reasonCode: reasonCode(reason, "approval-cancelled") },
      deduplicated: false, auditRef: ref("approval-audit", binding.secret, [approvalRef, resolvedAt, surface]), executor: "pi-guard", directExecution: false };
    pending.receipt = receipt; binding.recent.push(receipt); binding.recent = binding.recent.slice(-MAX_RECENT);
    this.#emit(binding, { kind: state === "expired" ? "expired" : "cancelled", approvalRef, receipt: clone(receipt) });
    pending.resolve({ allowed: false, brokered: true, receipt: clone(receipt), consume: () => false, cancel: () => undefined }); this.#finish(binding, pending, receipt);
  }

  #finish(binding: Binding, pending: Pending, receipt: Receipt): void {
    binding.pending.delete(receipt.approvalRef); for (const resolve of pending.finalWaiters.splice(0)) resolve(clone(receipt));
  }
  #nextRevision(binding: Binding, kind: string, value: unknown): string {
    binding.approvalCounter += 1; binding.approvalRevision = ref("approval-rev", binding.secret, [binding.runtimeInstanceId, binding.approvalCounter, kind, value]);
    return binding.approvalRevision;
  }
  #emit(binding: Binding, event: ApprovalBrokerEvent): void { for (const listener of binding.listeners) { try { listener(clone(event)); } catch { /* projection listeners are fail-soft */ } } }
  #summary(value: Request | Receipt): Record<string, unknown> {
    if (value.recordType === "request") return { approvalRef: value.approvalRef, state: "waiting", resolution: null,
      actionSummary: safe(`${value.action.toolName}: ${value.action.reason}`, 500).text || "Approval required", toolCallId: value.identity.toolCallId,
      expiresAt: value.expiresAt, reasonCode: null };
    return { approvalRef: value.approvalRef, state: value.state === "expired" ? "expired" : "resolved",
      resolution: value.state === "expired" ? "expired" : value.state === "cancelled" ? "cancelled" : value.decision,
      actionSummary: safe(`${value.identity.toolCallId}: ${value.decision ?? value.state}`, 500).text || "Approval resolved",
      toolCallId: value.identity.toolCallId, expiresAt: null, reasonCode: value.state === "expired" ? value.resolutionReason : null };
  }
}

const BROKER_KEY = Symbol.for("piagent.webui.approval-broker.v1");
const root = globalThis as typeof globalThis & { [BROKER_KEY]?: PiApprovalBroker };
export const piApprovalBroker = root[BROKER_KEY] ??= new PiApprovalBroker();
