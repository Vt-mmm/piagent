import { createHash } from "node:crypto";

export const ZERO_TURN_CONFORMANCE_VERSION = "piagent-webui-zero-turn-v1" as const;

const EFFECT_KEYS = [
  "providerRequests", "userMessages", "assistantMessages", "inputTokens", "outputTokens",
  "cacheReadTokens", "cacheWriteTokens", "costMicros", "continuationConsumed", "turnTriggers"
] as const;
type EffectKey = typeof EFFECT_KEYS[number];
export type ZeroTurnEffects = Record<EffectKey, number>;
export type ZeroTurnCausalEvent = {
  sequence: number;
  correlationId: string | null;
  attribution: "ui-command" | "unrelated-operation" | "unknown";
  effects: Partial<ZeroTurnEffects>;
};
export type ZeroTurnObservation = {
  providerRequests: number;
  userMessages: number;
  assistantMessages: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number };
  continuationConsumed: number;
  turnTriggers: number;
  sessionRef: string;
  leafMessageRef: string | null;
  messageSetDigest: string;
  taskContractDigest: string | null;
  journalHead: string | null;
  promptDigest: string;
  toolSchemaDigest: string;
  latestCausalSequence: number;
  causalEvents: ZeroTurnCausalEvent[];
};
export type ZeroTurnOptions = {
  action: string;
  commandId: string;
  concurrency: "quiescent" | "concurrent";
  mutationClass: "view" | "control";
  allowedDigestChanges?: Array<"taskContractDigest" | "journalHead">;
};
export type ZeroTurnReport<T = unknown> = {
  version: typeof ZERO_TURN_CONFORMANCE_VERSION;
  passed: boolean;
  action: string;
  commandId: string;
  concurrency: ZeroTurnOptions["concurrency"];
  mutationClass: ZeroTurnOptions["mutationClass"];
  violations: string[];
  delta: ZeroTurnEffects;
  result?: T;
};

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function canonical(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Cyclic value cannot be digested");
    seen.add(value); const output = value.map((item) => canonical(item, seen)); seen.delete(value); return output;
  }
  if (!plain(value)) throw new Error("Only JSON-compatible facts can be digested");
  if (seen.has(value)) throw new Error("Cyclic value cannot be digested");
  seen.add(value);
  const output = Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], seen)]));
  seen.delete(value); return output;
}
function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER;
}
function zeroEffects(): ZeroTurnEffects {
  return { providerRequests: 0, userMessages: 0, assistantMessages: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, continuationConsumed: 0, turnTriggers: 0 };
}
function counters(value: ZeroTurnObservation): ZeroTurnEffects {
  return { providerRequests: value.providerRequests, userMessages: value.userMessages, assistantMessages: value.assistantMessages,
    inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens, cacheReadTokens: value.usage.cacheReadTokens,
    cacheWriteTokens: value.usage.cacheWriteTokens, costMicros: value.usage.costMicros,
    continuationConsumed: value.continuationConsumed, turnTriggers: value.turnTriggers };
}
function observationErrors(value: ZeroTurnObservation): string[] {
  const errors: string[] = [], values = counters(value);
  for (const key of EFFECT_KEYS) if (!nonnegativeInteger(values[key])) errors.push(`invalid-observation:${key}`);
  if (!REF.test(value.sessionRef) || !(value.leafMessageRef === null || REF.test(value.leafMessageRef))) errors.push("invalid-observation:session-identity");
  for (const [key, digest] of [["messageSetDigest", value.messageSetDigest], ["promptDigest", value.promptDigest], ["toolSchemaDigest", value.toolSchemaDigest]] as const) {
    if (!DIGEST.test(digest)) errors.push(`invalid-observation:${key}`);
  }
  for (const [key, digest] of [["taskContractDigest", value.taskContractDigest], ["journalHead", value.journalHead]] as const) {
    if (!(digest === null || DIGEST.test(digest) || REF.test(digest))) errors.push(`invalid-observation:${key}`);
  }
  if (!nonnegativeInteger(value.latestCausalSequence)) errors.push("invalid-observation:causal-sequence");
  let previous = -1;
  for (const event of value.causalEvents) {
    if (!nonnegativeInteger(event.sequence) || event.sequence <= previous || event.sequence > value.latestCausalSequence) errors.push("invalid-observation:causal-event-order");
    previous = event.sequence;
    if (!(event.correlationId === null || REF.test(event.correlationId)) || !["ui-command", "unrelated-operation", "unknown"].includes(event.attribution)) errors.push("invalid-observation:causal-event-identity");
    for (const [key, effect] of Object.entries(event.effects)) {
      if (!EFFECT_KEYS.includes(key as EffectKey) || !nonnegativeInteger(effect)) errors.push(`invalid-observation:causal-effect:${key}`);
    }
  }
  return errors;
}

