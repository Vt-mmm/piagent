import { createHash, randomBytes } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";
import {
  chatContentDigest,
  controlActionDigest,
  type BridgeIdentity,
  type BridgeRevisions,
  type ChatReceipt,
  type NewOperationChatCommand,
  type SameSessionPiBridge
} from "./same-session-bridge.ts";

export const WEBUI_QUEUE_ENTRY_TYPE = "piagent-webui-held-queue-v1";
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;
const MAX_ITEMS = 100;

type QueueAction = "queue.update" | "queue.delete" | "queue.dispatch";
export type QueueControlReceipt = Omit<ChatReceipt, "action" | "resultCode"> & {
  action: "chat.send" | QueueAction;
  resultCode: ChatReceipt["resultCode"] | "held" | "updated" | "deleted";
};
type QueueCommand = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "control.chat"; action: "chat.send" | QueueAction; actionDigest: string;
  identity: BridgeIdentity; expectedRevisions: BridgeRevisions & { workspacePreimage: null; indexPreimage: null; patchPreimage: null };
  payload: Record<string, unknown>;
};
type QueueItem = {
  queueItemRef: string; messageRequestId: string; text: string; attachmentRefs: string[]; contentDigest: string;
  state: "held" | "quarantined"; createdAt: string; updatedAt: string; reasonCode: string | null;
};
type QueueProjectionItem = {
  queueItemRef: string; messageRequestId: string; position: number; state: "held" | "quarantined"; preview: string; redacted: boolean;
  truncated: boolean; attachmentCount: number; previewDigest: string; createdAt: string; updatedAt: string; reasonCode: string | null;
};
type QueueProjection = {
  schemaVersion: 1; version: "piagent-webui-queue-v1"; generatedAt: string; identity: BridgeIdentity; revision: BridgeRevisions;
  state: "ready" | "unavailable"; heldCount: number; quarantinedCount: number; items: QueueProjectionItem[];
  reasonCode: string | null;
};

function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function copy<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function exactKeys(value: unknown, keys: string[]): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && same(Object.keys(value as object).sort(), [...keys].sort()));
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function validIdentity(value: unknown): value is BridgeIdentity {
  if (!exactKeys(value, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])) return false;
  const identity = value as BridgeIdentity;
  return [identity.projectRef, identity.runtimeInstanceId, identity.sessionRef].every((item) => typeof item === "string" && REF.test(item))
    && [identity.taskId, identity.taskRunId].every((item) => item === null || PUBLIC_REF.test(item))
    && (identity.agentOperationId === null || REF.test(identity.agentOperationId)) && identity.toolCallId === null
    && (identity.taskRunId === null || identity.taskId !== null);
}
function validRevisions(value: unknown): value is QueueCommand["expectedRevisions"] {
  if (!exactKeys(value, ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision",
    "sessionOptionRevision", "queueRevision", "workspacePreimage", "indexPreimage", "patchPreimage"])) return false;
  const revisions = value as QueueCommand["expectedRevisions"];
  return REVISION.test(revisions.runtimeRevision) && REVISION.test(revisions.queueRevision ?? "")
    && [revisions.taskRevision, revisions.controlRevision, revisions.workspaceRevision, revisions.indexRevision, revisions.approvalRevision,
      revisions.sessionOptionRevision].every((item) => item === null || REVISION.test(item))
    && revisions.workspacePreimage === null && revisions.indexPreimage === null && revisions.patchPreimage === null;
}
function safePreview(text: string): { preview: string; redacted: boolean; truncated: boolean } {
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const redacted = redactSensitiveText(cleaned);
  return { preview: redacted.text.slice(0, 4_000), redacted: redacted.redacted, truncated: redacted.text.length > 4_000 };
}

