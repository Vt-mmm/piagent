import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import {
  authorizeSemanticRepairCall,
  completeSemanticRepairCall,
  decideBoundedRecoveryHandshake,
  decideSemanticRepairHandshake,
  pendingSemanticRepairCall,
  readSemanticRepairState,
  rejectSemanticRepairCall,
  reserveSemanticRepairCall,
  reservedSemanticRepairCallMatches,
  semanticRepairProvenance,
  semanticRepairResumeDecision,
  semanticRepairStateRequired,
  semanticRepairStatePath
} from "../packages/piagent-core/runtime/recovery/semantic-repair-handshake.ts";
import { SemanticRepairRuntime } from "../packages/piagent-core/runtime/recovery/semantic-repair-runtime.ts";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { appendTrajectoryTransition, writeTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";

const roots = new Set();
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-semantic-repair-"));
  roots.add(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  return cwd;
}

function taskContract() {
  const criterion = "`limit` defaults to 20 and must be a positive safe integer or throw `TypeError`.";
  return {
    taskId: "SEMANTIC-REPAIR",
    taskRunId: "semantic-repair-run-1",
    sessionId: "semantic-session",
    summary: "Implement a bounded limit contract.",
    expectedOutput: "Focused tests prove the exact limit contract.",
    acceptanceCriteria: [criterion],
    acceptanceReceipt: buildAcceptanceReceipt({
      summary: "Implement a bounded limit contract.",
      expectedOutput: "Focused tests prove the exact limit contract.",
      acceptanceCriteria: [criterion],
      changeMode: "source-change",
      source: "runtime"
    }).receipt,
    changeMode: "source-change",
    scope: ["src/**", "test/**"]
  };
}

function hash(character) {
  return `wt-content-v2:${character.repeat(64)}`;
}

function grantDecision() {
  return {
    authorized: true,
    conflictCodes: ["nullish-default-conflicts-with-invalid-null:limit"],
    eligibleTargets: ["src/limit.js"],
    eligiblePaths: ["src/limit.js", "test/limit.test.js"],
    pathConflictCodes: { "src/limit.js": ["nullish-default-conflicts-with-invalid-null:limit"] }
  };
}

function openSemanticGrant(cwd, task) {
  const reservation = reserveSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    decision: grantDecision(), targetPaths: ["src/limit.js"]
  });
  assert.equal(reservation.reserved, true);
  assert.equal(authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: reservation.reservationToken
  }).allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "source", success: true,
    currentDigest: hash("b"), changedPaths: ["src/limit.js"]
  }).result, "opened");
}

function authorizeExactVerifier(cwd, task, toolCallId, digest = hash("b")) {
  return authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId, toolName: "bash", currentDigest: digest,
    targetPaths: [], projectMutation: false, exactVerifier: true, shellLike: true
  });
}

function boundedRecoveryEvidence(overrides = {}) {
  return {
    currentDeltaPaths: ["src/limit.js", "test/limit.test.js"],
    observedChangedPaths: ["src/limit.js", "test/limit.test.js"],
    authoredFileDigests: {
      "src/limit.js": "current-source-digest",
      "test/limit.test.js": "current-test-digest"
    },
    targetPaths: ["src/limit.js"],
    verifierCurrent: true,
    ...overrides
  };
}

function boundedRecoveryContext(cwd, task) {
  return { cwd, sessionManager: { getSessionId: () => task.sessionId } };
}

function authorizePreparedRecovery(runtime, cwd, task, event, currentDigest = hash("a"), targetPaths = ["src/limit.js"]) {
  return runtime.authorize({
    cwd,
    task,
    sessionId: task.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    currentDigest,
    targetPaths,
    projectMutation: true,
    exactVerifier: false,
    shellLike: false
  });
}

