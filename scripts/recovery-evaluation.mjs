#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { classifyVerificationFailure } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { selectRecoveryDecision } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";

const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : undefined;
const cases = [
  {
    id: "syntax-repair",
    source: "export const value = ;\n",
    repaired: "export const value = 2;\n",
    files: { "test.mjs": "import assert from 'node:assert/strict'; import { value } from './source.mjs'; assert.equal(value, 2);\n" },
    expectedCategory: "test-assertion"
  },
  {
    id: "assertion-repair",
    source: "export function value() { return 1; }\n",
    repaired: "export function value() { return 2; }\n",
    files: { "test.mjs": "import assert from 'node:assert/strict'; import { value } from './source.mjs'; assert.equal(value(), 2);\n" },
    expectedCategory: "test-assertion"
  },
  {
    id: "format-repair",
    source: "export const value = 2;   \n",
    repaired: "export const value = 2;\n",
    files: { "test.mjs": "import fs from 'node:fs'; const source = fs.readFileSync(new URL('./source.mjs', import.meta.url), 'utf8'); if (/ +\\n/.test(source)) { console.error('eslint error: formatting violation'); process.exit(1); }\n" },
    expectedCategory: "test-assertion"
  },
  {
    id: "dependency-repair",
    source: "export { value } from './missing.mjs';\n",
    repaired: "export { value } from './value.mjs';\n",
    files: {
      "value.mjs": "export const value = 2;\n",
      "test.mjs": "import assert from 'node:assert/strict'; import { value } from './source.mjs'; assert.equal(value, 2);\n"
    },
    expectedCategory: "dependency-config"
  }
];

function verify(cwd) {
  const result = spawnSync(process.execPath, ["--test", "test.mjs"], { cwd, encoding: "utf8", timeout: 10_000 });
  return { exitCode: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

const results = [];
for (const [index, fixture] of cases.entries()) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-recovery-eval-"));
  try {
    fs.writeFileSync(path.join(cwd, "source.mjs"), fixture.source);
    for (const [name, content] of Object.entries(fixture.files)) fs.writeFileSync(path.join(cwd, name), content);
    const before = verify(cwd);
    const classification = classifyVerificationFailure(before.output, before.exitCode);
    const policyInput = {
      featureEnabled: true,
      task: { taskId: fixture.id, taskRunId: `${fixture.id}-run-1`, attempt: 1, maxAttempts: 3, changeMode: "source-change" },
      classification,
      currentPhase: "verify",
      exactVerifierAvailable: true,
      currentTreeMatchesEvidence: true,
      dependencyMutationAuthorized: classification.category === "dependency-config",
      history: []
    };
    const enabled = selectRecoveryDecision(policyInput);
    const disabled = selectRecoveryDecision({ ...policyInput, featureEnabled: false });
    let reworkPasses = 0;
    if (enabled.action === "repair" && enabled.sourceMutationAllowed) {
      fs.writeFileSync(path.join(cwd, "source.mjs"), fixture.repaired);
      reworkPasses += 1;
    }
    const after = verify(cwd);
    results.push({
      id: fixture.id,
      expectedCategory: fixture.expectedCategory,
      observedCategory: classification.category,
      evidenceDigest: classification.evidenceDigest,
      enabledAction: enabled.action,
      enabledSourceMutationAllowed: enabled.sourceMutationAllowed,
      disabledAction: disabled.action,
      beforeExitCode: before.exitCode,
      afterExitCode: after.exitCode,
      firstRepairSucceeded: reworkPasses === 1 && after.exitCode === 0,
      candidateReworkPasses: reworkPasses,
      manualBaselineReworkPasses: 1,
      outputStored: false,
      sourceStored: false,
      sequence: index + 1
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const candidateRework = results.reduce((sum, item) => sum + item.candidateReworkPasses, 0);
const baselineRework = results.reduce((sum, item) => sum + item.manualBaselineReworkPasses, 0);
const report = {
  schemaVersion: 1,
  evaluationId: `recovery-${new Date().toISOString().replace(/[-:.]/g, "")}`,
  generatedAt: new Date().toISOString(),
  platformVersion: "1.2.17",
  policyVersion: "recovery-v1",
  methodology: {
    sample: "Four controlled source-owned failures with deterministic one-line repairs and real Node verifier processes.",
    baseline: "Feature-off selects ordinary handoff; one equivalent manual repair pass is required per fixture.",
    candidate: "Feature-on policy selects one authorized repair pass, then reruns the exact verifier once.",
    limitation: "Controlled local fixtures measure recovery policy/outcome mechanics, not model quality on arbitrary repositories."
  },
  sampleSize: results.length,
  classificationPrecision: results.filter((item) => item.expectedCategory === item.observedCategory).length / results.length,
  featureOffAutomaticFirstRepairSuccess: 0,
  candidateFirstRepairSuccess: results.filter((item) => item.firstRepairSucceeded).length / results.length,
  candidateTotalReworkPasses: candidateRework,
  manualBaselineTotalReworkPasses: baselineRework,
  increasedTotalRework: candidateRework > baselineRework,
  rawOutputStored: false,
  sourceStored: false,
  results,
  gatePassed: results.every((item) => item.expectedCategory === item.observedCategory && item.enabledAction === "repair" && item.enabledSourceMutationAllowed && item.disabledAction === "handoff" && item.firstRepairSucceeded)
    && candidateRework <= baselineRework
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gatePassed) process.exitCode = 1;
