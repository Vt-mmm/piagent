import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runIsolatedContract } from "./acceptance-isolated-executor.js";
import { parseRequest, validateValue } from "./acceptance-executor/protocol.mjs";
import { canonicalValue } from "./acceptance-executor/values.mjs";
import { CASE_CAPABILITY_FIELDS, OBSERVATION_CAPABILITY_FIELDS, callbackIds, validateCallbackTrace, validateReturnIdentity, validateErrorObservation } from "./acceptance-executor/capabilities.mjs";
import { validateReferenceIdentity } from "./acceptance-executor/reference-identity.mjs";

export const INDEPENDENT_CONTRACT_VERSION = "bounded-module-contract-comparison-v5";
export const NODE_INDEPENDENT_CONTRACT_VERSION = "bounded-node-profile-contract-comparison-v1";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ERROR_CLASSES = ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "Error", "non-error"];

function shape(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Invalid independent contract object");
  }
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateExpected(expected, item, nodeProfile = false) {
  const { args } = item;
  shape(expected, ["outcome", "value", "errorClass", "clockReads", "dateArgsAfter", "argsAfter", ...OBSERVATION_CAPABILITY_FIELDS], ["outcome"]);
  if (nodeProfile && item.invocation?.kind === "construct" && !["constructed", "throw"].includes(expected.outcome)) {
    throw new TypeError("Invalid constructor expectation");
  }
  if (expected.outcome === "return") {
    validateValue(expected.value, false, new Set(), { typedBytes: nodeProfile });
    if (Object.hasOwn(expected, "errorClass")) throw new TypeError("Conflicting expected result");
  } else if (expected.outcome === "throw") {
    if (!ERROR_CLASSES.includes(expected.errorClass) || Object.hasOwn(expected, "value")) throw new TypeError("Invalid expected exception");
  } else if (nodeProfile && expected.outcome === "constructed") {
    if (item.invocation?.kind !== "construct" || Object.hasOwn(expected, "value") || Object.hasOwn(expected, "errorClass")) {
      throw new TypeError("Invalid expected construction");
    }
  } else throw new TypeError("Invalid expected outcome");
  if (Object.hasOwn(expected, "clockReads") && (!Number.isSafeInteger(expected.clockReads) || expected.clockReads < 0)) {
    throw new TypeError("Invalid expected clock reads");
  }
  if (Object.hasOwn(expected, "dateArgsAfter")) {
    const indexes = args.flatMap((arg, index) => arg.type === "date" ? [index] : []);
    if (!Array.isArray(expected.dateArgsAfter) || expected.dateArgsAfter.length !== indexes.length) throw new TypeError("Incomplete expected Date state");
    expected.dateArgsAfter.forEach((arg, index) => {
      shape(arg, ["index", "value"]);
      if (arg.index !== indexes[index]) throw new TypeError("Wrong expected Date argument");
      validateValue({ type: "number", value: arg.value }, false);
    });
  }
  if (Object.hasOwn(expected, "argsAfter")) {
    if (!item.observeArgs || !Array.isArray(expected.argsAfter) || expected.argsAfter.length !== args.length) throw new TypeError("Incomplete expected argument state");
    expected.argsAfter.forEach((arg) => validateValue(arg, true, callbackIds(item), { typedBytes: nodeProfile }));
  }
  if (item.callbacks) validateCallbackTrace(expected.callbackTrace, item, { nodeProfile });
  else if (Object.hasOwn(expected, "callbackTrace")) throw new TypeError("Unexpected expected callback trace");
  if (item.referencePairs || Object.hasOwn(expected, "referenceIdentity")) validateReferenceIdentity(expected.referenceIdentity, item);
  if (item.observeIdentity && expected.outcome === "return" || Object.hasOwn(expected, "returnIdentity")) {
    if (expected.outcome !== "return") throw new TypeError("Return identity on an exception");
    validateReturnIdentity(expected.returnIdentity, item);
  }
  if (item.observeError && expected.outcome === "throw" || Object.hasOwn(expected, "errorObservation")) {
    if (expected.outcome !== "throw") throw new TypeError("Error observation on a return");
    validateErrorObservation(expected.errorObservation, item, { nodeProfile });
  }
}

/** Compile a HOST-OWNED, independently specified plan, not model-authored proof. */
export function compileIndependentContract(planText) {
  if (typeof planText !== "string" || Buffer.byteLength(planText) > 1024 * 1024) throw new TypeError("Contract plan size exceeded");
  const plan = JSON.parse(planText);
  const nodeProfile = plan?.schemaVersion === 2;
  shape(plan, ["schemaVersion", "profile", "source", "exportName", "checks", "moduleGraph"],
    nodeProfile ? ["schemaVersion", "profile", "source", "exportName", "checks"] : ["schemaVersion", "source", "exportName", "checks"]);
  if (!nodeProfile && plan.schemaVersion !== 1 || !Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > 256) {
    throw new TypeError("Invalid contract checks");
  }
  const ids = new Set();
  const cases = [];
  for (const check of plan.checks) {
    shape(check, ["id", "cases"]);
    if (typeof check.id !== "string" || !ID.test(check.id) || ids.has(check.id) || !Array.isArray(check.cases)
      || check.cases.length < 1 || check.cases.length > 256) throw new TypeError("Invalid independent check");
    ids.add(check.id);
    for (const item of check.cases) {
      shape(item, ["id", "args", "clock", "expected", "sequence", "exportName", "reset", "observeArgs", "invocation", ...CASE_CAPABILITY_FIELDS],
        nodeProfile ? ["id", "args", "expected", "invocation"] : ["id", "args", "expected"]);
      const { expected, ...input } = item;
      cases.push(input);
      if (cases.length > 256) throw new TypeError("Too many independent cases");
    }
  }
  const requestText = JSON.stringify({ schemaVersion: nodeProfile ? 2 : 1, ...(nodeProfile ? { profile: plan.profile } : {}),
    source: plan.source, exportName: plan.exportName, cases,
    ...(Object.hasOwn(plan, "moduleGraph") ? { moduleGraph: plan.moduleGraph } : {}) });
  parseRequest(requestText); // Validate all guest inputs before validating dependent expected state.
  // Every failing step can retain its full replay prefix. Bound the worst-case
  // repeated input bytes before execution, not after a large receipt is built.
  let sequence, prefixBytes = 2, historyBytes = 0;
  for (const item of cases) {
    if (!item.sequence || item.sequence !== sequence) prefixBytes = 2;
    sequence = item.sequence;
    if (!sequence) continue;
    prefixBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    historyBytes += prefixBytes;
    if (historyBytes > 2 * 1024 * 1024) throw new TypeError("Counterexample history budget exceeded");
  }
  for (const check of plan.checks) for (const item of check.cases) validateExpected(item.expected, item, nodeProfile);
  const version = nodeProfile ? NODE_INDEPENDENT_CONTRACT_VERSION : INDEPENDENT_CONTRACT_VERSION;
  return freeze({ version, plan, requestText, planDigest: hash(JSON.stringify([version, plan])) });
}

