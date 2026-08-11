import assert from "node:assert/strict";
import test from "node:test";

import { workingTreeEvidenceDigest, versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { registerTaskCompletionTools } from "../packages/piagent-core/runtime/registration/task-completion-tools.ts";

const Type = {
  Object: () => ({}), String: () => ({}), Number: () => ({}), Array: () => ({}), Optional: (value) => value
};

test("explicit verify recording cannot bypass the automatic migration pre/post tree invariant", async () => {
  const snapshot = { "src/value.ts": versionWorkingTreeHash("a".repeat(64)) };
  const currentDigest = workingTreeEvidenceDigest(snapshot);
  let written;
  const task = {
    taskId: "digest-refresh", taskRunId: "digest-refresh-run-1", sessionId: "session-1", createdAt: "2026-08-10T00:00:00.000Z",
    trace: { outcome: "pending" }, verifyCommands: ["npm test"], verifyEvidence: [], acceptanceReceipt: { criteria: [] },
    workingTreeDigestAlgorithm: "wt-content-v2",
    workingTreeDigestMigration: {
      status: "verification-refresh-required", source: "legacy-unversioned", reasonCode: "clean-baseline-rebound",
      requiredAction: "rerun-exact-verifier", archivePath: ".pi/piagent-state/digest-migrations/digest-refresh-run-1.legacy.json",
      archiveDigest: "b".repeat(64), archiveBytes: 10, baselineEvidenceDigest: "d".repeat(64), finalEvidenceDigest: "e".repeat(64), recordedAt: "2026-08-10T00:00:00.000Z"
    }
  };
  const tools = new Map();
  registerTaskCompletionTools({}, {
    Type, StringEnum: () => ({}), registerPiagentTool: (_pi, definition) => tools.set(definition.name, definition),
    readTask: () => task, readObservedBashResults: () => [], observedBashLedgerPath: () => "unused",
    bashResults: { list: () => [] }, findMatchingObservedBashResult: () => ({ ok: true, entry: { recordedAt: "2026-08-10T00:01:00.000Z", isError: false, commandHash: "c".repeat(64) } }),
    redactText: (value) => value, redactForStorage: (value) => value, commandMatchesVerifyPlan: (command, commands) => commands.includes(command),
    workingTreeSnapshot: () => snapshot, workingTreeEvidenceDigest,
    taskChangedFileEvidence: () => ({ expected: ["src/value.ts"] }),
    allVerifyCommandsPassCurrentTree: (candidate, digest) => candidate.verifyCommands.every((command) => candidate.verifyEvidence.some((entry) => entry.command === command && entry.exitCode === 0 && entry.workingTreeDigest === digest)),
    applyRuntimeLifecycleObservation: () => ({ changed: true }), nowIso: () => "2026-08-10T00:02:00.000Z",
    refreshAcceptanceReceipt: (candidate) => ({ task: candidate }), writeTask: (_cwd, candidate) => (written = structuredClone(candidate)),
    appendTrace() {}, appendSessionTrace() {}, classifyVerificationFailure: () => ({ category: "none", retryable: false }),
    recordVerificationCheckpoint() {}, compactTaskDetails: (value) => value
  });

  const result = await tools.get("piagent_verify_record").execute("verify-1", {
    taskId: task.taskId, command: "npm test", exitCode: 0, summary: "pass"
  }, undefined, undefined, { cwd: "/tmp/digest-refresh", sessionManager: { getSessionId: () => "session-1" } });

  assert.equal(result.isError, undefined);
  assert.equal(written.workingTreeDigestMigration.status, "verification-refresh-required");
  assert.equal(written.workingTreeDigestMigration.requiredAction, "rerun-exact-verifier");
  assert.equal(written.verifyEvidence[0].workingTreeDigest, currentDigest);
});
