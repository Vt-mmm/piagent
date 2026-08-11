import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { redactSensitiveText } from "../../security/sensitive-data.js";

export const RUNTIME_MODEL_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const RUNTIME_FACT_SOURCES = Object.freeze([
  "pi-runtime",
  "authenticated-catalog",
  "provider-profile",
  "api-doc-hint"
] as const);

export type RuntimeFactSource = typeof RUNTIME_FACT_SOURCES[number];
export type RuntimeAvailability = "authenticated" | "unavailable" | "offline" | "logged-out" | "unknown";
export type RuntimeCapabilityValue = boolean | null;

export type RuntimeCapabilityFact = {
  name: string;
  value: RuntimeCapabilityValue;
  source: RuntimeFactSource;
};

export type RuntimeFactProvenance = {
  field: string;
  source: RuntimeFactSource;
  capturedAt: string;
  detail?: string;
};

export type RuntimeModelSnapshot = {
  schemaVersion: typeof RUNTIME_MODEL_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  source: RuntimeFactSource;
  piHostVersion: string | null;
  piagentVersion: string | null;
  provider: string | null;
  modelId: string | null;
  availability: RuntimeAvailability;
  contextWindow: number | null;
  requestedThinkingLevel: string | null;
  effectiveThinkingLevel: string | null;
  supportedThinkingLevels: string[] | null;
  capabilities: RuntimeCapabilityFact[];
  provenance: RuntimeFactProvenance[];
  warnings: string[];
};

export type RuntimeVersionMetadata = {
  piHostVersion: string | null;
  piagentVersion: string | null;
  piHostSource: RuntimeFactSource;
  piagentSource: RuntimeFactSource;
};

export type RuntimeSnapshotCaptureOptions = {
  capturedAt?: string;
  requestedThinkingLevel?: string | null;
  effectiveThinkingLevel?: string | null;
  versions?: RuntimeVersionMetadata;
};

const SNAPSHOT_FIELDS = new Set([
  "schemaVersion", "capturedAt", "source", "piHostVersion", "piagentVersion",
  "provider", "modelId", "availability", "contextWindow", "requestedThinkingLevel",
  "effectiveThinkingLevel", "supportedThinkingLevels", "capabilities", "provenance", "warnings"
]);
const CAPABILITY_FIELDS = new Set(["name", "value", "source"]);
const PROVENANCE_FIELDS = new Set(["field", "source", "capturedAt", "detail"]);
const AVAILABILITY = new Set<RuntimeAvailability>(["authenticated", "unavailable", "offline", "logged-out", "unknown"]);
const SOURCE_TRUST: Record<RuntimeFactSource, number> = {
  "pi-runtime": 4,
  "authenticated-catalog": 3,
  "provider-profile": 2,
  "api-doc-hint": 1
};
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unknownFields(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((field) => !allowed.has(field));
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function validNullableText(value: unknown, max = 160): boolean {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= max);
}

function source(value: unknown): value is RuntimeFactSource {
  return RUNTIME_FACT_SOURCES.includes(value as RuntimeFactSource);
}

export function runtimeModelSnapshotValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["snapshot must be an object"];
  const errors = unknownFields(value, SNAPSHOT_FIELDS).map((field) => `unknown snapshot field: ${field}`);
  for (const field of SNAPSHOT_FIELDS) {
    if (!(field in value)) errors.push(`missing snapshot field: ${field}`);
  }
  if (value.schemaVersion !== RUNTIME_MODEL_SNAPSHOT_SCHEMA_VERSION) errors.push("schemaVersion must be 1");
  if (!validTimestamp(value.capturedAt)) errors.push("capturedAt must be a UTC ISO timestamp with milliseconds");
  if (!source(value.source)) errors.push("source is invalid");
  for (const field of ["piHostVersion", "piagentVersion", "provider", "modelId", "requestedThinkingLevel", "effectiveThinkingLevel"] as const) {
    if (!validNullableText(value[field])) errors.push(`${field} must be null or bounded non-empty text`);
  }
  if (!AVAILABILITY.has(value.availability as RuntimeAvailability)) errors.push("availability is invalid");
  if (value.contextWindow !== null && (!Number.isInteger(value.contextWindow) || Number(value.contextWindow) < 1 || Number(value.contextWindow) > 10_000_000)) {
    errors.push("contextWindow must be null or an integer between 1 and 10000000");
  }
  if (value.supportedThinkingLevels !== null) {
    if (!Array.isArray(value.supportedThinkingLevels) || value.supportedThinkingLevels.length > 16
      || value.supportedThinkingLevels.some((entry) => typeof entry !== "string" || !NAME.test(entry))) {
      errors.push("supportedThinkingLevels must be null or at most 16 bounded names");
    } else if (new Set(value.supportedThinkingLevels).size !== value.supportedThinkingLevels.length) {
      errors.push("supportedThinkingLevels must be unique");
    }
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 64) {
    errors.push("capabilities must be an array with at most 64 entries");
  } else {
    const names = new Set<string>();
    for (const [index, raw] of value.capabilities.entries()) {
      const capability = record(raw);
      if (!capability) {
        errors.push(`capabilities[${index}] must be an object`);
        continue;
      }
      for (const field of unknownFields(capability, CAPABILITY_FIELDS)) errors.push(`capabilities[${index}] has unknown field: ${field}`);
      if (typeof capability.name !== "string" || !NAME.test(capability.name)) errors.push(`capabilities[${index}].name is invalid`);
      else if (names.has(capability.name)) errors.push(`duplicate capability: ${capability.name}`);
      else names.add(capability.name);
      if (capability.value !== null && typeof capability.value !== "boolean") errors.push(`capabilities[${index}].value must be boolean or null`);
      if (!source(capability.source)) errors.push(`capabilities[${index}].source is invalid`);
    }
  }
  if (!Array.isArray(value.provenance) || value.provenance.length > 128) {
    errors.push("provenance must be an array with at most 128 entries");
  } else {
    for (const [index, raw] of value.provenance.entries()) {
      const item = record(raw);
      if (!item) {
        errors.push(`provenance[${index}] must be an object`);
        continue;
      }
      for (const field of unknownFields(item, PROVENANCE_FIELDS)) errors.push(`provenance[${index}] has unknown field: ${field}`);
      if (typeof item.field !== "string" || !NAME.test(item.field)) errors.push(`provenance[${index}].field is invalid`);
      if (!source(item.source)) errors.push(`provenance[${index}].source is invalid`);
      if (!validTimestamp(item.capturedAt)) errors.push(`provenance[${index}].capturedAt is invalid`);
      if (item.detail !== undefined && (typeof item.detail !== "string" || item.detail.length > 240)) errors.push(`provenance[${index}].detail is invalid`);
    }
  }
  if (!Array.isArray(value.warnings) || value.warnings.length > 32
    || value.warnings.some((warning) => typeof warning !== "string" || warning.length < 1 || warning.length > 240)) {
    errors.push("warnings must contain at most 32 bounded strings");
  }
  return errors;
}