test("bounded recovery requires a current verifier and exact current authorship provenance for every target", () => {
  const task = taskContract();
  const decide = (overrides = {}) => {
    const evidence = boundedRecoveryEvidence(overrides);
    return decideBoundedRecoveryHandshake({
      task,
      mutationTargets: evidence.targetPaths,
      currentDeltaPaths: evidence.currentDeltaPaths,
      observedChangedPaths: evidence.observedChangedPaths,
      authoredFileDigests: evidence.authoredFileDigests,
      verifierCurrent: evidence.verifierCurrent
    });
  };

  const granted = decide();
  assert.equal(granted.authorized, true);
  assert.deepEqual(granted.eligibleTargets, ["src/limit.js"]);
  assert.deepEqual(granted.eligiblePaths, ["src/limit.js"]);

  for (const [label, overrides] of [
    ["empty target", { targetPaths: [] }],
    ["missing current verifier", { verifierCurrent: false }],
    ["target absent from actual delta", { currentDeltaPaths: [] }],
    ["target absent from observed task changes", { observedChangedPaths: [] }],
    ["target without model-authored provenance", { authoredFileDigests: {} }],
    ["target with empty current authorship digest", { authoredFileDigests: { "src/limit.js": "" } }],
    ["new path despite other provenance", {
      targetPaths: ["src/new.js"],
      observedChangedPaths: ["src/new.js"],
      authoredFileDigests: { "src/new.js": "current-new-digest" }
    }],
    ["mixed valid and new targets", {
      targetPaths: ["src/limit.js", "src/new.js"],
      observedChangedPaths: ["src/limit.js", "src/new.js"],
      authoredFileDigests: {
        "src/limit.js": "current-source-digest",
        "src/new.js": "current-new-digest"
      }
    }]
  ]) {
    const denied = decide(overrides);
    assert.equal(denied.authorized, false, label);
    assert.deepEqual(denied.eligibleTargets, [], `${label} must not leave a partial target grant`);
    assert.deepEqual(denied.eligiblePaths, [], `${label} must fail closed`);
  }
});

test("bounded recovery reservation is one-shot after rejection", () => {
  const cwd = project();
  const task = { ...taskContract(), taskRunId: "bounded-recovery-rejected" };
  const ctx = boundedRecoveryContext(cwd, task);
  const opened = [];
  const runtime = new SemanticRepairRuntime({
    now: () => "2026-08-22T00:00:00.000Z",
    trace() {},
    openRepair(...args) { opened.push(args); return { enforcementSafe: true }; }
  });
  const first = { toolCallId: "bounded-first", toolName: "edit", input: { path: "src/limit.js" } };
  const evidence = boundedRecoveryEvidence();

  assert.equal(runtime.prepareBoundedRecovery({ ctx, task, event: first, currentDigest: hash("a"), ...evidence }), true);
  assert.equal(runtime.reservedCallMatches({
    cwd,
    taskRunId: task.taskRunId,
    sessionId: task.sessionId,
    toolCallId: first.toolCallId,
    toolName: first.toolName,
    currentDigest: hash("a"),
    targetPaths: evidence.targetPaths
  }), true);
  assert.equal(runtime.reject({ cwd, taskRunId: task.taskRunId, toolCallId: first.toolCallId }).status, "cancelled");

  const second = { toolCallId: "bounded-second", toolName: "edit", input: { path: "src/limit.js" } };
  assert.equal(runtime.prepareBoundedRecovery({ ctx, task, event: second, currentDigest: hash("a"), ...evidence }), false);
  assert.equal(opened.length, 0);
});

