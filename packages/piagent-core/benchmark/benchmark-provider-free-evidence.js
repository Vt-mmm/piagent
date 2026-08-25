import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const LANE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "runtime-conformance-v1",
    configuration: "evals/runtime-conformance-v1/lane.json",
    runner: "evals/runtime-conformance-v1/runner.mjs",
    timeoutMilliseconds: 5 * 60_000
  }),
  Object.freeze({
    id: "long-horizon-v1",
    configuration: "evals/long-horizon-v1/lane.json",
    runner: "evals/long-horizon-v1/runner.mjs",
    timeoutMilliseconds: 40 * 60_000
  }),
  Object.freeze({
    id: "webui-parity-v1",
    configuration: "packages/piagent-webui/benchmark/parity-lane.v1.json",
    runner: "packages/piagent-webui/benchmark/parity-benchmark.mjs",
    timeoutMilliseconds: 20 * 60_000
  })
]);

function digestBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileDigest(root, relative) {
  return digestBytes(fs.readFileSync(path.join(root, relative)));
}

function receiptDigest(value) {
  const copy = structuredClone(value);
  delete copy.digest;
  return digestBytes(JSON.stringify(copy));
}

function validCompletionTime(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value
    && milliseconds <= Date.now() + 60_000;
}

function expectedLaneBindings(packageRoot) {
  return LANE_DEFINITIONS.map((lane) => ({
    id: lane.id,
    configurationPath: lane.configuration,
    configurationDigest: fileDigest(packageRoot, lane.configuration),
    runnerPath: lane.runner,
    runnerDigest: fileDigest(packageRoot, lane.runner)
  }));
}

export function productionProviderFreeEvidenceBinding({
  packageRoot,
  source,
  candidateProvenance,
  configurationDigest
}) {
  if (source?.kind !== "git-working-tree" || source.dirty !== false || !COMMIT.test(String(source.commit ?? ""))) {
    throw new Error("Production provider-free evidence requires an exact clean Git commit");
  }
  if (!HASH.test(String(candidateProvenance?.contentDigest ?? ""))) {
    throw new Error("Production provider-free evidence requires an exact candidate tree digest");
  }
  if (!HASH.test(String(configurationDigest ?? ""))) {
    throw new Error("Production provider-free evidence requires the frozen production configuration digest");
  }
  const binding = {
    schemaVersion: 1,
    source: {
      kind: source.kind,
      commit: source.commit,
      clean: true,
      treeDigest: candidateProvenance.contentDigest,
      treeAlgorithm: candidateProvenance.algorithm
    },
    productionConfigurationDigest: configurationDigest,
    lanes: expectedLaneBindings(packageRoot)
  };
  return { ...binding, digest: receiptDigest(binding) };
}

function lanePassed(id, result) {
  if (id === "runtime-conformance-v1") {
    return result?.summary?.passed === true
      && result?.provider?.used === false
      && result.provider.calls === 0
      && result.provider.modelInputTokens === 0
      && result.provider.modelOutputTokens === 0
      && Object.values(result?.gates ?? {}).every((value) => value === true);
  }
  if (id === "long-horizon-v1") {
    return result?.evidenceClass === "provider-free-long-horizon"
      && result?.providerUsed === false
      && result?.wallClockQualified === true
      && result?.completedFromResume === true
      && result?.context?.withinCeiling === true
      && result?.stateGrowth?.withinCeiling === true
      && result?.continuation?.enforcementSafe === true
      && result?.verification?.stableCurrentTree === true;
  }
  return result?.benchmark === "webui-parity-v1"
    && result?.passed === true
    && result?.providerCalls === 0
    && result?.modelTokens === 0
    && result?.invariants?.uiStability === "deterministic-current-state"
    && result?.invariants?.uiStabilitySuites === 7;
}

function laneSummary(id, result) {
  if (id === "runtime-conformance-v1") return {
    passed: result.summary.passed,
    configuredCases: result.summary.configuredCases,
    executedCases: result.summary.executedCases,
    failedCases: result.summary.failedCases,
    gates: result.gates
  };
  if (id === "long-horizon-v1") return {
    evidenceClass: result.evidenceClass,
    wallClockQualified: result.wallClockQualified,
    completedFromResume: result.completedFromResume,
    contextWithinCeiling: result.context.withinCeiling,
    stateGrowthWithinCeiling: result.stateGrowth.withinCeiling,
    continuationEnforcementSafe: result.continuation.enforcementSafe,
    stableCurrentTree: result.verification.stableCurrentTree
  };
  return {
    benchmark: result.benchmark,
    passed: result.passed,
    uiStability: result.invariants.uiStability,
    uiStabilitySuites: result.invariants.uiStabilitySuites,
    deterministicStabilityStepPassed: result.steps.some((step) => step.name === "deterministic-ui-stability" && step.passed === true)
  };
}

