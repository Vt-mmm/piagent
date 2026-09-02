import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerIndependentAcceptanceProvider, independentAcceptanceState } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { independentVerificationRecovery } from "../packages/piagent-core/runtime/recovery/independent-verification-recovery.ts";
import { selectRecoveryDecision, recoveryDecisionValidationErrors } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";

test("only a current host provider, not task JSON, supplies non-execution stop diagnostics", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-host-stop-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const task = { taskId: "task", taskRunId: "run", sessionId: "session", stopReason: "pending" };
  assert.equal(independentAcceptanceState(cwd, task, "tree").stopReason, undefined);
  for (const [stopReason, action, continuation] of [
    ["pending", "ask-operator", "operator"], ["unavailable", "ask-operator", "operator"], ["approval", "ask-operator", "operator"],
    ["interrupted", "handoff", "none"], ["exhausted", "handoff", "none"], ["stopping", "handoff", "none"]
  ]) {
    const dispose = registerIndependentAcceptanceProvider(cwd, task, () => ({ block: "host-owned stop", stopReason }));
    try {
      const recovery = independentVerificationRecovery(cwd, task, "tree");
      assert.ok(recovery);
      assert.match(recovery.guidance.join(" "), /not an executed correctness result/);
      const decision = selectRecoveryDecision({ featureEnabled: true, task: { ...task, attempt: 1, maxAttempts: 3, changeMode: "source-change" },
        classification: recovery.classification, currentPhase: "verify", exactVerifierAvailable: true, currentTreeMatchesEvidence: false,
        independentDisposition: recovery.independentDisposition });
      assert.deepEqual(recoveryDecisionValidationErrors(decision), []);
      assert.equal(decision.action, action);
      assert.equal(decision.continuation, continuation);
      assert.equal(decision.sourceMutationAllowed, false);
    } finally { dispose(); }
  }
  const dispose = registerIndependentAcceptanceProvider(cwd, task, () => ({ block: "unknown", stopReason: "invented" }));
  try {
    const recovery = independentVerificationRecovery(cwd, task, "tree");
    assert.equal(recovery.independentDisposition, "approval");
    assert.equal(recovery.classification.authorizesSourceMutation, false);
  }
  finally { dispose(); }
});