test("bounded recovery opens repair only after an authorized successful changed mutation", () => {
  for (const scenario of [
    { name: "changed success", success: true, nextDigest: hash("b"), changedPaths: ["src/limit.js"], authoredChangedPaths: ["src/limit.js"], expectedStatus: "active", opens: true },
    { name: "changed success without authorship proof", success: true, nextDigest: hash("b"), changedPaths: ["src/limit.js"], authoredChangedPaths: [], expectedStatus: "locked", opens: false },
    { name: "partial multi-target success", success: true, nextDigest: hash("b"), targetPaths: ["src/limit.js", "test/limit.test.js"], changedPaths: ["src/limit.js"], authoredChangedPaths: ["src/limit.js"], expectedStatus: "locked", opens: false },
    { name: "successful no-op", success: true, nextDigest: hash("a"), changedPaths: [], authoredChangedPaths: [], expectedStatus: "cancelled", opens: false },
    { name: "failed changed mutation", success: false, nextDigest: hash("b"), changedPaths: ["src/limit.js"], authoredChangedPaths: [], expectedStatus: "locked", opens: false }
  ]) {
    const cwd = project();
    const task = { ...taskContract(), taskRunId: `bounded-recovery-${scenario.name.replaceAll(" ", "-")}` };
    const ctx = boundedRecoveryContext(cwd, task);
    const opened = [];
    const openResult = { enforcementSafe: true, state: { currentPhase: "repair" } };
    const runtime = new SemanticRepairRuntime({
      now: () => "2026-08-22T00:00:00.000Z",
      trace() {},
      openRepair(...args) { opened.push(args); return openResult; }
    });
    const event = { toolCallId: `bounded-${scenario.name}`, toolName: "edit", input: { path: "src/limit.js" } };
    const evidence = boundedRecoveryEvidence(scenario.targetPaths ? { targetPaths: scenario.targetPaths } : {});

    assert.equal(runtime.prepareBoundedRecovery({ ctx, task, event, currentDigest: hash("a"), ...evidence }), true, scenario.name);
    assert.equal(opened.length, 0, `${scenario.name} must not open repair at reservation time`);
    const authorization = authorizePreparedRecovery(runtime, cwd, task, event, hash("a"), evidence.targetPaths);
    assert.equal(authorization.handled, true, scenario.name);
    assert.equal(authorization.allowed, true, scenario.name);
    assert.equal(authorization.bypassPhase, true, scenario.name);
    assert.equal(opened.length, 0, `${scenario.name} must not open repair at authorization time`);

    const completion = runtime.complete(ctx, task, event, {
      toolCallId: event.toolCallId,
      success: scenario.success,
      exitCode: scenario.success ? 0 : 1,
      currentWorkingTreeDigest: scenario.nextDigest,
      changedPaths: scenario.changedPaths,
      authoredChangedPaths: scenario.authoredChangedPaths,
      retryableFailure: false,
      correctiveFailure: false
    });
    assert.equal(readSemanticRepairState(cwd, task.taskRunId).state.status, scenario.expectedStatus, scenario.name);
    assert.equal(opened.length, scenario.opens ? 1 : 0, scenario.name);
    assert.equal(completion, scenario.opens ? openResult : undefined, scenario.name);

    const second = { toolCallId: `${event.toolCallId}-second`, toolName: "edit", input: { path: "src/limit.js" } };
    assert.equal(runtime.prepareBoundedRecovery({
      ctx,
      task,
      event: second,
      currentDigest: scenario.nextDigest,
      ...evidence
    }), false, `${scenario.name} must consume the one-shot reservation`);
  }
});

