import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import type { PiagentWebUICanonicalVolatileSessionOperationStateV1 } from "../../contracts/generated/session-live-state-v1.ts";

export type LiveActivity = { toolCallRef: string; toolLabel: string; state: "running" | "completed" | "failed";
  reasonCode?: string | null; startedAt?: string; finishedAt?: string | null };
export type OperationSettlement = "completed" | "blocked" | "aborted" | "error" | "unknown";
export type LiveConversation = { user: string; assistant: string; attachments: Attachment[]; activities: LiveActivity[];
  operationRef: string | null; complete: boolean; error: string | null; settlement?: OperationSettlement | null;
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
  return { ...existing, operationRef: payload.operationRef, abortable: false, complete: true, settlement,
    assistant: settlement === "completed" ? existing.assistant : "",
    error: settlement === "completed" ? null : String(payload.reasonCode ?? "operation-settlement-unknown") };
}

export function reconcileSessionLiveState(current: Readonly<Record<string, LiveConversation>>,
  projection: PiagentWebUICanonicalVolatileSessionOperationStateV1): Record<string, LiveConversation> {
  if (projection.state !== "ready") return { ...current };
  const operations = new Map(projection.operations.map((operation) => [operation.sessionRef, operation]));
  const next: Record<string, LiveConversation> = { ...current };
  for (const [sessionRef, existing] of Object.entries(current)) {
    if (operations.has(sessionRef) || existing.complete) continue;
    // The volatile read model is authoritative: if an operation is absent it is
    // no longer running. Drop transient draft/output instead of inventing an
    // error or leaving Stop/loading visible forever.
    next[sessionRef] = { ...existing, user: "", assistant: "", attachments: [], activities: [], operationRef: null,
      abortable: false, complete: true, settlement: "unknown", error: "operation-settlement-unavailable",
      lastEventAt: projection.generatedAt };
  }
  for (const operation of projection.operations) {
    const existing = current[operation.sessionRef];
    const sameOperation = existing?.operationRef === operation.operationRef;
    next[operation.sessionRef] = sameOperation
      ? { ...existing, operationRef: operation.operationRef, abortable: operation.abortable, complete: false, settlement: null,
        error: null, lastEventAt: projection.generatedAt }
      : { user: "", assistant: "", attachments: [], activities: [], operationRef: operation.operationRef,
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

export function liveProgressStatus(live: LiveConversation, locale: "vi" | "en" = "vi", now = Date.now()): {
  label: string; detail: string } {
  const running = [...live.activities].reverse().find((activity) => activity.state === "running");
  const phase = running ? liveToolPhase(running.toolLabel, locale) : live.activities.length
    ? (locale === "vi" ? "tổng hợp bước tiếp theo" : "preparing the next step")
    : (locale === "vi" ? "phân tích yêu cầu" : "analyzing the request");
  const observed = Date.parse(live.lastEventAt ?? running?.startedAt ?? live.startedAt ?? "");
  const ageSeconds = Number.isFinite(observed) ? Math.max(0, Math.floor((now - observed) / 1_000)) : null;
  const detail = ageSeconds === null ? (locale === "vi" ? "Đang chờ cập nhật tiến trình đầu tiên" : "Waiting for the first progress update")
    : ageSeconds < 10 ? (locale === "vi" ? "Tiến trình vừa cập nhật" : "Progress updated just now")
      : ageSeconds < 60 ? (locale === "vi" ? `Cập nhật ${ageSeconds} giây trước` : `Updated ${ageSeconds}s ago`)
        : (locale === "vi" ? `Cập nhật ${Math.floor(ageSeconds / 60)} phút trước` : `Updated ${Math.floor(ageSeconds / 60)}m ago`);
  return { label: locale === "vi" ? `Piagent đang ${phase}…` : `Piagent is ${phase}…`, detail };
}

export function liveStateConfirmsAbort(projection: PiagentWebUICanonicalVolatileSessionOperationStateV1 | undefined,
  gatewayRef: string, sessionRef: string, operationRef: string): boolean {
  if (projection?.state !== "ready" || projection.gatewayInstanceRef !== gatewayRef) return false;
  const operation = projection.operations.find((item) => item.sessionRef === sessionRef);
  return operation?.operationRef === operationRef && operation.abortable === true;
}
