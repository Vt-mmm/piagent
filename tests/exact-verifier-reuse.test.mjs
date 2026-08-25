import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateExactVerifierReuse,
  operatorExplicitlyRequestedVerifierExecution
} from "../packages/piagent-core/runtime/verification/exact-verifier-reuse.ts";
import { WORKING_TREE_DIGEST_ALGORITHM, versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";

function userEntry(text) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function task(digest, overrides = {}) {
  return {
    taskId: "frontend-sync",
    taskRunId: "frontend-sync-run-1",
    changeMode: "source-change",
    trace: { outcome: "pending" },
    workingTreeDigestAlgorithm: WORKING_TREE_DIGEST_ALGORITHM,
    verifyCommands: ["npm test -- frontend"],
    verifyEvidence: [{
      command: "npm test -- frontend",
      exitCode: 0,
      summary: "passed",
      recordedAt: "2026-08-25T00:00:00.000Z",
      observed: true,
      observedAt: "2026-08-25T00:00:00.000Z",
      matchedProfileCommand: true,
      preWorkingTreeDigest: digest,
      workingTreeDigest: digest
    }],
    ...overrides
  };
}

describe("exact verifier evidence reuse", () => {
  it("rewrites a redundant exact verifier to a transparent no-op on the same tree", () => {
    const digest = workingTreeEvidenceDigest({ "src/page.ts": versionWorkingTreeHash("a".repeat(64)) });
    const toolInput = { command: "npm test -- frontend" };
    const result = evaluateExactVerifierReuse({ task: task(digest), toolName: "bash", toolInput, workingTreeDigest: digest, sessionEntries: [userEntry("Continue the implementation")] });
    assert.equal(result.reused, true);
    assert.equal(result.reasonCode, "current-tree-exact-verifier-reused");
    assert.match(toolInput.command, /reused exact verifier evidence/);
    assert.doesNotMatch(toolInput.command, /npm test/);
  });

  it("does not reuse stale, failed, or non-exact evidence", () => {
    const digest = workingTreeEvidenceDigest({});
    const changedDigest = workingTreeEvidenceDigest({ "src/new.ts": versionWorkingTreeHash("b".repeat(64)) });
    const staleInput = { command: "npm test -- frontend" };
    assert.equal(evaluateExactVerifierReuse({ task: task(digest), toolName: "bash", toolInput: staleInput, workingTreeDigest: changedDigest }).reused, false);
    assert.equal(staleInput.command, "npm test -- frontend");
    const failed = task(digest, { verifyEvidence: [{ ...task(digest).verifyEvidence[0], exitCode: 1 }] });
    assert.equal(evaluateExactVerifierReuse({ task: failed, toolName: "bash", toolInput: { command: "npm test -- frontend" }, workingTreeDigest: digest }).reused, false);
    assert.equal(evaluateExactVerifierReuse({ task: task(digest), toolName: "bash", toolInput: { command: "npm test -- other" }, workingTreeDigest: digest }).reused, false);
  });

  it("honors an explicit operator request to execute the verifier again", () => {
    const digest = workingTreeEvidenceDigest({});
    const toolInput = { command: "npm test -- frontend" };
    const entries = [userEntry("Chạy lại test lần cuối cho anh")];
    assert.equal(operatorExplicitlyRequestedVerifierExecution(entries), true);
    const result = evaluateExactVerifierReuse({ task: task(digest), toolName: "bash", toolInput, workingTreeDigest: digest, sessionEntries: entries });
    assert.equal(result.reused, false);
    assert.equal(result.reasonCode, "operator-requested-execution");
    assert.equal(toolInput.command, "npm test -- frontend");
  });
});
