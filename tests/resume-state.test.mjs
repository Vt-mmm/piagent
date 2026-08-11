import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { recordVerificationCheckpoint } from "../packages/piagent-core/extensions/task-runtime-audit.js";
import { readTaskJournal, replayTaskCheckpoints, taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";
import { RESUME_CONTEXT_MAX_CHARS, buildTaskResumeContext, inspectTaskResumeState } from "../packages/piagent-core/runtime/recovery/resume-state.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { writeTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";

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

describe("safe task resume state", () => {
  it("restores phase/checkpoint identity and invalidates verifier evidence after a tree change", () => {
    const cwd = workspace();
    const current = task();
    const verifiedDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    current.verifyEvidence = [{
      command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-08T00:00:03.000Z",
      observed: true, observedAt: "2026-08-08T00:00:03.000Z", matchedProfileCommand: true, workingTreeDigest: verifiedDigest
    }];
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, {
      commandHash: "b".repeat(64), workingTreeDigest: verifiedDigest, exitCode: 0,
      evidence: { command: "npm test", workingTreeDigest: verifiedDigest }
    });
    writeVerifyTrajectory(cwd, current);
    fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 2;\n");
    const resume = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resume.enforcementSafe, true);
    assert.equal(resume.decision, "resume");
    assert.equal(resume.phase, "verify");
    assert.match(resume.latestCheckpoint.checkpointId, /^verify-/);
    assert.equal(resume.verifierEvidenceCurrent, false);
    assert.equal(resume.staleVerifierEvidence, true);
    assert.deepEqual(resume.invalidatedVerifierCommands, ["npm test"]);
    assert.match(resume.reason, /must be refreshed/);
    assert.equal(resume.reconstruction.nextAction.action, "rerun-exact-verifier");
    assert.deepEqual(resume.reconstruction.nextAction.exactCommands, ["npm test"]);
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

  it("refuses a task/session identity conflict", () => {
    const cwd = workspace();
    const resume = inspectTaskResumeState(cwd, task(), "another-session");
    assert.equal(resume.decision, "blocked");
    assert.equal(resume.enforcementSafe, false);
    assert.match(resume.reason, /belongs to session/);
    assert.equal(resume.reconstruction.nextAction.action, "inspect-handoff");
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
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, { commandHash: "c".repeat(64), workingTreeDigest: "d".repeat(64), exitCode: 1 });
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