function summaryPassed(id, summary) {
  if (id === "runtime-conformance-v1") return summary?.passed === true
    && summary.configuredCases === summary.executedCases && summary.failedCases === 0
    && Object.values(summary.gates ?? {}).every((value) => value === true);
  if (id === "long-horizon-v1") return summary?.evidenceClass === "provider-free-long-horizon"
    && summary.wallClockQualified === true && summary.completedFromResume === true
    && summary.contextWithinCeiling === true && summary.stateGrowthWithinCeiling === true
    && summary.continuationEnforcementSafe === true && summary.stableCurrentTree === true;
  return summary?.benchmark === "webui-parity-v1" && summary.passed === true
    && summary.uiStability === "deterministic-current-state"
    && summary.uiStabilitySuites === 7
    && summary.deterministicStabilityStepPassed === true;
}

function privateWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Non-POSIX filesystem. */ }
}

export function productionProviderFreeEvidenceValidationErrors(receipt, expectedBinding) {
  const errors = [];
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== "production-provider-free-evidence-v1") {
    return ["missing-or-unsupported-provider-free-evidence"];
  }
  if (!validCompletionTime(receipt.completedAt)) errors.push("provider-free-completion-time-invalid-or-future");
  const validExpectedBinding = expectedBinding?.schemaVersion === 1
    && expectedBinding?.source?.kind === "git-working-tree"
    && expectedBinding.source.clean === true
    && COMMIT.test(String(expectedBinding.source.commit ?? ""))
    && HASH.test(String(expectedBinding.source.treeDigest ?? ""))
    && HASH.test(String(expectedBinding.productionConfigurationDigest ?? ""))
    && Array.isArray(expectedBinding.lanes)
    && expectedBinding.lanes.length === LANE_DEFINITIONS.length
    && LANE_DEFINITIONS.every((definition, index) => {
      const lane = expectedBinding.lanes[index];
      return lane?.id === definition.id
        && lane.configurationPath === definition.configuration
        && lane.runnerPath === definition.runner
        && HASH.test(String(lane.configurationDigest ?? ""))
        && HASH.test(String(lane.runnerDigest ?? ""));
    })
    && expectedBinding.digest === receiptDigest(expectedBinding);
  if (!validExpectedBinding) return ["invalid-provider-free-expected-binding"];
  if (receipt?.binding?.digest !== expectedBinding?.digest
    || JSON.stringify(receipt.binding) !== JSON.stringify(expectedBinding)) errors.push("provider-free-binding-mismatch");
  if (!Array.isArray(receipt.lanes) || receipt.lanes.length !== LANE_DEFINITIONS.length) {
    errors.push("provider-free-lane-count-mismatch");
  } else {
    for (const expected of expectedBinding.lanes) {
      const lane = receipt.lanes.find((item) => item?.id === expected.id);
      if (!lane) { errors.push(`provider-free-lane-missing:${expected.id}`); continue; }
      if (lane.passed !== true || lane.providerUsed !== false || lane.providerCalls !== 0 || lane.modelTokens !== 0) {
        errors.push(`provider-free-lane-failed:${expected.id}`);
      }
      if (!summaryPassed(expected.id, lane.summary)) errors.push(`provider-free-lane-summary-invalid:${expected.id}`);
      if (lane.configurationDigest !== expected.configurationDigest
        || lane.runnerDigest !== expected.runnerDigest
        || !HASH.test(String(lane.resultDigest ?? ""))) errors.push(`provider-free-lane-binding-mismatch:${expected.id}`);
    }
  }
  if (receipt.digest !== receiptDigest(receipt)) errors.push("provider-free-receipt-digest-mismatch");
  return errors;
}

export function productionProviderFreeEvidenceContextValidationErrors(receipt, {
  source,
  candidateProvenance,
  configurationDigest
} = {}) {
  const errors = productionProviderFreeEvidenceValidationErrors(receipt, receipt?.binding);
  const binding = receipt?.binding;
  if (binding?.source?.kind !== source?.kind
    || binding?.source?.commit !== source?.commit
    || binding?.source?.clean !== (source?.dirty === false)) errors.push("provider-free-source-binding-mismatch");
  if (binding?.source?.treeDigest !== candidateProvenance?.contentDigest
    || binding?.source?.treeAlgorithm !== candidateProvenance?.algorithm) errors.push("provider-free-tree-binding-mismatch");
  if (binding?.productionConfigurationDigest !== configurationDigest) errors.push("provider-free-production-configuration-binding-mismatch");
  return [...new Set(errors)];
}