test("bounded recovery allows no second mutation and never opens a corrective source revision", () => {
  const run = ({ suffix, verifierSuccess, correctiveFailure }) => {
    const cwd = project();
    const task = { ...taskContract(), taskRunId: `bounded-recovery-final-${suffix}` };
    const ctx = boundedRecoveryContext(cwd, task);
    const opened = [];
    const runtime = new SemanticRepairRuntime({
      now: () => "2026-08-22T00:00:00.000Z",
      trace() {},
      openRepair(...args) { opened.push(args); return { enforcementSafe: true, state: { currentPhase: "repair" } }; }
    });
    const mutation = { toolCallId: `bounded-source-${suffix}`, toolName: "edit", input: { path: "src/limit.js" } };
    const evidence = boundedRecoveryEvidence();
    assert.equal(runtime.prepareBoundedRecovery({ ctx, task, event: mutation, currentDigest: hash("a"), ...evidence }), true);
    assert.equal(authorizePreparedRecovery(runtime, cwd, task, mutation).allowed, true);
    runtime.complete(ctx, task, mutation, {
      toolCallId: mutation.toolCallId,
      success: true,
      exitCode: 0,
      currentWorkingTreeDigest: hash("b"),
      changedPaths: ["src/limit.js"],
      authoredChangedPaths: ["src/limit.js"],
      retryableFailure: false,
      correctiveFailure: false
    });
    assert.equal(opened.length, 1);

    const secondMutation = runtime.authorize({
      cwd,
      task,
      sessionId: task.sessionId,
      toolCallId: `bounded-second-${suffix}`,
      toolName: "edit",
      currentDigest: hash("b"),
      targetPaths: ["src/limit.js"],
      projectMutation: true,
      exactVerifier: false,
      shellLike: false
    });
    assert.equal(secondMutation.handled, true);
    assert.equal(secondMutation.allowed, false);
    assert.match(secondMutation.reason, /exactly one successful mutation/);

    const verifier = authorizeExactVerifier(cwd, task, `bounded-verifier-${suffix}`);
    assert.equal(verifier.allowed, true);
    const completed = completeSemanticRepairCall({
      cwd,
      taskRunId: task.taskRunId,
      toolCallId: `bounded-verifier-${suffix}`,
      success: verifierSuccess,
      exitCode: verifierSuccess ? 0 : 1,
      currentDigest: hash("b"),
      changedPaths: [],
      retryableFailure: false,
      correctiveFailure
    });
    return { cwd, task, opened, completed };
  };

  const passed = run({ suffix: "passed", verifierSuccess: true, correctiveFailure: false });
  assert.equal(passed.completed.result, "passed");
  assert.equal(readSemanticRepairState(passed.cwd, passed.task.taskRunId).state.status, "passed");

  const failed = run({ suffix: "failed", verifierSuccess: false, correctiveFailure: true });
  assert.equal(failed.completed.result, "locked");
  assert.equal(readSemanticRepairState(failed.cwd, failed.task.taskRunId).state.status, "locked");
  assert.equal(failed.opened.length, 1, "a corrective verifier failure must not open a second source-repair turn");
});

test("semantic repair eligibility is per conflicting path and links only executable companion tests", () => {
  const cwd = project(), task = taskContract();
  fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
    "export function take(items, options = {}) {",
    "  const limit = options.limit ?? 20;",
    "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
    "  return items.slice(0, limit);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "src", "sibling.js"), "export const sibling = false;\n");
  fs.writeFileSync(path.join(cwd, "test", "limit.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { take } from '../src/limit.js';",
    "assert.throws(() => take([1], { limit: 0 }), TypeError);",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "comment-only.test.js"), "// assert.throws(() => take([], { limit: null }), TypeError)\n");
  fs.writeFileSync(path.join(cwd, "test", "unrelated.test.js"), "import assert from 'node:assert/strict'; assert.throws(() => unrelated(), TypeError);\n");
  fs.writeFileSync(path.join(cwd, "test", "nearby.test.js"), "take([1]);\nassert.throws(() => unrelated(), TypeError);\n");
  fs.writeFileSync(path.join(cwd, "test", "local-shadow.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { take as productTake } from '../src/limit.js';",
    "const take = () => { throw new TypeError('local'); };",
    "assert.throws(() => take(), TypeError);",
    "void productTake;",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "skipped.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { take } from '../src/limit.js';",
    "test.skip('not executable proof', () => assert.throws(() => take([], { limit: 0 }), TypeError));",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "unresolved-call.test.js"), [
    "import assert from 'node:assert/strict';",
    "assert.throws(() => take([], { limit: 0 }), TypeError);",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "dead.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { take } from '../src/limit.js';",
    "if (false) assert.throws(() => take([], { limit: 0 }), TypeError);",
    "while (false) assert.throws(() => take([], { limit: 0 }), TypeError);",
    "for (let index = 0; index < 0; index += 1) assert.throws(() => take([], { limit: 0 }), TypeError);",
    ""
  ].join("\n"));
  const rejectedCompanions = ["comment-only", "unrelated", "nearby", "local-shadow", "skipped", "unresolved-call", "dead"];
  const delta = ["src/limit.js", "src/sibling.js", "test/limit.test.js", ...rejectedCompanions.map((name) => `test/${name}.test.js`)];
  const source = decideSemanticRepairHandshake({ cwd, task, mutationTargets: ["src/limit.js"], currentDeltaPaths: delta, verifierCurrent: true });
  assert.equal(source.authorized, true);
  assert.deepEqual(source.eligiblePaths, ["src/limit.js", "test/limit.test.js"]);
  assert.equal(decideSemanticRepairHandshake({ cwd, task, mutationTargets: ["src/limit.js", "test/limit.test.js"], currentDeltaPaths: delta, verifierCurrent: true }).authorized, true);
  assert.equal(decideSemanticRepairHandshake({ cwd, task, mutationTargets: ["src/sibling.js"], currentDeltaPaths: delta, verifierCurrent: true }).authorized, false);
  assert.equal(decideSemanticRepairHandshake({ cwd, task, mutationTargets: ["test/limit.test.js"], currentDeltaPaths: delta, verifierCurrent: true }).authorized, false, "a companion test cannot open repair before the conflicting source changes");
  for (const name of rejectedCompanions) {
    const target = `test/${name}.test.js`;
    const rejected = decideSemanticRepairHandshake({ cwd, task, mutationTargets: ["src/limit.js", target], currentDeltaPaths: delta, verifierCurrent: true });
    assert.equal(rejected.authorized, false, `${target} must not join the exact repair grant`);
    assert.equal(rejected.eligiblePaths.includes(target), false);
  }
});

