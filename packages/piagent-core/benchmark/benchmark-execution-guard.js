import path from "node:path";

import {
  assertBenchmarkPiHomeConfigIdentity,
  assertBenchmarkPiRuntimeMatchesSeed,
  benchmarkPiHomeConfigIdentity
} from "./benchmark-pi-home.js";
import { assertBenchmarkTreeIdentity, benchmarkTreeIdentity } from "./benchmark-tree-identity.js";
import { verifyBenchmarkCommandIdentity } from "./benchmark-runtime-identity.js";

function assetError(stage, asset, cause) {
  const error = new Error(`Benchmark execution asset changed at ${stage} (${asset})`);
  error.code = "BENCHMARK_EXECUTION_ASSET_MISMATCH";
  error.exitCode = 1;
  const piHomeMismatch = asset === "pi-agent-home" && cause?.code === "BENCHMARK_PI_HOME_MISMATCH"
    ? cause.piHomeMismatch
    : undefined;
  error.executionAsset = {
    stage,
    asset,
    reason: "asset-identity-mismatch",
    ...(piHomeMismatch ? { piHomeMismatch } : {})
  };
  error.cause = cause;
  return error;
}

export function createBenchmarkExecutionGuard({ candidateGuard, suiteRoot, suiteIdentity, piAgentHome, codexCredential, runtimeDependencies, commands }) {
  const observeAssets = (stage, runtimeHomes = []) => {
    try {
      const suite = benchmarkTreeIdentity(suiteRoot, { rejectSymlinks: true });
      assertBenchmarkTreeIdentity(suiteIdentity, suite, "benchmark suite");
    } catch (error) {
      throw assetError(stage, "suite", error);
    }
    if (runtimeDependencies?.resolutionTree) {
      try {
        const runtimeTree = benchmarkTreeIdentity(runtimeDependencies.resolutionRoot);
        assertBenchmarkTreeIdentity(runtimeDependencies.resolutionTree, runtimeTree, "runtime dependency resolution root");
      } catch (error) {
        throw assetError(stage, "runtime-dependencies", error);
      }
    }
    if (piAgentHome?.seedIdentity) {
      try {
        const seed = benchmarkPiHomeConfigIdentity(piAgentHome.configRoot, { requiredFileMode: "400" });
        assertBenchmarkPiHomeConfigIdentity(piAgentHome.seedIdentity, seed);
        for (const runtimeHome of runtimeHomes) {
          const runtime = benchmarkPiHomeConfigIdentity(runtimeHome.path, { requiredFileMode: "600" });
          assertBenchmarkPiRuntimeMatchesSeed(seed, runtime);
        }
      } catch (error) {
        throw assetError(stage, "pi-agent-home", error);
      }
    }
    if (codexCredential?.privateIdentity) {
      try {
        const credential = benchmarkTreeIdentity(path.dirname(codexCredential.path), { rejectSymlinks: true });
        assertBenchmarkTreeIdentity(codexCredential.privateIdentity, credential, "controlled Codex credential");
      } catch (error) {
        throw assetError(stage, "codex-credential", error);
      }
    }
    for (const [label, identity] of Object.entries(commands ?? {})) {
      if (!identity) continue;
      try { verifyBenchmarkCommandIdentity(identity, label, { fullPackageClosure: stage === "finalization" || stage === "prepublish" }); }
      catch (error) { throw assetError(stage, `command:${label}`, error); }
    }
  };
  const receipt = (stage, runtimeHomes = []) => {
    const candidateReceipt = typeof candidateGuard.receipt === "function"
      ? candidateGuard.receipt(stage)
      : { error: candidateGuard.check(stage), stamp: candidateGuard.stamp(stage) };
    let error = candidateReceipt.error;
    if (!error) {
      try { observeAssets(stage, runtimeHomes); }
      catch (cause) { error = cause; }
    }
    const stamp = {
      stage,
      matched: !error,
      candidate: candidateReceipt.stamp,
      suite: suiteIdentity,
      runtimeDependencies,
      piAgentHome: piAgentHome ? {
        copied: piAgentHome.copied,
        globalInstructions: piAgentHome.globalInstructions,
        authRefreshPolicy: piAgentHome.authRefreshPolicy,
        isolation: "immutable-private-seed; run-scoped-writable-home; ephemeral-state-reset-between-sessions",
        identity: piAgentHome.identity
      } : null,
      codexCredential: codexCredential ? { identity: codexCredential.identity } : null,
      commands,
      ...(error ? { failure: error.executionAsset ?? { reason: error.message } } : {})
    };
    return { error, stamp };
  };
  const check = (stage, runtimeHomes = []) => receipt(stage, runtimeHomes).error;
  const stamp = (stage, runtimeHomes = []) => receipt(stage, runtimeHomes).stamp;
  return { check, stamp, receipt };
}
