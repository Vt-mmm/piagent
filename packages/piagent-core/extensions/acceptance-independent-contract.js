import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runIsolatedContract } from "./acceptance-isolated-executor.js";
import { parseRequest, validateValue } from "./acceptance-executor/protocol.mjs";

export const INDEPENDENT_CONTRACT_VERSION = "primitive-contract-comparison-v1";
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

function validateExpected(expected, args) {
  shape(expected, ["outcome", "value", "errorClass", "clockReads", "dateArgsAfter"], ["outcome"]);
  if (expected.outcome === "return") {
    validateValue(expected.value, false);
    if (Object.hasOwn(expected, "errorClass")) throw new TypeError("Conflicting expected result");
  } else if (expected.outcome === "throw") {
    if (!ERROR_CLASSES.includes(expected.errorClass) || Object.hasOwn(expected, "value")) throw new TypeError("Invalid expected exception");
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
}

/** Compile a HOST-OWNED, independently specified plan, not model-authored proof. */
export function compileIndependentContract(planText) {
  if (typeof planText !== "string" || Buffer.byteLength(planText) > 1024 * 1024) throw new TypeError("Contract plan size exceeded");
  const plan = JSON.parse(planText);
  shape(plan, ["schemaVersion", "source", "exportName", "checks"]);
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > 256) {
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
      shape(item, ["id", "args", "clock", "expected"], ["id", "args", "expected"]);
      const { expected, ...input } = item;
      cases.push(input);
      if (cases.length > 256) throw new TypeError("Too many independent cases");
    }
  }
  const requestText = JSON.stringify({ schemaVersion: 1, source: plan.source, exportName: plan.exportName, cases });
  parseRequest(requestText); // Validate all guest inputs before validating dependent expected state.
  for (const check of plan.checks) for (const item of check.cases) validateExpected(item.expected, item.args);
  return freeze({ plan, requestText, planDigest: hash(JSON.stringify([INDEPENDENT_CONTRACT_VERSION, plan])) });
}

function matches(expected, observed) {
  if (expected.outcome !== observed.outcome) return false;
  if (expected.outcome === "return" && !isDeepStrictEqual(expected.value, observed.value)) return false;
  if (expected.outcome === "throw" && expected.errorClass !== observed.errorClass) return false;
  if (Object.hasOwn(expected, "clockReads") && expected.clockReads !== observed.clockReads) return false;
  if (Object.hasOwn(expected, "dateArgsAfter") && !isDeepStrictEqual(expected.dateArgsAfter, observed.dateArgsAfter)) return false;
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
  const execution = await runIsolatedContract({ ...backend, requestText: compiled.requestText });
  const counterexamples = [];
  const observations = new Map((execution.observation?.cases ?? []).map((item) => [item.id, item]));
  const checks = compiled.plan.checks.map((check) => {
    let caseCount = 0, incomplete = false, error = false, counterexampleRef;
    for (const item of check.cases) {
      const observed = observations.get(item.id);
      if (!observed || observed.outcome === "unsupported") { incomplete = true; continue; }
      if (observed.outcome === "error") { error = true; continue; }
      caseCount += 1;
      if (!matches(item.expected, observed)) {
        const evidence = { version: INDEPENDENT_CONTRACT_VERSION, planDigest: compiled.planDigest,
          runId: execution.runId, sourceDigest: execution.sourceDigest, imageId: execution.imageId,
          checkId: check.id, input: { id: item.id, args: item.args, ...(Object.hasOwn(item, "clock") ? { clock: item.clock } : {}) },
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
  return freeze({ version: INDEPENDENT_CONTRACT_VERSION, planDigest: compiled.planDigest,
    verdict, execution, checks, counterexamples });
}