test("denied, no-op, and failed first calls never open repair and hit a separate bounded ceiling", () => {
  const cwd = project(), task = taskContract(), decision = grantDecision();
  const runtime = new SemanticRepairRuntime({ now: () => new Date().toISOString(), trace() {}, openRepair() {} });
  const reserve = (toolCallId) => reserveSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId, toolName: "edit", currentDigest: hash("a"),
    decision, targetPaths: ["src/limit.js"]
  });
  assert.equal(reserve("denied").reserved, true);
  rejectSemanticRepairCall({ cwd, taskRunId: task.taskRunId, toolCallId: "denied" });
  let state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.status, "cancelled");
  assert.equal(state.deniedCalls, 1);
  assert.equal(state.successfulMutations, 0);
  assert.equal(runtime.completionBlock(cwd, task.taskRunId), undefined);

  const noOpReservation = reserve("noop");
  assert.equal(noOpReservation.reserved, true);
  assert.equal(authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "noop", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: noOpReservation.reservationToken
  }).allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "noop", success: true,
    currentDigest: hash("a"), changedPaths: []
  }).result, "cancelled");
  state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.noOpCalls, 1);
  assert.equal(state.successfulMutations, 0);
  assert.equal(runtime.completionBlock(cwd, task.taskRunId), undefined);

  const failedReservation = reserve("failed");
  assert.equal(failedReservation.reserved, true);
  authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "failed", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: failedReservation.reservationToken
  });
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "failed", success: false,
    currentDigest: hash("a"), changedPaths: []
  }).result, "locked");
  state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.failedCalls, 1);
  assert.equal(state.successfulMutations, 0);
  assert.equal(runtime.completionBlock(cwd, task.taskRunId), undefined);
  assert.equal(reserve("escape").reserved, false);
  assert.equal(semanticRepairResumeDecision({ cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("a") }).openRepair, false);
});

