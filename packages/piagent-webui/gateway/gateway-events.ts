export type GatewayEventKind = "catalog.changed" | "session.changed" | "runtime.changed" | "message.delta"
  | "message.completed" | "tool.started" | "tool.completed";

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

export class GatewayEventStore {
  readonly #maximumCount: number;
  readonly #maximumAgeMs: number;
  #events: GatewayProtocolEvent[] = [];
  #sequence = 0;
  #listeners = new Set<(event: GatewayProtocolEvent) => void>();

  constructor(options: { maximumCount?: number; maximumAgeMs?: number } = {}) {
    this.#maximumCount = Math.max(1, Math.min(10_000, options.maximumCount ?? 1_000));
    this.#maximumAgeMs = Math.max(1_000, Math.min(24 * 60 * 60_000, options.maximumAgeMs ?? 60 * 60_000));
  }

  get stateVersion(): number { return this.#sequence; }

  #prune(now: number): void {
    const cutoff = now - this.#maximumAgeMs;
    while (this.#events.length > this.#maximumCount || this.#events[0] && Date.parse(this.#events[0].generatedAt) < cutoff) this.#events.shift();
  }

  publish(kind: GatewayEventKind, payload: Record<string, unknown>, now = new Date()): GatewayProtocolEvent {
    if (!Number.isFinite(now.getTime())) throw new Error("gateway-event-time-invalid");
    this.#sequence += 1;
    const event: GatewayProtocolEvent = {
      schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "event",
      sequence: this.#sequence, stateVersion: this.#sequence, generatedAt: now.toISOString(), kind, payload
    };
    this.#events.push(event); this.#prune(now.getTime());
    for (const listener of this.#listeners) { try { listener(event); } catch { /* observers cannot block truth */ } }
    return event;
  }

  subscribe(listener: (event: GatewayProtocolEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  replay(after: number | null): { state: "current" | "resync-required"; events: GatewayProtocolEvent[]; earliestSequence: number; currentSequence: number } {
    this.#prune(Date.now());
    const earliestSequence = this.#events[0]?.sequence ?? this.#sequence;
    if (after !== null && after < Math.max(0, earliestSequence - 1)) {
      return { state: "resync-required", events: [], earliestSequence, currentSequence: this.#sequence };
    }
    return { state: "current", events: after === null ? [] : this.#events.filter((event) => event.sequence > after), earliestSequence,
      currentSequence: this.#sequence };
  }
}