function matches(expected, observed) {
  if (expected.outcome !== observed.outcome) return false;
  if (expected.outcome === "return" && !isDeepStrictEqual(canonicalValue(expected.value), canonicalValue(observed.value))) return false;
  if (expected.outcome === "throw" && expected.errorClass !== observed.errorClass) return false;
  if (Object.hasOwn(expected, "clockReads") && expected.clockReads !== observed.clockReads) return false;
  if (Object.hasOwn(expected, "dateArgsAfter") && !isDeepStrictEqual(expected.dateArgsAfter, observed.dateArgsAfter)) return false;
  if (Object.hasOwn(expected, "argsAfter") && !isDeepStrictEqual(expected.argsAfter.map(canonicalValue), observed.argsAfter?.map(canonicalValue))) return false;
  const canonicalTrace = trace => trace?.map(call => call.event === "call" ? { ...call, args: call.args.map(canonicalValue) } : call);
  if (Object.hasOwn(expected, "callbackTrace") && !isDeepStrictEqual(canonicalTrace(expected.callbackTrace), canonicalTrace(observed.callbackTrace))) return false;
  if (Object.hasOwn(expected, "returnIdentity") && !isDeepStrictEqual(expected.returnIdentity, observed.returnIdentity)) return false;
  if (Object.hasOwn(expected, "referenceIdentity") && !isDeepStrictEqual(expected.referenceIdentity, observed.referenceIdentity)) return false;
  if (Object.hasOwn(expected, "errorObservation") && (expected.errorObservation.identity !== observed.errorObservation?.identity
    || !observed.errorObservation || !isDeepStrictEqual(canonicalValue(expected.errorObservation.properties), canonicalValue(observed.errorObservation.properties)))) return false;
  return true;
}

/**
 * Actual observations come only from this invocation of the isolated adapter.
 * Expected outputs remain on the host; guest output cannot select a verdict.
 * This returns diagnostic evidence, NOT an authenticated durable receipt or
 * completion authority. Runtime contract approval and snapshot binding remain
 * required at integration. Unsupported execution is never a passed case.
 */
export async function runIndependentContract({ planText, ...backend } = {}) {
  const compiled = compileIndependentContract(planText);
  const execution = await runIsolatedContract({ ...backend, ...(compiled.plan.schemaVersion === 2 ? { profile: compiled.plan.profile } : {}), requestText: compiled.requestText });
  return compareIndependentExecution(compiled, execution);
}

/** Host comparison only: this pure projection does not certify an execution. */
export function compareIndependentExecution(compiled, execution) {
  const counterexamples = [];
  const observations = new Map((execution.observation?.cases ?? []).map((item) => [item.id, item]));
  let sequence, history = [];
  const checks = compiled.plan.checks.map((check) => {
    let caseCount = 0, incomplete = false, error = false, counterexampleRef;
    for (const item of check.cases) {
      const { expected: _expected, ...input } = item;
      if (!item.sequence || item.sequence !== sequence) history = [];
      sequence = item.sequence; history.push(input);
      const observed = observations.get(item.id);
      if (!observed || observed.outcome === "unsupported") { incomplete = true; continue; }
      if (observed.outcome === "error") { error = true; continue; }
      caseCount += 1;
      if (!matches(item.expected, observed)) {
        const evidence = { version: compiled.version ?? INDEPENDENT_CONTRACT_VERSION, planDigest: compiled.planDigest,
          runId: execution.runId, sourceDigest: execution.sourceDigest, imageId: execution.imageId,
          checkId: check.id, input: { ...input, ...(sequence ? { prefix: history.slice() } : {}) },
          expected: item.expected, observed };
        const digest = hash(JSON.stringify(evidence));
        counterexamples.push({ digest, evidence });
        counterexampleRef ??= digest;
      }
    }
    const status = error ? "error" : counterexampleRef ? "fail" : incomplete ? "unknown" : "pass";
    return { id: check.id, status, caseCount, ...(status === "fail" ? { counterexampleRef } : {}) };
  });
  const statuses = checks.map((check) => check.status);
  const verdict = execution.status !== "completed" || !execution.cleanupConfirmed || statuses.includes("error") ? "error"
    : statuses.includes("fail") ? "fail" : statuses.includes("unknown") ? "unknown" : "pass";
  return freeze({ version: compiled.version ?? INDEPENDENT_CONTRACT_VERSION, planDigest: compiled.planDigest,
    verdict, execution, checks, counterexamples });
}
