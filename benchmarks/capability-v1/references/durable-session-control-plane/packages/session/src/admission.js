import crypto from "node:crypto";

import { routeRuntimeCommand } from "./runtime-route.js";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("command payload is not canonical JSON");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function runtimeCommandDigest(input) {
  record(input, "digest input");
  if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "kind") || !Object.hasOwn(input, "payload")) throw new TypeError("digest input must contain exactly kind and payload");
  return crypto.createHash("sha256").update(canonical({ kind: input.kind, payload: input.payload })).digest("hex");
}

export function admitRuntimeCommand(state, input) {
  record(state, "state"); record(input, "command");
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !record(state.receipts, "receipts")) throw new TypeError("invalid session state");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || ["__proto__", "prototype", "constructor"].includes(input.idempotencyKey)) throw new TypeError("invalid idempotency key");
  const route = routeRuntimeCommand(input);
  const commandDigest = runtimeCommandDigest({ kind: input.kind, payload: input.payload });
  const prior = Object.hasOwn(state.receipts, input.idempotencyKey) ? state.receipts[input.idempotencyKey] : undefined;
  if (prior) {
    if (prior.commandDigest !== commandDigest) throw new TypeError("idempotency key conflict");
    return { state, receipt: { ...prior, replayed: true } };
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision !== state.revision) throw new TypeError("stale or invalid revision");
  if (route.confirmationRequired && input.confirmed !== true) throw new TypeError("explicit confirmation required");
  const revisionAfter = state.revision + 1;
  if (!Number.isSafeInteger(revisionAfter)) throw new TypeError("revision overflow");
  const stored = {
    idempotencyKey: input.idempotencyKey,
    commandDigest,
    kind: input.kind,
    terminalCommand: route.terminalCommand,
    effect: route.effect,
    expectedModelCalls: route.expectedModelCalls,
    revisionBefore: state.revision,
    revisionAfter,
    replayed: false
  };
  const next = { revision: revisionAfter, receipts: { ...state.receipts, [input.idempotencyKey]: stored } };
  return { state: next, receipt: { ...stored } };
}
