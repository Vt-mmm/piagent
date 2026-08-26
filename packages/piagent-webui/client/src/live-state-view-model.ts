import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import type { PiagentWebUICanonicalVolatileSessionOperationStateV1 } from "../../contracts/generated/session-live-state-v1.ts";

export type LiveActivity = { toolCallRef: string; toolLabel: string; fileLabel?: string | null; state: "running" | "completed" | "failed";
  reasonCode?: string | null; startedAt?: string; finishedAt?: string | null };
export type OperationSettlement = "completed" | "blocked" | "aborted" | "error" | "unknown";
export type UserMessageDelivery = "submitting" | "admitted" | "unconfirmed";
export type LiveConversation = { user: string; assistant: string; attachments: Attachment[]; activities: LiveActivity[];
  operationRef: string | null; complete: boolean; error: string | null; settlement?: OperationSettlement | null;
  messageRequestId?: string | null; delivery?: UserMessageDelivery | null;
  abortable?: boolean; runtimeRecovery?: "required" | "restarting" | "recovered" | "failed" | null;
  startedAt?: string; lastEventAt?: string };
export type TerminalOperationActivity = {
  activityRef: string;
  operationRef: string;
  state: "failed" | "blocked" | "aborted" | "unknown";
  settlement: Exclude<OperationSettlement, "completed">;
  reasonCode: string;
  settledAt: string;
  sequence: number;
};

export function canonicalLiveStateSequence(projection: PiagentWebUICanonicalVolatileSessionOperationStateV1 | undefined,
  gatewayInstanceRef: string): number | null {
  return projection?.state === "ready" && projection.gatewayInstanceRef === gatewayInstanceRef
    && Number.isSafeInteger(projection.eventSequence) && projection.eventSequence >= 0
    && Array.isArray(projection.operations) && Array.isArray(projection.settlements)
    ? projection.eventSequence : null;
}

export function connectionStateAfterCatalogRefresh(socketOpen: boolean, canonicalRefreshRequired: boolean): "connected" | "reconnecting" {
  return socketOpen && !canonicalRefreshRequired ? "connected" : "reconnecting";
}

const TERMINAL_ACTIVITY_LIMIT = 100;
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,95}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function terminalReason(settlement: TerminalOperationActivity["settlement"], value: unknown): string {
  if (typeof value === "string" && REASON_CODE_PATTERN.test(value)) return value;
  if (settlement === "aborted") return "operation-aborted";
  if (settlement === "blocked") return "operation-blocked";
  if (settlement === "error") return "operation-failed";
  return "operation-settlement-unknown";
}

export function terminalOperationActivity(payload: { operationRef?: unknown; settlement?: unknown; reasonCode?: unknown;
  settledAt?: unknown; sequence?: unknown }): TerminalOperationActivity | null {
  if (payload.settlement === "completed") return null;
  if (typeof payload.operationRef !== "string" || !OPAQUE_REF_PATTERN.test(payload.operationRef)
    || typeof payload.settledAt !== "string" || !TIMESTAMP_PATTERN.test(payload.settledAt)
    || !Number.isSafeInteger(payload.sequence) || Number(payload.sequence) < 1) return null;
  const settlement: TerminalOperationActivity["settlement"] = ["blocked", "aborted", "error", "unknown"].includes(String(payload.settlement))
    ? payload.settlement as TerminalOperationActivity["settlement"] : "unknown";
  const state: TerminalOperationActivity["state"] = settlement === "error" ? "failed" : settlement;
  return { activityRef: payload.operationRef, operationRef: payload.operationRef, settlement, state,
    reasonCode: terminalReason(settlement, payload.reasonCode), settledAt: payload.settledAt, sequence: Number(payload.sequence) };
}

export function mergeTerminalOperationActivities(current: readonly TerminalOperationActivity[],
  incoming: readonly TerminalOperationActivity[]): TerminalOperationActivity[] {
  const byOperation = new Map<string, TerminalOperationActivity>();
  // Existing records arrived first and remain canonical if a contradictory
  // duplicate settlement appears at a later sequence.
  for (const activity of [...current, ...incoming]) {
    if (!byOperation.has(activity.operationRef)) byOperation.set(activity.operationRef, activity);
  }
  return [...byOperation.values()].sort((left, right) => right.sequence - left.sequence).slice(0, TERMINAL_ACTIVITY_LIMIT);
}

