import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { FAILURE_REASON_CODES, FAILURE_STRUCTURED_EVENTS, validateFailureClassification, validateFailureEvidence } from "../packages/piagent-core/extensions/failure-types.ts";
import { classifyCompletionGateFailure, classifyFailureEvidence, classifyRecordedVerificationFailure, classifyVerificationFailure, parseVerificationFailureEvidence, recordedFailureForObservation, selectCompletionRecoveryClassification } from "../packages/piagent-core/extensions/verification-intelligence.js";

const root = path.resolve(import.meta.dirname, "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "benchmarks", "failure-v1", "classification-corpus.json"), "utf8"));

describe("failure intelligence v1", () => {
  it("keeps public parser evidence schema aligned with structured verification gaps", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas/failure-evidence.schema.json"), "utf8"));
    assert.deepEqual(schema.properties.structuredEvents.items.enum, [...FAILURE_STRUCTURED_EVENTS]);
    assert.deepEqual(schema.$defs.reason.enum, [...FAILURE_REASON_CODES]);
  });
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

  it("never turns task-scope wording in ordinary verifier output into a policy block", () => {
    const assertion = classifyVerificationFailure("AssertionError: expected value outside declared scope", 1);
    assert.equal(assertion.category, "test-assertion");
    const proseOnly = classifyVerificationFailure("scope violation in the rendered label", 1);
    assert.equal(proseOnly.category, "unknown");
  });

  it("reconstructs the category from bounded runtime-generated verifier summaries", () => {
    for (const category of ["compile-typecheck", "test-assertion", "lint-format", "dependency-config", "environment", "provider-network", "permission-policy", "scope-protected-path", "flaky-infrastructure"]) {
      const suffix = ["provider-network", "flaky-infrastructure"].includes(category) ? ", retryable" : "";
      const result = classifyRecordedVerificationFailure(`Runtime observed configured verifier exit 1 (${category}${suffix}).`, 1);
      assert.equal(result.category, category);
      assert.equal(result.authorizesSourceMutation, false);
    }
  });

  it("keeps missing critical proof unknown without fabricating a source defect", () => {
    const result = classifyCompletionGateFailure([
      "critical acceptance evidence (ac-01-invalid-input-rejection:invalid-input-rejection)"
    ], "configured verifier passed", 0);
    assert.equal(result.category, "unknown");
    assert.equal(result.sourceMutationPermission, "forbidden");
    assert.deepEqual(result.reasonCodes, ["structured-verification-gap"]);
    assert.equal(result.authorizesSourceMutation, false);
  });

  it("does not revive a recorded failure after the observed verifier passes", () => {
    const recorded = classifyVerificationFailure("AssertionError: old failing test", 1);
    const missing = ["critical acceptance evidence (invalid-input-rejection)"];
    const result = selectCompletionRecoveryClassification(recorded, missing, "configured verifier passed", 0);
    assert.equal(result.category, "unknown");
    assert.equal(result.sourceMutationPermission, "forbidden");
    assert.equal(selectCompletionRecoveryClassification(recorded, missing, "current failing test", 1).category, "test-assertion");
    assert.equal(selectCompletionRecoveryClassification({ category: "test-assertion" }, missing).category, "unknown");
  });

  it("reuses a journal classification only for an exact current stable failed observation", () => {
    const tree = `wt-content-v2:${"a".repeat(64)}`;
    const observed = { command: "npm test", observed: true, matchedProfileCommand: true, exitCode: 1,
      observedAt: "2026-08-30T00:00:00.000Z", preWorkingTreeDigest: tree, workingTreeDigest: tree };
    const classification = classifyVerificationFailure("AssertionError: expected true, received false", 1);
    const checkpoint = { phase: "verify", status: "failed", evidence: { failureClassification: classification,
      verificationObservation: { command: observed.command, observedAt: observed.observedAt, exitCode: observed.exitCode,
        preWorkingTreeDigest: tree, workingTreeDigest: tree } } };
    assert.deepEqual(recordedFailureForObservation([checkpoint], observed, tree), classification);
    for (const [key, value] of [["command", "npm run lint"], ["exitCode", 2], ["observedAt", "2026-08-29T00:00:00.000Z"],
      ["preWorkingTreeDigest", `wt-content-v2:${"b".repeat(64)}`], ["workingTreeDigest", `wt-content-v2:${"b".repeat(64)}`]]) {
      const changed = structuredClone(checkpoint);
      changed.evidence.verificationObservation[key] = value;
      assert.equal(recordedFailureForObservation([changed], observed, tree), undefined, key);
    }
    assert.equal(recordedFailureForObservation([checkpoint], { ...observed, exitCode: 0 }, tree), undefined);
    assert.equal(recordedFailureForObservation([checkpoint], observed, `wt-content-v2:${"b".repeat(64)}`), undefined);
    assert.equal(recordedFailureForObservation([{ ...checkpoint, evidence: { failureClassification: classification } }], observed, tree), undefined);
    assert.equal(recordedFailureForObservation([checkpoint], { ...observed, observedAt: "invalid" }, tree), undefined);
  });

  it("classifies protected and mutation-forbidden boundaries as terminal policy failures even after a passing verifier", () => {
    const cases = [
      "read-only task has observed changes (src/report.js)",
      "completion cannot include a protected path",
      "mutation-forbidden task has observed changes (src/report.js)",
      "completion changed a read-only path"
    ];
    for (const missing of cases) {
      const result = classifyCompletionGateFailure([missing], "configured verifier passed", 0);
      assert.equal(result.category, "scope-protected-path", missing);
      assert.equal(result.retryable, false, missing);
      assert.equal(result.sourceMutationPermission, "forbidden", missing);
      assert.equal(result.authorizesSourceMutation, false, missing);
    }
  });

  it("gives a completion protected-path boundary precedence over critical proof and recorded verifier failures", () => {
    const recorded = classifyVerificationFailure("AssertionError: focused test failed", 1);
    const result = selectCompletionRecoveryClassification(recorded, [
      "critical acceptance evidence (ac-01-boundary-case:boundary-case)",
      "completion cannot include protected paths"
    ], "Runtime observed configured verifier exit 1 (test-assertion).", 1);
    assert.equal(recorded.category, "test-assertion");
    assert.equal(result.category, "scope-protected-path");
    assert.equal(result.sourceMutationPermission, "forbidden");
  });

  it("gives structured policy, protected-path, and provider events precedence over terminal wording", () => {
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