test("a successful observed first mutation commits an exact persisted grant through one exact verifier", () => {
  const cwd = project(), task = taskContract(), decision = grantDecision();
  const runtime = new SemanticRepairRuntime({ now: () => new Date().toISOString(), trace() {}, openRepair() {} });
  const sourceReservation = reserveSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    decision, targetPaths: ["src/limit.js"]
  });
  assert.equal(sourceReservation.reserved, true);
  assert.equal(reservedSemanticRepairCallMatches({
    cwd, taskRunId: task.taskRunId, sessionId: task.sessionId, toolCallId: "source", toolName: "edit",
    currentDigest: hash("a"), targetPaths: ["src/limit.js"], reservationToken: sourceReservation.reservationToken
  }), true);
  const authorized = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: sourceReservation.reservationToken
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.bypassPhase, true);
  assert.deepEqual(pendingSemanticRepairCall(cwd, task.taskRunId, "source").targetPaths, ["src/limit.js"]);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "source", success: true,
    currentDigest: hash("b"), changedPaths: ["src/limit.js"]
  }).result, "opened");
  assert.match(runtime.completionBlock(cwd, task.taskRunId), /exact final verifier/);
  assert.equal(semanticRepairResumeDecision({ cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("b") }).openRepair, true);

  for (const [toolCallId, toolName, targets, shellLike, opaqueCarrier] of [
    ["unknown-proxy", "mcp", [], false, true],
    ["shell-probe", "bash", [], true, false]
  ]) {
    const blocked = authorizeSemanticRepairCall({
      cwd, task, sessionId: task.sessionId, toolCallId, toolName, currentDigest: hash("b"),
      targetPaths: targets, projectMutation: toolCallId !== "shell-probe", exactVerifier: false, shellLike, opaqueCarrier
    });
    assert.equal(blocked.handled, true);
    assert.equal(blocked.allowed, false);
  }

  const shellMutation = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "test-shell", toolName: "bash", currentDigest: hash("b"),
    targetPaths: ["test/limit.test.js"], projectMutation: true, exactVerifier: false, shellLike: true
  });
  assert.equal(shellMutation.allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "test-shell", success: true,
    currentDigest: hash("c"), changedPaths: ["test/limit.test.js"]
  }).result, "recorded");
  const proxyMutation = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source-proxy", toolName: "mcp", currentDigest: hash("c"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false, opaqueCarrier: true
  });
  assert.equal(proxyMutation.allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "source-proxy", success: true,
    currentDigest: hash("d"), changedPaths: ["src/limit.js"]
  }).result, "recorded");
  const verifier = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "verify", toolName: "bash", currentDigest: hash("d"),
    targetPaths: [], projectMutation: false, exactVerifier: true, shellLike: true
  });
  assert.equal(verifier.allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "verify", success: true, exitCode: 0,
    currentDigest: hash("d"), changedPaths: []
  }).result, "passed");
  assert.equal(readSemanticRepairState(cwd, task.taskRunId).state.status, "passed");
  assert.deepEqual(semanticRepairProvenance(cwd, task.taskRunId), { enforcementSafe: true, repairCount: 1, retryCount: 0, passed: true }, "origin-backed provenance survives a missing trajectory transition");
  assert.equal(runtime.completionBlock(cwd, task.taskRunId), undefined);
  assert.equal(semanticRepairResumeDecision({ cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("d") }).openRepair, false);
});

test("one retryable verifier failure permits only one same-digest exact retry", () => {
  const cwd = project(), task = { ...taskContract(), taskRunId: "semantic-retry" };
  openSemanticGrant(cwd, task);
  assert.equal(authorizeExactVerifier(cwd, task, "verify-1").allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "verify-1", success: false, exitCode: 1,
    currentDigest: hash("b"), changedPaths: [], retryableFailure: true
  }).result, "retry");
  let state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.status, "retry-ready");
  assert.equal(state.transientRetryUsed, true);
  assert.equal(semanticRepairResumeDecision({ cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("b") }).openRepair, true);
  const mutation = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "retry-escape", toolName: "edit", currentDigest: hash("b"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false
  });
  assert.equal(mutation.allowed, false);
  assert.match(mutation.reason, /only the same exact verifier/);
  assert.equal(authorizeExactVerifier(cwd, task, "verify-2").allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "verify-2", success: true, exitCode: 0,
    currentDigest: hash("b"), changedPaths: []
  }).result, "passed");
  state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.status, "passed");
  assert.equal(state.successfulMutations, 1);
});