export function reconcileTerminalOperationActivities(projection: PiagentWebUICanonicalVolatileSessionOperationStateV1):
Record<string, TerminalOperationActivity[]> {
  if (projection.state !== "ready") return {};
  const grouped: Record<string, TerminalOperationActivity[]> = {};
  for (const settlement of projection.settlements ?? []) {
    const activity = terminalOperationActivity(settlement);
    if (!activity) continue;
    grouped[settlement.sessionRef] = mergeTerminalOperationActivities(grouped[settlement.sessionRef] ?? [], [activity]);
  }
  return grouped;
}

export function applyOperationSettlement(existing: LiveConversation, payload: { operationRef: string; settlement?: unknown;
  reasonCode?: unknown }): LiveConversation {
  const settlement: OperationSettlement = ["completed", "blocked", "aborted", "error"].includes(String(payload.settlement))
    ? payload.settlement as OperationSettlement : "unknown";
  return { ...existing, operationRef: payload.operationRef, abortable: false, complete: true, settlement, activities: [],
    delivery: existing.user ? "admitted" : existing.delivery,
    assistant: settlement === "completed" ? existing.assistant : "",
    error: settlement === "completed" ? null : String(payload.reasonCode ?? "operation-settlement-unknown") };
}

export function pendingUserConversation(existing: LiveConversation | undefined, input: { message: string; attachments: Attachment[];
  messageRequestId: string; submittedAt: string }): LiveConversation {
  return { ...(existing ?? { assistant: "", activities: [], operationRef: null, complete: true, error: null }),
    user: input.message, assistant: "", attachments: input.attachments, activities: [], operationRef: null,
    abortable: false, complete: false, settlement: null, error: null, messageRequestId: input.messageRequestId,
    delivery: "submitting", startedAt: input.submittedAt, lastEventAt: input.submittedAt };
}

export function markUserMessageDelivery(existing: LiveConversation, delivery: Exclude<UserMessageDelivery, "submitting">,
  operationRef?: string | null, observedAt?: string): LiveConversation {
  const exactAlreadySettled = delivery === "admitted" && Boolean(operationRef)
    && existing.operationRef === operationRef && existing.complete;
  return { ...existing, delivery, operationRef: operationRef ?? existing.operationRef,
    abortable: delivery === "admitted" && !exactAlreadySettled && Boolean(operationRef ?? existing.operationRef),
    complete: delivery === "admitted" ? exactAlreadySettled : existing.complete,
    error: null, lastEventAt: observedAt ?? existing.lastEventAt };
}

export function conversationAfterRejectedSend(existing: LiveConversation | undefined, previous: LiveConversation | undefined,
  messageRequestId: string): LiveConversation | undefined {
  if (!existing || existing.messageRequestId !== messageRequestId || existing.delivery === "admitted") return existing;
  return previous;
}

export function reconcileSessionLiveState(current: Readonly<Record<string, LiveConversation>>,
  projection: PiagentWebUICanonicalVolatileSessionOperationStateV1): Record<string, LiveConversation> {
  if (projection.state !== "ready") return { ...current };
  const operations = new Map(projection.operations.map((operation) => [operation.sessionRef, operation]));
  const next: Record<string, LiveConversation> = { ...current };
  for (const [sessionRef, existing] of Object.entries(current)) {
    if (operations.has(sessionRef) || existing.complete) continue;
    // A command response can legitimately be slower than the first live event.
    // An operation-free snapshot taken while the browser is still submitting is
    // therefore not proof that the user's input was rejected. Keep that bubble
    // stable until the exact receipt or a later operation event resolves it.
    if (existing.delivery === "submitting") continue;
    // The volatile read model is authoritative: if an operation is absent it is
    // no longer running. Preserve an admitted user message while dropping only
    // untrusted assistant/tool progress; the durable transcript may lag this
    // snapshot and must not make the user's bubble disappear in the meantime.
    next[sessionRef] = { ...existing, assistant: "", activities: [], operationRef: null,
      abortable: false, complete: true, settlement: "unknown", error: "operation-settlement-unavailable",
      lastEventAt: projection.generatedAt };
  }
  for (const operation of projection.operations) {
    const existing = current[operation.sessionRef];
    const requestCompatible = !(operation.messageRequestId && existing?.messageRequestId
      && operation.messageRequestId !== existing.messageRequestId);
    const sameOperation = requestCompatible && (existing?.operationRef === operation.operationRef
      || Boolean(existing?.user && ["submitting", "unconfirmed"].includes(String(existing.delivery))));
    next[operation.sessionRef] = sameOperation
      ? { ...existing, operationRef: operation.operationRef, abortable: operation.abortable, complete: false, settlement: null,
        messageRequestId: operation.messageRequestId ?? existing?.messageRequestId,
        delivery: existing?.user ? "admitted" : existing?.delivery, error: null, lastEventAt: projection.generatedAt }
      : { user: "", assistant: "", attachments: [], activities: [], operationRef: operation.operationRef,
        messageRequestId: operation.messageRequestId ?? null,
        abortable: operation.abortable, complete: false, settlement: null, error: null, runtimeRecovery: null,
        startedAt: projection.generatedAt, lastEventAt: projection.generatedAt };
  }
  return next;
}

