import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { appendJsonlBounded } from "../../extensions/state-retention.js";
import { solveTaskFeatures } from "./solver-policy.ts";
import { extractTaskFeatures } from "./task-features.ts";
import type { TaskFeatureInput } from "./task-features.ts";
import type { SolverDecision, SolverMode, SolverRoute, TaskFeatures } from "./solver-types.ts";
import { validateSolverDecision, validateTaskFeatures } from "./solver-types.ts";

export const SOLVER_SHADOW_EVENT_SCHEMA_VERSION = 1 as const;
const MAX_EVENT_BYTES = 512 * 1024;

export type SolverShadowEvent = {
  schemaVersion: typeof SOLVER_SHADOW_EVENT_SCHEMA_VERSION;
  recordedAt: string;
  sessionHash: string;
  featureHash: string;
  features: TaskFeatures;
  decision: SolverDecision;
};

export type SolverShadowEvaluation =
  | { status: "off"; durationMs: 0 }
  | { status: "error"; durationMs: number; warnings: string[] }
  | {
      status: "ok";
      durationMs: number;
      reused: boolean;
      persisted: boolean;
      warnings: string[];
      features: TaskFeatures;
      decision: SolverDecision;
    };

export type SolverOverrideCapture =
  | { status: "no-decision" | "same-route" }
  | { status: "error"; warnings: string[] }
  | { status: "recorded"; decision: SolverDecision; persisted: boolean; warnings: string[] };

export type SolverShadowTelemetryView = {
  records: SolverShadowEvent[];
  latest?: SolverShadowEvent;
  corruptions: string[];
  routingSafe: boolean;
};

type SolverShadowDependencies = {
  extract?: typeof extractTaskFeatures;
  solve?: typeof solveTaskFeatures;
  persist?: typeof recordSolverShadowEvent;
  now?: () => number;
};

const HASH = /^[a-f0-9]{64}$/;

export function solverModeFromEnvironment(value: unknown): SolverMode {
  const normalized = String(value ?? "shadow").trim().toLowerCase();
  return normalized === "off" || normalized === "recommend" ? normalized : "shadow";
}

export function solverShadowEventPath(cwd: string): string {
  return path.join(cwd, ".pi", "piagent-state", "solver", "decisions.jsonl");
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return "";
    throw error;
  }
}

function validateEvent(input: unknown): SolverShadowEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("event must be an object");
  const value = input as Record<string, unknown>;
  const fields = new Set(["schemaVersion", "recordedAt", "sessionHash", "featureHash", "features", "decision"]);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0 || [...fields].some((field) => !(field in value))) throw new Error("event fields are invalid");
  if (value.schemaVersion !== 1) throw new Error("event schemaVersion must be 1");
  if (typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))) throw new Error("recordedAt is invalid");
  if (typeof value.sessionHash !== "string" || !HASH.test(value.sessionHash)) throw new Error("sessionHash is invalid");
  if (typeof value.featureHash !== "string" || !HASH.test(value.featureHash)) throw new Error("featureHash is invalid");
  const features = validateTaskFeatures(value.features, "persisted solver features");
  const decision = validateSolverDecision(value.decision, "persisted solver decision");
  if (features.featureHash !== value.featureHash || decision.featureHash !== value.featureHash) throw new Error("feature hash mismatch");
  return value as SolverShadowEvent;
}

