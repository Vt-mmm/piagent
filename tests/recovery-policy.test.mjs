import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyVerificationFailure } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { RECOVERY_CEILINGS, selectRecoveryDecision } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";

function classification(category) {
  const samples = {
    passed: ["all checks passed", 0],
    "compile-typecheck": ["TS2322: type string is not assignable", 2],
    "test-assertion": ["AssertionError: expected 1 received 2", 1],
    "lint-format": ["eslint error: formatting violation", 1],
    "dependency-config": ["Cannot find module 'left-pad'", 1],
    environment: ["command not found: docker", 127],
    "provider-network": ["provider API request timed out", 1],
    "permission-policy": ["permission denied", 1],
    "scope-protected-path": ["outside declared scope", 1],
    "flaky-infrastructure": ["EADDRINUSE: port 3000 is already in use", 1],
    unknown: ["opaque failure 773", 1]
  };
  const [output, exitCode] = samples[category];
  const result = classifyVerificationFailure(output, exitCode);
  assert.equal(result.category, category);
  return result;
}

function input(category, overrides = {}) {
  return {
    featureEnabled: true,
    task: { taskId: "task-a", taskRunId: "task-a-run-1", attempt: 1, maxAttempts: 3, changeMode: "source-change" },
    classification: classification(category),
    currentPhase: "verify",
    exactVerifierAvailable: true,
    currentTreeMatchesEvidence: true,
    history: [],
    ...overrides
  };
}

function history(inputValue, action, disposition = "failed", overrides = {}) {
  return {
    taskId: inputValue.task.taskId,
    taskRunId: inputValue.task.taskRunId,
    taskAttempt: inputValue.task.attempt,
    evidenceDigest: inputValue.classification.evidenceDigest,
    failureCategory: inputValue.classification.category,
    action,
    disposition,
    phase: inputValue.currentPhase,
    hypothesisRef: null,
    ...overrides
  };
}

