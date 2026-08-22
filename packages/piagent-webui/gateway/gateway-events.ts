import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";

export type GatewayEventKind = "catalog.changed" | "session.changed" | "runtime.changed" | "message.delta"
  | "message.completed" | "operation.settled" | "tool.started" | "tool.completed";

export type GatewayProtocolEvent = {
  schemaVersion: 1;
  version: "piagent-gateway-protocol-v1";
  messageType: "event";
  sequence: number;
  stateVersion: number;
  generatedAt: string;
  kind: GatewayEventKind | "resync.required";
  payload: Record<string, unknown>;
};

export type GatewayTerminalSettlement = {
  sessionRef: string;
  operationRef: string;
  settlement: "blocked" | "aborted" | "error" | "unknown";
  reasonCode: string;
  settledAt: string;
  sequence: number;
};

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9.-]{0,95}$/;
const TERMINAL_SETTLEMENTS = new Set(["completed", "blocked", "aborted", "error", "unknown"]);
const SETTLEMENT_RETENTION_COUNT = 100;
const SETTLEMENT_RETENTION_MS = 60 * 60_000;
const MAX_SETTLEMENT_DECISION_COUNT = 10_000;
type GatewaySettlementDecision = { settledAt: string; settlement: "completed" | GatewayTerminalSettlement["settlement"];
  reasonCode: string | null };

function settlementReason(settlement: GatewayTerminalSettlement["settlement"], value: unknown): string {
  if (typeof value === "string" && REASON_CODE_PATTERN.test(value) && !redactSensitiveText(value).redacted) return value;
  if (settlement === "aborted") return "operation-aborted";
  if (settlement === "blocked") return "operation-blocked";
  if (settlement === "error") return "operation-failed";
  return "operation-settlement-unknown";
}

export class GatewayEventStore {
  readonly #maximumCount: number;
  readonly #maximumAgeMs: number;
  readonly #settlementDecisionCount: number;
  #events: GatewayProtocolEvent[] = [];
  #settlements: GatewayTerminalSettlement[] = [];
  #settlementDecisions = new Map<string, GatewaySettlementDecision>();
  #sequence = 0;
  #listeners = new Set<(event: GatewayProtocolEvent) => void>();