export function validateRuntimeModelSnapshot(input: unknown, sourceName = "runtime snapshot"): RuntimeModelSnapshot {
  const errors = runtimeModelSnapshotValidationErrors(input);
  if (errors.length > 0) throw new Error(`${sourceName}: ${errors.join("; ")}`);
  return input as RuntimeModelSnapshot;
}

function redactedText(value: string, max: number): string {
  return redactSensitiveText(value).text.trim().slice(0, max);
}

export function redactRuntimeModelSnapshot(input: RuntimeModelSnapshot): RuntimeModelSnapshot {
  const snapshot = structuredClone(input);
  snapshot.warnings = snapshot.warnings.map((value) => redactedText(value, 240)).filter(Boolean).slice(0, 32);
  snapshot.provenance = snapshot.provenance.map((item) => ({
    ...item,
    detail: item.detail === undefined ? undefined : redactedText(item.detail, 240)
  }));
  return validateRuntimeModelSnapshot(snapshot);
}

export function serializeRuntimeModelSnapshot(input: RuntimeModelSnapshot): string {
  const snapshot = redactRuntimeModelSnapshot(input);
  snapshot.capabilities.sort((left, right) => left.name.localeCompare(right.name));
  snapshot.provenance.sort((left, right) => `${left.field}:${left.source}`.localeCompare(`${right.field}:${right.source}`));
  snapshot.supportedThinkingLevels?.sort();
  snapshot.warnings.sort();
  return `${JSON.stringify(snapshot)}\n`;
}

export function runtimeModelSnapshotDigest(input: RuntimeModelSnapshot): string {
  const stable = JSON.parse(serializeRuntimeModelSnapshot(input)) as RuntimeModelSnapshot;
  stable.capturedAt = "1970-01-01T00:00:00.000Z";
  for (const item of stable.provenance) item.capturedAt = "1970-01-01T00:00:00.000Z";
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function trust(value: RuntimeFactSource): number {
  return SOURCE_TRUST[value];
}

export function mergeRuntimeModelSnapshots(inputs: readonly RuntimeModelSnapshot[]): RuntimeModelSnapshot {
  if (inputs.length === 0) throw new Error("at least one runtime snapshot is required");
  const snapshots = inputs.map((item) => validateRuntimeModelSnapshot(structuredClone(item)));
  const ranked = [...snapshots].sort((left, right) => trust(right.source) - trust(left.source));
  const result = structuredClone(ranked[0]);
  const nullable = ["piHostVersion", "piagentVersion", "provider", "modelId", "contextWindow", "requestedThinkingLevel", "effectiveThinkingLevel", "supportedThinkingLevels"] as const;
  for (const candidate of ranked.slice(1)) {
    for (const field of nullable) {
      if (result[field] === null && candidate[field] !== null) (result as Record<string, unknown>)[field] = candidate[field];
    }
    if (result.availability === "unknown" && candidate.availability !== "unknown") result.availability = candidate.availability;
  }
  const capabilities = new Map<string, RuntimeCapabilityFact>();
  for (const candidate of ranked) {
    for (const capability of candidate.capabilities) if (!capabilities.has(capability.name)) capabilities.set(capability.name, capability);
  }
  result.capabilities = [...capabilities.values()].sort((left, right) => left.name.localeCompare(right.name));
  result.provenance = snapshots.flatMap((item) => item.provenance)
    .filter((item, index, all) => all.findIndex((other) => `${other.field}:${other.source}:${other.capturedAt}` === `${item.field}:${item.source}:${item.capturedAt}`) === index)
    .slice(0, 128);
  result.warnings = [...new Set(snapshots.flatMap((item) => item.warnings))].slice(0, 32);
  result.capturedAt = snapshots.map((item) => item.capturedAt).sort().at(-1) as string;
  return validateRuntimeModelSnapshot(result);
}

function boundedNullable(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, 160) : null;
}

