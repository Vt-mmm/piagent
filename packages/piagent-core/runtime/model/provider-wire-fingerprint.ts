import crypto from "node:crypto";

type JsonRecord = Record<string, unknown>;
type BoundReason = "instructions-unavailable" | "instructions-too-large" | "tools-invalid" | "tools-too-large"
  | "input-invalid" | "input-too-large" | "deferred-tools-invalid" | "deferred-tools-too-large"
  | "surface-too-deep" | "surface-too-large" | "surface-not-json" | "surface-cyclic";

const MAX_INSTRUCTIONS_CHARS = 1_000_000;
const MAX_TOOLS = 512;
const MAX_INPUT_ITEMS = 4_096;
const MAX_SURFACE_DEPTH = 32;
const MAX_SURFACE_NODES = 50_000;
const MAX_SURFACE_STRING_CHARS = 2_000_000;
const MAX_CONTAINER_ITEMS = 4_096;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const CONTROL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type ProviderWireFingerprint = {
  applicable: boolean;
  state: "known" | "unavailable";
  reasonCode: BoundReason | "not-applicable" | null;
  modelId: string | null;
  instructionsHash: string | null;
  baseInstructionsHash: string | null;
  instructionNormalization: "host-relocation-v1" | "none" | null;
  instructionChars: number | null;
  orderedToolSurfaceHash: string | null;
  toolCount: number | null;
  deferredToolSurfaceHash: string | null;
  deferredToolCount: number | null;
  deferredToolBatchCount: number | null;
  reasoningEffort: string | null;
  textVerbosity: string | null;
  toolChoiceKind: string | null;
  toolChoiceHash: string | null;
  requestPrefixFingerprint: string | null;
};

class SurfaceBoundError extends Error {
  readonly reasonCode: BoundReason;
  constructor(reasonCode: BoundReason) { super(reasonCode); this.reasonCode = reasonCode; }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function control(value: unknown): string | null {
  return typeof value === "string" && CONTROL_VALUE.test(value) ? value : null;
}

function canonicalJson(value: unknown): string {
  const budget = { nodes: 0, stringChars: 0, active: new WeakSet<object>() };
  const visit = (item: unknown, depth: number, inArray: boolean): unknown => {
    budget.nodes += 1;
    if (budget.nodes > MAX_SURFACE_NODES) throw new SurfaceBoundError("surface-too-large");
    if (depth > MAX_SURFACE_DEPTH) throw new SurfaceBoundError("surface-too-deep");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      budget.stringChars += item.length;
      if (budget.stringChars > MAX_SURFACE_STRING_CHARS) throw new SurfaceBoundError("surface-too-large");
      return item;
    }
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (["undefined", "function", "symbol"].includes(typeof item)) return inArray ? null : undefined;
    if (typeof item === "bigint" || typeof item !== "object") throw new SurfaceBoundError("surface-not-json");
    if (budget.active.has(item)) throw new SurfaceBoundError("surface-cyclic");
    budget.active.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > MAX_CONTAINER_ITEMS) throw new SurfaceBoundError("surface-too-large");
        return item.map((entry) => visit(entry, depth + 1, true));
      }
      const entries = Object.entries(item as JsonRecord)
        .filter(([, entry]) => !["undefined", "function", "symbol"].includes(typeof entry));
      if (entries.length > MAX_CONTAINER_ITEMS) throw new SurfaceBoundError("surface-too-large");
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      const output: JsonRecord = {};
      for (const [key, entry] of entries) {
        budget.stringChars += key.length;
        if (budget.stringChars > MAX_SURFACE_STRING_CHARS) throw new SurfaceBoundError("surface-too-large");
        output[key] = visit(entry, depth + 1, false);
      }
      return output;
    } finally {
      budget.active.delete(item);
    }
  };
  return JSON.stringify(visit(value, 0, false));
}

function unavailable(modelId: string, reasonCode: BoundReason): ProviderWireFingerprint {
  return { applicable: true, state: "unavailable", reasonCode, modelId, instructionsHash: null,
    baseInstructionsHash: null, instructionNormalization: null, instructionChars: null,
    orderedToolSurfaceHash: null, toolCount: null, deferredToolSurfaceHash: null, deferredToolCount: null,
    deferredToolBatchCount: null, reasoningEffort: null, textVerbosity: null, toolChoiceKind: null,
    toolChoiceHash: null, requestPrefixFingerprint: null };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function boundedHostPaths(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) return [];
  if (/^[\\/]+$/.test(value) || /^[A-Za-z]:[\\/]?$/.test(value)) return [];
  const native = value.replace(/[\\/]+$/, "");
  const slash = native.replace(/\\/g, "/");
  return [...new Set([native, slash].filter(Boolean))];
}

function normalizeSkillLocations(instructions: string, platformRoot: unknown): string {
  const roots = boundedHostPaths(platformRoot);
  if (roots.length === 0) return instructions;
  const startTag = "<available_skills>";
  const endTag = "</available_skills>";
  let cursor = 0;
  let output = "";
  while (cursor < instructions.length) {
    const start = instructions.indexOf(startTag, cursor);
    if (start < 0) return output + instructions.slice(cursor);
    const endStart = instructions.indexOf(endTag, start + startTag.length);
    if (endStart < 0) return output + instructions.slice(cursor);
    const end = endStart + endTag.length;
    let section = instructions.slice(start, end);
    for (const root of roots) {
      const locationPrefix = `<location>${xmlEscape(root)}`;
      section = section
        .replaceAll(`${locationPrefix}/`, "<location>[PIAGENT_PLATFORM_ROOT]/")
        .replaceAll(`${locationPrefix}\\`, "<location>[PIAGENT_PLATFORM_ROOT]/")
        .replaceAll(`${locationPrefix}</location>`, "<location>[PIAGENT_PLATFORM_ROOT]</location>");
    }
    output += instructions.slice(cursor, start) + section;
    cursor = end;
  }
  return output;
}