describe("bounded recovery policy v1", () => {
  it("keeps the feature-off path observational and non-mutating", () => {
    const result = selectRecoveryDecision(input("compile-typecheck", { featureEnabled: false }));
    assert.equal(result.action, "handoff");
    assert.equal(result.sourceMutationAllowed, false);
    assert.deepEqual(result.reasonCodes, ["feature-disabled"]);
  });

  it("allows one in-scope source repair and never raises the ceiling on a later task attempt", () => {
    const first = input("compile-typecheck", { proposedHypothesisRef: "hypothesis:type-boundary" });
    const repair = selectRecoveryDecision(first);
    assert.equal(repair.action, "repair");
    assert.equal(repair.sourceMutationAllowed, true);
    assert.equal(repair.nextPhase, "repair");
    const later = input("compile-typecheck", {
      task: { ...first.task, taskRunId: "task-a-run-2", attempt: 2 },
      proposedHypothesisRef: "hypothesis:new",
      history: [history(first, "repair")]
    });
    const exhausted = selectRecoveryDecision(later);
    assert.equal(exhausted.action, "handoff");
    assert.equal(exhausted.counts.sourceRepairPasses, RECOVERY_CEILINGS.sourceRepairPasses);
    assert.equal(exhausted.sourceMutationAllowed, false);
  });

  it("does not repeat a failed or explicitly ruled-out repair hypothesis", () => {
    const first = input("test-assertion", { proposedHypothesisRef: "hypothesis:fixture" });
    const result = selectRecoveryDecision({
      ...first,
      history: [history(first, "repair", "failed", { hypothesisRef: "hypothesis:fixture" })]
    });
    assert.equal(result.action, "handoff");
    assert.deepEqual(result.reasonCodes, ["repeated-hypothesis"]);
  });

  it("requires task authorization before a dependency/config repair", () => {
    assert.equal(selectRecoveryDecision(input("dependency-config")).action, "ask-operator");
    const authorized = selectRecoveryDecision(input("dependency-config", { dependencyMutationAuthorized: true }));
    assert.equal(authorized.action, "repair");
    assert.equal(authorized.sourceMutationAllowed, true);
  });

  it("keeps environment, permission, scope, and read-only failures out of mutation", () => {
    const expected = new Map([
      ["environment", "ask-operator"],
      ["permission-policy", "ask-operator"],
      ["scope-protected-path", "handoff"]
    ]);
    for (const [category, action] of expected) {
      const result = selectRecoveryDecision(input(category));
      assert.equal(result.action, action);
      assert.equal(result.sourceMutationAllowed, false);
    }
    const readOnly = selectRecoveryDecision(input("lint-format", { task: { ...input("lint-format").task, changeMode: "read-only" } }));
    assert.equal(readOnly.action, "handoff");
    assert.equal(readOnly.sourceMutationAllowed, false);
  });

  it("terminates scope and read-only boundary recovery before stale or diagnostic retries", () => {
    const scope = input("scope-protected-path", { currentTreeMatchesEvidence: false });
    const scopeDecision = selectRecoveryDecision(scope);
    assert.equal(scopeDecision.action, "handoff");
    assert.equal(scopeDecision.continuation, "none");
    assert.equal(scopeDecision.sourceMutationAllowed, false);
    assert.deepEqual(scopeDecision.reasonCodes, ["scope-replan-required"]);

    const readOnlyBoundary = input("scope-protected-path", {
      task: { ...scope.task, changeMode: "read-only" },
      currentTreeMatchesEvidence: false,
      history: [history(scope, "retry")]
    });
    const readOnlyDecision = selectRecoveryDecision(readOnlyBoundary);
    assert.equal(readOnlyDecision.action, "handoff");
    assert.equal(readOnlyDecision.continuation, "none");
    assert.equal(readOnlyDecision.sourceMutationAllowed, false);
    assert.deepEqual(readOnlyDecision.reasonCodes, ["scope-replan-required"]);
  });

  it("retries an explicitly transient provider failure once, then selects a fresh session", () => {
    const first = input("provider-network", { currentPhase: "execute" });
    const retry = selectRecoveryDecision(first);
    assert.equal(retry.action, "retry");
    assert.equal(retry.sourceMutationAllowed, false);
    const exhausted = selectRecoveryDecision({ ...first, history: [history(first, "retry")] });
    assert.equal(exhausted.action, "fresh-session");
    assert.equal(exhausted.sourceMutationAllowed, false);
  });

  it("retries the exact verifier once for transient infrastructure and stale evidence", () => {
    const flaky = input("flaky-infrastructure");
    assert.equal(selectRecoveryDecision(flaky).action, "retry");
    assert.equal(selectRecoveryDecision({ ...flaky, history: [history(flaky, "retry")] }).action, "handoff");
    const staleInput = input("compile-typecheck", { currentTreeMatchesEvidence: false });
    const stale = selectRecoveryDecision(staleInput);
    assert.equal(stale.action, "retry");
    assert.equal(stale.nextPhase, "verify");
    assert.equal(stale.sourceMutationAllowed, false);
    assert.equal(selectRecoveryDecision({ ...staleInput, history: [history(staleInput, "retry")] }).action, "handoff");
    const unknownStale = input("unknown", { currentTreeMatchesEvidence: false });
    assert.equal(selectRecoveryDecision(unknownStale).action, "retry");
    assert.equal(selectRecoveryDecision({ ...unknownStale, history: [history(unknownStale, "retry")] }).action, "handoff");
  });

  it("allows a verifier retry after one acceptance repair while keeping each class bounded", () => {
    const first = input("test-assertion");
    const afterRepair = input("unknown", { history: [history(first, "repair", "succeeded")] });
    const retry = selectRecoveryDecision(afterRepair);
    assert.equal(retry.action, "retry");
    assert.deepEqual(retry.reasonCodes, ["unknown-diagnostic-pass"]);
    const exhausted = selectRecoveryDecision({
      ...afterRepair,
      history: [...afterRepair.history, history(afterRepair, "retry")]
    });
    assert.equal(exhausted.action, "handoff");
  });

  it("uses one non-mutating diagnostic pass for unknown evidence and then stops", () => {
    const first = input("unknown", { currentPhase: "execute" });
    const diagnostic = selectRecoveryDecision(first);
    assert.equal(diagnostic.action, "retry");
    assert.equal(diagnostic.nextPhase, "scout");
    assert.equal(diagnostic.sourceMutationAllowed, false);
    const later = input("unknown", {
      task: { ...first.task, taskRunId: "task-a-run-2", attempt: 2 },
      currentPhase: "execute",
      history: [history(first, "retry")]
    });
    assert.equal(selectRecoveryDecision(later).action, "handoff");
  });

  it("fails closed for invalid identity, terminal state, and already-passed evidence", () => {
    assert.equal(selectRecoveryDecision(input("unknown", { task: { ...input("unknown").task, taskRunId: "" } })).action, "blocked");
    assert.equal(selectRecoveryDecision(input("unknown", { currentPhase: "terminal" })).action, "blocked");
    assert.equal(selectRecoveryDecision(input("passed")).action, "handoff");
  });
});
