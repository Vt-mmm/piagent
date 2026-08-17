import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { webUiProjectRef, webUiSessionRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
export const WEBUI_CONTROL_ENTRY_TYPE = "piagent-webui-control-receipt-v1";
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/, PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/, MAX_EVENTS = 256, MAX_SESSION_ENTRIES = 50_000; type NullableRef = string | null;
export type { BridgeIdentity, BridgeRevisions, BridgeSnapshot } from "../../piagent-core/runtime/inspection/session-identity.ts";
import type { BridgeIdentity, BridgeRevisions, BridgeSnapshot } from "../../piagent-core/runtime/inspection/session-identity.ts";
export type BridgeTaskFacts = { taskId: string; taskRunId: string; taskRevision: string; controlRevision: string;
  controlState: "active" | "pause-requested" | "paused" | "terminal" | "unknown" } | null;
export type NewOperationChatCommand = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string; requestedAt: string;
  expiresAt: string; capabilityScope: "control.chat"; action: "chat.send"; actionDigest: string;
  identity: BridgeIdentity; expectedRevisions: BridgeRevisions & { workspacePreimage: null; indexPreimage: null; patchPreimage: null };
  payload: { messageRequestId: string; capabilityAction: "send"; delivery: "new-operation" | "follow-up" | "steer";
    text: string; attachmentRefs: string[]; contentDigest: string };
};
export type ChatReceipt = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string; idempotencyKeyDigest: string;
  action: "chat.send"; actionDigest: string; identity: BridgeIdentity; phase: "requested" | "accepted" | "settled" | "rejected" | "uncertain";
  resultCode: "dispatch-requested" | "dispatch-observed" | "dispatch-rejected" | "dispatch-unknown" | "identity-mismatch"
    | "stale-revision" | "capability-unavailable" | "replay" | "idempotency-payload-mismatch" | "expired" | "invalid-command" | "resync-required";
  requestedAt: string; settledAt: string | null; observedRevisionsBefore: BridgeRevisions; observedRevisionsAfter: BridgeRevisions; deduplicated: boolean;
  auditRef: string | null; settlementEvidenceRef: string | null; error: { code: string; message: string; retryable: boolean } | null;
};
export type BridgeEvent = { sequence: number; at: string; kind: "binding.ready" | "binding.closed" | "operation.started" | "operation.settled" | "command.receipt";
  sessionRef: string | null; operationRef: string | null; commandId: string | null; resultCode: string | null };
export type SessionOptionMutationPermit = { commitObservation(record: (before: BridgeRevisions, after: BridgeRevisions) => void): { before: BridgeRevisions; after: BridgeRevisions; recorded: boolean } | null; release(): void };
type Binding = { ctx: ExtensionContext; rawSessionId: string; identity: BridgeIdentity; revisions: BridgeRevisions; state: BridgeSnapshot["state"] };
type SessionOptionPermitState = { token: number; generation: number; rawSessionId: string; before: BridgeRevisions; externalConflict: boolean };
type DispatchContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type PreparedDispatch = { content: DispatchContent; observedText: string; commit?(): void; release?(): void };
type PendingDispatch = { command: NewOperationChatCommand; operationId: string; before: BridgeRevisions; leafBefore: string | null; correlationToken: string;
  observedText: string; resolve(receipt: ChatReceipt): void; timer: NodeJS.Timeout; inputObserved: boolean };
