import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { recordCompletionAudit, recordVerificationCheckpoint } from "../packages/piagent-core/extensions/task-runtime-audit.js";
import { hashEvidenceCommand } from "../packages/piagent-core/extensions/runtime-evidence.js";
import { readTaskJournal, recordTaskCheckpoint, replayTaskCheckpoints, taskJournalPaths, taskRecoveryDecision } from "../packages/piagent-core/extensions/task-journal.js";
import { operatorRequestDigest, workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";
import { currentWorkspaceRevisionDigest } from "../packages/piagent-core/extensions/workspace-revision.js";
import {
  LEGACY_TASK_TRUTH_OVERFLOW_MARKER,
  RESUME_CONTEXT_LOSSLESS_MAX_CHARS,
  RESUME_CONTEXT_LOSSLESS_OVERFLOW_MARKER,
  RESUME_CONTEXT_MAX_CHARS,
  buildTaskResumeContext,
  inspectTaskResumeState,
  legacyTaskResumeTruthChars
} from "../packages/piagent-core/runtime/recovery/resume-state.ts";
import { buildHandoffProjection, handoffProjectionPath, writeHandoffProjection } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { writeTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";
import { captureVerifierFileSnapshot } from "../packages/piagent-core/runtime/inspection/verifier-snapshot-store.ts";
import { automaticAcceptanceCriteria, automaticTaskSummary } from "../packages/piagent-core/runtime/workflows/task-intake.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-resume-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function task() {
  const current = {
    ...structuredClone(fixture),
    taskId: "resume-101",
    taskRunId: "resume-101-run-1",
    sessionId: "session-resume",
    sessionName: "RESUME-101",
    verifyCommands: ["npm test"],
    observedChangedFiles: ["src/a.ts"],
    changedFiles: ["src/a.ts"]
  };
  current.authoritySnapshot = createBoundTaskAuthority({
    taskId: current.taskId, taskRunId: current.taskRunId, createdAt: current.createdAt
  });
  return current;
}

function writeVerifyTrajectory(cwd, current) {
  let state = createTrajectoryState({
    taskId: current.taskId, taskRunId: current.taskRunId, sessionId: current.sessionId,
    changeMode: current.changeMode, riskLane: current.riskLane, createdAt: current.createdAt
  });
  state = reduceTrajectory(state, createTrajectoryTransition(state, { to: "plan", cause: "plan-observed", sourceHook: "task-state", observedAt: "2026-08-08T00:00:02.000Z" }));
  state = reduceTrajectory(state, createTrajectoryTransition(state, { to: "execute", cause: "mutation-observed", sourceHook: "task-state", observedAt: "2026-08-08T00:00:03.000Z" }));
  state = reduceTrajectory(state, createTrajectoryTransition(state, { to: "verify", cause: "verification-started", sourceHook: "tool-call", observedAt: "2026-08-08T00:00:04.000Z" }));
  writeTrajectoryState(cwd, state);
}

function terminalHandoffRecovery(current, overrides = {}) {
  return {
    policyVersion: "recovery-v1", taskId: current.taskId, taskRunId: current.taskRunId, taskAttempt: current.attempt,
    evidenceDigest: "a".repeat(64), failureCategory: "test-assertion", currentPhase: "review",
    action: "handoff", continuation: "none", nextPhase: null, sourceMutationAllowed: false,
    reasonCodes: ["repair-ceiling-reached"],
    counts: { sourceRepairPasses: 1, transientVerifierRetries: 0, unknownDiagnosticPasses: 0, providerRetries: 0 },
    ceilings: { sourceRepairPasses: 1, transientVerifierRetries: 1, unknownDiagnosticPasses: 1, providerRetries: 1 },
    hypothesisRef: null, ...overrides
  };
}

describe("safe task resume state", () => {
  it("restores phase/checkpoint identity and invalidates verifier evidence after a tree change", () => {
    const cwd = workspace();
    const current = task();
    const verifiedDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    current.verifyEvidence = [{
      command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-08T00:00:03.000Z",
      observed: true, observedAt: "2026-08-08T00:00:03.000Z", matchedProfileCommand: true, workingTreeDigest: verifiedDigest
    }];
    captureVerifierFileSnapshot({
      projectRoot: cwd, taskId: current.taskId, taskRunId: current.taskRunId, sessionId: current.sessionId,
      toolCallId: "verify-call", commandHash: hashEvidenceCommand("npm test"),
      observedAt: "2026-08-08T00:00:03.000Z", capturedAt: "2026-08-08T00:00:04.000Z",
      exitCode: 0, treeDigest: verifiedDigest, snapshot: workingTreeSnapshot(cwd)
    });
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, {
      commandHash: "b".repeat(64), workingTreeDigest: verifiedDigest, exitCode: 0,
      evidence: { command: "npm test", workingTreeDigest: verifiedDigest }
    });
    writeVerifyTrajectory(cwd, current);
    fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n");
    const resume = inspectTaskResumeState(cwd, current, current.sessionId, undefined, { protectedPaths: [] });
    assert.equal(resume.enforcementSafe, true);
    assert.equal(resume.decision, "resume");
    assert.equal(resume.phase, "verify");
    assert.match(resume.latestCheckpoint.checkpointId, /^verify-/);
    assert.equal(resume.verifierEvidenceCurrent, false);
    assert.equal(resume.staleVerifierEvidence, true);
    assert.deepEqual(resume.invalidatedVerifierCommands, ["npm test"]);
    assert.deepEqual(resume.invalidatedVerifierFiles, ["src/a.ts"]);
    assert.equal(resume.invalidatedVerifierFilesKnown, true);
    assert.match(resume.reason, /must be refreshed/);
    assert.equal(resume.reconstruction.nextAction.action, "rerun-exact-verifier");
    assert.deepEqual(resume.reconstruction.nextAction.exactCommands, ["npm test"]);
  });

  it("keeps stale legacy verifier files explicitly unknown when no sidecar exists", () => {
    const cwd = workspace();
    const current = task();
    const verifiedDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    current.verifyEvidence = [{
      command: "npm test", exitCode: 0, summary: "legacy pass", recordedAt: "2026-08-08T00:00:03.000Z",
      observed: true, observedAt: "2026-08-08T00:00:03.000Z", matchedProfileCommand: true, workingTreeDigest: verifiedDigest
    }];
    writeVerifyTrajectory(cwd, current);
    fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 3;\n");
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.staleVerifierEvidence, true);
    assert.deepEqual(resume.invalidatedVerifierFiles, []);
    assert.equal(resume.invalidatedVerifierFilesKnown, false);
  });

  it("reconstructs a bounded task, plan, progress, verifier, and next action for a new process", () => {
    const cwd = workspace();
    const current = task();
    current.summary = `Resume a long bounded task ${"goal ".repeat(200)}`;
    current.expectedOutput = `A verified artifact ${"result ".repeat(100)}`;
    current.acceptanceCriteria = Array.from({ length: 12 }, (_entry, index) => `[C${index + 1}] ${"criterion ".repeat(40)}tail-${index + 1}`);
    current.criterionGraph = compileCriterionGraph({
      acceptanceCriteria: current.acceptanceCriteria, scope: current.scope, verifyCommands: current.verifyCommands,
      changeMode: current.changeMode, mode: "criterion-graph", createdAt: current.createdAt
    });
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    const projection = buildTaskResumeContext(current, resume);
    assert.equal(resume.reconstruction.currentStepId, "implement");
    assert.equal(resume.reconstruction.nextAction.action, "continue-plan");
    assert.equal(resume.reconstruction.nextAction.stepId, "implement");
    assert.equal(projection.customType, "piagent-runtime-task-resume");
    assert.ok(projection.content.length <= RESUME_CONTEXT_MAX_CHARS, projection.content.length);
    assert.equal(projection.details.losslessOverflow, false);
    assert.match(projection.content, /Piagent durable task resume/);
    assert.match(projection.content, /Task: resume-101 \(resume-101-run-1\)/);
    assert.match(projection.content, /plan: done/);
    assert.match(projection.content, /implement: in-progress/);
    assert.match(projection.content, /Execution map \(planning only\):/);
    assert.match(projection.content, /criterion-01 behavior/);
    assert.match(projection.content, /Exact verifier commands:\n1\. npm test/);
    assert.match(projection.content, /Next safe action: continue-plan \(implement\)/);
    assert.doesNotMatch(projection.content, /session-resume/);
    assert.deepEqual(projection.details.nextAction, resume.reconstruction.nextAction);
  });

  it("restores authoritative clauses omitted from the summary and selected criteria", () => {
    const cwd = workspace();
    const cases = [
      ["concurrent-lease-lifecycle.md", "- [L4] `withLease` throws an error containing `busy` when acquisition fails."],
      ["durable-session-control-plane.md", "- [D5] A newly admitted command increments revision exactly once and returns"]
    ];
    for (const [file, omittedClause] of cases) {
      const operatorRequest = fs.readFileSync(path.resolve(import.meta.dirname, "../benchmarks/capability-v1/prompts", file), "utf8");
      const current = task();
      current.summary = automaticTaskSummary(operatorRequest);
      current.acceptanceCriteria = automaticAcceptanceCriteria(operatorRequest);
      current.operatorRequest = operatorRequest;
      current.operatorRequestDigest = operatorRequestDigest(operatorRequest);
      current.criterionGraph = compileCriterionGraph({
        acceptanceCriteria: current.acceptanceCriteria, scope: current.scope, verifyCommands: current.verifyCommands,
        changeMode: current.changeMode, mode: "criterion-graph", createdAt: current.createdAt
      });
      const projection = buildTaskResumeContext(current, inspectTaskResumeState(cwd, current, current.sessionId));
      const escaped = omittedClause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.doesNotMatch([current.summary, ...current.acceptanceCriteria].join("\n"), new RegExp(escaped));
      assert.ok(projection.content.length <= RESUME_CONTEXT_MAX_CHARS, `${file}: ${projection.content.length}`);
      assert.match(projection.content, /Authoritative operator request \(redacted, lossless\): operator-request-v1:/);
      assert.match(projection.content, new RegExp(escaped));
    }
  });

  it("retains maximum astral Unicode operator truth and exact verifiers within the resume cap", () => {
    const cwd = workspace();
    const criticalMiddle = "RESUME_MIDDLE_CLAUSE remains mandatory after process restart.";
    const criticalTail = "RESUME_FINAL_CLAUSE remains mandatory at handoff.";
    const operatorRequest = `${"🧠".repeat(3_900)}${criticalMiddle}${"🧩".repeat(4_100 - Array.from(criticalMiddle + criticalTail).length)}${criticalTail}`;
    const prefixOne = "node -e '0' # ", prefixTwo = "npm test -- # ";
    const verifier = (prefix, glyph) => {
      const remaining = 900 - Buffer.byteLength(prefix, "utf8"), glyphBytes = Buffer.byteLength(glyph, "utf8");
      const repeated = glyph.repeat(Math.floor(remaining / glyphBytes));
      return `${prefix}${repeated}${"x".repeat(remaining - Buffer.byteLength(repeated, "utf8"))}`;
    };
    const verifierOne = verifier(prefixOne, "🧪");
    const verifierTwo = verifier(prefixTwo, "🚀");
    const current = task();
    current.summary = "Resume the maximum Unicode task without weakening its operator contract.";
    current.operatorRequest = operatorRequest;
    current.operatorRequestDigest = operatorRequestDigest(operatorRequest);
    current.acceptanceCriteria = [criticalMiddle, criticalTail];
    current.verifyCommands = [verifierOne, verifierTwo];
    current.criterionGraph = compileCriterionGraph({
      acceptanceCriteria: current.acceptanceCriteria, scope: current.scope, verifyCommands: current.verifyCommands,
      changeMode: current.changeMode, mode: "criterion-graph", createdAt: current.createdAt
    });
    const projection = buildTaskResumeContext(current, inspectTaskResumeState(cwd, current, current.sessionId));
    assert.equal(Array.from(operatorRequest).length, 8_000);
    assert.ok(projection.content.length > RESUME_CONTEXT_MAX_CHARS, projection.content.length);
    assert.ok(projection.content.length <= RESUME_CONTEXT_LOSSLESS_MAX_CHARS, projection.content.length);
    assert.equal(projection.content.includes(RESUME_CONTEXT_LOSSLESS_OVERFLOW_MARKER), true);
    assert.equal(projection.details.losslessOverflow, true);
    assert.equal(projection.content.includes(operatorRequest), true, "resume must retain the complete validated operator request");
    assert.equal(projection.content.includes(verifierOne), true, "resume must retain exact verifier one literally");
    assert.equal(projection.content.includes(verifierTwo), true, "resume must retain exact verifier two literally");
    assert.match(projection.content, /RESUME_MIDDLE_CLAUSE/);
    assert.match(projection.content, /RESUME_FINAL_CLAUSE/);
  });

  it("uses an explicit lossless overflow for bounded model-authored task truth", () => {
    const cwd = workspace();
    const current = task();
    current.operatorRequest = undefined;
    current.operatorRequestDigest = undefined;
    current.summary = `${"🧠".repeat(2_000 - "MANUAL_SUMMARY_TAIL".length)}MANUAL_SUMMARY_TAIL`;
    current.expectedOutput = `${"🧩".repeat(2_000 - "MANUAL_OUTPUT_TAIL".length)}MANUAL_OUTPUT_TAIL`;
    current.acceptanceCriteria = Array.from({ length: 12 }, (_item, index) => (
      `${"🚀".repeat(1_000 - `MANUAL_CRITERION_TAIL_${index + 1}`.length)}MANUAL_CRITERION_TAIL_${index + 1}`
    ));
    current.criterionGraph = compileCriterionGraph({
      acceptanceCriteria: current.acceptanceCriteria, scope: current.scope, verifyCommands: current.verifyCommands,
      changeMode: current.changeMode, mode: "criterion-graph", createdAt: current.createdAt
    });
    const projection = buildTaskResumeContext(current, inspectTaskResumeState(cwd, current, current.sessionId));
    assert.equal(Array.from(current.summary).length, 2_000);
    assert.equal(Array.from(current.expectedOutput).length, 2_000);
    assert.equal(current.acceptanceCriteria.every((criterion) => Array.from(criterion).length === 1_000), true);
    assert.ok(projection.content.length > RESUME_CONTEXT_MAX_CHARS, projection.content.length);
    assert.ok(projection.content.length <= RESUME_CONTEXT_LOSSLESS_MAX_CHARS, projection.content.length);
    assert.equal(projection.content.includes(RESUME_CONTEXT_LOSSLESS_OVERFLOW_MARKER), true);
    assert.match(projection.content, /MANUAL_SUMMARY_TAIL/);
    assert.match(projection.content, /MANUAL_OUTPUT_TAIL/);
    for (let index = 1; index <= 12; index += 1) assert.match(projection.content, new RegExp(`MANUAL_CRITERION_TAIL_${index}`));
  });

  it("resumes legacy truth at the exact lossless ceiling and blocks one character above it", () => {
    const cwd = workspace();
    const atBoundary = task();
    delete atBoundary.operatorRequest;
    delete atBoundary.operatorRequestDigest;
    const padding = RESUME_CONTEXT_LOSSLESS_MAX_CHARS - legacyTaskResumeTruthChars(atBoundary);
    assert.ok(padding > 0);
    atBoundary.summary += `${"b".repeat(padding - "LEGACY_BOUNDARY_TAIL".length)}LEGACY_BOUNDARY_TAIL`;
    assert.equal(legacyTaskResumeTruthChars(atBoundary), RESUME_CONTEXT_LOSSLESS_MAX_CHARS);
    const boundaryResume = inspectTaskResumeState(cwd, atBoundary, atBoundary.sessionId);
    const boundaryProjection = buildTaskResumeContext(atBoundary, boundaryResume);
    assert.equal(boundaryResume.enforcementSafe, true);
    assert.equal(boundaryResume.decision, "resume");
    assert.equal(boundaryProjection.content.length, RESUME_CONTEXT_LOSSLESS_MAX_CHARS);
    assert.match(boundaryProjection.content, /LEGACY_BOUNDARY_TAIL/);
    assert.equal(boundaryProjection.details.legacyTaskTruthOverflow, undefined);

    const aboveBoundary = structuredClone(atBoundary);
    aboveBoundary.summary += "x";
    assert.equal(legacyTaskResumeTruthChars(aboveBoundary), RESUME_CONTEXT_LOSSLESS_MAX_CHARS + 1);
    const blockedResume = inspectTaskResumeState(cwd, aboveBoundary, aboveBoundary.sessionId);
    const blockedProjection = buildTaskResumeContext(aboveBoundary, blockedResume);
    assert.equal(blockedResume.enforcementSafe, false);
    assert.equal(blockedResume.decision, "blocked");
    assert.equal(blockedResume.reconstruction.nextAction.action, "inspect-handoff");
    assert.match(blockedResume.reason, /legacy-task-truth-overflow/);
    assert.equal(blockedProjection.content.includes(LEGACY_TASK_TRUTH_OVERFLOW_MARKER), true);
    assert.ok(blockedProjection.content.length < 1_000, blockedProjection.content.length);
    assert.equal(blockedProjection.details.legacyTaskTruthOverflow, true);
    assert.doesNotMatch(blockedProjection.content, /LEGACY_BOUNDARY_TAIL/);
  });

  it("keeps a 100k legacy task private and blocks automatic resume without token-heavy injection", () => {
    const cwd = workspace();
    const current = task();
    delete current.operatorRequest;
    delete current.operatorRequestDigest;
    current.summary = `LEGACY_100K_PRIVATE_SENTINEL ${"x".repeat(100_000)}`;
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    const projection = buildTaskResumeContext(current, resume);
    assert.equal(resume.decision, "blocked");
    assert.equal(resume.enforcementSafe, false);
    assert.ok(projection.content.length < 1_000, projection.content.length);
    assert.match(projection.content, /legacy-task-truth-overflow/);
    assert.match(projection.content, /re-intake the original request|compact handoff/);
    assert.doesNotMatch(projection.content, /LEGACY_100K_PRIVATE_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(projection.details), /LEGACY_100K_PRIVATE_SENTINEL/);
    assert.doesNotMatch(projection.content, /\.pi\/piagent-state/);
  });

  it("hides the legacy runtime-scope criterion from resume presentation without rewriting durable task state", () => {
    const cwd = workspace();
    const current = task();
    const legacyCriterion = "Changes stay within the runtime-derived task scope.";
    current.scope = ["v-nexus-frontend/src/**", "v-nexus-frontend/e2e/**"];
    current.acceptanceCriteria = [
      legacyCriterion,
      "Frontend implementation matches the approved backend contract.",
      "Run the configured verification commands."
    ];
    current.criterionGraph = compileCriterionGraph({
      acceptanceCriteria: current.acceptanceCriteria,
      scope: current.scope,
      verifyCommands: current.verifyCommands,
      changeMode: current.changeMode,
      mode: "criterion-graph",
      createdAt: current.createdAt
    });
    const durableCriteria = structuredClone(current.acceptanceCriteria);
    const durableGraph = structuredClone(current.criterionGraph);
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    const projection = buildTaskResumeContext(current, resume);

    assert.doesNotMatch(projection.content, /Changes stay within the runtime-derived task scope/);
    assert.doesNotMatch(projection.content, /criterion-01/);
    assert.match(projection.content, /criterion-02 behavior/);
    assert.match(projection.content, /criterion-03 verification .*after=criterion-02/);
    assert.match(projection.content, /Initial focus \(advisory\):/);
    assert.match(projection.content, /neither authorizes nor forbids mutation/);
    assert.doesNotMatch(projection.content, /\nScope:/);
    assert.deepEqual(current.acceptanceCriteria, durableCriteria);
    assert.deepEqual(current.criterionGraph, durableGraph);
  });

  it("reruns the exact verifier before an open plan step when verify has no current stable pass", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    writeVerifyTrajectory(cwd, current);
    const currentDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, {
      commandHash: "c".repeat(64), workingTreeDigest: currentDigest, exitCode: 1,
      evidence: { command: "npm test", workingTreeDigest: currentDigest }
    });
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.enforcementSafe, true);
    assert.equal(resume.decision, "resume");
    assert.equal(resume.phase, "verify");
    assert.equal(resume.verifierEvidenceCurrent, false);
    assert.equal(resume.staleVerifierEvidence, false);
    assert.equal(resume.reconstruction.currentStepId, "implement");
    assert.equal(resume.reconstruction.nextAction.action, "rerun-exact-verifier");
    assert.equal(resume.reconstruction.nextAction.stepId, "implement");
    assert.deepEqual(resume.reconstruction.nextAction.exactCommands, ["npm test"]);
  });

  it("does not retry a verifier after durable recovery records a terminal handoff", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    const currentDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    current.verifyEvidence = [{
      command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-08T00:00:05.000Z",
      observed: true, observedAt: "2026-08-08T00:00:05.000Z", matchedProfileCommand: true,
      preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest,
      preWorkspaceRevisionDigest: currentWorkspaceRevisionDigest(cwd), workspaceRevisionDigest: currentWorkspaceRevisionDigest(cwd)
    }];
    writeVerifyTrajectory(cwd, current);
    recordCompletionAudit({ cwd, ui: { notify() {} } }, current, {
      outcome: "blocked",
      evidence: {
        recovery: terminalHandoffRecovery(current)
      }
    });

    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.enforcementSafe, true);
    assert.equal(resume.verifierEvidenceCurrent, true);
    assert.equal(resume.staleVerifierEvidence, false);
    assert.equal(resume.decision, "blocked");
    assert.equal(resume.reconstruction.nextAction.action, "inspect-handoff");
    assert.deepEqual(resume.reconstruction.nextAction.exactCommands, []);
    assert.match(resume.reason, /terminal recovery handoff/);
  });

  it("preserves a terminal handoff across a later generic completion audit", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan[1].status = "in-progress";
    recordCompletionAudit({ cwd, ui: { notify() {} } }, current, {
      outcome: "blocked", evidence: { recovery: terminalHandoffRecovery(current) }
    });
    recordCompletionAudit({ cwd, ui: { notify() {} } }, current, {
      outcome: "failed", evidence: { missing: ["generic-later-audit"] }
    });

    const replay = replayTaskCheckpoints(cwd, current.taskRunId, current);
    assert.equal(replay.corruptions.length, 0);
    assert.equal(replay.checkpoints.length, 1);
    assert.equal(replay.checkpoints[0].evidence.recovery.policyVersion, "recovery-v1");
    const decision = taskRecoveryDecision(current, replay);
    assert.equal(decision.decision, "blocked");
    assert.equal(decision.retryAllowed, false);
    assert.match(decision.reason, /terminal recovery handoff/);
  });

  it("does not make incomplete or incoherent recovery evidence terminal or monotonic", () => {
    const invalidRecoveries = [
      (value) => { delete value.policyVersion; },
      (value) => { value.policyVersion = "recovery-v0"; },
      (value) => { delete value.evidenceDigest; },
      (value) => { value.reasonCodes = ["not-a-recovery-reason"]; },
      (value) => { value.failureCategory = "environment"; },
      (value) => { value.failureCategory = "environment"; value.reasonCodes = ["operator-environment-action"]; },
      (value) => { value.currentPhase = "verify"; value.reasonCodes = ["handoff-already-observed"]; },
      (value) => { value.counts = { ...value.counts, sourceRepairPasses: 0 }; },
      (value) => { value.ceilings = { ...value.ceilings, sourceRepairPasses: 0 }; }
    ];
    for (const invalidate of invalidRecoveries) {
      const cwd = workspace();
      const current = task();
      current.workPlan.forEach((step) => { step.status = "done"; });
      const recovery = terminalHandoffRecovery(current);
      invalidate(recovery);
      recordCompletionAudit({ cwd, ui: { notify() {} } }, current, { outcome: "blocked", evidence: { recovery } });
      recordCompletionAudit({ cwd, ui: { notify() {} } }, current, { outcome: "failed", evidence: { missing: ["generic-later-audit"] } });

      const replay = replayTaskCheckpoints(cwd, current.taskRunId, current);
      assert.equal(replay.corruptions.length, 0);
      const decision = taskRecoveryDecision(current, replay);
      assert.equal(decision.decision, "retry");
      assert.equal(decision.retryAllowed, true);
    }
  });

  it("skips a checkpoint whose journal identity does not match the Task Contract", () => {
    const cwd = workspace();
    const current = task();
    recordTaskCheckpoint(cwd, {
      taskRunId: current.taskRunId, taskId: "foreign-task", sessionId: "foreign-session",
      checkpointId: "completion", phase: "review", status: "blocked", attempt: current.attempt,
      evidence: { recovery: terminalHandoffRecovery(current) }
    });

    const replay = replayTaskCheckpoints(cwd, current.taskRunId, current);
    assert.match(replay.corruptions.join("; "), /identity does not match the Task Contract/);
    assert.deepEqual(replay.checkpoints, []);
    const decision = taskRecoveryDecision(current, replay);
    assert.equal(decision.decision, "blocked");
    assert.match(decision.reason, /journal corruption/);
    const wrongRunReplay = replayTaskCheckpoints(cwd, "foreign-run", current);
    assert.match(wrongRunReplay.corruptions.join("; "), /taskRunId does not match the Task Contract/);
    assert.deepEqual(wrongRunReplay.checkpoints, []);
  });

  it("skips a checkpoint from a different task attempt", () => {
    const cwd = workspace();
    const current = task();
    recordTaskCheckpoint(cwd, {
      taskRunId: current.taskRunId, taskId: current.taskId, sessionId: current.sessionId,
      checkpointId: "completion", phase: "review", status: "blocked", attempt: current.attempt + 1,
      evidence: { recovery: terminalHandoffRecovery(current) }
    });

    const replay = replayTaskCheckpoints(cwd, current.taskRunId, current);
    assert.match(replay.corruptions.join("; "), /identity does not match the Task Contract/);
    assert.deepEqual(replay.checkpoints, []);
  });

  it("still retries an identity-bound generic failed checkpoint", () => {
    const cwd = workspace();
    const current = task();
    current.workPlan.forEach((step) => { step.status = "done"; });
    recordTaskCheckpoint(cwd, {
      taskRunId: current.taskRunId, taskId: current.taskId, sessionId: current.sessionId,
      checkpointId: "verify", phase: "verify", status: "failed", attempt: current.attempt
    });

    const replay = replayTaskCheckpoints(cwd, current.taskRunId, current);
    assert.equal(replay.corruptions.length, 0);
    const decision = taskRecoveryDecision(current, replay);
    assert.equal(decision.decision, "retry");
    assert.equal(decision.retryAllowed, true);
  });

  it("refuses a task/session identity conflict", () => {
    const cwd = workspace();
    const resume = inspectTaskResumeState(cwd, task(), "another-session");
    assert.equal(resume.decision, "blocked");
    assert.equal(resume.enforcementSafe, false);
    assert.match(resume.reason, /belongs to session/);
    assert.equal(resume.reconstruction.nextAction.action, "inspect-handoff");
  });

  it("binds every security-relevant handoff identity field to the authoritative task contract", () => {
    const mutations = [
      ["sessionHash", () => "f".repeat(64)],
      ["attempt", (current) => current.attempt + 1],
      ["maxAttempts", (current) => current.maxAttempts + 1]
    ];
    for (const [field, mutate] of mutations) {
      const cwd = workspace();
      const current = task();
      writeVerifyTrajectory(cwd, current);
      const currentDigests = workingTreeSnapshot(cwd);
      const projection = buildHandoffProjection(cwd, current, {
        gate: { decision: "fail", missing: ["completion pending"], missingVerifyCommands: current.verifyCommands },
        currentDigests
      });
      writeHandoffProjection(cwd, projection);
      const valid = inspectTaskResumeState(cwd, current, current.sessionId, currentDigests);
      assert.equal(valid.enforcementSafe, true, `${field}: canonical handoff remains valid`);

      projection.identity[field] = mutate(current);
      writeHandoffProjection(cwd, projection);
      const forged = inspectTaskResumeState(cwd, current, current.sessionId, currentDigests);
      assert.equal(forged.enforcementSafe, false, `${field}: forged identity must fail closed`);
      assert.equal(forged.decision, "blocked", `${field}: forged identity must block resume`);
      assert.match(forged.warnings.join("; "), /handoff identity conflicts with the task contract/);
      assert.equal(forged.reconstruction.nextAction.action, "inspect-handoff");
    }
  });

  it("keeps a pending handoff valid when the operator renames the same session", () => {
    const cwd = workspace();
    const current = task();
    writeVerifyTrajectory(cwd, current);
    const currentDigests = workingTreeSnapshot(cwd);
    const projection = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["completion pending"], missingVerifyCommands: current.verifyCommands },
      currentDigests
    });
    writeHandoffProjection(cwd, projection);

    const renamed = { ...current, sessionName: `${current.sessionName}-RENAMED` };
    const resume = inspectTaskResumeState(cwd, renamed, renamed.sessionId, currentDigests);
    assert.equal(resume.enforcementSafe, true);
    assert.equal(resume.handoff.exists, true);
    assert.equal(resume.handoff.valid, true);
    assert.doesNotMatch(resume.warnings.join("; "), /handoff identity conflicts/);
  });

  it("quarantines a legacy v1 sidecar without blocking its authoritative active task", () => {
    const cwd = workspace();
    const current = task();
    writeVerifyTrajectory(cwd, current);
    const currentDigests = workingTreeSnapshot(cwd);
    const legacy = buildHandoffProjection(cwd, current, {
      gate: { decision: "fail", missing: ["completion pending"], missingVerifyCommands: current.verifyCommands },
      currentDigests
    });
    writeHandoffProjection(cwd, legacy);
    legacy.projectionVersion = "handoff-v1";
    delete legacy.acceptance;
    legacy.state.completionApproved = true;
    fs.writeFileSync(handoffProjectionPath(cwd, current.taskRunId), `${JSON.stringify(legacy)}\n`);

    const active = inspectTaskResumeState(cwd, current, current.sessionId, currentDigests);
    assert.equal(active.enforcementSafe, true);
    assert.equal(active.decision, "resume");
    assert.deepEqual(active.handoff, { path: `.pi/piagent-state/handoffs/${current.taskRunId}.json`, exists: false, valid: true });

    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:06.000Z" };
    const terminal = inspectTaskResumeState(cwd, current, current.sessionId, currentDigests);
    assert.equal(terminal.decision, "terminal", "only the Task Contract, never legacy completionApproved, settles the task");
    assert.equal(terminal.handoff.exists, false);
  });

  it("blocks an active task whose authority snapshot is missing instead of resuming legacy advanced state", () => {
    const cwd = workspace();
    const current = task();
    delete current.authoritySnapshot;
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.decision, "blocked");
    assert.equal(resume.enforcementSafe, false);
    assert.equal(resume.authorityPolicy.disposition, "new-attempt-required");
    assert.equal(resume.authorityPolicy.reason, "missing-task-snapshot");
    assert.match(resume.reason, /new-attempt-required: missing-task-snapshot/);
  });

  it("journals each verifier execution transition while deduplicating the same observed event", () => {
    const cwd = workspace();
    const current = task();
    const digest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    const checkpoint = (exitCode, observedAt, preWorkingTreeDigest = digest) => recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, {
      commandHash: "b".repeat(64), workingTreeDigest: digest, exitCode, observedAt,
      evidence: { command: "npm test", preWorkingTreeDigest, workingTreeDigest: digest }
    });
    checkpoint(0, "2026-08-08T00:00:03.000Z");
    checkpoint(1, "2026-08-08T00:00:04.000Z");
    checkpoint(0, "2026-08-08T00:00:05.000Z");
    checkpoint(0, "2026-08-08T00:00:05.000Z");
    checkpoint(0, "2026-08-08T00:00:05.000Z", "wt-content-v2:" + "f".repeat(64));
    checkpoint(0, "2026-08-08T00:00:05.000Z", "wt-content-v2:" + "f".repeat(64));
    const replay = replayTaskCheckpoints(cwd, current.taskRunId, current);
    const latest = replay.checkpoints.find((entry) => entry.phase === "verify");
    assert.equal(latest?.status, "done");
    assert.equal(latest?.sequence, 5, "pre-tree changes create a distinct event while the exact duplicate after it remains idempotent");
    assert.equal(readTaskJournal(cwd, { taskRunId: current.taskRunId }).events.filter((entry) => entry.eventType === "checkpoint").length, 6);
  });

  it("surfaces a corrupt journal tail with a handoff recovery path", () => {
    const cwd = workspace();
    const current = task();
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, { commandHash: "c".repeat(64), workingTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)), exitCode: 1 });
    fs.appendFileSync(taskJournalPaths(cwd).events, "{truncated\n");
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.decision, "blocked");
    assert.equal(resume.enforcementSafe, false);
    assert.ok(resume.journal.corruptions.length > 0);
    assert.match(resume.handoff.path, /^\.pi\/piagent-state\/handoffs\//);
    assert.equal(resume.reconstruction.nextAction.action, "inspect-handoff");
  });

  it("keeps terminal outcomes terminal and never recommends a retry", () => {
    const cwd = workspace();
    const current = task();
    current.trace = { outcome: "completed", recordedAt: "2026-08-08T00:00:04.000Z" };
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.decision, "terminal");
    assert.match(resume.reason, /immutable after completed/);
    assert.equal(resume.reconstruction.nextAction.action, "terminal");
  });
});
