import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { classifyVerificationFailure } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { recordCompletionAudit, recordVerificationCheckpoint } from "../packages/piagent-core/extensions/task-runtime-audit.js";
import { taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { buildHandoffProjection, handoffProjectionPath, readHandoffProjection, validateHandoffProjection, writeHandoffProjection } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { selectRecoveryDecision } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";

const taskFixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-handoff-"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  return cwd;
}

function context(cwd) {
  return { cwd, ui: { notify() {} } };
}

function task() {
  const operatorRequest = "PRIVATE_OPERATOR_REQUEST_SENTINEL: repair the bounded handoff fixture without exposing this source text.";
  return {
    ...structuredClone(taskFixture),
    taskId: "handoff-101",
    taskRunId: "handoff-101-run-1",
    sessionId: "private-session-id",
    sessionName: "HANDOFF-101",
    summary: "Repair the bounded handoff fixture.",
    operatorRequest,
    operatorRequestDigest: operatorRequestDigest(operatorRequest),
    expectedOutput: "The handoff can be resumed from operational evidence.",
    acceptanceCriteria: ["The exact verifier passes on the current tree."],
    scope: ["src/a.ts"],
    verifyCommands: ["TOKEN=super-secret npm test"],
    baselineFileDigests: {},
    baselineChangedFiles: [],
    observedChangedFiles: ["src/a.ts"],
    changedFiles: ["src/a.ts"],
    ruledOut: "The cached-output hypothesis was disproved by the current tree digest."
  };
}