export function assertProductionProviderFreeEvidence(receipt, expectedBinding, label = "production provider-free evidence") {
  const errors = productionProviderFreeEvidenceValidationErrors(receipt, expectedBinding);
  if (errors.length > 0) throw new Error(`${label} is missing or changed (${errors.join(", ")})`);
  return receipt;
}

export async function collectProductionProviderFreeEvidence({
  packageRoot,
  liveRoot,
  runCommand,
  source,
  candidateProvenance,
  configurationDigest
}) {
  const binding = productionProviderFreeEvidenceBinding({ packageRoot, source, candidateProvenance, configurationDigest });
  const cacheRoot = path.join(liveRoot, ".pi", "benchmarks", "provider-free-evidence", binding.digest);
  const cachePath = path.join(cacheRoot, "receipt.json");
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (productionProviderFreeEvidenceValidationErrors(cached, binding).length === 0) return cached;
  }

  const assertLiveSource = async (stage) => {
    const commit = await runCommand("git", ["-C", liveRoot, "rev-parse", "HEAD"], { cwd: liveRoot, timeoutMs: 15_000 });
    const status = await runCommand("git", ["-C", liveRoot, "status", "--porcelain=v1", "--untracked-files=all"], { cwd: liveRoot, timeoutMs: 15_000 });
    if (commit.code !== 0 || commit.stdout.trim() !== source.commit || status.code !== 0 || status.stdout.trim()) {
      throw new Error(`Production provider-free evidence source changed at ${stage}`);
    }
    for (const lane of binding.lanes) {
      if (fileDigest(liveRoot, lane.configurationPath) !== lane.configurationDigest
        || fileDigest(liveRoot, lane.runnerPath) !== lane.runnerDigest) {
        throw new Error(`Production provider-free lane assets changed at ${stage}: ${lane.id}`);
      }
    }
  };

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-provider-free-evidence-"));
  const lanes = [];
  try {
    await assertLiveSource("before-lanes");
    for (const definition of LANE_DEFINITIONS) {
      const output = path.join(temporaryRoot, `${definition.id}.json`);
      const result = await runCommand(process.execPath, [path.join(liveRoot, definition.runner), "--output", output], {
        cwd: liveRoot,
        timeoutMs: definition.timeoutMilliseconds
      });
      if (result.code !== 0) {
        throw new Error(`Required provider-free lane failed: ${definition.id} (${result.stderr.trim() || result.signal || `exit ${result.code}`})`);
      }
      const bytes = fs.readFileSync(output);
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!lanePassed(definition.id, parsed)) throw new Error(`Required provider-free lane returned an incomplete receipt: ${definition.id}`);
      const expected = binding.lanes.find((lane) => lane.id === definition.id);
      lanes.push({
        schemaVersion: 1,
        id: definition.id,
        passed: true,
        providerUsed: false,
        providerCalls: 0,
        modelTokens: 0,
        configurationDigest: expected.configurationDigest,
        runnerDigest: expected.runnerDigest,
        resultDigest: digestBytes(bytes),
        summary: laneSummary(definition.id, parsed)
      });
      await assertLiveSource(`after-${definition.id}`);
    }
    const receipt = {
      schemaVersion: 1,
      kind: "production-provider-free-evidence-v1",
      completedAt: new Date().toISOString(),
      binding,
      lanes
    };
    receipt.digest = receiptDigest(receipt);
    assertProductionProviderFreeEvidence(receipt, binding);
    privateWrite(cachePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function productionProviderFreeLaneDefinitions() {
  return LANE_DEFINITIONS.map((lane) => ({ ...lane }));
}

export async function prepareProductionProviderFreeEvidence({
  required,
  packageRoot,
  bootstrapMetadata,
  candidateProvenance,
  configurationDigest,
  runCommand,
  resumedReceipt = undefined
}) {
  if (!required) return { receipt: null, binding: null };
  const binding = productionProviderFreeEvidenceBinding({
    packageRoot,
    source: bootstrapMetadata.sourceIdentity,
    candidateProvenance,
    configurationDigest
  });
  const receipt = resumedReceipt !== undefined
    ? assertProductionProviderFreeEvidence(resumedReceipt, binding, "resumed production provider-free evidence")
    : await collectProductionProviderFreeEvidence({
      packageRoot,
      liveRoot: bootstrapMetadata.liveRoot,
      runCommand,
      source: bootstrapMetadata.sourceIdentity,
      candidateProvenance,
      configurationDigest
    });
  return { receipt, binding };
}

export function productionProviderFreeEvidenceError(receipt, binding, label) {
  try { assertProductionProviderFreeEvidence(receipt, binding, label); return null; }
  catch (error) { return error; }
}