export function readSolverShadowEvents(cwd: string): SolverShadowTelemetryView {
  try {
    const target = solverShadowEventPath(cwd);
    const current = resolveLocalStatePath(cwd, target, { label: "Solver shadow events" });
    const rotated = resolveLocalStatePath(cwd, `${target}.1`, { label: "Rotated solver shadow events" });
    const records: SolverShadowEvent[] = [];
    const corruptions: string[] = [];
    const lines = [readText(rotated), readText(current)].join("").split(/\r?\n/).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      try {
        records.push(validateEvent(JSON.parse(line)));
      } catch (error) {
        corruptions.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { records, latest: records.at(-1), corruptions, routingSafe: corruptions.length === 0 };
  } catch {
    return { records: [], corruptions: ["solver shadow event path is unsafe"], routingSafe: false };
  }
}

export function recordSolverShadowEvent(
  cwd: string,
  sessionId: string,
  featuresInput: TaskFeatures,
  decisionInput: SolverDecision,
  options: { recordedAt?: string } = {}
): { written: boolean; warnings: string[] } {
  const features = validateTaskFeatures(structuredClone(featuresInput));
  const decision = validateSolverDecision(structuredClone(decisionInput));
  if (features.featureHash !== decision.featureHash) throw new Error("solver feature/decision hash mismatch");
  const sessionHash = crypto.createHash("sha256").update(String(sessionId || "unknown-session")).digest("hex");
  const existing = readSolverShadowEvents(cwd);
  if (!existing.routingSafe) return { written: false, warnings: existing.corruptions };
  if (existing.latest?.sessionHash === sessionHash && existing.latest.featureHash === features.featureHash
    && JSON.stringify(existing.latest.decision) === JSON.stringify(decision)) return { written: false, warnings: [] };
  appendJsonlBounded(solverShadowEventPath(cwd), {
    schemaVersion: SOLVER_SHADOW_EVENT_SCHEMA_VERSION,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    sessionHash,
    featureHash: features.featureHash,
    features,
    decision
  } satisfies SolverShadowEvent, { maxBytes: MAX_EVENT_BYTES, mode: 0o600, projectRoot: cwd });
  return { written: true, warnings: [] };
}

export class SolverShadowRuntime {
  readonly #mode: SolverMode;
  readonly #extract: typeof extractTaskFeatures;
  readonly #solve: typeof solveTaskFeatures;
  readonly #persist: typeof recordSolverShadowEvent;
  readonly #now: () => number;
  readonly #cache = new Map<string, { features: TaskFeatures; decision: SolverDecision }>();

  constructor(mode: SolverMode, dependencies: SolverShadowDependencies = {}) {
    this.#mode = mode;
    this.#extract = dependencies.extract ?? extractTaskFeatures;
    this.#solve = dependencies.solve ?? solveTaskFeatures;
    this.#persist = dependencies.persist ?? recordSolverShadowEvent;
    this.#now = dependencies.now ?? (() => performance.now());
  }

  evaluate(cwd: string, sessionId: string, input: TaskFeatureInput): SolverShadowEvaluation {
    if (this.#mode === "off") return { status: "off", durationMs: 0 };
    const started = this.#now();
    try {
      const features = this.#extract(input);
      const cacheKey = `${cwd}\u0000${sessionId}`;
      const cached = this.#cache.get(cacheKey);
      if (cached?.features.featureHash === features.featureHash) {
        return { status: "ok", durationMs: Math.max(0, this.#now() - started), reused: true, persisted: false, warnings: [], ...cached };
      }
      const decision = this.#solve(features, this.#mode);
      const persisted = this.#persist(cwd, sessionId, features, decision);
      this.#cache.set(cacheKey, { features, decision });
      while (this.#cache.size > 100) this.#cache.delete(this.#cache.keys().next().value as string);
      return {
        status: "ok",
        durationMs: Math.max(0, this.#now() - started),
        reused: false,
        persisted: persisted.written,
        warnings: persisted.warnings,
        features,
        decision
      };
    } catch (error) {
      return {
        status: "error",
        durationMs: Math.max(0, this.#now() - started),
        warnings: [error instanceof Error ? error.message : String(error)].slice(0, 4)
      };
    }
  }

  observeRoute(cwd: string, sessionId: string, actualRoute: SolverRoute, recordedAt = new Date().toISOString()): SolverOverrideCapture {
    const cached = this.#cache.get(`${cwd}\u0000${sessionId}`);
    if (!cached) return { status: "no-decision" };
    if (cached.decision.route === actualRoute) return { status: "same-route" };
    try {
      const decision = validateSolverDecision({
        ...structuredClone(cached.decision),
        override: { observed: true, route: actualRoute, recordedAt }
      });
      const persisted = this.#persist(cwd, sessionId, cached.features, decision);
      this.#cache.set(`${cwd}\u0000${sessionId}`, { features: cached.features, decision });
      return { status: "recorded", decision, persisted: persisted.written, warnings: persisted.warnings };
    } catch (error) {
      return { status: "error", warnings: [error instanceof Error ? error.message : String(error)] };
    }
  }
}