describe("durable handoff projection v2", () => {
  it("reconstructs bounded task, tree, verifier, failure, recovery, and authority state", () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
    const current = task();
    const digests = { "src/a.ts": versionWorkingTreeHash("a".repeat(64)) };
    const treeDigest = workingTreeEvidenceDigest(digests);
    current.finalWorkingTreeFiles = ["src/a.ts"];
    current.finalFileDigests = digests;
    current.verifyEvidence = [{
      command: current.verifyCommands[0], exitCode: 2, summary: "TOKEN=super-secret TS2322", recordedAt: "2026-08-08T00:00:00.000Z",
      observed: true, observedAt: "2026-08-08T00:00:00.000Z", isError: true, matchedProfileCommand: true, workingTreeDigest: treeDigest
    }];
    const failure = classifyVerificationFailure("TS2322: type string is not assignable", 2, { captureRef: "capture:verify-1", truncated: true });
    recordVerificationCheckpoint(context(cwd), current, {
      commandHash: "a".repeat(64), workingTreeDigest: treeDigest, exitCode: 2,
      evidence: { failureClassification: failure }
    });
    const recovery = selectRecoveryDecision({
      featureEnabled: true,
      task: { taskId: current.taskId, taskRunId: current.taskRunId, attempt: 1, maxAttempts: 3, changeMode: "source-change" },
      classification: failure,
      currentPhase: "verify",
      exactVerifierAvailable: true,
      currentTreeMatchesEvidence: true
    });
    recordCompletionAudit(context(cwd), current, { outcome: "blocked", evidence: { recovery } });
    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:01.000Z" };
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["passing verifier"], missingVerifyCommands: current.verifyCommands },
      currentDigests: digests,
      recovery,
      generatedAt: "2026-08-08T00:00:02.000Z"
    });
    assert.equal(projection.state.completionApproved, false, "a failed gate must outrank a completed-looking task trace");
    assert.equal(projection.failure.classification.category, "compile-typecheck");
    assert.equal(projection.failure.classification.outputRef.captureRef, "capture:verify-1");
    assert.equal(projection.failure.recovery.action, "repair");
    assert.equal(projection.nextSafeAction.sourceMutationAllowed, true);
    assert.deepEqual(projection.changedFiles.current, ["src/a.ts"]);
    assert.equal(projection.tree.latestVerifierMatchesCurrentTree, false);
    assert.equal(projection.tree.algorithm, "wt-content-v2");
    assert.equal(projection.tree.evidenceCurrent, true);
    assert.match(projection.tree.currentDigest, /^wt-content-v2:[a-f0-9]{64}$/);
    assert.equal(projection.references.solverDecision, null);
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes("super-secret"), false);
    assert.equal(serialized.includes("[REDACTED_SECRET]"), true);
    assert.equal(serialized.includes("private-session-id"), false);
    assert.equal(serialized.includes("PRIVATE_OPERATOR_REQUEST_SENTINEL"), false, "handoff projection must omit the private operator request");

    const staleRepair = structuredClone(projection);
    staleRepair.failure.recovery.taskAttempt = 999;
    assert.throws(() => validateHandoffProjection(staleRepair), /recovery decision is invalid/);

    const malformedRepair = structuredClone(projection);
    malformedRepair.failure.recovery.sourceMutationAllowed = false;
    assert.throws(() => validateHandoffProjection(malformedRepair), /recovery decision is invalid/);

    const staleHandoff = structuredClone(projection);
    Object.assign(staleHandoff.failure.recovery, {
      action: "handoff", continuation: "none", nextPhase: null, sourceMutationAllowed: false
    });
    assert.throws(() => validateHandoffProjection(staleHandoff), /recovery decision is invalid/);

    const forgedAuthority = structuredClone(projection);
    forgedAuthority.requiredAuthority = { required: true, kind: "operator", reasonCodes: ["source-repair-eligible"] };
    assert.throws(() => validateHandoffProjection(forgedAuthority), /required authority conflicts with recovery decision/);
  });

  it("writes owner-only state and reads it back", () => {
    const cwd = workspace();
    const current = task();
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["verification"], missingVerifyCommands: current.verifyCommands },
      currentDigests: {},
      generatedAt: "2026-08-08T00:00:02.000Z"
    });
    writeHandoffProjection(cwd, projection);
    const target = handoffProjectionPath(cwd, current.taskRunId);
    assert.deepEqual(readHandoffProjection(cwd, current.taskRunId), projection);
    assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  });

  for (const code of ["ENOSPC", "EACCES"]) {
    it(`preserves the last valid handoff and removes a partial temporary file after ${code}`, () => {
      const cwd = workspace();
      const current = task();
      const first = buildHandoffProjection(cwd, current, {
        gate: { decision: "fail", missing: ["verification"], missingVerifyCommands: current.verifyCommands },
        currentDigests: {}, generatedAt: "2026-08-08T00:00:02.000Z"
      });
      writeHandoffProjection(cwd, first);
      const next = { ...structuredClone(first), generatedAt: "2026-08-08T00:00:03.000Z" };
      const original = fs.writeFileSync;
      fs.writeFileSync = function partialThenFail(file, data, options) {
        if (String(file).includes(".tmp")) {
          original.call(this, file, String(data).slice(0, 23), options);
          const error = new Error(code === "ENOSPC" ? "synthetic disk full" : "synthetic permission denied");
          error.code = code;
          throw error;
        }
        return original.call(this, file, data, options);
      };
      try {
        assert.throws(() => writeHandoffProjection(cwd, next), new RegExp(code === "ENOSPC" ? "disk full" : "permission denied"));
      } finally {
        fs.writeFileSync = original;
      }
      assert.deepEqual(readHandoffProjection(cwd, current.taskRunId), first);
      const directory = path.dirname(handoffProjectionPath(cwd, current.taskRunId));
      assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes(".tmp")), []);
    });
  }

  it("surfaces corrupt journal state instead of trusting partial recovery evidence", () => {
    const cwd = workspace();
    const current = task();
    recordCompletionAudit(context(cwd), current, { outcome: "blocked", evidence: { recovery: { policyVersion: "recovery-v1" } } });
    fs.appendFileSync(taskJournalPaths(cwd).events, "{truncated\n");
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["journal integrity"], missingVerifyCommands: [] },
      currentDigests: {}
    });
    assert.equal(projection.failure.journalIntegrity, "corrupt");
    assert.equal(projection.failure.classification, null);
    assert.equal(projection.failure.recovery, null);
    assert.ok(projection.failure.warnings.length > 0);
  });

  it("refuses a symlinked handoff state directory", () => {
    const cwd = workspace();
    const outside = workspace();
    fs.mkdirSync(path.join(cwd, ".pi", "piagent-state"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, ".pi", "piagent-state", "handoffs"));
    const current = task();
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["verification"], missingVerifyCommands: [] },
      currentDigests: {}
    });
    assert.throws(() => writeHandoffProjection(cwd, projection), /must not traverse a symbolic link/);
  });

  it("keeps legacy task evidence historical and never projects completion approval", () => {
    const cwd = workspace();
    const current = task();
    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:01.000Z" };
    current.workingTreeDigestAlgorithm = "legacy-untrusted";
    current.workingTreeDigestMigration = {
      status: "historical-unverifiable",
      source: "legacy-unversioned",
      reasonCode: "terminal-legacy-evidence",
      requiredAction: "historical-only",
      archivePath: ".pi/piagent-state/digest-migrations/handoff-101-run-1.legacy.json",
      archiveDigest: "a".repeat(64), archiveBytes: 1,
      baselineEvidenceDigest: "b".repeat(64), finalEvidenceDigest: "c".repeat(64),
      recordedAt: "2026-08-08T00:00:00.000Z"
    };
    const currentDigests = {};
    const projection = buildHandoffProjection(cwd, current, {
      gate: {
        decision: "pass",
        missing: [],
        missingVerifyCommands: [],
        currentWorkingTreeDigest: workingTreeEvidenceDigest(currentDigests)
      },
      currentDigests
    });
    assert.equal(projection.state.completionApproved, false);
    assert.equal(projection.tree.algorithm, "legacy-untrusted");
    assert.equal(projection.tree.migration.status, "historical-unverifiable");
    assert.equal(projection.tree.evidenceCurrent, false);
    assert.ok(projection.state.missing.includes("working-tree-evidence-not-current"));
  });

  it("never projects completion approval while acceptance criteria remain pending", () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
    const current = task();
    const digests = { "src/a.ts": versionWorkingTreeHash("a".repeat(64)) };
    const treeDigest = workingTreeEvidenceDigest(digests);
    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:01.000Z" };
    current.changedFiles = ["src/a.ts"];
    current.finalWorkingTreeFiles = ["src/a.ts"];
    current.finalFileDigests = digests;
    current.acceptanceReceipt = {
      source: "runtime",
      schemaVersion: 1,
      criteria: [{ id: "criterion-1", hash: "a".repeat(64), obligation: "requested-behavior", priority: "critical", status: "pending", evidence: [] }]
    };
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "pass", missing: [], missingVerifyCommands: [], currentWorkingTreeDigest: treeDigest },
      currentDigests: digests
    });
    assert.equal(projection.state.completionApproved, false);
    assert.deepEqual(projection.acceptance, {
      required: true,
      satisfied: false,
      criteriaCount: 1,
      dispositionDigest: projection.acceptance.dispositionDigest
    });
    assert.match(projection.acceptance.dispositionDigest, /^[a-f0-9]{64}$/);
    assert.ok(projection.state.missing.includes("acceptance-criteria-pending"));
    assert.equal(projection.nextSafeAction.action, "handoff");

    const forgedAcceptance = structuredClone(projection);
    forgedAcceptance.state = { ...forgedAcceptance.state, completionApproved: true, missing: [] };
    forgedAcceptance.tree = {
      ...forgedAcceptance.tree,
      baselineDigest: workingTreeEvidenceDigest({}),
      currentDigest: treeDigest,
      evidenceCurrent: true
    };
    forgedAcceptance.nextSafeAction = { action: "completed", continuation: "none", sourceMutationAllowed: false, exactCommands: [] };
    assert.throws(() => validateHandoffProjection(forgedAcceptance), /requires satisfied acceptance/);

    const forgedMissing = structuredClone(forgedAcceptance);
    forgedMissing.acceptance.satisfied = true;
    forgedMissing.state.missing = ["acceptance-criteria-pending"];
    assert.throws(() => validateHandoffProjection(forgedMissing), /cannot retain missing completion evidence/);

    const forgedAction = structuredClone(forgedMissing);
    forgedAction.state.missing = [];
    forgedAction.nextSafeAction.action = "handoff";
    assert.throws(() => validateHandoffProjection(forgedAction), /requires a completed next safe action/);

    const forgedVerifier = structuredClone(forgedAction);
    forgedVerifier.nextSafeAction.action = "completed";
    forgedVerifier.verification.missingCommands = [current.verifyCommands[0]];
    assert.throws(() => validateHandoffProjection(forgedVerifier), /cannot retain missing verifier commands/);

    const missingVerifierField = structuredClone(forgedAction);
    missingVerifierField.nextSafeAction.action = "completed";
    delete missingVerifierField.verification.missingCommands;
    assert.throws(() => validateHandoffProjection(missingVerifierField), /verification is invalid/);

    const scalarVerifierField = structuredClone(forgedAction);
    scalarVerifierField.nextSafeAction.action = "completed";
    scalarVerifierField.verification.missingCommands = "npm test";
    assert.throws(() => validateHandoffProjection(scalarVerifierField), /verification is invalid/);

    const missingCurrentVerifier = structuredClone(forgedAction);
    missingCurrentVerifier.nextSafeAction.action = "completed";
    assert.throws(() => validateHandoffProjection(missingCurrentVerifier), /requires current exact verifier evidence/);
  });

  it("writes a valid unapproved handoff when required acceptance evidence is absent", () => {
    const cwd = workspace();
    const current = task();
    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:01.000Z" };
    current.acceptanceReceipt = null;
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "pass", missing: [], missingVerifyCommands: [], currentWorkingTreeDigest: workingTreeEvidenceDigest({}) },
      currentDigests: {}
    });
    assert.deepEqual(projection.acceptance, {
      required: true,
      satisfied: false,
      criteriaCount: 0,
      dispositionDigest: projection.acceptance.dispositionDigest
    });
    assert.equal(projection.state.completionApproved, false);
    assert.ok(projection.state.missing.includes("acceptance-criteria-pending"));
    assert.doesNotThrow(() => validateHandoffProjection(projection));
  });

  it("does not approve a pass-gate projection without current exact verifier evidence", () => {
    const cwd = workspace();
    const current = task();
    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:01.000Z" };
    current.changedFiles = [];
    current.observedChangedFiles = [];
    current.finalWorkingTreeFiles = [];
    current.finalFileDigests = {};
    current.verifyEvidence = [];
    const treeDigest = workingTreeEvidenceDigest({});
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "pass", missing: [], missingVerifyCommands: [], currentWorkingTreeDigest: treeDigest },
      currentDigests: {}
    });
    assert.equal(projection.acceptance.satisfied, true);
    assert.equal(projection.tree.evidenceCurrent, true);
    assert.equal(projection.state.completionApproved, false);
    assert.ok(projection.state.missing.includes("current exact verifier evidence"));
  });

  it("does not overstate a partial refreshed migration descriptor", () => {
    const cwd = workspace();
    const current = task();
    current.workingTreeDigestMigration = { status: "refreshed" };
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["invalid task contract"], missingVerifyCommands: current.verifyCommands },
      currentDigests: {}
    });
    assert.equal(projection.tree.evidenceCurrent, false);
    assert.equal(projection.tree.latestVerifierMatchesCurrentTree, false);
    assert.equal(projection.tree.migration, null);
  });

  it("requires the latest verifier to pass without mutating the current tree", () => {
    const cwd = workspace();
    const current = task();
    const currentDigest = workingTreeEvidenceDigest({});
    current.verifyEvidence = [{
      command: current.verifyCommands[0], exitCode: 0, summary: "pass", recordedAt: "2026-08-08T00:00:01.000Z",
      observed: true, observedAt: "2026-08-08T00:00:01.000Z", isError: false, matchedProfileCommand: true,
      preWorkingTreeDigest: versionWorkingTreeHash("f".repeat(64)), workingTreeDigest: currentDigest
    }];
    const mutated = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["unstable verifier"], missingVerifyCommands: current.verifyCommands }, currentDigests: {}
    });
    assert.equal(mutated.tree.latestVerifierMatchesCurrentTree, false);
    const forged = structuredClone(mutated);
    forged.tree.latestVerifierMatchesCurrentTree = true;
    assert.throws(() => validateHandoffProjection(forged), /latest verifier tree claim is invalid/);
    current.verifyEvidence[0].preWorkingTreeDigest = currentDigest;
    const stable = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: [], missingVerifyCommands: [] }, currentDigests: {}
    });
    assert.equal(stable.tree.latestVerifierMatchesCurrentTree, true);

    const newerDigests = { "src/a.ts": versionWorkingTreeHash("a".repeat(64)) };
    const newerDigest = workingTreeEvidenceDigest(newerDigests);
    current.verifyEvidence[0].preWorkingTreeDigest = newerDigest;
    current.verifyEvidence[0].workingTreeDigest = newerDigest;
    const currentVerifierWithoutFinalSnapshot = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["acceptance evidence"], missingVerifyCommands: [] },
      currentDigests: newerDigests
    });
    assert.equal(currentVerifierWithoutFinalSnapshot.tree.evidenceCurrent, false);
    assert.equal(currentVerifierWithoutFinalSnapshot.tree.latestVerifierMatchesCurrentTree, true);
    assert.doesNotThrow(() => validateHandoffProjection(currentVerifierWithoutFinalSnapshot));

    current.verifyEvidence.push({
      ...current.verifyEvidence[0], exitCode: 1, summary: "newer failure",
      recordedAt: "2026-08-08T00:00:03.000Z", observedAt: "2026-08-08T00:00:03.000Z"
    }, {
      ...current.verifyEvidence[0], summary: "older ledger pass appended later",
      recordedAt: "2026-08-08T00:00:02.000Z", observedAt: "2026-08-08T00:00:02.000Z"
    });
    const failedLatest = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["newer verifier failed"], missingVerifyCommands: current.verifyCommands }, currentDigests: {}
    });
    assert.equal(failedLatest.verification.latestObserved.exitCode, 1);
    assert.equal(failedLatest.tree.latestVerifierMatchesCurrentTree, false);
  });
});