test("one high-confidence in-scope verifier failure opens one mutation-bound corrective revision", () => {
  const cwd = project(), task = { ...taskContract(), taskRunId: "semantic-correction" };
  openSemanticGrant(cwd, task);
  assert.equal(authorizeExactVerifier(cwd, task, "verify-1").allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "verify-1", success: false, exitCode: 1,
    currentDigest: hash("b"), changedPaths: [], correctiveFailure: true
  }).result, "correction");
  let state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.revision, 2);
  assert.equal(state.successfulMutationsInRevision, 0);
  assert.equal(authorizeExactVerifier(cwd, task, "premature-verify").allowed, false, "the corrective revision must mutate before re-verifying");
  const mutation = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "correction", toolName: "write", currentDigest: hash("b"),
    targetPaths: ["test/limit.test.js"], projectMutation: true, exactVerifier: false, shellLike: false
  });
  assert.equal(mutation.allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "correction", success: true,
    currentDigest: hash("c"), changedPaths: ["test/limit.test.js"]
  }).result, "recorded");
  assert.equal(authorizeExactVerifier(cwd, task, "verify-2", hash("c")).allowed, true);
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "verify-2", success: true, exitCode: 0,
    currentDigest: hash("c"), changedPaths: []
  }).result, "passed");
  state = readSemanticRepairState(cwd, task.taskRunId).state;
  assert.equal(state.status, "passed");
  assert.equal(state.revision, 2);
});

test("unclassified or exhausted verifier failures lock without opening mutation", () => {
  for (const [suffix, failure] of [["unclassified", {}], ["tree-changing", { retryableFailure: true, currentDigest: hash("c"), changedPaths: ["test/limit.test.js"] }]]) {
    const cwd = project(), task = { ...taskContract(), taskRunId: `semantic-${suffix}` };
    openSemanticGrant(cwd, task);
    assert.equal(authorizeExactVerifier(cwd, task, "verify").allowed, true);
    const completion = completeSemanticRepairCall({
      cwd, taskRunId: task.taskRunId, toolCallId: "verify", success: false, exitCode: 1,
      currentDigest: hash("b"), changedPaths: [], ...failure
    });
    assert.equal(completion.result, "locked");
    assert.equal(readSemanticRepairState(cwd, task.taskRunId).state.status, "locked");
    assert.equal(authorizeSemanticRepairCall({
      cwd, task, sessionId: task.sessionId, toolCallId: "escape", toolName: "edit", currentDigest: completion.state.currentDigest,
      targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false
    }).allowed, false);
  }
});

test("persisted unresolved and corrupt grants fail closed on resume", () => {
  const cwd = project(), task = taskContract();
  const reservation = reserveSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "pending", toolName: "edit", currentDigest: hash("a"),
    decision: grantDecision(), targetPaths: ["src/limit.js"]
  });
  assert.equal(reservation.reserved, true);
  assert.equal(authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "pending", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false
  }).allowed, false, "a persisted reservation is not replayable without its process-local token");
  assert.match(semanticRepairResumeDecision({
    cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("a")
  }).blockReason, /unresolved|stale/);
  assert.match(semanticRepairResumeDecision({
    cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: "different-session", currentDigest: hash("a")
  }).blockReason, /identity mismatch/);
  fs.writeFileSync(semanticRepairStatePath(cwd, task.taskRunId), "{ corrupt\n");
  const corrupt = readSemanticRepairState(cwd, task.taskRunId);
  assert.equal(corrupt.enforcementSafe, false);
  assert.equal(semanticRepairResumeDecision({
    cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("a")
  }).openRepair, false);
});

