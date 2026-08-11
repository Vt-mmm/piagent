import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { appendJsonlBounded } from "../../extensions/state-retention.js";
import type { ModelRoutePolicyInput } from "./model-route-policy.ts";
import { routeParentModel } from "./model-route-policy.ts";
import type { ModelRouteDecision, ParentRoutingMode, RoutingObjective } from "./model-route-types.ts";
import { validateModelRouteDecision } from "./model-route-types.ts";

export const MODEL_ROUTE_EVENT_SCHEMA_VERSION = 1 as const;
const MAX_EVENT_BYTES = 512 * 1024;

export type ModelRouteEvaluation =
  | { status: "off"; durationMs: 0 }
  | { status: "error"; durationMs: number; warnings: string[] }
  | { status: "ok"; durationMs: number; reused: boolean; persisted: boolean; warnings: string[]; decision: ModelRouteDecision };

export type ModelRouteEvent = {
  schemaVersion: typeof MODEL_ROUTE_EVENT_SCHEMA_VERSION;
  recordedAt: string;
  sessionHash: string;
  decision: ModelRouteDecision;
};

export function modelRouteEventPath(cwd: string): string {
  return path.join(cwd, ".pi", "piagent-state", "model-routing", "decisions.jsonl");
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return ""; throw error; }
}

function validateEvent(input: unknown): ModelRouteEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("model route event must be an object");
  const value = input as Record<string, unknown>;
  const fields = new Set(["schemaVersion", "recordedAt", "sessionHash", "decision"]);
  if (Object.keys(value).some((field) => !fields.has(field)) || [...fields].some((field) => !(field in value))) throw new Error("model route event fields are invalid");
  if (value.schemaVersion !== 1 || typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))) throw new Error("model route event metadata is invalid");
  if (typeof value.sessionHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sessionHash)) throw new Error("model route session hash is invalid");
  validateModelRouteDecision(value.decision, "persisted model route decision");
  return value as ModelRouteEvent;
}

export function readModelRouteEvents(cwd: string): { records: ModelRouteEvent[]; corruptions: string[]; latest?: ModelRouteEvent } {
  try {
    const current = resolveLocalStatePath(cwd, modelRouteEventPath(cwd), { label: "Model route events" });
    const rotated = resolveLocalStatePath(cwd, `${modelRouteEventPath(cwd)}.1`, { label: "Rotated model route events" });
    const records: ModelRouteEvent[] = [], corruptions: string[] = [];
    for (const [index, line] of [readText(rotated), readText(current)].join("").split(/\r?\n/).filter(Boolean).entries()) {
      try { records.push(validateEvent(JSON.parse(line))); }
      catch (error) { corruptions.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { records, corruptions, latest: records.at(-1) };
  } catch {
    return { records: [], corruptions: ["model route event path is unsafe"] };
  }
}

export function recordModelRouteEvent(cwd: string, sessionId: string, decisionInput: ModelRouteDecision, recordedAt = new Date().toISOString()): { written: boolean; warnings: string[] } {
  const decision = validateModelRouteDecision(structuredClone(decisionInput));
  const existing = readModelRouteEvents(cwd);
  if (existing.corruptions.length > 0) return { written: false, warnings: existing.corruptions };
  const sessionHash = crypto.createHash("sha256").update(String(sessionId || "unknown-session")).digest("hex");
  if (existing.latest?.sessionHash === sessionHash && existing.latest.decision.decisionDigest === decision.decisionDigest) return { written: false, warnings: [] };
  appendJsonlBounded(modelRouteEventPath(cwd), { schemaVersion: MODEL_ROUTE_EVENT_SCHEMA_VERSION, recordedAt, sessionHash, decision } satisfies ModelRouteEvent, { maxBytes: MAX_EVENT_BYTES, mode: 0o600, projectRoot: cwd });
  return { written: true, warnings: [] };
}

export class ModelRouteRuntime {
  readonly #mode: ParentRoutingMode;
  readonly #objective: RoutingObjective;
  readonly #cache = new Map<string, ModelRouteDecision>();

  constructor(mode: ParentRoutingMode, objective: RoutingObjective) {
    this.#mode = mode;
    this.#objective = objective;
  }

  get mode(): ParentRoutingMode { return this.#mode; }
  get objective(): RoutingObjective { return this.#objective; }

  evaluate(cwd: string, sessionId: string, input: Omit<ModelRoutePolicyInput, "mode" | "objective">): ModelRouteEvaluation {
    if (this.#mode === "off") return { status: "off", durationMs: 0 };
    const started = performance.now();
    try {
      const decision = routeParentModel({ ...input, mode: this.#mode, objective: this.#objective });
      const key = `${cwd}\u0000${sessionId}`;
      const cached = this.#cache.get(key);
      if (cached?.decisionDigest === decision.decisionDigest) return { status: "ok", durationMs: performance.now() - started, reused: true, persisted: false, warnings: [], decision: cached };
      const persisted = recordModelRouteEvent(cwd, sessionId, decision);
      this.#cache.set(key, decision);
      while (this.#cache.size > 100) this.#cache.delete(this.#cache.keys().next().value as string);
      return { status: "ok", durationMs: performance.now() - started, reused: false, persisted: persisted.written, warnings: persisted.warnings, decision };
    } catch (error) {
      return { status: "error", durationMs: performance.now() - started, warnings: [error instanceof Error ? error.message : String(error)] };
    }
  }
}
