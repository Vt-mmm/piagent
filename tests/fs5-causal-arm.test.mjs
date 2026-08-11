import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateFs5CausalLocalReport,
  fs5CausalArmValidationErrors,
  treatmentEnvironmentDiff
} from "../packages/piagent-core/benchmark/fs5-causal-arm.js";
import { PIAGENT_BENCHMARK_TREATMENTS } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { createEnvironmentBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";

const root = path.resolve(import.meta.dirname, "..");
const protocol = JSON.parse(fs.readFileSync(path.join(root, "evals/fs5-causal-arm.v1.json"), "utf8"));
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");

test("freezes one CAP-09 causal arm against local-safe", () => {
  assert.deepEqual(fs5CausalArmValidationErrors(protocol), []);
  assert.deepEqual(
    treatmentEnvironmentDiff(PIAGENT_BENCHMARK_TREATMENTS[protocol.baseline.treatment], PIAGENT_BENCHMARK_TREATMENTS[protocol.arm.treatment]),
    ["PIAGENT_PHASE_TOOLS"]
  );
  const task = { taskId: "task-fs5", taskRunId: "run-fs5", createdAt: "2026-08-11T00:00:00.000Z" };
  const baseline = createEnvironmentBoundTaskAuthority(task, PIAGENT_BENCHMARK_TREATMENTS[protocol.baseline.treatment]);
  const arm = createEnvironmentBoundTaskAuthority(task, PIAGENT_BENCHMARK_TREATMENTS[protocol.arm.treatment]);
  const changed = baseline.capabilities.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(arm.capabilities[index]));
  assert.deepEqual(changed.map((entry) => entry.id), ["CAP-09"]);
  const baselinePhase = baseline.capabilities.find((entry) => entry.id === "CAP-09");
  const armPhase = arm.capabilities.find((entry) => entry.id === "CAP-09");
  assert.deepEqual({ mode: baselinePhase.mode, authority: baselinePhase.authority, budgets: baselinePhase.budgets }, { mode: "shadow", authority: "observe", budgets: { systemContinuations: 0, automaticDispatches: 0, reviewRounds: 0 } });
  assert.deepEqual({ mode: armPhase.mode, authority: armPhase.authority, budgets: armPhase.budgets }, { mode: "on", authority: "enforce", budgets: { systemContinuations: 0, automaticDispatches: 0, reviewRounds: 0 } });
});

test("binds every causal artifact to the current bytes", () => {
  for (const binding of protocol.artifactBindings) assert.equal(hash(binding.path), binding.sha256, binding.path);
});

test("passes the deterministic phase shadow-versus-enforce reproducer without promotion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-fs5-causal-"));
  const output = path.join(directory, "report.json");
  try {
    execFileSync(process.execPath, ["scripts/phase-tools-evaluation.mjs", "--output", output], { cwd: root, stdio: "pipe" });
    const decision = evaluateFs5CausalLocalReport(protocol, JSON.parse(fs.readFileSync(output, "utf8")));
    assert.deepEqual(decision, {
      passed: true,
      changedEnvironmentKeys: ["PIAGENT_PHASE_TOOLS"],
      providerCanaryRequiredForPromotion: true,
      promotionAllowed: false,
      blockers: []
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects bundled feature drift and unbounded provider confirmation", () => {
  const bundledTreatments = structuredClone(PIAGENT_BENCHMARK_TREATMENTS);
  bundledTreatments["causal-phase-enforce"].PIAGENT_SOLVER_MODE = "recommend";
  assert.match(fs5CausalArmValidationErrors(protocol, bundledTreatments).join("; "), /only in PIAGENT_PHASE_TOOLS/);
  const unbounded = structuredClone(protocol);
  unbounded.providerBudget.confirmationPairsAfterCodeChange = 2;
  assert.match(fs5CausalArmValidationErrors(unbounded).join("; "), /provider budget/);
});

test("fails closed when local mechanics report blocked valid calls or shadow interference", () => {
  const report = {
    gatePassed: true,
    runtimeContract: {
      strict: { providerSchema: { unchanged: true }, validCalls: { blocked: 1 }, deniedMutations: { evaluated: 8, blocked: 8 } },
      shadow: { providerSchema: { unchanged: true }, validCalls: { blocked: 0 }, deniedMutations: { blocked: 1 } }
    }
  };
  assert.deepEqual(evaluateFs5CausalLocalReport(protocol, report).blockers, ["blocked-valid-call", "shadow-interference"]);
});