test("denied carriers have a bounded ceiling and digest races lock an active grant", () => {
  const cwd = project(), task = taskContract();
  const reservation = reserveSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    decision: grantDecision(), targetPaths: ["src/limit.js"]
  });
  authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: reservation.reservationToken
  });
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "source", success: true,
    currentDigest: hash("b"), changedPaths: ["src/limit.js"]
  }).result, "opened");
  for (const [index, input] of [
    { toolName: "bash", targetPaths: ["src/limit.js"], projectMutation: true, shellLike: true, targetExtractionComplete: false },
    { toolName: "mcp", targetPaths: ["src/limit.js"], projectMutation: true, shellLike: false, opaqueCarrier: true, targetExtractionComplete: false },
    { toolName: "exec", targetPaths: [], projectMutation: false, shellLike: true }
  ].entries()) {
    const denied = authorizeSemanticRepairCall({
      cwd, task, sessionId: task.sessionId, toolCallId: `denied-${index}`, currentDigest: hash("b"),
      exactVerifier: false, ...input
    });
    assert.equal(denied.allowed, false);
  }
  assert.equal(readSemanticRepairState(cwd, task.taskRunId).state.status, "locked");

  const raceCwd = project(), raceTask = { ...taskContract(), taskRunId: "semantic-repair-race" };
  const raceReservation = reserveSemanticRepairCall({
    cwd: raceCwd, task: raceTask, sessionId: raceTask.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    decision: grantDecision(), targetPaths: ["src/limit.js"]
  });
  authorizeSemanticRepairCall({
    cwd: raceCwd, task: raceTask, sessionId: raceTask.sessionId, toolCallId: "source", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: raceReservation.reservationToken
  });
  completeSemanticRepairCall({ cwd: raceCwd, taskRunId: raceTask.taskRunId, toolCallId: "source", success: true, currentDigest: hash("b"), changedPaths: ["src/limit.js"] });
  assert.match(authorizeSemanticRepairCall({
    cwd: raceCwd, task: raceTask, sessionId: raceTask.sessionId, toolCallId: "raced", toolName: "write", currentDigest: hash("c"),
    targetPaths: ["test/limit.test.js"], projectMutation: true, exactVerifier: false, shellLike: false
  }).reason, /digest is stale/);
  assert.equal(readSemanticRepairState(raceCwd, raceTask.taskRunId).state.status, "locked");
});

test("a dedicated semantic origin survives state loss without confusing generic recovery", () => {
  const genericCwd = project(), genericTask = { ...taskContract(), taskRunId: "generic-recovery-run" };
  let trajectory = createTrajectoryState({
    taskId: genericTask.taskId.toLowerCase(), taskRunId: genericTask.taskRunId, sessionId: genericTask.sessionId,
    changeMode: "source-change", riskLane: "tiny"
  });
  writeTrajectoryState(genericCwd, trajectory);
  for (const input of [
    { to: "execute", cause: "execution-authorized", sourceHook: "agent-start" },
    { to: "verify", cause: "verification-started", sourceHook: "tool-call" },
    { to: "repair", cause: "recovery-requested", sourceHook: "session-start" }
  ]) {
    const event = createTrajectoryTransition(trajectory, input);
    trajectory = reduceTrajectory(trajectory, event);
    appendTrajectoryTransition(genericCwd, event);
    writeTrajectoryState(genericCwd, trajectory);
  }
  assert.equal(semanticRepairStateRequired(genericCwd, genericTask.taskRunId), false, "ordinary recovery is not a semantic-origin marker");

  const cwd = project(), task = taskContract();
  const reservation = reserveSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "origin", toolName: "edit", currentDigest: hash("a"),
    decision: grantDecision(), targetPaths: ["src/limit.js"]
  });
  authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "origin", toolName: "edit", currentDigest: hash("a"),
    targetPaths: ["src/limit.js"], projectMutation: true, exactVerifier: false, shellLike: false,
    reservationToken: reservation.reservationToken
  });
  assert.equal(completeSemanticRepairCall({
    cwd, taskRunId: task.taskRunId, toolCallId: "origin", success: true,
    currentDigest: hash("b"), changedPaths: ["src/limit.js"]
  }).result, "opened");
  assert.equal(semanticRepairStateRequired(cwd, task.taskRunId), true);
  fs.rmSync(semanticRepairStatePath(cwd, task.taskRunId));
  assert.equal(semanticRepairProvenance(cwd, task.taskRunId).enforcementSafe, false);
  assert.match(semanticRepairResumeDecision({
    cwd, taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, currentDigest: hash("b")
  }).blockReason, /required semantic repair state is missing/);
  const denied = authorizeSemanticRepairCall({
    cwd, task, sessionId: task.sessionId, toolCallId: "second-restart", toolName: "edit", currentDigest: hash("b"),
    targetPaths: ["src/sibling.js"], projectMutation: true, exactVerifier: false, shellLike: false
  });
  assert.equal(denied.handled, true);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /required semantic repair state is missing/);
});
