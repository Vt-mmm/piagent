import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openBenchmarkBudgetGovernor } from "../packages/piagent-core/benchmark/benchmark-budget-governor.js";

export const BENCHMARK_BUDGET_CONTEXT = "PIAGENT_BENCHMARK_BUDGET_CONTEXT";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const executionKeys = ["model", "thinking", "serviceTier", "surfaces", "repeats", "timeoutSeconds",
  "infrastructureRetries", "codexMode", "codexBaseline", "piagentTreatment"];
function fail(message) {
  throw Object.assign(new Error(`Benchmark budget: ${message}`), { exitCode: 1, code: "BENCHMARK_BUDGET_DENIED" });
}
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("policy must be a regular file");
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes), sha256: hash(bytes) };
}
function canonicalPath(file) {
  let ancestor = file;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail("path has no existing ancestor");
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

export function readBenchmarkBudgetControl({ options, resumeManifest, sourceRoot } = {}) {
  const saved = resumeManifest?.budgetControl;
  if (resumeManifest && !saved && options.budgetPolicy) fail("cannot add a budget policy to an existing unbudgeted lineage");
  if (!saved && !options.budgetPolicy) return null;
  const policyPath = options.budgetPolicy ?? saved?.policyPath;
  const statePath = options.budgetState ?? saved?.statePath;
  if (![policyPath, statePath].every(p => typeof p === "string" && path.isAbsolute(p) && path.normalize(p) === p)
    || policyPath === statePath) fail("canonical distinct policy/state paths are required");
  if ([policyPath, statePath, `${statePath}.guard`].some(file => canonicalPath(file) !== file)) {
    fail("canonical paths are required; symlink aliases are not allowed");
  }
  const { value, sha256 } = read(policyPath);
  if (value?.schemaVersion !== 1 || value.kind !== "benchmark-management-budget-v1"
    || value.policy?.semantics !== "management-thresholds"
    || ![value.policy.maxProviderAttempts, value.policy.freshTokenThreshold, value.policy.activeWallTimeMsThreshold]
      .every(n => Number.isSafeInteger(n) && n > 0)
    || typeof value.authorityDecision !== "string" || !value.authorityDecision
    || !value.binding || !digestPattern.test(value.binding.candidateDigest)
    || !digestPattern.test(value.binding.suiteDigest)
    || !path.isAbsolute(value.binding.runRoot ?? "")
    || path.normalize(value.binding.runRoot) !== value.binding.runRoot
    || !Array.isArray(value.binding.plannedAttempts)
    || value.binding.plannedAttempts.length !== value.policy.maxProviderAttempts
    || !value.binding.execution) fail("unsupported policy or incomplete frozen binding");
  const identity = { schemaVersion: 1, policyPath, statePath, sha256 };
  if (saved && JSON.stringify(saved) !== JSON.stringify(identity)) fail("resume policy identity changed");
  const output = options.resume ?? options.output;
  if (!output) fail("an explicit pinned output or resume path is required");
  if (path.resolve(output) !== value.binding.runRoot || canonicalPath(output) !== value.binding.runRoot) {
    fail("policy belongs to a different or aliased run root");
  }
  const forbiddenRoots = [value.binding.runRoot, ...(sourceRoot ? [canonicalPath(sourceRoot)] : [])];
  for (const root of forbiddenRoots) {
    const rel = path.relative(root, statePath);
    if (!rel || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
      fail("budget state must be outside source, model workspaces and run output");
    }
  }
  options.budgetPolicy = policyPath;
  options.budgetState = statePath;
  options.budgetControl = identity;
  return Object.freeze({ ...value, identity });
}

export function assertBenchmarkBudgetBinding(control, { options, candidateDigest, suiteDigest, fullOrder }) {
  if (!control) return;
  if (control.binding.candidateDigest !== candidateDigest || control.binding.suiteDigest !== suiteDigest) {
    fail("source or suite differs from the approved policy");
  }
  const execution = Object.fromEntries(executionKeys.map(key => [key, options[key]]));
  if (executionKeys.some(key => JSON.stringify(execution[key]) !== JSON.stringify(control.binding.execution[key]))) {
    fail("execution configuration differs from the approved policy");
  }
  const order = fullOrder.map((item, index) => ({
    orderIndex: index + 1, scenarioId: item.scenario?.id ?? item.scenarioId,
    surface: item.surface, repeat: item.repeat
  }));
  if (JSON.stringify(order) !== JSON.stringify(control.binding.plannedAttempts)) fail("planned attempt order differs");
}

export function assertBenchmarkBudgetPolicyUnchanged(control) {
  if (control && read(control.identity.policyPath).sha256 !== control.identity.sha256) fail("policy changed during execution");
}

export function openBenchmarkBudgetCore(control, { env = process.env, parentPid = process.ppid, now = Date.now } = {}) {
  if (!control) {
    if (env[BENCHMARK_BUDGET_CONTEXT]) fail("launcher budget context has no bound policy");
    return null;
  }
  let context;
  try { context = JSON.parse(env[BENCHMARK_BUDGET_CONTEXT] ?? "null"); } catch { fail("malformed launcher context"); }
  if (!context || context.parentPid !== parentPid || context.policySha256 !== control.identity.sha256
    || context.statePath !== control.identity.statePath || !/^[a-f0-9]{32}$/.test(context.stageId ?? "")) {
    fail("trusted launcher stage handoff is missing or mismatched");
  }
  assertBenchmarkBudgetPolicyUnchanged(control);
  const governor = openBenchmarkBudgetGovernor({ statePath: control.identity.statePath,
    policy: control.policy, binding: control.binding, resume: true, attachStageId: context.stageId, now });
  return { governor, stageId: context.stageId,
    check() {
      assertBenchmarkBudgetPolicyUnchanged(control);
      const snapshot = governor.checkpointStage(context.stageId);
      const reasons = snapshot.stopReasons.filter(reason => !(reason === "session-cap" && snapshot.inFlightAttempts === 1));
      if (reasons.length) fail(`stopped: ${reasons.join(",")}`);
    },
    providerStarted(attempt) { governor.startAttempt(attempt); },
    providerReturned(attempt) {
      governor.settleAttempt(attempt, { usage: attempt.usage, usageStatus: attempt.usageStatus });
      try { assertBenchmarkBudgetPolicyUnchanged(control); }
      catch (error) { governor.stop("budget-policy-changed"); throw error; }
    },
    close() { governor.close(); }
  };
}

export function createBudgetProviderCallbacks(budget, campaign) {
  return {
    onProviderAttemptStart(attempt) { budget?.providerStarted(attempt); campaign?.providerStarted(attempt); },
    onProviderAttemptReturned(attempt) {
      // Keep observed spend even if the independent campaign journal fails.
      try { campaign?.providerReturned(attempt); }
      finally { budget?.providerReturned(attempt); }
    }
  };
}
