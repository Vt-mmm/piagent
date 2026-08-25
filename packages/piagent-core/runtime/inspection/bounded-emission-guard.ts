import { createHash } from "node:crypto";

export type EmissionSuppressionReason =
  | "empty"
  | "filler"
  | "duplicate-exact"
  | "duplicate-normalized"
  | "update-budget";

export type BoundedEmissionCandidate = {
  channel: string;
  identityKey: string;
  updateKey: string;
  text: string;
  actionable: boolean;
  reference: string;
};

export type EmissionDecision = {
  accepted: boolean;
  reason: EmissionSuppressionReason | null;
  priorReference: string | null;
};

export type BoundedEmissionTelemetry = {
  schemaVersion: 1;
  capacity: number;
  retained: number;
  primed: number;
  accepted: number;
  suppressed: number;
  suppressedByReason: Record<EmissionSuppressionReason, number>;
};

type RetainedEmission = {
  exactKey: string;
  normalizedKey: string;
  updateKey: string | null;
  reference: string;
};

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const DEFAULT_CAPACITY = 512;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 16_384;

const FILLER = new Set([
  "abort", "all good", "carry on", "complete", "continue", "done", "finished", "halt", "lgtm",
  "looks good", "no action", "no action needed", "no concern", "no concerns", "no further advice",
  "no further advice needed", "no further input", "no further input needed", "no issue", "no issues",
  "no issue continue", "no notes", "nothing to add", "nothing to flag", "nothing to report", "ok", "okay",
  "stop", "stop here", "stop now", "task complete", "task done",
  "da xong", "đã xong", "khong can lam gi", "không cần làm gì", "khong co gi de bao cao", "không có gì để báo cáo",
  "khong co loi", "không có lỗi", "khong co van de", "không có vấn đề", "on", "ổn", "tiep tuc", "tiếp tục", "xong"
]);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactEmissionText(value: string): string {
  return String(value ?? "")
    .replace(ANSI, "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable comparison form for reviewer notes and compact runtime event summaries. */
export function normalizeEmissionText(value: string): string {
  return exactEmissionText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return String(value);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function canonicalText(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function textField(payload: Record<string, unknown>): string | null {
  for (const field of ["note", "advice", "finding", "message", "summary"]) {
    if (typeof payload[field] === "string" && payload[field].trim()) return payload[field];
  }
  return null;
}

function reviewerRole(payload: Record<string, unknown>): string | null {
  for (const field of ["role", "agentRole", "actorRole", "sourceRole"]) {
    const value = String(payload[field] ?? "").toLowerCase();
    if (value === "reviewer" || value === "piagent-reviewer") return value;
  }
  const emissionType = String(payload.emissionType ?? "").toLowerCase();
  return emissionType === "reviewer-note" || emissionType === "review-note" ? "reviewer" : null;
}

type RuntimeEmissionLike = {
  kind: string;
  sessionRef: string;
  taskRunId: string | null;
  agentOperationId: string | null;
  turnIndex: number | null;
  toolCallId: string | null;
  revision: object;
  payload: Record<string, unknown>;
};

/**
 * Select only bounded activity, reviewer-note and operation emissions. Message
 * deltas/completions are deliberately outside this boundary, so a final user-
 * visible response can never be suppressed by this guard.
 */
export function runtimeEventEmissionCandidate(event: RuntimeEmissionLike, reference: string): BoundedEmissionCandidate | null {
  const payload = event.payload ?? {};
  const revision = canonicalText(event.revision);
  // Lifecycle state is authoritative. Classify it before reviewer metadata so
  // a note attached to a started/finished event can never hide that state.
  if (event.kind.startsWith("activity.")) {
    const state = payload.state ?? event.kind.slice("activity.".length);
    return {
      channel: "activity",
      identityKey: canonicalText([event.agentOperationId, event.toolCallId, payload.activityRef, event.kind, state]),
      updateKey: canonicalText([revision, event.agentOperationId, event.toolCallId, event.kind, state]),
      text: canonicalText(payload),
      actionable: false,
      reference
    };
  }
  if (event.kind.startsWith("agent-operation.")) {
    const state = payload.state ?? payload.settlement ?? payload.status ?? event.kind.slice("agent-operation.".length);
    return {
      channel: "operation",
      identityKey: canonicalText([event.agentOperationId, event.kind, state]),
      updateKey: canonicalText([revision, event.agentOperationId, event.kind, state]),
      text: canonicalText(payload),
      actionable: false,
      reference
    };
  }
  const role = reviewerRole(payload), note = role ? textField(payload) : null;
  if (role && note) {
    const explicitUpdate = payload.updateRef ?? payload.reviewerRevision ?? payload.revision;
    return {
      channel: "reviewer",
      // A session may host many unrelated tasks. Dedupe reviewer prose across
      // retries/operations of one durable task, but never across task runs.
      identityKey: canonicalText([event.sessionRef, event.taskRunId, role]),
      updateKey: canonicalText([event.sessionRef, event.agentOperationId, event.turnIndex, explicitUpdate ?? revision]),
      text: note,
      actionable: true,
      reference
    };
  }
  return null;
}

/** A small in-memory policy gate. It stores only hashes, never emitted prose. */
export class BoundedEmissionGuard {
  readonly capacity: number;
  readonly #retained: RetainedEmission[] = [];
  readonly #exact = new Map<string, string>();
  readonly #normalized = new Map<string, string>();
  readonly #updates = new Map<string, string>();
  #primed = 0;
  #accepted = 0;
  readonly #suppressed: Record<EmissionSuppressionReason, number> = {
    empty: 0,
    filler: 0,
    "duplicate-exact": 0,
    "duplicate-normalized": 0,
    "update-budget": 0
  };

  constructor(options: { capacity?: number } = {}) {
    const candidate = Number.isFinite(options.capacity) ? Math.floor(Number(options.capacity)) : DEFAULT_CAPACITY;
    this.capacity = Math.max(MIN_CAPACITY, Math.min(MAX_CAPACITY, candidate));
  }

  #keys(candidate: BoundedEmissionCandidate): { exactKey: string; normalizedKey: string; updateKey: string | null; exact: string; normalized: string } {
    const exact = exactEmissionText(candidate.text), normalized = normalizeEmissionText(exact);
    const scope = `${candidate.channel}\0${candidate.identityKey}`;
    return {
      exact,
      normalized,
      exactKey: digest(`${scope}\0exact\0${exact}`),
      normalizedKey: digest(`${scope}\0normalized\0${normalized}`),
      updateKey: candidate.actionable ? digest(`${candidate.channel}\0update\0${candidate.updateKey}`) : null
    };
  }

  #reject(reason: EmissionSuppressionReason, priorReference: string | null = null, count = true): EmissionDecision {
    if (count) this.#suppressed[reason] += 1;
    return { accepted: false, reason, priorReference };
  }

  #inspect(candidate: BoundedEmissionCandidate, countSuppression: boolean): EmissionDecision {
    const keys = this.#keys(candidate);
    if (candidate.actionable && !keys.exact) return this.#reject("empty", null, countSuppression);
    if (candidate.actionable && FILLER.has(keys.normalized)) return this.#reject("filler", null, countSuppression);
    const exact = this.#exact.get(keys.exactKey);
    if (exact) return this.#reject("duplicate-exact", exact, countSuppression);
    const normalized = this.#normalized.get(keys.normalizedKey);
    if (normalized) return this.#reject("duplicate-normalized", normalized, countSuppression);
    const update = keys.updateKey ? this.#updates.get(keys.updateKey) : undefined;
    if (update) return this.#reject("update-budget", update, countSuppression);
    return { accepted: true, reason: null, priorReference: null };
  }

  inspect(candidate: BoundedEmissionCandidate): EmissionDecision {
    return this.#inspect(candidate, true);
  }

  /** Seed retained history without counting old suppression as live telemetry. */
  prime(candidate: BoundedEmissionCandidate): boolean {
    if (!this.#inspect(candidate, false).accepted) return false;
    this.recordAccepted(candidate, { primed: true });
    return true;
  }

  recordAccepted(candidate: BoundedEmissionCandidate, options: { primed?: boolean } = {}): void {
    const keys = this.#keys(candidate);
    const record = { exactKey: keys.exactKey, normalizedKey: keys.normalizedKey, updateKey: keys.updateKey, reference: candidate.reference };
    this.#retained.push(record);
    this.#exact.set(record.exactKey, record.reference);
    this.#normalized.set(record.normalizedKey, record.reference);
    if (record.updateKey) this.#updates.set(record.updateKey, record.reference);
    if (options.primed) this.#primed += 1;
    else this.#accepted += 1;
    while (this.#retained.length > this.capacity) {
      const stale = this.#retained.shift() as RetainedEmission;
      if (this.#exact.get(stale.exactKey) === stale.reference) this.#exact.delete(stale.exactKey);
      if (this.#normalized.get(stale.normalizedKey) === stale.reference) this.#normalized.delete(stale.normalizedKey);
      if (stale.updateKey && this.#updates.get(stale.updateKey) === stale.reference) this.#updates.delete(stale.updateKey);
    }
  }

  /** Remove fingerprints when their durable event leaves the retention window. */
  forget(reference: string): boolean {
    const kept = this.#retained.filter((record) => record.reference !== reference);
    if (kept.length === this.#retained.length) return false;
    this.#retained.length = 0;
    this.#retained.push(...kept);
    this.#exact.clear();
    this.#normalized.clear();
    this.#updates.clear();
    for (const record of this.#retained) {
      this.#exact.set(record.exactKey, record.reference);
      this.#normalized.set(record.normalizedKey, record.reference);
      if (record.updateKey) this.#updates.set(record.updateKey, record.reference);
    }
    return true;
  }

  reset(): void {
    this.#retained.length = 0;
    this.#exact.clear();
    this.#normalized.clear();
    this.#updates.clear();
    this.#primed = 0;
    this.#accepted = 0;
    for (const reason of Object.keys(this.#suppressed) as EmissionSuppressionReason[]) this.#suppressed[reason] = 0;
  }

  telemetry(): BoundedEmissionTelemetry {
    const suppressedByReason = { ...this.#suppressed };
    return {
      schemaVersion: 1,
      capacity: this.capacity,
      retained: this.#retained.length,
      primed: this.#primed,
      accepted: this.#accepted,
      suppressed: Object.values(suppressedByReason).reduce((sum, value) => sum + value, 0),
      suppressedByReason
    };
  }
}
