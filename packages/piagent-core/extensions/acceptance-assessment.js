import { isCurrentWorkingTreeDigest } from "./working-tree-digest.js";

export const ACCEPTANCE_ASSESSMENT_VERSION = "contract-assessment-v1";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/;
const STATUSES = new Set(["pass", "fail", "unknown", "error"]);
const COMPLETIONS = new Set(["completed", "timeout", "crashed", "cancelled"]);
const MAX_CHECKS = 256;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`Invalid ${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw new TypeError(`Invalid ${label} properties`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function tree(value, label) {
  if (!isCurrentWorkingTreeDigest(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function denseArray(value, label, allowEmpty = true) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_CHECKS || (!allowEmpty && value.length === 0)) throw new TypeError(`Invalid ${label}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw new TypeError(`Invalid ${label} properties`);
  const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) throw new TypeError(`Invalid ${label} entry`);
    copy.push(descriptor.value);
  }
  return copy;
}

function contractSnapshot(input) {
  record(input, "assessment contract");
  const requiredCheckIds = denseArray(input.requiredCheckIds, "required checks", false).map((value) => identifier(value, "check id"));
  if (new Set(requiredCheckIds).size !== requiredCheckIds.length) throw new TypeError("Duplicate required check");
  return Object.freeze({
    taskRunId: identifier(input.taskRunId, "task run id"),
    criterionHash: hash(input.criterionHash, "criterion hash"),
    workingTreeDigest: tree(input.workingTreeDigest, "working tree digest"),
    verifierDigest: hash(input.verifierDigest, "verifier digest"),
    requiredCheckIds: Object.freeze(requiredCheckIds)
  });
}

function observedCheck(input, required) {
  record(input, "observed check");
  const id = identifier(input.id, "observed check id");
  if (!required.has(id) || !STATUSES.has(input.status)
    || !Number.isSafeInteger(input.caseCount) || input.caseCount < 0
    || (["pass", "fail"].includes(input.status) && input.caseCount === 0)) throw new TypeError("Invalid observed check result");
  const counterexampleRef = input.counterexampleRef === undefined ? null : hash(input.counterexampleRef, "counterexample reference");
  if ((input.status === "fail") !== (counterexampleRef !== null)) throw new TypeError("Counterexample must identify a failed check");
  return Object.freeze({ id, status: input.status, caseCount: input.caseCount, counterexampleRef });
}

function result(verdict, action, reasons, options = {}) {
  return Object.freeze({
    schemaVersion: 1,
    policyVersion: ACCEPTANCE_ASSESSMENT_VERSION,
    verdict,
    action,
    completionAllowed: verdict === "pass",
    // A decision never grants mutation authority; the recovery policy must
    // additionally authorize a concrete repair and consume its durable budget.
    repairEligible: verdict === "fail",
    sourceMutationAllowed: false,
    assurance: verdict === "pass" ? "bounded-contract-tested" : "none",
    reasons: Object.freeze(reasons),
    failedChecks: Object.freeze(options.failedChecks ?? []),
    missingChecks: Object.freeze(options.missingChecks ?? [])
  });
}

/**
 * One-shot host-side assessment boundary. Only an approved executor may hold
 * observeExecution. Neither method is a model tool or a candidate-code binding.
 *
 * A receipt is a live capability, not authenticated JSON: copies, deserialized
 * objects, and receipts from another session are rejected. Durable admission
 * must be implemented separately; this module never trusts a public digest as
 * proof of who produced a receipt. It does not execute project JavaScript.
 */
export function createAcceptanceAssessmentSession(input) {
  const contract = contractSnapshot(input);
  const required = new Set(contract.requiredCheckIds);
  const observations = new WeakMap();
  let observed = false;

  function observeExecution(input) {
    if (observed) throw new Error("Assessment session already observed an execution");
    record(input, "execution observation");
    const runId = identifier(input.runId, "execution run id");
    if (!COMPLETIONS.has(input.completion)) {
      throw new TypeError("Invalid execution observation");
    }
    const checks = denseArray(input.checks, "observed checks").map((check) => observedCheck(check, required));
    if (new Set(checks.map((check) => check.id)).size !== checks.length) throw new TypeError("Duplicate observed check");
    const snapshot = Object.freeze({
      taskRunId: identifier(input.taskRunId, "observed task run id"),
      criterionHash: hash(input.criterionHash, "observed criterion hash"),
      verifierDigest: hash(input.verifierDigest, "observed verifier digest"),
      beforeWorkingTreeDigest: tree(input.beforeWorkingTreeDigest, "pre-execution tree"),
      afterWorkingTreeDigest: tree(input.afterWorkingTreeDigest, "post-execution tree"),
      completion: input.completion,
      checks: Object.freeze(checks)
    });
    const receipt = Object.freeze({ schemaVersion: 1, runId, ...snapshot });
    observations.set(receipt, snapshot);
    observed = true;
    return receipt;
  }

  function assess({ receipt, currentWorkingTreeDigest, policy = "unknown", projectVerifierCurrent = false } = {}) {
    if (policy !== "allow") return result("unknown", "resolve-policy", [policy === "deny" ? "policy-denied" : "policy-unestablished"]);
    if (!isCurrentWorkingTreeDigest(currentWorkingTreeDigest) || currentWorkingTreeDigest !== contract.workingTreeDigest) {
      return result("unknown", "reverify-current-tree", ["current-tree-mismatch"]);
    }
    if (projectVerifierCurrent !== true) return result("unknown", "run-project-verifier", ["current-project-verifier-missing"]);
    const observation = receipt && typeof receipt === "object" ? observations.get(receipt) : undefined;
    if (!observation) return result("unknown", "run-independent-verifier", [receipt == null ? "independent-observation-missing" : "untrusted-observation"]);
    if (observation.taskRunId !== contract.taskRunId || observation.criterionHash !== contract.criterionHash
      || observation.verifierDigest !== contract.verifierDigest) return result("unknown", "reverify-contract", ["observation-binding-mismatch"]);
    if (observation.beforeWorkingTreeDigest !== contract.workingTreeDigest
      || observation.afterWorkingTreeDigest !== contract.workingTreeDigest) return result("unknown", "reverify-current-tree", ["execution-tree-mismatch"]);
    if (observation.completion !== "completed") return result("error", "diagnose-executor", [`executor-${observation.completion}`]);
    if (observation.checks.some((check) => check.status === "error")) return result("error", "diagnose-executor", ["check-execution-error"]);
    const failedChecks = observation.checks.filter((check) => check.status === "fail").map((check) => check.id);
    if (failedChecks.length) return result("fail", "repair-counterexample", ["observed-contract-counterexample"], { failedChecks });
    const passed = new Set(observation.checks.filter((check) => check.status === "pass").map((check) => check.id));
    const missingChecks = contract.requiredCheckIds.filter((id) => !passed.has(id));
    if (missingChecks.length) return result("unknown", "complete-verification", ["required-check-coverage-missing"], { missingChecks });
    return result("pass", "accept-covered-contract", ["all-required-checks-observed"]);
  }

  return Object.freeze({ contract, observeExecution, assess });
}
