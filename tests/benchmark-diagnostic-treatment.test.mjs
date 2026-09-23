import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveDiagnosticCandidateEntries, assertDiagnosticCandidateDerivation, assertDiagnosticBenchmarkMatrix, benchmarkAcceptancePolicyBinding, DIAGNOSTIC_POLICY_PATH, DIAGNOSTIC_TREATMENT } from "../packages/piagent-core/benchmark/benchmark-diagnostic-treatment.js";
import { piagentTreatment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { comparisonProtocol } from "../packages/piagent-core/benchmark/benchmark-comparison.js";
import { applyBenchmarkClaimRestrictions } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";

function fixture(t, mode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-treatment-")));
  const file = path.join(root, DIAGNOSTIC_POLICY_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ finalGate: mode ? { acceptanceProofMode: mode } : {} }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}
const options = { piagentTreatment: DIAGNOSTIC_TREATMENT, measurementOnly: true };

test("diagnostic CLI treatment does not invent environment activation", () => {
  assert.equal(parseBenchmarkArgs(["--piagent-treatment", DIAGNOSTIC_TREATMENT, "--measurement-only"]).piagentTreatment, DIAGNOSTIC_TREATMENT);
  assert.deepEqual(piagentTreatment(DIAGNOSTIC_TREATMENT).environment, {});
});
test("diagnostic requires the exact installed mode and measurement flag", t => {
  const { root, file } = fixture(t);
  assert.throws(() => benchmarkAcceptancePolicyBinding(root, options), /does not match/);
  fs.writeFileSync(file, JSON.stringify({ finalGate: { acceptanceProofMode: "diagnostic" } }));
  assert.throws(() => benchmarkAcceptancePolicyBinding(root, { ...options, measurementOnly: false }), /requires --measurement-only/);
  const a = benchmarkAcceptancePolicyBinding(root, options);
  assert.equal(a.origin, undefined, "historical derived-treatment bindings remain readable");
  fs.appendFileSync(file, "\n");
  const b = benchmarkAcceptancePolicyBinding(root, options);
  assert.notEqual(a.policySha256, b.policySha256);
});
test("installed diagnostic policy remains bound and no-claim under feature treatments", t => {
  const { root } = fixture(t, "diagnostic");
  for (const id of ["candidate", "configured-independent-v2", "feature-off"]) {
    const binding = benchmarkAcceptancePolicyBinding(root, { piagentTreatment: id });
    assert.equal(binding.origin, "installed-release-policy");
    assert.equal(binding.qualityClaim, "withheld");
    assert.doesNotThrow(() => assertDiagnosticCandidateDerivation(binding, undefined, { contentDigest: "a".repeat(64) }));
    const environment = { piagentTreatment: piagentTreatment(id), acceptancePolicyBinding: binding };
    assert.equal(comparisonProtocol(environment, { schemaVersion: 2 }, "raw-pi").checks["piagent-treatment-recorded"], true);
    const report = { environment, comparison: { tokenClaimAllowed: true }, verdict: { status: "observational-efficiency-only" } };
    applyBenchmarkClaimRestrictions(report, { surfaces: [] });
    assert.equal(report.verdict.status, "measurement-only-no-claim");
    assert.equal(report.comparison.tokenClaimAllowed, false);
  }
});
test("default candidate retains unmodified release treatment binding", t => {
  const { root } = fixture(t);
  assert.equal(benchmarkAcceptancePolicyBinding(root, { piagentTreatment: "release-defaults" }), null);
});
test("release defaults bind an installed diagnostic policy as measurement-only without a synthetic derivation", t => {
  const { root } = fixture(t, "diagnostic");
  const binding = benchmarkAcceptancePolicyBinding(root, { piagentTreatment: "release-defaults" });
  assert.equal(binding.origin, "installed-release-policy");
  assert.doesNotThrow(() => assertDiagnosticCandidateDerivation(binding, undefined, { contentDigest: "a".repeat(64) }));
  assert.throws(() => assertDiagnosticCandidateDerivation(binding, { changes: [] }, { contentDigest: "a".repeat(64) }), /cannot claim a treatment derivation/);
  const environment = { piagentTreatment: piagentTreatment("release-defaults"),
    acceptancePolicyBinding: binding, measurementOnly: true };
  assert.equal(comparisonProtocol(environment, { schemaVersion: 2 }, "raw-pi").checks["piagent-treatment-recorded"], true);
  assert.equal(comparisonProtocol({ ...environment, measurementOnly: false }, { schemaVersion: 2 }, "raw-pi").checks["piagent-treatment-recorded"], true);
  assert.equal(comparisonProtocol({ ...environment, acceptancePolicyBinding: { ...binding, policySha256: "invalid" } }, { schemaVersion: 2 }, "raw-pi").checks["piagent-treatment-recorded"], false);
  const report = { environment, comparison: { tokenClaimAllowed: true }, verdict: { status: "observational-efficiency-only" } };
  applyBenchmarkClaimRestrictions(report, { surfaces: [] });
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.verdict.status, "measurement-only-no-claim");
});
test("symlinked policy is refused", t => {
  const { root, file } = fixture(t, "diagnostic");
  fs.renameSync(file, file + ".saved");
  fs.symlinkSync(file + ".saved", file);
  assert.throws(() => benchmarkAcceptancePolicyBinding(root, options), /regular file/);
});
test("comparison requires diagnostic policy identity and measurement disclosure", t => {
  const { root } = fixture(t, "diagnostic");
  const env = { piagentTreatment: piagentTreatment(DIAGNOSTIC_TREATMENT), measurementOnly: true,
    acceptancePolicyBinding: benchmarkAcceptancePolicyBinding(root, options) };
  const check = value => comparisonProtocol(value, { schemaVersion: 1 }, "raw-pi").checks["piagent-treatment-recorded"];
  // Use schema v2 so the treatment evidence check is mandatory for every baseline.
  const required = value => comparisonProtocol(value, { schemaVersion: 2 }, "raw-pi").checks["piagent-treatment-recorded"];
  assert.equal(check(env), true);
  assert.equal(required(env), true);
  assert.equal(required({ ...env, acceptancePolicyBinding: undefined }), false);
  assert.equal(required({ ...env, measurementOnly: false }), false);
});
test("treatment alone forces no-claim even when measurement flag is absent in report", () => {
  const report = { environment: { piagentTreatment: piagentTreatment(DIAGNOSTIC_TREATMENT) },
    comparison: { tokenClaimAllowed: true }, verdict: { status: "observational-efficiency-only" } };
  applyBenchmarkClaimRestrictions(report, { surfaces: [] });
  assert.equal(report.measurementOnly, true);
  assert.equal(report.environment.measurementOnly, true);
  assert.equal(report.comparison.tokenClaimAllowed, false);
  assert.equal(report.comparison.claimEligibility.generalizationClaimAllowed, false);
  assert.equal(report.verdict.status, "measurement-only-no-claim");
});