function normalizeHostOwnedRelocation(instructions: string, workingDirectory: unknown, platformRoot: unknown): {
  value: string;
  mode: "host-relocation-v1" | "none";
} {
  const cwdVariants = boundedHostPaths(workingDirectory);
  let value = normalizeSkillLocations(instructions, platformRoot);
  for (const cwd of cwdVariants) {
    const cwdLine = `Current working directory: ${cwd}`;
    if (value.endsWith(cwdLine)) {
      value = `${value.slice(0, -cwdLine.length)}Current working directory: [PIAGENT_PROJECT_ROOT]`;
    }
    value = value
      .replaceAll(`<project_instructions path="${cwd}">`, '<project_instructions path="[PIAGENT_PROJECT_ROOT]">')
      .replaceAll(`<project_instructions path="${cwd}/`, '<project_instructions path="[PIAGENT_PROJECT_ROOT]/')
      .replaceAll(`<project_instructions path="${cwd}\\`, '<project_instructions path="[PIAGENT_PROJECT_ROOT]/');
  }
  return value === instructions
    ? { value, mode: "none" }
    : { value, mode: "host-relocation-v1" };
}

export function buildOpenAiCodexWireFingerprint(input: {
  payload: unknown;
  provider: unknown;
  modelId: unknown;
  workingDirectory?: unknown;
  platformRoot?: unknown;
}): ProviderWireFingerprint {
  const payload = record(input.payload);
  const provider = typeof input.provider === "string" ? input.provider : "";
  const modelId = typeof input.modelId === "string" && PUBLIC_ID.test(input.modelId) ? input.modelId : "";
  if (provider !== "openai-codex" || !payload || !modelId || payload.model !== modelId) {
    return { ...unavailable("", "surface-not-json"), applicable: false, state: "unavailable",
      reasonCode: "not-applicable", modelId: null };
  }
  if (typeof payload.instructions !== "string") return unavailable(modelId, "instructions-unavailable");
  if (payload.instructions.length > MAX_INSTRUCTIONS_CHARS) return unavailable(modelId, "instructions-too-large");
  const tools = payload.tools === undefined ? [] : payload.tools;
  if (!Array.isArray(tools)) return unavailable(modelId, "tools-invalid");
  if (tools.length > MAX_TOOLS) return unavailable(modelId, "tools-too-large");
  const requestInput = payload.input === undefined ? [] : payload.input;
  if (!Array.isArray(requestInput)) return unavailable(modelId, "input-invalid");
  if (requestInput.length > MAX_INPUT_ITEMS) return unavailable(modelId, "input-too-large");

  const deferredBatches: Array<{ inputIndex: number; tools: unknown[] }> = [];
  let deferredToolCount = 0;
  for (let index = 0; index < requestInput.length; index += 1) {
    const item = record(requestInput[index]);
    if (item?.type !== "tool_search_output") continue;
    if (!Array.isArray(item.tools)) return unavailable(modelId, "deferred-tools-invalid");
    deferredToolCount += item.tools.length;
    if (deferredToolCount > MAX_TOOLS) return unavailable(modelId, "deferred-tools-too-large");
    deferredBatches.push({ inputIndex: index, tools: item.tools });
  }

  try {
    const instructionsHash = hash(payload.instructions);
    const normalizedInstructions = normalizeHostOwnedRelocation(payload.instructions, input.workingDirectory, input.platformRoot);
    const baseInstructionsHash = hash(normalizedInstructions.value);
    // Object keys are canonicalized because their order is semantic noise;
    // arrays are preserved so changing provider-visible tool order is detected.
    const orderedToolSurfaceHash = hash(canonicalJson(tools));
    const deferredToolSurfaceHash = hash(canonicalJson(deferredBatches));
    const toolChoice = payload.tool_choice ?? null;
    const toolChoiceHash = hash(canonicalJson(toolChoice));
    const reasoningEffort = control(record(payload.reasoning)?.effort);
    const textVerbosity = control(record(payload.text)?.verbosity);
    const toolChoiceKind = typeof toolChoice === "string" ? control(toolChoice) : record(toolChoice) ? "structured" : "none";
    const requestPrefixFingerprint = hash(JSON.stringify({
      schemaVersion: 1,
      modelId,
      instructionsHash,
      baseInstructionsHash,
      orderedToolSurfaceHash,
      toolCount: tools.length,
      deferredToolSurfaceHash,
      deferredToolCount,
      deferredToolBatchCount: deferredBatches.length,
      reasoningEffort,
      textVerbosity,
      toolChoiceHash
    }));
    return { applicable: true, state: "known", reasonCode: null, modelId, instructionsHash,
      baseInstructionsHash, instructionNormalization: normalizedInstructions.mode,
      instructionChars: payload.instructions.length, orderedToolSurfaceHash, toolCount: tools.length,
      deferredToolSurfaceHash, deferredToolCount, deferredToolBatchCount: deferredBatches.length,
      reasoningEffort, textVerbosity, toolChoiceKind, toolChoiceHash, requestPrefixFingerprint };
  } catch (error) {
    return unavailable(modelId, error instanceof SurfaceBoundError ? error.reasonCode : "surface-not-json");
  }
}