type Stored = { receipt: ChatReceipt; messageRequestId?: string; contentDigest?: string; attachmentRefs?: string[] };
function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function ref(prefix: string, value: unknown): string { return `${prefix}.${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; }
function copy<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false; const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function exactKeys(value: unknown, expected: string[]): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value as Record<string, unknown>).sort(), [...expected].sort()));
}
function validRef(value: unknown): value is string { return typeof value === "string" && REF.test(value); }
function validPublicRef(value: unknown): value is string { return typeof value === "string" && PUBLIC_REF.test(value); }
function validRevision(value: unknown): value is string { return typeof value === "string" && REVISION.test(value); }
function validDigest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value); }
function validIdentity(value: unknown): value is BridgeIdentity {
  if (!exactKeys(value, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])) return false;
  const identity = value as BridgeIdentity;
  return validRef(identity.projectRef) && validRef(identity.runtimeInstanceId) && validRef(identity.sessionRef)
    && (identity.taskId === null || validPublicRef(identity.taskId)) && (identity.taskRunId === null || validPublicRef(identity.taskRunId))
    && (identity.taskRunId === null || identity.taskId !== null) && (identity.agentOperationId === null || validRef(identity.agentOperationId))
    && identity.toolCallId === null;
}
function validRevisions(value: unknown): value is BridgeRevisions {
  if (!exactKeys(value, ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"])) return false;
  const revisions = value as BridgeRevisions;
  return validRevision(revisions.runtimeRevision) && [revisions.taskRevision, revisions.controlRevision, revisions.workspaceRevision,
    revisions.indexRevision, revisions.approvalRevision, revisions.sessionOptionRevision, revisions.queueRevision]
    .every((item) => item === null || validRevision(item));
}
function validError(value: unknown): boolean {
  return Boolean(exactKeys(value, ["code", "message", "retryable"]) && typeof (value as any).code === "string"
    && /^[a-z0-9][a-z0-9.-]{0,95}$/.test((value as any).code) && typeof (value as any).message === "string"
    && (value as any).message.length > 0 && (value as any).message.length <= 500 && typeof (value as any).retryable === "boolean");
}
function validReceipt(value: unknown): value is ChatReceipt {
  if (!exactKeys(value, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKeyDigest", "action", "actionDigest", "identity", "phase",
    "resultCode", "requestedAt", "settledAt", "observedRevisionsBefore", "observedRevisionsAfter", "deduplicated", "auditRef", "settlementEvidenceRef", "error"])) return false;
  const receipt = value as ChatReceipt;
  if (receipt.schemaVersion !== 1 || receipt.version !== "piagent-webui-control-v1" || receipt.messageType !== "receipt" || receipt.action !== "chat.send"
    || !validRef(receipt.commandId) || !validDigest(receipt.idempotencyKeyDigest) || !validDigest(receipt.actionDigest) || !validIdentity(receipt.identity)
    || !timestamp(receipt.requestedAt) || !validRevisions(receipt.observedRevisionsBefore) || !validRevisions(receipt.observedRevisionsAfter)
    || typeof receipt.deduplicated !== "boolean" || receipt.auditRef !== null) return false;
  if (receipt.phase === "requested") return receipt.resultCode === "dispatch-requested" && receipt.settledAt === null
    && receipt.settlementEvidenceRef === null && receipt.error === null && !receipt.deduplicated;
  if (receipt.phase === "accepted") return receipt.resultCode === "dispatch-requested" && receipt.settledAt === null
    && receipt.settlementEvidenceRef === null && receipt.error === null && !receipt.deduplicated;
  if (!timestamp(receipt.settledAt)) return false;
  if (receipt.phase === "settled") return receipt.resultCode === "dispatch-observed" && validRef(receipt.identity.agentOperationId)
    && validRef(receipt.settlementEvidenceRef) && receipt.error === null;
  if (receipt.phase === "uncertain") return receipt.resultCode === "dispatch-unknown" && receipt.settlementEvidenceRef === null && validError(receipt.error);
  const rejected = new Set<ChatReceipt["resultCode"]>(["dispatch-rejected", "identity-mismatch", "stale-revision", "capability-unavailable", "replay",
    "idempotency-payload-mismatch", "expired", "invalid-command", "resync-required"]);
  return receipt.phase === "rejected" && rejected.has(receipt.resultCode) && receipt.settlementEvidenceRef === null && validError(receipt.error)
    && (receipt.resultCode !== "replay" || receipt.deduplicated);
}
function messageText(message: any): string {
  return Array.isArray(message?.content) ? message.content.filter((item: any) => item?.type === "text").map((item: any) => String(item.text ?? "")).join("\n") : String(message?.content ?? "");
}
function firstMessageText(message: any): string { return Array.isArray(message?.content) ? String(message.content.find((item: any) => item?.type === "text")?.text ?? "") : String(message?.content ?? ""); }
function dispatchEntry(pending: PendingDispatch, ctx: ExtensionContext): any | null {
  return ctx.sessionManager.getBranch().find((entry: any) => entry?.type === "message" && entry.parentId === pending.leafBefore
    && entry.message?.role === "user" && messageText(entry.message) === pending.observedText) ?? null;
}
export function chatContentDigest(payload: Pick<NewOperationChatCommand["payload"], "text" | "attachmentRefs">): string {
  return sha(canonical({ text: payload.text, attachmentRefs: payload.attachmentRefs }));
}
export function controlActionDigest(command: { action: unknown; identity: unknown; expectedRevisions: unknown; payload: unknown }): string {
  return sha(canonical({ action: command.action, identity: command.identity, expectedRevisions: command.expectedRevisions, payload: command.payload }));
}
export const chatActionDigest = controlActionDigest;
export class SameSessionPiBridge {
  readonly #pi: ExtensionAPI;
  readonly #runtimeInstanceId: string;
  readonly #taskFacts: (ctx: ExtensionContext) => BridgeTaskFacts;
  readonly #prepareAttachments: ((refs: string[], messageRequestId: string, identity: BridgeIdentity, text: string) => PreparedDispatch) | null;
  readonly #now: () => Date;
  #binding: Binding | null = null;
  #generation = 0;
  #queueCounter = 0;
  #sessionOptionCounter = 0;
  #sessionOptionPermit: SessionOptionPermitState | null = null;
  #sessionOptionPermitCounter = 0;
  #operationCounter = 0;
  #pending: PendingDispatch | null = null;
  readonly #dispatchContext = new AsyncLocalStorage<string>();
  #receiptsByKey = new Map<string, ChatReceipt>();
  #receiptsByCommand = new Map<string, ChatReceipt>();
  #storedByKey = new Map<string, { messageRequestId: string; contentDigest: string; attachmentRefs: string[] }>();
  #messageRequests = new Set<string>();
  #serial: Promise<unknown> = Promise.resolve();
  #events: BridgeEvent[] = [];
  #sequence = 0;
  readonly #listeners = new Set<(event: BridgeEvent) => void>();
  constructor(pi: ExtensionAPI, options: { runtimeInstanceId: string; taskFacts?: (ctx: ExtensionContext) => BridgeTaskFacts; now?: () => Date;
    prepareAttachments?: (refs: string[], messageRequestId: string, identity: BridgeIdentity, text: string) => PreparedDispatch }) {
    if (!validRef(options.runtimeInstanceId)) throw new Error("webui-bridge-runtime-identity-invalid");
    this.#pi = pi; this.#runtimeInstanceId = options.runtimeInstanceId; this.#taskFacts = options.taskFacts ?? (() => null);
    this.#prepareAttachments = options.prepareAttachments ?? null; this.#now = options.now ?? (() => new Date());
  }
  #event(kind: BridgeEvent["kind"], details: Partial<Pick<BridgeEvent, "operationRef" | "commandId" | "resultCode">> = {}): void {
    const event = { sequence: ++this.#sequence, at: this.#now().toISOString(), kind, sessionRef: this.#binding?.identity.sessionRef ?? null,
      operationRef: details.operationRef ?? null, commandId: details.commandId ?? null, resultCode: details.resultCode ?? null } satisfies BridgeEvent;
    this.#events.push(event); if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    for (const listener of this.#listeners) {
      try { listener(copy(event)); } catch { /* observation is best-effort and never blocks authority settlement */ }
    }
  }
  #revision(prefix: string, ...parts: unknown[]): string { return ref(prefix, [this.#runtimeInstanceId, this.#generation, ...parts]); }
  #currentIdentity(ctx: ExtensionContext): BridgeIdentity {
    const task = this.#taskFacts(ctx);
    return { projectRef: webUiProjectRef(ctx.cwd), runtimeInstanceId: this.#runtimeInstanceId, sessionRef: webUiSessionRef(ctx.sessionManager.getSessionId()),
      taskId: task?.taskId ?? null, taskRunId: task?.taskRunId ?? null, agentOperationId: this.#binding?.identity.agentOperationId ?? null, toolCallId: null };
  }
  #currentRevisions(ctx: ExtensionContext): BridgeRevisions {
    const task = this.#taskFacts(ctx);
    return { runtimeRevision: this.#revision("runtime-rev", ctx.cwd, ctx.sessionManager.getSessionId(), this.#operationCounter), taskRevision: task?.taskRevision ?? null,
      controlRevision: task?.controlRevision ?? null, workspaceRevision: null, indexRevision: null, approvalRevision: null,
      sessionOptionRevision: this.#revision("session-option-rev", ctx.sessionManager.getSessionId(), this.#sessionOptionCounter),
      queueRevision: this.#revision("queue-rev", this.#queueCounter) };
  }
  #refresh(): void {
    if (!this.#binding) return;
    this.#binding.identity = this.#currentIdentity(this.#binding.ctx);
    this.#binding.revisions = this.#currentRevisions(this.#binding.ctx);
  }
  #loadReceipts(ctx: ExtensionContext): void {
    this.#receiptsByKey.clear(); this.#receiptsByCommand.clear(); this.#storedByKey.clear(); this.#messageRequests.clear();
    const branch = ctx.sessionManager.getBranch();
    if (!Array.isArray(branch) || branch.length > MAX_SESSION_ENTRIES) throw new Error("webui-bridge-receipt-history-unavailable");
    const requested = new Map<string, { receipt: ChatReceipt; messageRequestId: string; contentDigest: string; attachmentRefs: string[]; entryId: string }>();
    const entriesById = new Map(branch.map((entry: any) => [entry?.id, entry]));
    for (const entry of branch) {
      if (entry?.type !== "custom" || entry.customType !== WEBUI_CONTROL_ENTRY_TYPE) continue;
      if (!exactKeys(entry.data, ["receipt"]) && !exactKeys(entry.data, ["receipt", "messageRequestId", "contentDigest"])
        && !exactKeys(entry.data, ["receipt", "messageRequestId", "contentDigest", "attachmentRefs"])) throw new Error("webui-bridge-receipt-store-corrupt");
      const receipt = (entry.data as Stored).receipt;
      const messageRequestId = (entry.data as Stored).messageRequestId;
      const contentDigest = (entry.data as Stored).contentDigest;
      const attachmentRefs = (entry.data as Stored).attachmentRefs ?? [];
      if (!validReceipt(receipt) || !(messageRequestId === undefined || validRef(messageRequestId)) || !(contentDigest === undefined || validDigest(contentDigest)))
        throw new Error("webui-bridge-receipt-store-corrupt");
      if (!Array.isArray(attachmentRefs) || attachmentRefs.length > 4 || attachmentRefs.some((item) => !validRef(item))) throw new Error("webui-bridge-receipt-store-corrupt");
      if (receipt.identity.runtimeInstanceId !== this.#runtimeInstanceId || receipt.identity.sessionRef !== webUiSessionRef(ctx.sessionManager.getSessionId())) continue;
      if (attachmentRefs.length > 0) continue; // bytes are not persisted; proof is runtime-lifetime only
      if (receipt.resultCode === "idempotency-payload-mismatch") continue;
      const requestKey = `${receipt.commandId}\0${receipt.idempotencyKeyDigest}`;
      if (receipt.phase === "requested") {
        if (!messageRequestId || !contentDigest || !validRef(entry.id) || requested.has(requestKey)) throw new Error("webui-bridge-receipt-store-corrupt");
        requested.set(requestKey, { receipt, messageRequestId, contentDigest, attachmentRefs, entryId: entry.id });
      } else if (receipt.resultCode === "dispatch-observed" || receipt.resultCode === "dispatch-unknown" || receipt.phase === "accepted") {
        const prior = requested.get(requestKey);
        if (!prior || !messageRequestId || !contentDigest || messageRequestId !== prior.messageRequestId || contentDigest !== prior.contentDigest || receipt.actionDigest !== prior.receipt.actionDigest
          || receipt.requestedAt !== prior.receipt.requestedAt || !same(receipt.observedRevisionsBefore, prior.receipt.observedRevisionsBefore)
          || !same(receipt.identity, prior.receipt.identity) || !same(attachmentRefs, prior.attachmentRefs)) throw new Error("webui-bridge-receipt-store-corrupt");
        if (receipt.resultCode === "dispatch-observed") {
          const evidence = entriesById.get(receipt.settlementEvidenceRef as string) as any;
          if (!evidence || evidence.type !== "message" || evidence.parentId !== prior.entryId || evidence.message?.role !== "user"
            || chatContentDigest({ text: firstMessageText(evidence.message), attachmentRefs: prior.attachmentRefs }) !== prior.contentDigest) throw new Error("webui-bridge-receipt-store-corrupt");
        }
      }
      this.#receiptsByKey.set(receipt.idempotencyKeyDigest, copy(receipt)); this.#receiptsByCommand.set(receipt.commandId, copy(receipt));
      if (messageRequestId && contentDigest) {
        this.#messageRequests.add(messageRequestId); this.#storedByKey.set(receipt.idempotencyKeyDigest, { messageRequestId, contentDigest, attachmentRefs });
      }
    }
  }
  bind(ctx: ExtensionContext): void {
    const rawSessionId = ctx.sessionManager.getSessionId();
    if (typeof rawSessionId !== "string" || !rawSessionId || !validRef(this.#runtimeInstanceId)) throw new Error("webui-bridge-identity-unavailable");
    if (this.#pending) this.#settlePending("dispatch-unknown", "uncertain", "session-rebound-before-dispatch-observation", false);
    this.#generation += 1; this.#queueCounter = 0; this.#sessionOptionCounter = 0; this.#sessionOptionPermit = null;
    this.#operationCounter = 0; this.#pending = null;
    this.#binding = { ctx, rawSessionId, state: "ready", identity: {} as BridgeIdentity, revisions: {} as BridgeRevisions };
    try { this.#refresh(); this.#loadReceipts(ctx); this.#event("binding.ready"); }
    catch (error) { this.#binding = null; throw error; }
  }
  refresh(ctx: ExtensionContext): boolean {
    if (!this.#binding || this.#binding.rawSessionId !== ctx.sessionManager.getSessionId() || this.#binding.identity.projectRef !== webUiProjectRef(ctx.cwd)) return false;
    this.#binding.ctx = ctx; this.#refresh(); return true;
  }
  replacementPending(): void {
    if (!this.#binding) return;
    this.#binding.state = "replacement-pending";
    if (this.#pending) this.#settlePending("dispatch-unknown", "uncertain", "session-replacement-before-dispatch-observation", false);
    this.#event("binding.closed", { resultCode: "replacement-pending" });
  }
  revalidateUnchangedSession(ctx: ExtensionContext): boolean {
    if (!this.#binding || this.#binding.state !== "replacement-pending"
      || this.#binding.rawSessionId !== ctx.sessionManager.getSessionId()
      || this.#binding.identity.projectRef !== webUiProjectRef(ctx.cwd)) return false;
    this.#generation += 1; this.#binding.ctx = ctx; this.#binding.state = "ready"; this.#refresh();
    this.#event("binding.ready", { resultCode: "replacement-cancelled-or-failed" }); return true;
  }
  shutdown(ctx?: ExtensionContext): void {
    if (!this.#binding || ctx && this.#binding.rawSessionId !== ctx.sessionManager.getSessionId()) return;
    if (this.#pending) this.#settlePending("dispatch-unknown", "uncertain", "session-shutdown-before-dispatch-observation", false);
    this.#sessionOptionPermit = null; this.#binding.state = "shutdown"; this.#event("binding.closed", { resultCode: "shutdown" }); this.#binding = null;
  }
  snapshot(): BridgeSnapshot {
    if (!this.#binding) return { state: "unbound", identity: null, revisions: null, liveness: "unknown", taskState: "none", eventSequence: this.#sequence };
    this.#refresh();
    const task = this.#taskFacts(this.#binding.ctx);
    return { state: this.#binding.state, identity: copy(this.#binding.identity), revisions: copy(this.#binding.revisions),
      liveness: this.#binding.identity.agentOperationId ? "running" : this.#binding.ctx.isIdle() ? "idle" : "unknown",
      taskState: task?.controlState ?? "none", eventSequence: this.#sequence };
  }
  events(after = 0): { state: "current" | "resync-required"; events: BridgeEvent[]; latestSequence: number } {
    const first = this.#events[0]?.sequence ?? this.#sequence + 1;
    return { state: after > 0 && after < first - 1 ? "resync-required" : "current", events: this.#events.filter((event) => event.sequence > after).map(copy), latestSequence: this.#sequence };
  }
  subscribe(listener: (event: BridgeEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  commitQueueMutation(record: (before: BridgeRevisions, after: BridgeRevisions) => void): { before: BridgeRevisions; after: BridgeRevisions } | null {
    if (!this.#binding || this.#binding.state !== "ready") return null;
    this.#refresh();
    const before = copy(this.#binding.revisions), previousCounter = this.#queueCounter;
    this.#queueCounter += 1; this.#refresh();
    const after = copy(this.#binding.revisions);
    try { record(copy(before), copy(after)); }
    catch { this.#queueCounter = previousCounter; this.#refresh(); return null; }
    return { before, after };
  }
  #commitSessionOptionObservation(permit: SessionOptionPermitState,
    record: (before: BridgeRevisions, after: BridgeRevisions) => void): {
    before: BridgeRevisions; after: BridgeRevisions; recorded: boolean;
  } | null {
    if (!this.#binding || this.#binding.state !== "ready" || !this.#sessionOptionPermit
      || !same(this.#sessionOptionPermit, permit) || permit.generation !== this.#generation || permit.rawSessionId !== this.#binding.rawSessionId) return null;
    this.#refresh();
    const before = copy(permit.before);
    if (!permit.externalConflict) { this.#sessionOptionCounter += 1; this.#refresh(); }
    const after = copy(this.#binding.revisions); if (permit.externalConflict) return { before, after, recorded: false };
    try { record(copy(before), copy(after)); return { before, after, recorded: true }; }
    catch { return { before, after, recorded: false }; }
  }
  beginSessionOptionMutation(): SessionOptionMutationPermit | null {
    if (!this.#binding || this.#binding.state !== "ready" || this.#sessionOptionPermit || this.#pending
      || this.#binding.identity.agentOperationId || !this.#binding.ctx.isIdle()
      || (this.#taskFacts(this.#binding.ctx)?.controlState ?? "active") !== "active"
      || (typeof this.#binding.ctx.hasPendingMessages === "function" && this.#binding.ctx.hasPendingMessages())) return null;
    this.#refresh();
    const permit = { token: ++this.#sessionOptionPermitCounter, generation: this.#generation, rawSessionId: this.#binding.rawSessionId,
      before: copy(this.#binding.revisions), externalConflict: false };
    this.#sessionOptionPermit = permit;
    return {
      commitObservation: (record) => this.#commitSessionOptionObservation(permit, record),
      release: () => { if (this.#sessionOptionPermit && same(this.#sessionOptionPermit, permit)) this.#sessionOptionPermit = null; }
    };
  }
  sessionOptionMutationActive(ctx?: ExtensionContext): boolean {
    return Boolean(this.#sessionOptionPermit) && Boolean(this.#binding && (!ctx
      || this.#binding.rawSessionId === ctx.sessionManager.getSessionId() && this.#binding.identity.projectRef === webUiProjectRef(ctx.cwd)));
  }
  observeSessionOptionChange(ctx: ExtensionContext, causal = false): boolean {
    if (!this.refresh(ctx) || !this.#binding || !["ready", "replacement-pending"].includes(this.#binding.state)) return false;
    this.#sessionOptionCounter += 1;
    if (!causal && this.#sessionOptionPermit?.rawSessionId === this.#binding.rawSessionId) this.#sessionOptionPermit.externalConflict = true;
    this.#refresh(); return true;
  }
  observeInput(event: { source?: unknown; text?: unknown }, ctx: ExtensionContext): void {
    if ((event.source === "interactive" || event.source === "rpc") && this.#binding?.state === "replacement-pending") {
      this.revalidateUnchangedSession(ctx);
    }
    if (!this.refresh(ctx) || this.#binding?.state !== "ready") return; const pending = this.#pending;
    if (pending && event.source === "extension" && event.text === pending.observedText
      && this.#dispatchContext.getStore() === pending.correlationToken) {
      pending.inputObserved = true;
      if (pending.command.payload.delivery !== "new-operation") this.#acceptPending();
    }
  }
  observeMessageStart(event: { message?: unknown }, ctx: ExtensionContext): void {
    if (!this.refresh(ctx) || this.#binding?.state !== "ready") return; const pending = this.#pending, message = event.message as any;
    const leaf = pending ? ctx.sessionManager.getLeafEntry?.() : null;
    const leafObserved = Boolean(pending && leaf?.type === "message" && leaf.id !== pending.leafBefore && leaf.parentId === pending.leafBefore && leaf.message?.role === "user"
      && messageText(leaf.message) === pending.observedText);
    if (pending && pending.inputObserved && leafObserved && message?.role === "user" && messageText(message) === pending.observedText)
      this.#settlePending("dispatch-observed", "settled", null, true, leaf.id);
  }
  observeAgentStart(ctx: ExtensionContext): void {
    if (!this.refresh(ctx) || !this.#binding || this.#binding.state !== "ready") return;
    const pending = this.#pending;
    const operationId = pending?.operationId ?? this.#revision("operation", ++this.#operationCounter, "external");
    this.#binding.identity.agentOperationId = operationId; this.#refresh(); this.#event("operation.started", { operationRef: operationId, commandId: pending?.command.commandId });
    const observedEntry = pending ? dispatchEntry(pending, ctx) : null;
    const messageObserved = Boolean(observedEntry);
    if (pending && pending.inputObserved && messageObserved) this.#settlePending("dispatch-observed", "settled", null, true, observedEntry.id);
  }
  observeAgentSettled(ctx: ExtensionContext): void {
    if (!this.refresh(ctx) || !this.#binding || this.#binding.state !== "ready") return;
    const operationId = this.#binding.identity.agentOperationId;
    if (this.#pending) {
      const observedEntry = dispatchEntry(this.#pending, ctx);
      if (this.#pending.inputObserved && observedEntry) this.#settlePending("dispatch-observed", "settled", null, true, observedEntry.id);
      else this.#settlePending("dispatch-unknown", "uncertain", "agent-settled-without-dispatch-observation", false);
    }
    this.#binding.identity.agentOperationId = null; this.#operationCounter += 1; this.#refresh(); this.#event("operation.settled", { operationRef: operationId });
  }
  execute(command: NewOperationChatCommand): Promise<ChatReceipt> {
    const run = this.#serial.then(() => this.#execute(command), () => this.#execute(command));
    this.#serial = run.catch(() => undefined); return run;
  }
  async #execute(command: NewOperationChatCommand): Promise<ChatReceipt> {
    const binding = this.#binding, now = this.#now();
    const structural = this.#validate(command);
    if (!binding || binding.state !== "ready") return this.#rejection(command, "resync-required", "bridge-binding-not-ready", "The current Pi session binding is unavailable.");
    this.#refresh();
    if (structural) return this.#rejection(command, "invalid-command", structural, "The chat command is invalid.");
    const keyDigest = sha(command.idempotencyKey), oldByKey = this.#receiptsByKey.get(keyDigest), oldByCommand = this.#receiptsByCommand.get(command.commandId);
    if (oldByKey || oldByCommand) {
      const old = oldByKey ?? oldByCommand!;
      if (old.actionDigest !== command.actionDigest || old.commandId !== command.commandId || old.idempotencyKeyDigest !== keyDigest)
        return this.#rejection(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", "The command key was already bound to a different payload.");
      if (old.phase === "requested") {
        const stored = this.#storedByKey.get(old.idempotencyKeyDigest);
        if (!stored) return this.#rejection(command, "resync-required", "receipt-history-unavailable", "The requested dispatch cannot be reconciled.");
        const uncertain = { ...copy(old), phase: "uncertain" as const, resultCode: "dispatch-unknown" as const, settledAt: this.#now().toISOString(),
          observedRevisionsAfter: copy(this.#binding.revisions), deduplicated: false, settlementEvidenceRef: null,
          error: { code: "dispatch-acknowledgement-ambiguous", message: "A prior dispatch may have started; automatic resend is disabled.", retryable: false } };
        this.#record(uncertain, stored.messageRequestId, stored.contentDigest, stored.attachmentRefs); return uncertain;
      }
      return { ...copy(old), deduplicated: true };
    }
    if (Date.parse(command.requestedAt) > now.getTime() + 30_000) return this.#rejection(command, "invalid-command", "requested-at-in-future", "The chat command timestamp is not yet valid.");
    if (now.getTime() > Date.parse(command.expiresAt)) return this.#rejection(command, "expired", "command-expired", "The chat command expired before dispatch.");
    if (!same(command.identity, binding.identity)) return this.#rejection(command, "identity-mismatch", "identity-mismatch", "The command does not target the current Pi session.");
    if (command.expectedRevisions.runtimeRevision !== binding.revisions.runtimeRevision || command.expectedRevisions.queueRevision !== binding.revisions.queueRevision
      || command.expectedRevisions.taskRevision !== binding.revisions.taskRevision || command.expectedRevisions.controlRevision !== binding.revisions.controlRevision)
      return this.#rejection(command, "stale-revision", "stale-revision", "The current Pi session changed before dispatch.");
    if (this.#sessionOptionPermit)
      return this.#rejection(command, "capability-unavailable", "session-option-change-in-progress", "A model or thinking change is being settled.");
    const delivery = command.payload.delivery;
    const controlState = this.#taskFacts(binding.ctx)?.controlState;
    if (controlState && controlState !== "active" && !(controlState === "terminal" && delivery === "new-operation"))
      return this.#rejection(command, "capability-unavailable", controlState === "terminal" ? "task-terminal" : "task-control-gate-closed",
        controlState === "terminal" ? "A terminal task accepts only a new operation that can establish its successor." : "Task lifecycle control currently blocks dispatch.");
    if (delivery === "new-operation" && (!binding.ctx.isIdle() || binding.identity.agentOperationId))
      return this.#rejection(command, "dispatch-rejected", "agent-not-idle", "A new operation can start only while the Pi session is idle.");
    if (delivery !== "new-operation" && (binding.ctx.isIdle() || !binding.identity.agentOperationId))
      return this.#rejection(command, "dispatch-rejected", "agent-not-running", "Follow-up and Interrupt & Send require the current Pi operation to be running.");
    if (this.#messageRequests.has(command.payload.messageRequestId)) return this.#rejection(command, "replay", "message-request-replay", "This message request was already accepted.");
    let prepared: PreparedDispatch = { content: command.payload.text, observedText: command.payload.text };
    if (command.payload.attachmentRefs.length > 0) {
      if (!this.#prepareAttachments) return this.#rejection(command, "capability-unavailable", "attachments-unavailable", "Attachments are unavailable.");
      try { prepared = this.#prepareAttachments(command.payload.attachmentRefs, command.payload.messageRequestId, command.identity, command.payload.text); }
      catch { return this.#rejection(command, "dispatch-rejected", "attachment-reference-unavailable", "One or more staged attachments are unavailable."); }
    }
    const operationId = delivery === "new-operation"
      ? this.#revision("operation", ++this.#operationCounter, command.commandId, command.actionDigest)
      : binding.identity.agentOperationId as string;
    if (delivery === "new-operation") binding.identity.agentOperationId = operationId;
    this.#queueCounter += 1; const before = copy(binding.revisions); this.#refresh();
    const requested = this.#receipt(command, before, "requested", "dispatch-requested", null, false, operationId);
    if (!this.#record(requested, command.payload.messageRequestId, command.payload.contentDigest, command.payload.attachmentRefs)) {
      prepared.release?.();
      if (delivery === "new-operation") {
        binding.identity.agentOperationId = null; this.#operationCounter += 1; this.#refresh();
      }
      return this.#rejection(command, "capability-unavailable", "receipt-store-unavailable", "The durable session receipt store is unavailable.", "rejected", false);
    }
    this.#messageRequests.add(command.payload.messageRequestId);
    return new Promise<ChatReceipt>((resolve) => {
      const timer = setTimeout(() => this.#settlePending("dispatch-unknown", "uncertain", "dispatch-observation-timeout", false), 5_000); timer.unref();
      const correlationToken = `correlation.${randomBytes(24).toString("hex")}`;
      this.#pending = { command: copy(command), operationId, before, leafBefore: binding.ctx.sessionManager.getLeafId?.() ?? null,
        correlationToken, observedText: prepared.observedText, resolve, timer, inputObserved: false };
      try { this.#dispatchContext.run(correlationToken, () => this.#pi.sendUserMessage(prepared.content,
        delivery === "new-operation" ? undefined : { deliverAs: delivery === "steer" ? "steer" : "followUp" })); }
      catch { prepared.release?.(); this.#messageRequests.delete(command.payload.messageRequestId);
        this.#settlePending("dispatch-rejected", "rejected", "pi-send-user-message-rejected", false); return; }
      try { prepared.commit?.(); }
      catch { this.#settlePending("dispatch-unknown", "uncertain", "attachment-commit-unavailable", false); }
    });
  }
  #validate(command: NewOperationChatCommand): string | null {
    if (!command || typeof command !== "object" || command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1"
      || command.messageType !== "command" || command.action !== "chat.send" || command.capabilityScope !== "control.chat") return "unsupported-command-shape";
    if (!exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope", "action", "actionDigest", "identity", "expectedRevisions", "payload"])
      || !exactKeys(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      || !exactKeys(command.expectedRevisions, ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision", "workspacePreimage", "indexPreimage", "patchPreimage"])
      || !exactKeys(command.payload, ["messageRequestId", "capabilityAction", "delivery", "text", "attachmentRefs", "contentDigest"])) return "unknown-command-field";
    if (!validRef(command.commandId) || typeof command.idempotencyKey !== "string" || !IDEMPOTENCY.test(command.idempotencyKey)
      || !timestamp(command.requestedAt) || !timestamp(command.expiresAt)
      || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000) return "invalid-command-metadata";
    const revisions = command.expectedRevisions;
    if (!validIdentity(command.identity) || !validRevision(revisions.runtimeRevision) || !validRevision(revisions.queueRevision)
      || ![revisions.taskRevision, revisions.controlRevision, revisions.workspaceRevision, revisions.indexRevision, revisions.approvalRevision, revisions.sessionOptionRevision]
        .every((value) => value === null || validRevision(value)) || revisions.workspacePreimage !== null || revisions.indexPreimage !== null || revisions.patchPreimage !== null)
      return "invalid-authority-binding";
    const payload = command.payload;
    if (!payload || !validRef(payload.messageRequestId) || !["new-operation", "follow-up", "steer"].includes(payload.delivery)
      || payload.capabilityAction !== (payload.delivery === "steer" ? "interruptAndSend" : "send")
      || typeof payload.text !== "string" || payload.text.length < 1 || Buffer.byteLength(payload.text) > 65_536 || payload.text.includes("\0")
      || !Array.isArray(payload.attachmentRefs) || payload.attachmentRefs.length > 4 || new Set(payload.attachmentRefs).size !== payload.attachmentRefs.length
      || payload.attachmentRefs.some((item) => !validRef(item)) || payload.contentDigest !== chatContentDigest(payload)) return "invalid-message-payload";
    if (!validDigest(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    return null;
  }
  #receipt(command: NewOperationChatCommand, before: BridgeRevisions, phase: ChatReceipt["phase"], resultCode: ChatReceipt["resultCode"], reason: string | null,
    deduplicated: boolean, operationId: string | null, settlementEvidenceRef: string | null = null): ChatReceipt {
    const terminal = phase !== "requested" && phase !== "accepted", settledAt = terminal ? this.#now().toISOString() : null;
    const identity = { ...command.identity, agentOperationId: operationId };
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: command.commandId,
      idempotencyKeyDigest: sha(command.idempotencyKey), action: "chat.send", actionDigest: command.actionDigest, identity,
      phase, resultCode, requestedAt: command.requestedAt, settledAt, observedRevisionsBefore: copy(before),
      observedRevisionsAfter: copy(this.#binding?.revisions ?? before), deduplicated, auditRef: null,
      settlementEvidenceRef: phase === "settled" ? settlementEvidenceRef : null,
      error: phase === "rejected" || phase === "uncertain" ? { code: reason ?? resultCode, message: reason ? reason.replace(/-/g, " ") : resultCode, retryable: false } : null };
  }
  #rejection(command: NewOperationChatCommand, resultCode: ChatReceipt["resultCode"], reason: string, message: string,
    phase: "rejected" | "uncertain" = "rejected", persist = true): ChatReceipt {
    const fallback = this.#binding?.revisions ?? { runtimeRevision: ref("runtime-rev", "unbound"), taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    const safe = command && typeof command === "object" ? command : {} as NewOperationChatCommand;
    const safeIdentity = validIdentity(safe.identity) ? copy(safe.identity) : copy(this.#binding?.identity ?? { projectRef: ref("project", "unbound"), runtimeInstanceId: this.#runtimeInstanceId,
      sessionRef: ref("session", "unbound"), taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null });
    const safeCommand = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command",
      commandId: validRef(safe.commandId) ? safe.commandId : ref("command", reason),
      idempotencyKey: typeof safe.idempotencyKey === "string" && IDEMPOTENCY.test(safe.idempotencyKey) ? safe.idempotencyKey : "invalid-command-key-0000000000000000",
      requestedAt: timestamp(safe.requestedAt) ? safe.requestedAt : this.#now().toISOString(), expiresAt: this.#now().toISOString(),
      capabilityScope: "control.chat", action: "chat.send", actionDigest: validDigest(safe.actionDigest) ? safe.actionDigest : sha(reason),
      identity: safeIdentity, expectedRevisions: { ...fallback, workspacePreimage: null, indexPreimage: null, patchPreimage: null },
      payload: { messageRequestId: ref("message-request", reason), capabilityAction: "send", delivery: "new-operation", text: "invalid", attachmentRefs: [], contentDigest: sha("invalid") }
    } as NewOperationChatCommand;
    const receipt = { ...this.#receipt(safeCommand,
      fallback, phase, resultCode, reason, resultCode === "replay", validIdentity(safe.identity) ? safe.identity.agentOperationId : null),
      error: { code: reason, message, retryable: false } };
    if (persist) this.#record(receipt); return receipt;
  }
  #record(receipt: ChatReceipt, messageRequestId?: string, contentDigest?: string, attachmentRefs: string[] = []): boolean {
    try { this.#pi.appendEntry(WEBUI_CONTROL_ENTRY_TYPE, { receipt: copy(receipt), ...(messageRequestId && contentDigest ? { messageRequestId, contentDigest,
      ...(attachmentRefs.length ? { attachmentRefs: copy(attachmentRefs) } : {}) } : {}) } satisfies Stored); }
    catch { return false; }
    if (receipt.resultCode !== "idempotency-payload-mismatch") {
      this.#receiptsByKey.set(receipt.idempotencyKeyDigest, copy(receipt)); this.#receiptsByCommand.set(receipt.commandId, copy(receipt));
      if (messageRequestId && contentDigest) this.#storedByKey.set(receipt.idempotencyKeyDigest, { messageRequestId, contentDigest, attachmentRefs: copy(attachmentRefs) });
    }
    this.#event("command.receipt", { operationRef: receipt.identity.agentOperationId, commandId: receipt.commandId, resultCode: receipt.resultCode });
    return true;
  }
  #settlePending(resultCode: "dispatch-observed" | "dispatch-rejected" | "dispatch-unknown", phase: "settled" | "rejected" | "uncertain", reason: string | null,
    observed: boolean, evidenceRef: unknown = null): void {
    const pending = this.#pending; if (!pending) return; clearTimeout(pending.timer); this.#pending = null;
    if (!this.#binding) return pending.resolve(this.#rejection(pending.command, "dispatch-unknown", reason ?? "bridge-unbound", "Dispatch settlement is unavailable.", "uncertain"));
    const exactEvidenceRef = validRef(evidenceRef) ? evidenceRef : null;
    if (phase === "settled" && !exactEvidenceRef) { phase = "uncertain"; resultCode = "dispatch-unknown"; reason = "settlement-evidence-unavailable"; observed = false; }
    if (!observed && pending.command.payload.delivery === "new-operation") {
      this.#binding.identity.agentOperationId = null; this.#operationCounter += 1; this.#refresh();
    }
    const receipt = this.#receipt(pending.command, pending.before, phase, resultCode, reason, false, pending.operationId, exactEvidenceRef);
    if (this.#record(receipt, pending.command.payload.messageRequestId, pending.command.payload.contentDigest, pending.command.payload.attachmentRefs)) pending.resolve(receipt);
      else pending.resolve(this.#receipt(pending.command, pending.before, "uncertain", "dispatch-unknown", "settlement-receipt-store-unavailable", false, pending.operationId));
  }
  #acceptPending(): void {
    const pending = this.#pending; if (!pending) return;
    clearTimeout(pending.timer); this.#pending = null;
    if (!this.#binding) return pending.resolve(this.#rejection(pending.command, "dispatch-unknown", "bridge-unbound", "Dispatch acceptance is unavailable.", "uncertain"));
    const receipt = this.#receipt(pending.command, pending.before, "accepted", "dispatch-requested", null, false, pending.operationId);
    if (this.#record(receipt, pending.command.payload.messageRequestId, pending.command.payload.contentDigest, pending.command.payload.attachmentRefs)) pending.resolve(receipt);
    else pending.resolve(this.#receipt(pending.command, pending.before, "uncertain", "dispatch-unknown", "acceptance-receipt-store-unavailable", false, pending.operationId));
  }
}
