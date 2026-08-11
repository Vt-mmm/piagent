import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { classifyCompletionGateFailure, classifyVerificationFailure } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { recordVerificationCheckpoint } from "../packages/piagent-core/extensions/task-runtime-audit.js";
import { appendTaskJournalEvent, readTaskJournal, taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { workingTreeSnapshot, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/task-lifecycle.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { buildHandoffProjection, writeHandoffProjection } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { inspectTaskResumeState } from "../packages/piagent-core/runtime/recovery/resume-state.ts";
import { selectRecoveryDecision } from "../packages/piagent-core/runtime/recovery/recovery-policy.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { writeTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-recovery-chaos-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "chaos.ts"), "export const chaos = 1;\n");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

function task(suffix = "1") {
  const current = {
    ...structuredClone(fixture),
    taskId: "chaos-101",
    taskRunId: `chaos-101-run-${suffix}`,
    sessionId: "session-chaos",
    sessionName: "CHAOS-101",
    scope: ["src/chaos.ts"],
    verifyCommands: ["npm test"],
    observedChangedFiles: ["src/chaos.ts"],
    changedFiles: ["src/chaos.ts"]
  };
  current.authoritySnapshot = createBoundTaskAuthority({
    taskId: current.taskId, taskRunId: current.taskRunId, createdAt: current.createdAt
  });
  return current;
}

function trajectoryAt(cwd, current, phase) {
  let state = createTrajectoryState({
    taskId: current.taskId, taskRunId: current.taskRunId, sessionId: current.sessionId,
    changeMode: current.changeMode, riskLane: current.riskLane, createdAt: current.createdAt
  });
  const edges = [
    ["plan", "plan-observed", "task-state"],
    ["execute", "mutation-observed", "task-state"],
    ["verify", "verification-started", "tool-call"]
  ];
  for (const [to, cause, sourceHook] of edges) {
    if (state.currentPhase === phase) break;
    state = reduceTrajectory(state, createTrajectoryTransition(state, {
      to, cause, sourceHook, observedAt: `2026-08-08T00:00:0${state.sequence + 2}.000Z`
    }));
  }
  writeTrajectoryState(cwd, state);
}

function recoveryInput(classification, overrides = {}) {
  return {
    featureEnabled: true,
    task: { taskId: "chaos-101", taskRunId: "chaos-101-run-1", attempt: 1, maxAttempts: 3, changeMode: "source-change" },
    classification,
    currentPhase: "verify",
    exactVerifierAvailable: true,
    currentTreeMatchesEvidence: true,
    history: [],
    ...overrides
  };
}

describe("recovery chaos and interruption safety", () => {
  it("restores exact execute state after process exit between execute and verify", () => {
    const cwd = workspace();
    const current = task();
    trajectoryAt(cwd, current, "execute");
    const expectedDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    const resumed = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resumed.decision, "resume");
    assert.equal(resumed.enforcementSafe, true);
    assert.equal(resumed.phase, "execute");
    assert.equal(resumed.currentTreeDigest, expectedDigest);
    assert.equal(resumed.taskRunId, current.taskRunId);
  });

  it("reconstructs the same task and next action in a fresh Node process", () => {
    const cwd = workspace();
    const current = task("fresh-process");
    current.workPlan[0].status = "done";
    current.workPlan[1].status = "in-progress";
    writeTaskContract(cwd, current);
    trajectoryAt(cwd, current, "execute");
    const resumeModule = pathToFileURL(path.resolve(import.meta.dirname, "../packages/piagent-core/runtime/recovery/resume-state.ts")).href;
    const script = [
      "import fs from 'node:fs';",
      `import { inspectTaskResumeState } from ${JSON.stringify(resumeModule)};`,
      "const cwd=process.env.PIAGENT_TEST_CWD;",
      "const task=JSON.parse(fs.readFileSync(process.env.PIAGENT_TEST_TASK,'utf8'));",
      "const resume=inspectTaskResumeState(cwd,task,task.sessionId);",
      "process.stdout.write(JSON.stringify({taskId:resume.taskId,taskRunId:resume.taskRunId,phase:resume.phase,decision:resume.decision,safe:resume.enforcementSafe,currentStepId:resume.reconstruction.currentStepId,nextAction:resume.reconstruction.nextAction.action,tree:resume.currentTreeDigest}));"
    ].join("\n");
    const taskPath = path.join(cwd, ".pi", "piagent-state", "tasks", `${current.taskRunId}.json`);
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, PIAGENT_TEST_CWD: cwd, PIAGENT_TEST_TASK: taskPath }
    });
    const reconstructed = JSON.parse(output);
    assert.deepEqual(reconstructed, {
      taskId: current.taskId,
      taskRunId: current.taskRunId,
      phase: "execute",
      decision: "resume",
      safe: true,
      currentStepId: "implement",
      nextAction: "continue-plan",
      tree: workingTreeEvidenceDigest(workingTreeSnapshot(cwd))
    });
  });

  it("reconstructs verify checkpoint identity after session compaction", () => {
    const cwd = workspace();
    const current = task("compacted");
    trajectoryAt(cwd, current, "verify");
    const digest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, {
      commandHash: "a".repeat(64), workingTreeDigest: digest, exitCode: 1,
      evidence: { command: "npm test", workingTreeDigest: digest }
    });
    const first = inspectTaskResumeState(cwd, current, current.sessionId);
    const reconstructed = inspectTaskResumeState(cwd, structuredClone(current), current.sessionId);
    assert.deepEqual(reconstructed.latestCheckpoint, first.latestCheckpoint);
    assert.equal(reconstructed.phase, "verify");
    assert.equal(reconstructed.currentTreeDigest, digest);
    assert.equal(reconstructed.taskId, current.taskId);
  });

  it("discards a process-torn final journal line before the next durable append", () => {
    const cwd = workspace();
    const current = task("torn-tail");
    const event = (id) => ({
      eventType: "checkpoint", taskId: current.taskId, taskRunId: current.taskRunId,
      sessionId: current.sessionId, checkpointId: id, idempotencyKey: id,
      data: { phase: id, status: "in-progress", attempt: 1 }
    });
    appendTaskJournalEvent(cwd, event("first"));
    fs.appendFileSync(taskJournalPaths(cwd).events, '{"process":"killed"');
    const interrupted = readTaskJournal(cwd);
    assert.equal(interrupted.corruptions.length, 0);
    assert.ok(interrupted.recoverableTailBytes > 0);
    assert.equal(interrupted.events.length, 1);
    appendTaskJournalEvent(cwd, event("second"));
    const recovered = readTaskJournal(cwd);
    assert.equal(recovered.recoverableTailBytes, 0);
    assert.equal(recovered.corruptions.length, 0);
    assert.deepEqual(recovered.events.map((entry) => entry.checkpointId), ["first", "second"]);
  });

  it("rolls back an in-process partial journal append after disk failure", () => {
    const cwd = workspace();
    const current = task("disk-failure");
    appendTaskJournalEvent(cwd, {
      eventType: "checkpoint", taskId: current.taskId, taskRunId: current.taskRunId,
      sessionId: current.sessionId, checkpointId: "stable", idempotencyKey: "stable",
      data: { phase: "execute", status: "in-progress", attempt: 1 }
    });
    const original = fs.appendFileSync;
    fs.appendFileSync = function partialThenFail(file, data, options) {
      if (String(file).endsWith(path.join("task-journal", "events.jsonl"))) {
        original.call(this, file, String(data).slice(0, 19), options);
        const error = new Error("synthetic disk full");
        error.code = "ENOSPC";
        throw error;
      }
      return original.call(this, file, data, options);
    };
    try {
      assert.throws(() => appendTaskJournalEvent(cwd, {
        eventType: "checkpoint", taskId: current.taskId, taskRunId: current.taskRunId,
        sessionId: current.sessionId, checkpointId: "partial", idempotencyKey: "partial",
        data: { phase: "verify", status: "failed", attempt: 1 }
      }), /disk full/);
    } finally {
      fs.appendFileSync = original;
    }
    const journal = readTaskJournal(cwd);
    assert.equal(journal.corruptions.length, 0);
    assert.equal(journal.recoverableTailBytes, 0);
    assert.deepEqual(journal.events.map((entry) => entry.checkpointId), ["stable"]);
  });

  it("keeps verifier timeout and provider disconnect recovery non-mutating", () => {
    const timeout = classifyVerificationFailure("ETIMEDOUT while contacting local test worker", 1);
    const provider = classifyVerificationFailure("provider websocket disconnected before response", 1);
    assert.equal(timeout.category, "flaky-infrastructure");
    assert.equal(provider.category, "provider-network");
    for (const classification of [timeout, provider]) {
      const decision = selectRecoveryDecision(recoveryInput(classification));
      assert.equal(decision.action, "retry");
      assert.equal(decision.sourceMutationAllowed, false);
    }
  });

  it("hands off an immutable completion scope mismatch without a diagnostic or repair pass", () => {
    const classification = classifyCompletionGateFailure([
      "critical acceptance evidence (ac-01-boundary-case:boundary-case)",
      "changes within task scope (apps/web/src/search-view.js, packages/shared/src/search-contract.js)"
    ], "Runtime observed configured verifier exit 0 (passed).", 0);
    const decision = selectRecoveryDecision(recoveryInput(classification, {
      currentTreeMatchesEvidence: false,
      history: []
    }));
    assert.equal(classification.category, "scope-protected-path");
    assert.equal(decision.action, "handoff");
    assert.equal(decision.continuation, "none");
    assert.equal(decision.nextPhase, null);
    assert.equal(decision.sourceMutationAllowed, false);
    assert.deepEqual(decision.reasonCodes, ["scope-replan-required"]);
  });

  it("rejects a late tool result after terminal task persistence", () => {
    const cwd = workspace();
    const pending = task("late-result");
    writeTaskContract(cwd, pending);
    const terminal = writeTaskContract(cwd, {
      ...pending,
      trace: { outcome: "completed", recordedAt: "2026-08-08T00:00:10.000Z" }
    });
    const late = {
      ...terminal,
      verifyEvidence: [...terminal.verifyEvidence, {
        command: "npm test", exitCode: 0, summary: "late result", recordedAt: "2026-08-08T00:00:11.000Z",
        observed: true, matchedProfileCommand: true, workingTreeDigest: versionWorkingTreeHash("b".repeat(64))
      }]
    };
    assert.throws(() => writeTaskContract(cwd, late), /immutable after completed/);
  });

  it("invalidates stale verifier evidence after an external post-verify tree edit", () => {
    const cwd = workspace();
    const current = task("external-edit");
    trajectoryAt(cwd, current, "verify");
    const verifiedDigest = workingTreeEvidenceDigest(workingTreeSnapshot(cwd));
    current.verifyEvidence = [{
      command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-08T00:00:05.000Z",
      observed: true, matchedProfileCommand: true, workingTreeDigest: verifiedDigest
    }];
    fs.writeFileSync(path.join(cwd, "src", "chaos.ts"), "export const chaos = 2;\n");
    const resumed = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resumed.staleVerifierEvidence, true);
    assert.equal(resumed.verifierEvidenceCurrent, false);
    assert.deepEqual(resumed.invalidatedVerifierCommands, ["npm test"]);
  });

  it("surfaces a corrupt journal tail and refuses a symlink handoff escape", () => {
    const cwd = workspace();
    const current = task("corrupt-symlink");
    recordVerificationCheckpoint({ cwd, ui: { notify() {} } }, current, {
      commandHash: "c".repeat(64), workingTreeDigest: "d".repeat(64), exitCode: 1
    });
    fs.appendFileSync(taskJournalPaths(cwd).events, "{truncated\n");
    const resumed = inspectTaskResumeState(cwd, current, current.sessionId);
    assert.equal(resumed.decision, "blocked");
    assert.equal(resumed.enforcementSafe, false);
    assert.ok(resumed.journal.corruptions.length > 0);

    const clean = workspace();
    const outside = workspace();
    fs.mkdirSync(path.join(clean, ".pi", "piagent-state"), { recursive: true });
    fs.symlinkSync(outside, path.join(clean, ".pi", "piagent-state", "handoffs"));
    const projection = buildHandoffProjection(clean, current, {
      gate: { decision: "fail", missing: ["verification"], missingVerifyCommands: ["npm test"] },
      currentDigests: {}
    });
    assert.throws(() => writeHandoffProjection(clean, projection), /must not traverse a symbolic link/);
  });

  it("stops verifier and provider retries beyond their immutable ceilings", () => {
    const samples = [
      classifyVerificationFailure("EADDRINUSE: port 3000 is already in use", 1),
      classifyVerificationFailure("provider API request timed out", 1)
    ];
    for (const classification of samples) {
      const input = recoveryInput(classification);
      const history = [{
        taskId: input.task.taskId, taskRunId: input.task.taskRunId, taskAttempt: 1,
        evidenceDigest: classification.evidenceDigest, failureCategory: classification.category,
        action: "retry", disposition: "failed", phase: "verify", hypothesisRef: null
      }];
      const exhausted = selectRecoveryDecision({ ...input, history });
      assert.equal(exhausted.sourceMutationAllowed, false);
      assert.notEqual(exhausted.action, "retry");
      assert.ok(["handoff", "fresh-session"].includes(exhausted.action));
    }
  });
});