export class HeldMessageQueue {
  readonly #bridge: SameSessionPiBridge;
  readonly #appendEntry: (customType: string, data: unknown) => void;
  readonly #now: () => Date;
  #sessionRef: string | null = null;
  #lastIdentity: BridgeIdentity | null = null;
  #lastRevisions: BridgeRevisions | null = null;
  #items: QueueItem[] = [];
  #receiptsByKey = new Map<string, QueueControlReceipt>();
  #receiptsByCommand = new Map<string, QueueControlReceipt>();
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: { bridge: SameSessionPiBridge; appendEntry(customType: string, data: unknown): void; now?: () => Date }) {
    this.#bridge = options.bridge; this.#appendEntry = options.appendEntry; this.#now = options.now ?? (() => new Date());
  }

  reset(): void {
    this.#sessionRef = null; this.#lastIdentity = null; this.#lastRevisions = null; this.#items = [];
    this.#receiptsByKey.clear(); this.#receiptsByCommand.clear();
  }

  #sync(): ReturnType<SameSessionPiBridge["snapshot"]> {
    const snapshot = this.#bridge.snapshot();
    if (snapshot.identity && snapshot.revisions) {
      if (this.#sessionRef && this.#sessionRef !== snapshot.identity.sessionRef) this.reset();
      this.#sessionRef = snapshot.identity.sessionRef; this.#lastIdentity = copy(snapshot.identity); this.#lastRevisions = copy(snapshot.revisions);
    }
    return snapshot;
  }

  #projectItem(item: QueueItem, position: number): QueueProjectionItem {
    const preview = safePreview(item.text);
    return { queueItemRef: item.queueItemRef, messageRequestId: item.messageRequestId, position, state: item.state, ...preview,
      attachmentCount: item.attachmentRefs.length, previewDigest: sha(canonical({ ...preview, attachmentCount: item.attachmentRefs.length })),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
      reasonCode: item.reasonCode };
  }

  #evidence(command: QueueCommand, receipt: QueueControlReceipt, item: QueueItem, position: number, mutationRef: string): Record<string, unknown> {
    return { schemaVersion: 1, mutationRef, commandId: command.commandId, action: command.action, resultCode: receipt.resultCode,
      queueRevision: receipt.observedRevisionsAfter.queueRevision, item: this.#projectItem(item, position) };
  }

  projection(): QueueProjection {
    const snapshot = this.#sync(), ready = snapshot.state === "ready" && Boolean(snapshot.identity && snapshot.revisions);
    if (!this.#lastIdentity || !this.#lastRevisions) throw new Error("webui-held-queue-identity-unavailable");
    const items = ready ? this.#items.map((item, position) => this.#projectItem(item, position)) : [];
    return { schemaVersion: 1, version: "piagent-webui-queue-v1", generatedAt: this.#now().toISOString(), identity: copy(snapshot.identity ?? this.#lastIdentity),
      revision: copy(snapshot.revisions ?? this.#lastRevisions), state: ready ? "ready" : "unavailable",
      heldCount: items.filter((item) => item.state === "held").length, quarantinedCount: items.filter((item) => item.state === "quarantined").length,
      items, reasonCode: ready ? null : "bridge-binding-not-ready" };
  }

  snapshot(): { heldCount: number; quarantinedCount: number; queueRevision: string | null } {
    const projection = this.projection();
    return { heldCount: projection.heldCount, quarantinedCount: projection.quarantinedCount, queueRevision: projection.revision.queueRevision };
  }

  execute(command: unknown): Promise<QueueControlReceipt> {
    const run = this.#serial.then(() => this.#execute(command), () => this.#execute(command));
    this.#serial = run.catch(() => undefined); return run;
  }

  async #execute(input: unknown): Promise<QueueControlReceipt> {
    const command = input as QueueCommand;
    if (command?.action === "chat.send" && (command.payload as any)?.delivery !== "hold") return this.#bridge.execute(command as unknown as NewOperationChatCommand);
    const snapshot = this.#sync(), structural = this.#validate(command);
    if (snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions)
      return this.#reject(command, "resync-required", "bridge-binding-not-ready", "The current Pi session binding is unavailable.");
    if (structural) return this.#reject(command, "invalid-command", structural, "The queue command is invalid.");
    const keyDigest = sha(command.idempotencyKey), old = this.#receiptsByKey.get(keyDigest) ?? this.#receiptsByCommand.get(command.commandId);
    if (old) {
      if (old.commandId !== command.commandId || old.actionDigest !== command.actionDigest || old.idempotencyKeyDigest !== keyDigest)
        return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", "The command key is already bound to another payload.");
      return { ...copy(old), deduplicated: true };
    }
    const now = this.#now().getTime();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future", "The command timestamp is not yet valid.");
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired", "The command expired before execution.");
    if (!same(command.identity, snapshot.identity)) return this.#reject(command, "identity-mismatch", "identity-mismatch", "The command does not target this Pi session.");
    if (!["runtimeRevision", "taskRevision", "controlRevision", "queueRevision"].every((key) =>
      (command.expectedRevisions as any)[key] === (snapshot.revisions as any)[key]))
      return this.#reject(command, "stale-revision", "stale-revision", "The queue changed before this command.");
    if (command.action === "chat.send") return this.#hold(command);
    if (command.action === "queue.update") return this.#update(command);
    if (command.action === "queue.delete") return this.#delete(command);
    return this.#dispatch(command);
  }

  #validate(command: QueueCommand): string | null {
    if (!command || typeof command !== "object" || command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1"
      || command.messageType !== "command" || command.capabilityScope !== "control.chat"
      || !["chat.send", "queue.update", "queue.delete", "queue.dispatch"].includes(command.action)) return "unsupported-command-shape";
    if (!exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope",
      "action", "actionDigest", "identity", "expectedRevisions", "payload"]) || !validIdentity(command.identity) || !validRevisions(command.expectedRevisions)
      || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt) || !timestamp(command.expiresAt)
      || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000)
      return "invalid-command-metadata";
    const payload = command.payload;
    if (command.action === "chat.send") {
      if (!exactKeys(payload, ["messageRequestId", "capabilityAction", "delivery", "text", "attachmentRefs", "contentDigest"])
        || payload.capabilityAction !== "hold" || payload.delivery !== "hold" || typeof payload.messageRequestId !== "string" || !REF.test(payload.messageRequestId)
        || typeof payload.text !== "string" || payload.text.length < 1 || Buffer.byteLength(payload.text) > 65_536 || payload.text.includes("\0")
        || !Array.isArray(payload.attachmentRefs) || payload.attachmentRefs.length > 0 || payload.contentDigest !== chatContentDigest(payload as any)) return "invalid-hold-payload";
    } else if (command.action === "queue.update") {
      if (!exactKeys(payload, ["queueItemRef", "text", "attachmentRefs", "contentDigest"]) || typeof payload.queueItemRef !== "string" || !REF.test(payload.queueItemRef)
        || typeof payload.text !== "string" || payload.text.length < 1 || Buffer.byteLength(payload.text) > 65_536 || payload.text.includes("\0")
        || !Array.isArray(payload.attachmentRefs) || payload.attachmentRefs.length > 0 || payload.contentDigest !== chatContentDigest(payload as any)) return "invalid-update-payload";
    } else if (command.action === "queue.delete") {
      if (!exactKeys(payload, ["queueItemRef"]) || typeof payload.queueItemRef !== "string" || !REF.test(payload.queueItemRef)) return "invalid-delete-payload";
    } else if (!exactKeys(payload, ["queueItemRef", "messageRequestId"]) || typeof payload.queueItemRef !== "string" || !REF.test(payload.queueItemRef)
      || typeof payload.messageRequestId !== "string" || !REF.test(payload.messageRequestId)) return "invalid-dispatch-payload";
    if (!DIGEST.test(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    return null;
  }

  #hold(command: QueueCommand): QueueControlReceipt {
    if (this.#items.length >= MAX_ITEMS) return this.#reject(command, "capability-unavailable", "held-queue-full", "The held message queue is full.");
    if (this.#items.some((item) => item.messageRequestId === command.payload.messageRequestId))
      return this.#reject(command, "replay", "message-request-replay", "This held message request already exists.");
    const at = this.#now().toISOString(), item: QueueItem = { queueItemRef: this.#opaqueRef("queue-item"),
      messageRequestId: command.payload.messageRequestId as string, text: command.payload.text as string, attachmentRefs: [],
      contentDigest: command.payload.contentDigest as string, state: "held", createdAt: at, updatedAt: at, reasonCode: null };
    let receipt: QueueControlReceipt | null = null;
    const mutationRef = this.#opaqueRef("queue-mutation");
    const committed = this.#bridge.commitQueueMutation((before, after) => {
      receipt = this.#receipt(command, before, after, "accepted", "held", null, null);
      this.#appendEntry(WEBUI_QUEUE_ENTRY_TYPE, this.#evidence(command, receipt, item, this.#items.length, mutationRef));
    });
    if (!committed || !receipt) return this.#reject(command, "capability-unavailable", "queue-evidence-unavailable", "The held message could not be recorded.");
    this.#items.push(item); return this.#remember(receipt);
  }

  #update(command: QueueCommand): QueueControlReceipt {
    const index = this.#items.findIndex((item) => item.queueItemRef === command.payload.queueItemRef);
    if (index < 0 || this.#items[index].state !== "held") return this.#reject(command, "capability-unavailable", "queue-item-unavailable", "The held message is unavailable.");
    const projection = this.#projectItem(this.#items[index], index);
    if (projection.redacted || projection.truncated)
      return this.#reject(command, "capability-unavailable", "queue-item-preview-not-editable", "A redacted or truncated held message cannot be edited from its preview.");
    const next = { ...this.#items[index], text: command.payload.text as string, attachmentRefs: [], contentDigest: command.payload.contentDigest as string,
      updatedAt: this.#now().toISOString() };
    return this.#commitSettled(command, "updated", next, index, false);
  }

  #delete(command: QueueCommand): QueueControlReceipt {
    const index = this.#items.findIndex((item) => item.queueItemRef === command.payload.queueItemRef);
    if (index < 0) return this.#reject(command, "capability-unavailable", "queue-item-unavailable", "The held message is unavailable.");
    return this.#commitSettled(command, "deleted", this.#items[index], index, true);
  }

  #commitSettled(command: QueueCommand, resultCode: "updated" | "deleted", item: QueueItem, index: number, remove: boolean): QueueControlReceipt {
    const mutationRef = this.#opaqueRef("queue-mutation"); let receipt: QueueControlReceipt | null = null;
    const committed = this.#bridge.commitQueueMutation((before, after) => {
      receipt = this.#receipt(command, before, after, "settled", resultCode, null, mutationRef);
      this.#appendEntry(WEBUI_QUEUE_ENTRY_TYPE, this.#evidence(command, receipt, item, index, mutationRef));
    });
    if (!committed || !receipt) return this.#reject(command, "capability-unavailable", "queue-evidence-unavailable", "The queue change could not be recorded.");
    if (remove) this.#items.splice(index, 1); else this.#items[index] = item;
    return this.#remember(receipt);
  }

  async #dispatch(command: QueueCommand): Promise<QueueControlReceipt> {
    const index = this.#items.findIndex((item) => item.queueItemRef === command.payload.queueItemRef), beforeSnapshot = this.#bridge.snapshot();
    if (index < 0 || this.#items[index].state !== "held" || !beforeSnapshot.identity || !beforeSnapshot.revisions)
      return this.#reject(command, "capability-unavailable", "queue-item-unavailable", "The held message is unavailable.");
    if (beforeSnapshot.liveness === "unknown") return this.#reject(command, "capability-unavailable", "agent-liveness-unknown", "Pi operation state is unknown.");
    const item = this.#items[index], payload = { messageRequestId: command.payload.messageRequestId as string, capabilityAction: "send" as const,
      delivery: beforeSnapshot.liveness === "running" ? "follow-up" as const : "new-operation" as const,
      text: item.text, attachmentRefs: item.attachmentRefs, contentDigest: item.contentDigest };
    const inner: NewOperationChatCommand = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command",
      commandId: this.#ref("queue-dispatch", command.commandId, command.actionDigest), idempotencyKey: `queue-dispatch.${sha(command.idempotencyKey).slice(7)}`,
      requestedAt: command.requestedAt, expiresAt: command.expiresAt, capabilityScope: "control.chat", action: "chat.send", actionDigest: "",
      identity: copy(beforeSnapshot.identity), expectedRevisions: { ...copy(beforeSnapshot.revisions), workspacePreimage: null, indexPreimage: null, patchPreimage: null }, payload };
    inner.actionDigest = controlActionDigest(inner);
    const innerReceipt = await this.#bridge.execute(inner);
    if (innerReceipt.phase === "rejected") return this.#reject(command, innerReceipt.resultCode as ChatReceipt["resultCode"], innerReceipt.error?.code ?? "dispatch-rejected",
      innerReceipt.error?.message ?? "The held message was not dispatched.");
    const uncertain = innerReceipt.phase === "uncertain", removed = !uncertain;
    const nextItem = { ...item, state: "quarantined" as const, updatedAt: this.#now().toISOString(), reasonCode: "dispatch-acknowledgement-ambiguous" };
    const mutationRef = this.#opaqueRef("queue-mutation"); let receipt: QueueControlReceipt | null = null;
    const committed = this.#bridge.commitQueueMutation((before, after) => {
      receipt = this.#receipt(command, copy(beforeSnapshot.revisions!), after, innerReceipt.phase, innerReceipt.resultCode as ChatReceipt["resultCode"],
        innerReceipt.error, innerReceipt.settlementEvidenceRef, innerReceipt.identity);
      this.#appendEntry(WEBUI_QUEUE_ENTRY_TYPE, this.#evidence(command, receipt, uncertain ? nextItem : item, index, mutationRef));
    });
    if (!committed || !receipt) {
      this.#items[index] = nextItem;
      return this.#receipt(command, copy(beforeSnapshot.revisions), this.#bridge.snapshot().revisions ?? copy(beforeSnapshot.revisions), "uncertain", "dispatch-unknown",
        { code: "queue-settlement-evidence-unavailable", message: "Dispatch may have occurred; the queue item was quarantined.", retryable: false }, null,
        innerReceipt.identity);
    }
    if (removed) this.#items.splice(index, 1); else this.#items[index] = nextItem;
    return this.#remember(receipt);
  }

  #receipt(command: QueueCommand, before: BridgeRevisions, after: BridgeRevisions, phase: ChatReceipt["phase"], resultCode: QueueControlReceipt["resultCode"],
    error: ChatReceipt["error"], settlementEvidenceRef: string | null, identity: BridgeIdentity = command.identity): QueueControlReceipt {
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: command.commandId,
      idempotencyKeyDigest: sha(command.idempotencyKey), action: command.action, actionDigest: command.actionDigest, identity: copy(identity), phase, resultCode,
      requestedAt: command.requestedAt, settledAt: ["requested", "accepted"].includes(phase) ? null : this.#now().toISOString(),
      observedRevisionsBefore: copy(before), observedRevisionsAfter: copy(after), deduplicated: false, auditRef: null,
      settlementEvidenceRef: phase === "settled" ? settlementEvidenceRef : null, error };
  }

  #reject(command: QueueCommand, resultCode: QueueControlReceipt["resultCode"], code: string, message: string): QueueControlReceipt {
    const snapshot = this.#sync(), fallbackIdentity = snapshot.identity ?? this.#lastIdentity ?? { projectRef: "project.unavailable", runtimeInstanceId: "runtime.unavailable",
      sessionRef: "session.unavailable", taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
    const fallbackRevisions = snapshot.revisions ?? this.#lastRevisions ?? { runtimeRevision: "runtime-rev.unavailable", taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    const safeAction = ["chat.send", "queue.update", "queue.delete", "queue.dispatch"].includes(command?.action) ? command.action : "chat.send";
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: REF.test(command?.commandId ?? "") ? command.commandId : this.#ref("command", code),
      idempotencyKeyDigest: IDEMPOTENCY.test(command?.idempotencyKey ?? "") ? sha(command.idempotencyKey) : sha("invalid-idempotency-key"), action: safeAction,
      actionDigest: DIGEST.test(command?.actionDigest ?? "") ? command.actionDigest : sha(code), identity: validIdentity(command?.identity) ? copy(command.identity) : copy(fallbackIdentity),
      phase: "rejected", resultCode, requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : this.#now().toISOString(), settledAt: this.#now().toISOString(),
      observedRevisionsBefore: copy(fallbackRevisions), observedRevisionsAfter: copy(fallbackRevisions), deduplicated: resultCode === "replay", auditRef: null,
      settlementEvidenceRef: null, error: { code, message, retryable: false } };
  }

  #remember(receipt: QueueControlReceipt): QueueControlReceipt {
    this.#receiptsByKey.set(receipt.idempotencyKeyDigest, copy(receipt)); this.#receiptsByCommand.set(receipt.commandId, copy(receipt)); return receipt;
  }
  #opaqueRef(prefix: string): string { return `${prefix}.${randomBytes(24).toString("hex")}`; }
  #ref(prefix: string, ...parts: string[]): string { return `${prefix}.${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`; }
}
