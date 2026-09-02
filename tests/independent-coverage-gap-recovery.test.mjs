import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerIndependentAcceptanceProvider } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { independentVerificationRecovery } from "../packages/piagent-core/runtime/recovery/independent-verification-recovery.ts";
import { selectRecoveryDecision, recoveryDecisionValidationErrors } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-coverage-recovery-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, task: { taskId: "task", taskRunId: "run", sessionId: "session", acceptanceReceipt: { criteria: [] } } };
}

function assertOperatorOnly(recovery, task) {
  assert.ok(recovery, "a host coverage block must not disappear into generic model diagnostics");
  const decision = selectRecoveryDecision({ featureEnabled: true,
    task: { ...task, attempt: 1, maxAttempts: 3, changeMode: "source-change" },
    classification: recovery.classification, currentPhase: "verify",
    exactVerifierAvailable: true, currentTreeMatchesEvidence: false,
    independentDisposition: recovery.independentDisposition });
  assert.deepEqual(recoveryDecisionValidationErrors(decision), []);
  assert.equal(decision.action, "ask-operator");
  assert.equal(decision.continuation, "operator");
  assert.equal(decision.sourceMutationAllowed, false);
  assert.equal(recovery.classification.authorizesSourceMutation, false);
  assert.ok(!decision.reasonCodes.includes("unknown-diagnostic-pass"));
}

test("configured but unprepared verification does not spend a model diagnostic turn", (t) => {
  const { cwd, task } = fixture(t);
  const previous = process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG;
  process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG = "/not-opened/approval.json";
  t.after(() => previous === undefined ? delete process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG
    : process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG = previous);
  assertOperatorOnly(independentVerificationRecovery(cwd, task, "tree"), task);
});

for (const [name, read] of [
  ["criterion binding mismatch", () => ({ entries: [{ criterionId: "other", criterionHash: "a".repeat(64) }] })],
  ["host provider unavailable", () => { throw new Error("offline host fault"); }],
  ["unrecognized host stop", () => ({ block: "not approved", stopReason: "invented" })]
]) test(`${name} remains non-authorizing and cannot become a stale-evidence retry`, (t) => {
  const { cwd, task } = fixture(t);
  t.after(registerIndependentAcceptanceProvider(cwd, task, read));
  assertOperatorOnly(independentVerificationRecovery(cwd, task, "tree"), task);
});

test("task-authored diagnostics do not create host authority and the unconfigured legacy route is unchanged", (t) => {
  const { cwd, task } = fixture(t);
  const previous = process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG;
  delete process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG;
  t.after(() => { if (previous !== undefined) process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG = previous; });
  task.stopReason = "approval";
  task.block = "pretend host coverage gap";
  assert.equal(independentVerificationRecovery(cwd, task, "tree"), undefined);
});