export function readRuntimeVersionMetadata(platformRoot: string): RuntimeVersionMetadata {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(platformRoot, "package.json"), "utf8")) as {
      version?: unknown;
      peerDependencies?: Record<string, unknown>;
    };
    return {
      piHostVersion: boundedNullable(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]),
      piagentVersion: boundedNullable(manifest.version),
      piHostSource: "provider-profile",
      piagentSource: "provider-profile"
    };
  } catch {
    return {
      piHostVersion: null,
      piagentVersion: null,
      piHostSource: "provider-profile",
      piagentSource: "provider-profile"
    };
  }
}

function activeModel(ctx: ExtensionContext): { provider: string | null; modelId: string | null } {
  const model = (ctx as unknown as { model?: { provider?: unknown; id?: unknown; name?: unknown } }).model;
  return {
    provider: boundedNullable(model?.provider),
    modelId: boundedNullable(model?.id ?? model?.name)
  };
}

function provenance(field: string, source: RuntimeFactSource, capturedAt: string, detail?: string): RuntimeFactProvenance {
  return { field, source, capturedAt, ...(detail ? { detail } : {}) };
}

export function captureActiveRuntimeSnapshot(
  ctx: ExtensionContext,
  options: RuntimeSnapshotCaptureOptions = {}
): RuntimeModelSnapshot {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const versions = options.versions ?? {
    piHostVersion: null,
    piagentVersion: null,
    piHostSource: "provider-profile" as const,
    piagentSource: "provider-profile" as const
  };
  const model = activeModel(ctx);
  const warnings: string[] = [];
  let contextWindow: number | null = null;
  try {
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    if (Number.isInteger(usage?.contextWindow) && Number(usage?.contextWindow) > 0) contextWindow = Number(usage?.contextWindow);
    else warnings.push("Live context window is unavailable.");
  } catch {
    warnings.push("Live context usage capture failed; runtime behavior is unchanged.");
  }
  if (!model.provider) warnings.push("Active provider is unavailable.");
  if (!model.modelId) warnings.push("Active model is unavailable.");
  const requestedThinkingLevel = boundedNullable(options.requestedThinkingLevel);
  const effectiveThinkingLevel = boundedNullable(options.effectiveThinkingLevel);
  if (!effectiveThinkingLevel) warnings.push("Effective thinking level is unavailable.");
  const facts: RuntimeFactProvenance[] = [
    provenance("provider", "pi-runtime", capturedAt),
    provenance("modelId", "pi-runtime", capturedAt),
    provenance("contextWindow", "pi-runtime", capturedAt),
    provenance("requestedThinkingLevel", "pi-runtime", capturedAt),
    provenance("effectiveThinkingLevel", "pi-runtime", capturedAt)
  ];
  if (versions.piHostVersion) facts.push(provenance("piHostVersion", versions.piHostSource, capturedAt, "reviewed package metadata"));
  if (versions.piagentVersion) facts.push(provenance("piagentVersion", versions.piagentSource, capturedAt, "reviewed package metadata"));
  return validateRuntimeModelSnapshot({
    schemaVersion: RUNTIME_MODEL_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    source: "pi-runtime",
    piHostVersion: versions.piHostVersion,
    piagentVersion: versions.piagentVersion,
    provider: model.provider,
    modelId: model.modelId,
    availability: "unknown",
    contextWindow,
    requestedThinkingLevel,
    effectiveThinkingLevel,
    supportedThinkingLevels: null,
    capabilities: [],
    provenance: facts,
    warnings
  });
}

export class RuntimeSnapshotCapture {
  readonly #bySession = new Map<string, { identity: string; snapshot: RuntimeModelSnapshot }>();

  capture(ctx: ExtensionContext, options: RuntimeSnapshotCaptureOptions = {}): RuntimeModelSnapshot {
    const candidate = captureActiveRuntimeSnapshot(ctx, options);
    const sessionId = boundedNullable(ctx.sessionManager?.getSessionId?.()) ?? "unknown-session";
    const identity = runtimeModelSnapshotDigest(candidate);
    const existing = this.#bySession.get(sessionId);
    if (existing?.identity === identity) return structuredClone(existing.snapshot);
    this.#bySession.set(sessionId, { identity, snapshot: candidate });
    return structuredClone(candidate);
  }

  clear(sessionId?: string): void {
    if (sessionId) this.#bySession.delete(sessionId);
    else this.#bySession.clear();
  }
}