function liveToolPhase(toolLabel: string, locale: "vi" | "en"): string {
  const tool = toolLabel.toLowerCase();
  if (/(subagent|scout|delegate|agent)/.test(tool)) return locale === "vi" ? "phối hợp agent hỗ trợ" : "coordinating a helper agent";
  if (/(bash|exec|shell|command|terminal)/.test(tool)) return locale === "vi" ? "chạy lệnh" : "running a command";
  if (/(read|grep|find|list|glob|search_file)/.test(tool)) return locale === "vi" ? "đọc mã nguồn" : "reading source";
  if (/(edit|write|patch|apply)/.test(tool)) return locale === "vi" ? "cập nhật file" : "updating files";
  if (/(test|verify|check|lint)/.test(tool)) return locale === "vi" ? "kiểm tra kết quả" : "verifying results";
  if (/(web|search|browser|fetch)/.test(tool)) return locale === "vi" ? "tìm kiếm thông tin" : "searching";
  return locale === "vi" ? "chạy công cụ" : "running a tool";
}

const SENSITIVE_FILE_LABEL = /(?:sk-(?:proj|live|test|svcacct)-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|password|secret|token)=)/i;
export function safeLiveFileLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const basename = (value.replace(/\\/g, "/").split("/").at(-1) ?? "").trim();
  if (!basename || basename === "." || basename === ".." || basename.length > 160
    || /[\u0000-\u001f\u007f/\\]/.test(basename) || SENSITIVE_FILE_LABEL.test(basename)
    || basename.includes("[REDACTED")) return null;
  return basename;
}

export function liveProgressStatus(live: LiveConversation, locale: "vi" | "en" = "vi", now = Date.now()): {
  label: string; detail: string } {
  const running = [...live.activities].reverse().find((activity) => activity.state === "running");
  const phase = running ? liveToolPhase(running.toolLabel, locale) : live.activities.length
    ? (locale === "vi" ? "tổng hợp bước tiếp theo" : "preparing the next step")
    : (locale === "vi" ? "phân tích yêu cầu" : "analyzing the request");
  const observed = Date.parse(live.lastEventAt ?? running?.startedAt ?? live.startedAt ?? "");
  const ageSeconds = Number.isFinite(observed) ? Math.max(0, Math.floor((now - observed) / 1_000)) : null;
  const age = ageSeconds === null ? (locale === "vi" ? "Đang chờ cập nhật tiến trình đầu tiên" : "Waiting for the first progress update")
    : ageSeconds < 10 ? (locale === "vi" ? "Tiến trình vừa cập nhật" : "Progress updated just now")
      : ageSeconds < 60 ? (locale === "vi" ? `Cập nhật ${ageSeconds} giây trước` : `Updated ${ageSeconds}s ago`)
        : (locale === "vi" ? `Cập nhật ${Math.floor(ageSeconds / 60)} phút trước` : `Updated ${Math.floor(ageSeconds / 60)}m ago`);
  const fileLabel = safeLiveFileLabel(running?.fileLabel);
  const detail = fileLabel ? `${fileLabel} · ${age}` : age;
  return { label: locale === "vi" ? `Piagent đang ${phase}…` : `Piagent is ${phase}…`, detail };
}

export function liveStateConfirmsAbort(projection: PiagentWebUICanonicalVolatileSessionOperationStateV1 | undefined,
  gatewayRef: string, sessionRef: string, operationRef: string): boolean {
  if (projection?.state !== "ready" || projection.gatewayInstanceRef !== gatewayRef) return false;
  const operation = projection.operations.find((item) => item.sessionRef === sessionRef);
  return operation?.operationRef === operationRef && operation.abortable === true;
}
