import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { validateFailureClassification, validateFailureEvidence } from "../packages/piagent-core/extensions/failure-types.ts";
import { classifyCompletionGateFailure, classifyFailureEvidence, classifyRecordedVerificationFailure, classifyVerificationFailure, parseVerificationFailureEvidence, selectCompletionRecoveryClassification } from "../packages/piagent-core/extensions/verification-intelligence.js";

const root = path.resolve(import.meta.dirname, "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "benchmarks", "failure-v1", "classification-corpus.json"), "utf8"));

describe("failure intelligence v1", () => {
  it("separates bounded parser evidence from policy classification", () => {
    const secret = "OPENAI_API_KEY=not-stored";
    const evidence = parseVerificationFailureEvidence(`TS2322: ${secret}`, 2, { captureRef: "capture:abc123", truncated: true });
    validateFailureEvidence(evidence);
    assert.equal(JSON.stringify(evidence).includes(secret), false);
    assert.equal(evidence.outputRef.captureRef, "capture:abc123");
    assert.equal(evidence.outputRef.truncated, true);
    const classification = classifyFailureEvidence(evidence);
    validateFailureClassification(classification);
    assert.equal(classification.category, "compile-typecheck");
    assert.equal(classification.authorizesSourceMutation, false);
    assert.equal(classification.sourceMutationPermission, "eligible-in-scope");
  });

  it("keeps exit zero passed regardless of warning or assertion text", () => {
    const result = classifyVerificationFailure("warning: assertion failed in a skipped test", 0);
    assert.equal(result.category, "passed");
    assert.equal(result.retryable, false);
    assert.equal(result.sourceMutationPermission, "forbidden");
  });

  it("defaults unknown and low-confidence evidence to no source mutation", () => {
    const result = classifyVerificationFailure("unrecognized failure 773", 1);
    assert.equal(result.category, "unknown");
    assert.equal(result.confidence, "low");
    assert.equal(result.sourceMutationPermission, "forbidden");
    assert.equal(result.authorizesSourceMutation, false);
  });

  it("reconstructs the category from bounded runtime-generated verifier summaries", () => {
    for (const category of ["compile-typecheck", "test-assertion", "lint-format", "dependency-config", "environment", "provider-network", "permission-policy", "scope-protected-path", "flaky-infrastructure"]) {
      const suffix = ["provider-network", "flaky-infrastructure"].includes(category) ? ", retryable" : "";
      const result = classifyRecordedVerificationFailure(`Runtime observed configured verifier exit 1 (${category}${suffix}).`, 1);
      assert.equal(result.category, category);
      assert.equal(result.authorizesSourceMutation, false);
    }
  });

  it("routes missing critical acceptance proof through the bounded test repair policy", () => {
    const result = classifyCompletionGateFailure([
      "critical acceptance evidence (ac-01-invalid-input-rejection:invalid-input-rejection)"
    ], "configured verifier passed", 0);
    assert.equal(result.category, "test-assertion");
    assert.equal(result.sourceMutationPermission, "eligible-in-scope");
  });

  it("classifies completion boundary violations as terminal scope failures even after a passing verifier", () => {
    const cases = [
      "changes within task scope (apps/web/src/search-view.js)",
      "read-only task has observed changes (src/report.js)",
      "completion cannot include a protected path",
      "mutation landed outside its declared scope"
    ];
    for (const missing of cases) {
      const result = classifyCompletionGateFailure([missing], "configured verifier passed", 0);
      assert.equal(result.category, "scope-protected-path", missing);
      assert.equal(result.retryable, false, missing);
      assert.equal(result.sourceMutationPermission, "forbidden", missing);
      assert.equal(result.authorizesSourceMutation, false, missing);
    }
  });

  it("gives a completion scope boundary precedence over critical proof and recorded verifier failures", () => {
    const recorded = classifyVerificationFailure("AssertionError: focused test failed", 1);
    const result = selectCompletionRecoveryClassification(recorded, [
      "critical acceptance evidence (ac-01-boundary-case:boundary-case)",
      "changes within task scope (packages/shared/src/search-contract.js)"
    ], "Runtime observed configured verifier exit 1 (test-assertion).", 1);
    assert.equal(recorded.category, "test-assertion");
    assert.equal(result.category, "scope-protected-path");
    assert.equal(result.sourceMutationPermission, "forbidden");
  });

  it("gives structured policy, scope, and provider events precedence over terminal wording", () => {
    assert.equal(classifyVerificationFailure("TS2322", 1, { structuredEvents: ["protected-path"] }).category, "scope-protected-path");
    assert.equal(classifyVerificationFailure("AssertionError", 1, { structuredEvents: ["permission-denied"] }).category, "permission-policy");
    assert.equal(classifyVerificationFailure("compile error", 1, { structuredEvents: ["provider-network"] }).category, "provider-network");
  });

  it("reaches at least 90 percent precision on the reviewed multi-stack corpus", () => {
    const results = corpus.cases.map((item) => ({
      id: item.id,
      expected: item.expected,
      actual: classifyVerificationFailure(item.output, item.exitCode, { structuredEvents: item.structuredEvents }).category
    }));
    const correct = results.filter((item) => item.actual === item.expected).length;
    const precision = correct / results.length;
    assert.ok(precision >= 0.9, `${correct}/${results.length} = ${(precision * 100).toFixed(1)}%\n${results.filter((item) => item.actual !== item.expected).map((item) => `${item.id}: ${item.expected} -> ${item.actual}`).join("\n")}`);
    for (const item of corpus.cases) {
      const first = classifyVerificationFailure(item.output, item.exitCode, { structuredEvents: item.structuredEvents });
      const second = classifyVerificationFailure(item.output, item.exitCode, { structuredEvents: item.structuredEvents });
      assert.deepEqual(second, first);
      if (["environment", "provider-network", "permission-policy", "scope-protected-path", "flaky-infrastructure", "unknown"].includes(first.category)) {
        assert.equal(first.sourceMutationPermission, "forbidden");
      }
    }
  });
});