export function digestZeroTurnFact(domain: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(domain)) throw new Error("Invalid fact digest domain");
  return `sha256:${hash(`piagent-webui-zero-turn:${domain}\n${JSON.stringify(canonical(value))}`)}`;
}

export function providerVisibleToolSchemaDigest(tools: Array<{ name: string; description?: string; parameters?: unknown }>): string {
  const projected = tools.map((tool) => {
    if (!REF.test(tool.name)) throw new Error(`Invalid provider-visible tool name: ${tool.name}`);
    return { name: tool.name, description: String(tool.description ?? ""), parameters: canonical(tool.parameters ?? {}) };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(projected.map((tool) => tool.name)).size !== projected.length) throw new Error("Provider-visible tool names must be unique");
  return digestZeroTurnFact("tool-schema", projected);
}

export function evaluateZeroTurn<T>(options: ZeroTurnOptions, before: ZeroTurnObservation, after: ZeroTurnObservation, result?: T): ZeroTurnReport<T> {
  const violations = [...observationErrors(before).map((error) => `before:${error}`), ...observationErrors(after).map((error) => `after:${error}`)];
  const beforeCounters = counters(before), afterCounters = counters(after), delta = zeroEffects();
  for (const key of EFFECT_KEYS) {
    delta[key] = afterCounters[key] - beforeCounters[key];
    if (delta[key] < 0) violations.push(`counter-regressed:${key}`);
  }
  if (after.latestCausalSequence < before.latestCausalSequence) violations.push("causal-sequence-regressed");
  const events = after.causalEvents.filter((event) => event.sequence > before.latestCausalSequence);
  if (events.some((event) => event.sequence > after.latestCausalSequence)) violations.push("causal-event-after-observation");
  if (options.concurrency === "quiescent") {
    for (const key of EFFECT_KEYS) if (delta[key] !== 0) violations.push(`quiescent-counter-changed:${key}`);
    if (events.some((event) => EFFECT_KEYS.some((key) => (event.effects[key] ?? 0) > 0))) violations.push("quiescent-causal-effect-observed");
  } else {
    const reconciled = zeroEffects();
    for (const event of events) {
      for (const key of EFFECT_KEYS) reconciled[key] += event.effects[key] ?? 0;
      if (EFFECT_KEYS.some((key) => (event.effects[key] ?? 0) > 0)
        && (event.attribution !== "unrelated-operation" || event.correlationId === options.commandId)) violations.push(`prohibited-causal-attribution:${event.sequence}`);
    }
    for (const key of EFFECT_KEYS) if (reconciled[key] !== delta[key]) violations.push(`unreconciled-concurrent-delta:${key}`);
  }
  if (before.sessionRef !== after.sessionRef) violations.push("session-replaced");
  const unrelatedMessagesSettled = options.concurrency === "concurrent" && delta.userMessages + delta.assistantMessages > 0;
  if (before.leafMessageRef !== after.leafMessageRef && !unrelatedMessagesSettled) violations.push("leaf-message-changed");
  if (before.messageSetDigest !== after.messageSetDigest && !unrelatedMessagesSettled) violations.push("message-set-changed");
  if (before.promptDigest !== after.promptDigest) violations.push("prompt-changed");
  if (before.toolSchemaDigest !== after.toolSchemaDigest) violations.push("provider-tool-schema-changed");
  const allowed = new Set(options.allowedDigestChanges ?? []);
  if (before.taskContractDigest !== after.taskContractDigest && !allowed.has("taskContractDigest")) violations.push("task-contract-changed");
  if (before.journalHead !== after.journalHead && !allowed.has("journalHead")) violations.push("journal-head-changed");
  if (options.mutationClass === "view" && allowed.size > 0) violations.push("view-action-cannot-allow-authoritative-mutation");
  return { version: ZERO_TURN_CONFORMANCE_VERSION, passed: violations.length === 0, action: options.action, commandId: options.commandId,
    concurrency: options.concurrency, mutationClass: options.mutationClass, violations: [...new Set(violations)], delta, ...(result === undefined ? {} : { result }) };
}

export async function runZeroTurnConformance<T>(
  options: ZeroTurnOptions,
  observe: () => ZeroTurnObservation | Promise<ZeroTurnObservation>,
  action: () => T | Promise<T>
): Promise<ZeroTurnReport<T>> {
  const before = structuredClone(await observe());
  let result: T;
  try { result = await action(); } catch (error) {
    const after = structuredClone(await observe());
    const report = evaluateZeroTurn<T>(options, before, after);
    return { ...report, passed: false, violations: [...report.violations, `action-failed:${error instanceof Error ? error.name : "unknown"}`] };
  }
  const after = structuredClone(await observe());
  return evaluateZeroTurn(options, before, after, result);
}
