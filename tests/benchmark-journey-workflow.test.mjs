import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateWorkflowEvidence } from "../packages/piagent-core/benchmark/benchmark-core.js";
import { acceptedTaskStartTraceEvidence } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { taskWorkingTreeEvidenceDigest } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";

const timestamp = (minute) => `2026-08-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
const contentDigest = (value) => `wt-content-v2:${value.repeat(64)}`;

function treeFields(files) {
  const finalFileDigests = Object.fromEntries(files.map((file, index) => [file, contentDigest(index ? "b" : "a")]));
  return {
    digest: taskWorkingTreeEvidenceDigest(finalFileDigests),
    fields: {
      workingTreeDigestAlgorithm: "wt-content-v2",
      baselineChangedFiles: [],
      baselineFileDigests: {},
      finalWorkingTreeFiles: [...files],
      finalFileDigests
    }
  };
}

function task({ id, minute, changeMode, changedFiles = [], tree, verify = false, criteria = [] }) {
  return {
    schemaVersion: 2,
    taskId: id,
    taskRunId: `${id}-run`,
    sessionId: "journey-session",
    createdAt: timestamp(minute),
    updatedAt: timestamp(minute),
    intakeMode: "runtime",
    changeMode,
    trace: { outcome: "completed" },
    workPlan: [{ id: "work", status: "done" }],
    verifyCommands: verify ? ["npm test"] : [],
    verifyEvidence: verify ? [{
      command: "npm test",
      exitCode: 0,
      observed: true,
      observedAt: timestamp(minute),
      matchedProfileCommand: true,
      preWorkingTreeDigest: tree.digest,
      workingTreeDigest: tree.digest
    }] : [],
    changedFiles,
    acceptanceReceipt: { criteria },
    ...tree.fields
  };
}

function journeyFixture() {
  const empty = treeFields([]);
  const final = treeFields(["src/platform/config.js", "test/config.test.js"]);
  const scout = task({
    id: "scout",
    minute: 1,
    changeMode: "read-only",
    tree: empty,
    criteria: [{ id: "scout-advice", priority: "critical", status: "pending", evidence: [] }]
  });
  const implement = task({
    id: "implement",
    minute: 2,
    changeMode: "source-change",
    changedFiles: ["src/platform/config.js", "test/config.test.js"],
    tree: final,
    verify: true,
    criteria: [{
      id: "falsey-precedence",
      priority: "critical",
      status: "satisfied",
      evidence: [{ kind: "verifier-backed-focused-test", workingTreeDigest: final.digest }]
    }]
  });
  const verify = task({
    id: "verify",
    minute: 3,
    changeMode: "source-change",
    tree: empty,
    verify: true
  });
  // A verification-only turn owns no delta, but its verifier is bound to the
  // implementation task's final tree.
  verify.verifyEvidence[0].preWorkingTreeDigest = final.digest;
  verify.verifyEvidence[0].workingTreeDigest = final.digest;
  return { tasks: [verify, implement, scout], final };
}

function startEvidence(turnIds = ["turn-3", "turn-2", "turn-1"]) {
  const taskRunIds = ["verify-run", "implement-run", "scout-run"];
  return {
    acceptedTaskStartCount: taskRunIds.length,
    starts: taskRunIds.map((taskRunId, index) => ({
      taskRunId,
      turnId: turnIds[index],
      missingTurnId: !turnIds[index],
      conflictingTurnIds: false
    })),
    distinctTurnCount: new Set(turnIds.filter(Boolean)).size,
    missingTurnIdCount: turnIds.filter((item) => !item).length,
    conflictingTaskTurnCount: 0,
    duplicateTurnCount: turnIds.length - new Set(turnIds).size
  };
}

test("journey workflow combines implementation ownership with terminal verification", () => {
  const { tasks } = journeyFixture();
  const workflow = evaluateWorkflowEvidence(tasks, ["test/config.test.js", "src/platform/config.js"], {}, {
    scenarioKind: "source-change",
    taskStartEvidence: startEvidence(),
    expectedTurnCount: 3
  });

  assert.equal(workflow.score, 10);
  for (const id of ["terminal-completion", "completed-work-plan", "current-tree-evidence", "observed-verification", "truthful-changed-files", "criterion-linked-evidence", "turn-bounded-task-start"]) {
    assert.equal(workflow.checks.find((check) => check.id === id)?.passed, true, id);
  }
  assert.deepEqual(workflow.taskEvidence.acceptance, {
    criteria: 1,
    satisfied: 1,
    critical: 1,
    criticalSatisfied: 1
  });
  assert.equal(workflow.choreography.taskCount, 3);
  assert.equal(workflow.choreography.distinctTaskStartTurns, 3);
});

test("journey workflow fails closed for unfinished tasks, incomplete file union, or duplicate turns", () => {
  const { tasks } = journeyFixture();
  tasks[2].trace.outcome = "pending";
  tasks[2].workPlan[0].status = "in-progress";
  let workflow = evaluateWorkflowEvidence(tasks, ["src/platform/config.js", "test/config.test.js"], {}, {
    taskStartEvidence: startEvidence(), expectedTurnCount: 3
  });
  assert.equal(workflow.checks.find((check) => check.id === "terminal-completion").passed, false);
  assert.equal(workflow.checks.find((check) => check.id === "completed-work-plan").passed, false);

  tasks[2].trace.outcome = "completed";
  tasks[2].workPlan[0].status = "done";
  tasks[1].changedFiles = ["src/platform/config.js"];
  workflow = evaluateWorkflowEvidence(tasks, ["src/platform/config.js", "test/config.test.js"], {}, {
    taskStartEvidence: startEvidence(), expectedTurnCount: 3
  });
  assert.equal(workflow.checks.find((check) => check.id === "truthful-changed-files").passed, false);

  tasks[1].changedFiles = ["src/platform/config.js", "test/config.test.js"];
  workflow = evaluateWorkflowEvidence(tasks, ["src/platform/config.js", "test/config.test.js"], {}, {
    taskStartEvidence: startEvidence(["turn-1", "turn-1", "turn-3"]), expectedTurnCount: 3
  });
  assert.equal(workflow.checks.find((check) => check.id === "turn-bounded-task-start").passed, false);
});

test("a read-only follow-up cannot rescue missing source-task final-tree ownership", () => {
  const { tasks, final } = journeyFixture();
  const [verify, implement, scout] = tasks;
  for (const sourceTask of [verify, implement]) {
    sourceTask.workingTreeDigestAlgorithm = "legacy-untrusted";
    sourceTask.finalWorkingTreeFiles = [];
    sourceTask.finalFileDigests = {};
  }
  Object.assign(scout, final.fields);

  const workflow = evaluateWorkflowEvidence(tasks, ["src/platform/config.js", "test/config.test.js"], {}, {
    scenarioKind: "source-change",
    taskStartEvidence: startEvidence(),
    expectedTurnCount: 3
  });

  assert.equal(workflow.checks.find((check) => check.id === "current-tree-evidence").passed, false);
  assert.ok(workflow.score < 10);
});

test("multi-task choreography rejects missing turn IDs and trace evidence reports duplicates", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-start-"));
  const file = path.join(directory, "session.jsonl");
  const entries = [
    ["scout-run", "turn-1"],
    ["scout-run", "turn-1"],
    ["implement-run", "turn-1"],
    ["verify-run", undefined]
  ].map(([taskRunId, turnId]) => ({
    type: "custom",
    customType: "piagent-task-trace",
    data: { event: "task_start", sessionId: "journey-session", taskRunId, ...(turnId ? { turnId } : {}) }
  }));
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  try {
    const evidence = acceptedTaskStartTraceEvidence([file], "journey-session");
    assert.equal(evidence.acceptedTaskStartCount, 3);
    assert.equal(evidence.distinctTurnCount, 1);
    assert.equal(evidence.missingTurnIdCount, 1);
    assert.equal(evidence.duplicateTurnCount, 1);

    const { tasks } = journeyFixture();
    const workflow = evaluateWorkflowEvidence(tasks, ["src/platform/config.js", "test/config.test.js"], {}, {
      taskStartEvidence: evidence,
      expectedTurnCount: 3
    });
    assert.equal(workflow.checks.find((check) => check.id === "turn-bounded-task-start").passed, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("single-task choreography permits a legacy missing turn ID but rejects proven conflicting binding", () => {
  const { tasks } = journeyFixture();
  const implementation = tasks[1];
  const base = {
    acceptedTaskStartCount: 1,
    starts: [{ taskRunId: implementation.taskRunId, turnId: null, missingTurnId: true, conflictingTurnIds: false }],
    distinctTurnCount: 0,
    missingTurnIdCount: 1,
    conflictingTaskTurnCount: 0,
    duplicateTurnCount: 0
  };
  let workflow = evaluateWorkflowEvidence(implementation, ["src/platform/config.js", "test/config.test.js"], {}, {
    taskStartEvidence: base
  });
  assert.equal(workflow.checks.find((check) => check.id === "single-task-start").passed, true);

  workflow = evaluateWorkflowEvidence(implementation, ["src/platform/config.js", "test/config.test.js"], {}, {
    taskStartEvidence: { ...base, conflictingTaskTurnCount: 1 }
  });
  assert.equal(workflow.checks.find((check) => check.id === "single-task-start").passed, false);
});