test("diagnostic admission retains the production-v3 full matrix and controlled baseline", () => {
  const selected = { ...options, codexMode: "controlled" };
  const matrix = { builtInId: "production-v3", fullMatrix: true, expectedSessions: 108 };
  assert.doesNotThrow(() => assertDiagnosticBenchmarkMatrix(selected, matrix));
  for (const change of [{ builtInId: "production-v2" }, { fullMatrix: false }, { expectedSessions: 12 }]) {
    assert.throws(() => assertDiagnosticBenchmarkMatrix(selected, { ...matrix, ...change }), /complete production-v3/);
  }
  assert.throws(() => assertDiagnosticBenchmarkMatrix({ ...selected, codexMode: "native" }, matrix), /complete production-v3/);
  assert.throws(() => assertDiagnosticBenchmarkMatrix({ ...selected, measurementOnly: false }, matrix), /complete production-v3/);
});

test("diagnostic derivation changes only copied policy bytes and binds their origin", t => {
  const { root } = fixture(t);
  const policy = { path: DIAGNOSTIC_POLICY_PATH, kind: "regular", payload: Buffer.from('{"finalGate":{"requireTrace":true}}') };
  const untouched = { path: "other.js", kind: "regular", payload: Buffer.from("keep") };
  const original = Buffer.from(policy.payload), entries = [policy, untouched];
  const derived = deriveDiagnosticCandidateEntries(entries, options);
  assert.deepEqual(policy.payload, original);
  assert.equal(derived.entries[1], untouched);
  assert.deepEqual(JSON.parse(derived.entries[0].payload), { finalGate: { requireTrace: true, acceptanceProofMode: "diagnostic" } });
  fs.writeFileSync(path.join(root, DIAGNOSTIC_POLICY_PATH), derived.entries[0].payload);
  const binding = benchmarkAcceptancePolicyBinding(root, options), candidate = { contentDigest: "b".repeat(64) };
  const receipt = { ...derived.derivation, sourceCandidateProvenance: { contentDigest: "a".repeat(64) }, derivedCandidateProvenance: candidate };
  assert.doesNotThrow(() => assertDiagnosticCandidateDerivation(binding, receipt, candidate));
  assert.throws(() => assertDiagnosticCandidateDerivation(binding, undefined, candidate), /does not match/);
  assert.throws(() => assertDiagnosticCandidateDerivation({ ...binding, policySha256: "c".repeat(64) }, receipt, candidate), /does not match/);
  assert.throws(() => assertDiagnosticCandidateDerivation(binding, receipt, { contentDigest: "d".repeat(64) }), /does not match/);
  assert.throws(() => deriveDiagnosticCandidateEntries(entries, { ...options, measurementOnly: false }), /requires/);
  assert.throws(() => deriveDiagnosticCandidateEntries(derived.entries, options), /enforce source/);
  assert.deepEqual(deriveDiagnosticCandidateEntries(entries), { entries });
});