  constructor(options: { maximumCount?: number; maximumAgeMs?: number; settlementDecisionCount?: number } = {}) {
    this.#maximumCount = Math.max(1, Math.min(10_000, options.maximumCount ?? 1_000));
    this.#maximumAgeMs = Math.max(1_000, Math.min(24 * 60 * 60_000, options.maximumAgeMs ?? 60 * 60_000));
    this.#settlementDecisionCount = Math.max(1,
      Math.min(MAX_SETTLEMENT_DECISION_COUNT, Math.floor(options.settlementDecisionCount ?? MAX_SETTLEMENT_DECISION_COUNT)));
  }

  get stateVersion(): number { return this.#sequence; }

  #prune(now: number): void {
    const cutoff = now - this.#maximumAgeMs;
    while (this.#events.length > this.#maximumCount || this.#events[0] && Date.parse(this.#events[0].generatedAt) < cutoff) this.#events.shift();
  }

  #pruneSettlements(now: number): void {
    const cutoff = now - SETTLEMENT_RETENTION_MS;
    this.#settlements = this.#settlements.filter((item) => Date.parse(item.settledAt) >= cutoff);
    if (this.#settlements.length > SETTLEMENT_RETENTION_COUNT) {
      this.#settlements.splice(0, this.#settlements.length - SETTLEMENT_RETENTION_COUNT);
    }
    for (const [key, decision] of this.#settlementDecisions) {
      if (Date.parse(decision.settledAt) < cutoff) this.#settlementDecisions.delete(key);
    }
    while (this.#settlementDecisions.size > this.#settlementDecisionCount) {
      this.#settlementDecisions.delete(this.#settlementDecisions.keys().next().value as string);
    }
  }

  #settlementDecision(sessionRef: string, operationRef: string): GatewaySettlementDecision | undefined {
    const key = `${sessionRef}\u0000${operationRef}`;
    const indexed = this.#settlementDecisions.get(key);
    if (indexed) return indexed;
    const retained = this.#settlements.find((item) => item.sessionRef === sessionRef && item.operationRef === operationRef);
    if (!retained) return undefined;
    const restored = { settledAt: retained.settledAt, settlement: retained.settlement, reasonCode: retained.reasonCode };
    this.#settlementDecisions.set(key, restored);
    return restored;
  }

  #recordSettlement(event: GatewayProtocolEvent, now: number): void {
    if (event.kind !== "operation.settled") return;
    const sessionRef = event.payload.sessionRef, operationRef = event.payload.operationRef, settlement = event.payload.settlement;
    if (typeof sessionRef !== "string" || !OPAQUE_REF_PATTERN.test(sessionRef)
      || typeof operationRef !== "string" || !OPAQUE_REF_PATTERN.test(operationRef)
      || typeof settlement !== "string" || !TERMINAL_SETTLEMENTS.has(settlement)) return;
    this.#pruneSettlements(now);
    const key = `${sessionRef}\u0000${operationRef}`;
    if (this.#settlementDecision(sessionRef, operationRef)) return;
    this.#settlementDecisions.set(key, { settledAt: event.generatedAt,
      settlement: settlement as GatewaySettlementDecision["settlement"],
      reasonCode: settlement === "completed" ? null : String(event.payload.reasonCode) });
    const retained = { sessionRef, operationRef, settledAt: event.generatedAt, sequence: event.sequence };
    if (settlement !== "completed") {
      const outcome = settlement as GatewayTerminalSettlement["settlement"];
      this.#settlements.push({ ...retained, settlement: outcome, reasonCode: settlementReason(outcome, event.payload.reasonCode) });
    }
    this.#pruneSettlements(now);
  }

  publish(kind: GatewayEventKind, payload: Record<string, unknown>, now = new Date()): GatewayProtocolEvent {
    if (!Number.isFinite(now.getTime())) throw new Error("gateway-event-time-invalid");
    if (kind === "operation.settled") {
      if (payload.settlement === "completed") payload = { ...payload, reasonCode: null };
      else {
        const settlement = ["blocked", "aborted", "error", "unknown"].includes(String(payload.settlement))
          ? payload.settlement as GatewayTerminalSettlement["settlement"] : "unknown";
        payload = { ...payload, settlement, reasonCode: settlementReason(settlement, payload.reasonCode) };
      }
      this.#pruneSettlements(now.getTime());
      const sessionRef = payload.sessionRef, operationRef = payload.operationRef;
      if (typeof sessionRef === "string" && OPAQUE_REF_PATTERN.test(sessionRef)
        && typeof operationRef === "string" && OPAQUE_REF_PATTERN.test(operationRef)) {
        const canonical = this.#settlementDecision(sessionRef, operationRef);
        if (canonical) payload = { ...payload, settlement: canonical.settlement, reasonCode: canonical.reasonCode };
      }
    }
    this.#sequence += 1;
    const event: GatewayProtocolEvent = {
      schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "event",
      sequence: this.#sequence, stateVersion: this.#sequence, generatedAt: now.toISOString(), kind, payload
    };
    this.#events.push(event); this.#prune(now.getTime()); this.#recordSettlement(event, now.getTime());
    for (const listener of this.#listeners) { try { listener(event); } catch { /* observers cannot block truth */ } }
    return event;
  }

  subscribe(listener: (event: GatewayProtocolEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  recentOperationSettlements(maximum = 100, now = new Date()): GatewayTerminalSettlement[] {
    if (!Number.isFinite(now.getTime())) throw new Error("gateway-settlement-time-invalid");
    const limit = Math.max(0, Math.min(100, Math.floor(maximum)));
    if (limit === 0) return [];
    this.#pruneSettlements(now.getTime());
    return [...this.#settlements].sort((left, right) => right.sequence - left.sequence).slice(0, limit).map((item) => ({ ...item }));
  }

  replay(after: number | null): { state: "current" | "resync-required"; events: GatewayProtocolEvent[]; earliestSequence: number; currentSequence: number } {
    this.#prune(Date.now());
    // An empty retained ring after pruning contains no event at `#sequence`.
    // Treat the next sequence as the retention boundary so a client one event
    // behind must resync instead of silently receiving an empty replay.
    const earliestSequence = this.#events[0]?.sequence ?? Math.min(Number.MAX_SAFE_INTEGER, this.#sequence + 1);
    if (after !== null && (after > this.#sequence || after < Math.max(0, earliestSequence - 1))) {
      return { state: "resync-required", events: [], earliestSequence, currentSequence: this.#sequence };
    }
    return { state: "current", events: after === null ? [] : this.#events.filter((event) => event.sequence > after), earliestSequence,
      currentSequence: this.#sequence };
  }
}
