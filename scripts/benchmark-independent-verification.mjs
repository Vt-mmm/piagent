import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { installedContractVerifierDigest, openHostContractConfiguration, validateHostContractPlan, writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { DURABLE_EXECUTION_VERSION } from "../packages/piagent-core/extensions/acceptance-durable-execution.js";
import { compileIndependentContract, compareIndependentExecution, INDEPENDENT_CONTRACT_VERSION } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { EXECUTION_SNAPSHOT_VERSION } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { parseRequest, parseResponse } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";

export const BENCHMARK_VERIFICATION_PLAN_VERSION = "benchmark-independent-verification-plan-v1";
const HASH = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const inside = (root, file) => { const relative = path.relative(fs.realpathSync.native(root), file);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };

export function resolvedJourneyTurns(scenario, suiteRoot, resolveSuiteEntry) {
  if (!scenario.userJourney) return null;
  return scenario.userJourney.turns.map((turn) => ({
    id: turn.id,
    message: fs.readFileSync(resolveSuiteEntry(suiteRoot, turn.prompt, `journey prompt ${scenario.id}/${turn.id}`), "utf8").trim(),
    reconnectBefore: turn.reconnectBefore === true,
    receiptUncertain: turn.receiptUncertain === true,
    ...(turn.workflow ? { workflow: turn.workflow } : {})
  }));
}

export function prepareBenchmarkVerification({ options, resumeState, ...scope }) {
  if (resumeState) {
    if (options.verificationPlan && options.verificationPlan !== resumeState.manifest.verificationPlan?.file) throw new Error("Cannot change the verification plan on resume");
    options.verificationPlan = resumeState.manifest.verificationPlan?.file;
  }
  if (options.approveVerification && !options.verificationPlan) throw new Error("--approve-verification requires a verification plan");
  const plan = options.verificationPlan ? loadBenchmarkVerificationPlan({ ...scope, file: options.verificationPlan }) : null;
  if (resumeState && JSON.stringify(plan?.identity ?? null) !== JSON.stringify(resumeState.manifest.verificationPlan?.identity ?? null)) {
    throw new Error("Cannot resume benchmark: independent verification configuration changed");
  }
  if (plan && !options.dryRun && !options.preflightOnly && !options.approveVerification) {
    throw new Error("Independent verification requires explicit --approve-verification; --yes is not approval");
  }
  if (plan) options.keepWorkspaces = true;
  return plan;
}

function readPlan(file) {
  if (!path.isAbsolute(file) || fs.realpathSync.native(file) !== file) throw new Error("Verification plan path must be canonical");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > 2 * 1024 * 1024) throw new Error("Verification plan must be a private bounded host file");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (bytes.length !== stat.size || current.isSymbolicLink()
      || ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].some(key => stat[key] !== after[key] || stat[key] !== current[key])) {
      throw new Error("Verification plan changed during read");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Structural validation is not operator approval or source/plan authentication. */
export function validateBenchmarkVerificationPlan(value) {
  if (!exact(value, ["schemaVersion", "kind", "suiteDigest", "verifierDigest", "scenarios"])
    || value.schemaVersion !== 1 || value.kind !== BENCHMARK_VERIFICATION_PLAN_VERSION
    || !HASH.test(value.suiteDigest) || !HASH.test(value.verifierDigest)
    || !Array.isArray(value.scenarios) || value.scenarios.length < 1 || value.scenarios.length > 100) {
    throw new TypeError("Invalid benchmark verification catalog");
  }
  const seen = new Set();
  for (const entry of value.scenarios) {
    if (!exact(entry, ["scenarioId", "plans"]) || typeof entry.scenarioId !== "string"
      || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(entry.scenarioId) || seen.has(entry.scenarioId)) {
      throw new TypeError("Invalid or duplicate verification scenario");
    }
    seen.add(entry.scenarioId);
    validateHostContractPlan({ schemaVersion: 2, plans: entry.plans });
  }
  return value;
}

/** Read and bind operator-authored expected results; never derive them from a candidate or grader. */
export function loadBenchmarkVerificationPlan({ file, installedRoot, suiteDigest, scenarios, suiteRoot, resolveSuiteEntry }) {
  if (inside(installedRoot, file) || inside(suiteRoot, file)) throw new Error("Verification catalog must be outside candidate and suite source");
  const bytes = readPlan(file), value = validateBenchmarkVerificationPlan(JSON.parse(bytes));
  if (value.suiteDigest !== suiteDigest || value.verifierDigest !== installedContractVerifierDigest(installedRoot)) {
    throw new Error("Verification plan does not match the frozen suite and installed verifier");
  }
  const known = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  for (const entry of value.scenarios) {
    const scenario = known.get(entry.scenarioId);
    if (!scenario) throw new Error("Unknown verification scenario");
    // WebUI journeys send their declared turns, not the ordinary CLI prompt.
    const prompts = scenario.userJourney ? scenario.userJourney.turns.map(turn => turn.prompt) : [scenario.prompt];
    const requests = new Set(prompts.map(prompt => operatorRequestDigest(fs.readFileSync(
      resolveSuiteEntry(suiteRoot, prompt, "verification public prompt"), "utf8").trim())));
    if (entry.plans.some(plan => !requests.has(plan.operatorRequestDigest))) throw new Error("Verification plan authorizes a request not sent by this scenario");
  }
  const catalog = freeze(value);
  const identity = freeze({ kind: BENCHMARK_VERIFICATION_PLAN_VERSION, contentDigest: hash(bytes),
    suiteDigest, verifierDigest: catalog.verifierDigest,
    scenarios: catalog.scenarios.map(entry => ({ scenarioId: entry.scenarioId,
      requests: entry.plans.map(plan => ({ operatorRequestDigest: plan.operatorRequestDigest, criterionCount: plan.contracts.length,
        criteria: plan.contracts.map(contract => ({ criterionId: contract.criterionId, criterionHash: contract.criterionHash })) })) })) });
  const isCurrent = () => {
    try { return hash(readPlan(file)) === identity.contentDigest && installedContractVerifierDigest(installedRoot) === identity.verifierDigest; }
    catch { return false; }
  };
  return Object.freeze({ identity, isCurrent,
    prepare({ scenarioId, surface, projectRoot, directory, approved = false }) {
      if (surface !== "piagent") return null;
      if (approved !== true) throw new Error("Benchmark verification requires explicit --approve-verification");
      if (inside(projectRoot, file)) throw new Error("Verification catalog must be outside the candidate project");
      if (!isCurrent()) throw new Error("Frozen benchmark verification plan or verifier changed");
      const entry = catalog.scenarios.find(item => item.scenarioId === scenarioId);
      if (!entry) return Object.freeze({ environment: Object.freeze({}), observe: () => freeze({ schemaVersion: 1,
        planDigest: identity.contentDigest, status: "not-configured", attempts: 0, workersObserved: 0, requests: [] }) });
      const { configPath } = writeHostContractApproval({ directory, projectRoot, installedRoot, plans: entry.plans, approved: true });
      return Object.freeze({ environment: Object.freeze({ PIAGENT_INDEPENDENT_VERIFICATION_CONFIG: configPath }),
        observe(tasks) { return observeRequests({ configPath, projectRoot, installedRoot, plans: entry.plans,
          planDigest: identity.contentDigest, tasks, isCurrent }); } });
    }
  });
}

/** Observation only, never completion authority. Keep failures and pending attempts in the denominator. */
function observeRequests({ configPath, projectRoot, installedRoot, plans, planDigest, tasks, isCurrent }) {
  let config;
  try {
    if (!isCurrent()) throw new Error("Plan drift");
    if (!Array.isArray(tasks) || tasks.length > 1000 || tasks.some(task => typeof task?.taskRunId !== "string")
      || new Set(tasks.map(task => task.taskRunId)).size !== tasks.length) throw new Error("Invalid task observation");
    config = openHostContractConfiguration({ configPath, projectRoot, installedRoot });
    let attempts = 0, workersObserved = 0, complete = true;
    const requests = plans.map(plan => {
      const matched = tasks.filter(task => task.operatorRequestDigest === plan.operatorRequestDigest);
      if (matched.length === 0) complete = false;
      const backendDigest = hash(JSON.stringify([DURABLE_EXECUTION_VERSION, INDEPENDENT_CONTRACT_VERSION,
        EXECUTION_SNAPSHOT_VERSION, plan.backend.imageId, plan.backend.dockerSocket, plan.backend.timeoutMs]));
      const runs = matched.map(task => ({ taskRunId: task.taskRunId, criteria: plan.contracts.map(contract => {
        const event = config.store.latest({ taskRunId: task.taskRunId, criterionId: contract.criterionId });
        const result = { criterionId: contract.criterionId, criterionHash: contract.criterionHash,
          attempts: event?.attempt ?? 0, phase: event?.phase ?? "not-observed", verdict: null, workerObserved: false };
        attempts += result.attempts;
        const matching = task.acceptanceReceipt?.criteria.some(criterion => criterion.id === contract.criterionId && criterion.hash === contract.criterionHash);
        if (!matching || !event || event.binding.criterionHash !== contract.criterionHash
          || event.binding.verifierDigest !== config.payload.verifierDigest || event.binding.backendDigest !== backendDigest) {
          complete = false; result.phase = event ? "binding-mismatch" : "not-observed"; return result;
        }
        if (event.phase !== "settled") { complete = false; return result; }
        const evidence = JSON.parse(event.evidenceText);
        if (evidence.version !== DURABLE_EXECUTION_VERSION || evidence.snapshotDigest !== event.binding.snapshotDigest
          || evidence.planDigest !== event.binding.planDigest || !["pass", "fail", "unknown", "error"].includes(evidence.verdict)) {
          complete = false; result.phase = "invalid-evidence"; return result;
        }
        result.verdict = evidence.verdict;
        const observed = evidence.observed, execution = observed?.result?.execution;
        if (observed?.snapshotDigest === event.binding.snapshotDigest && observed.result?.version === INDEPENDENT_CONTRACT_VERSION
          && observed.result.planDigest === event.binding.planDigest && execution?.runId === event.attemptId
          && execution.imageId === plan.backend.imageId && HASH.test(execution.sourceDigest) && HASH.test(execution.requestDigest)
          && execution.observation && execution.cleanupConfirmed === true) {
          const template = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: "export const placeholder=0;",
            exportName: contract.exportName, checks: contract.checks }));
          const response = parseResponse(JSON.stringify(execution.observation), parseRequest(template.requestText), execution.requestDigest);
          const compared = compareIndependentExecution({ ...template, planDigest: event.binding.planDigest }, execution);
          result.workerObserved = response.status === execution.status && compared.verdict === evidence.verdict
            && compared.verdict === observed.verdict && compared.verdict === observed.result.verdict
            && JSON.stringify(compared.checks) === JSON.stringify(observed.result.checks)
            && JSON.stringify(compared.counterexamples) === JSON.stringify(observed.result.counterexamples);
        }
        if (result.workerObserved) workersObserved += 1;
        else complete = false;
        return result;
      }) }));
      return { operatorRequestDigest: plan.operatorRequestDigest, runs };
    });
    if (!config.isCurrent() || !isCurrent()) throw new Error("Approval drift");
    return freeze({ schemaVersion: 1, planDigest, status: complete ? "observed" : "partial", attempts, workersObserved, requests });
  } catch {
    // Usage has already been collected by the caller. Invalid verification
    // evidence must not discard the paid attempt or reveal private plan data.
    return freeze({ schemaVersion: 1, planDigest, status: "unavailable", attempts: null, workersObserved: null, requests: [] });
  } finally { config?.close(); }
}
