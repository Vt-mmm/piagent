import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextPlanAcceptsConfidence,
  planAdaptiveContext
} from "../packages/piagent-core/runtime/context/adaptive-planner.ts";
import { modelCapabilityFromContext } from "../packages/piagent-core/runtime/model/capabilities.ts";
import { CONTEXT_PACK_MAX_TOKENS } from "../packages/piagent-core/runtime/runtime-limits.ts";
import {
  evaluateExactFinalOutputContract,
  exactFinalOutputGuidance
} from "../packages/piagent-core/runtime/quality/exact-output-contract.ts";
import {
  appendRepositoryMemoryFact,
  appendTaskJournalEvent,
  bindSessionTask,
  chooseVerificationScope,
  classifyVerificationFailure,
  executionBackendAllowsMutation,
  pruneTaskJournal,
  readRepositoryMemoryFacts,
  readTaskJournal,
  recordTaskCheckpoint,
  replayTaskCheckpoints,
  resolveExecutionBackend,
  selectRepositoryMemoryFacts,
  selectVerificationPlan,
  taskJournalPaths,
  taskJournalSnapshot,
  taskRecoveryDecision,
  verificationRunIdentity,
  writeTaskContract
} from "../packages/piagent-core/extensions/core-services.js";
import {
  acceptanceBaselineGuidance,
  acceptanceProofGuidance,
  acceptanceSemanticConflicts,
  buildAcceptanceReceipt,
  refreshAcceptanceReceipt
} from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash, workingTreeCarrierDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import {
  BENCHMARK_SCOPE_BANDS,
  benchmarkTrustChecklist,
  recommendedBenchmarkBand,
  requiresLongHorizonEvidence
} from "../packages/piagent-core/benchmark/benchmark-matrix.js";

const treeDigest = (value) => versionWorkingTreeHash(value.repeat(64));
function temporaryProject(t, prefix = "piagent-adaptive-") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function extensionContext(overrides = {}) {
  return {
    cwd: "/tmp/project",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    getContextUsage: () => ({ tokens: 72_000, contextWindow: 100_000, percent: 72 }),
    ...overrides
  };
}

function contract(overrides = {}) {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    taskRunId: "task-20260801000000-abcdef1234",
    taskId: "task",
    sessionId: "session-a",
    sessionName: "TASK-1",
    changeMode: "source-change",
    attempt: 1,
    maxAttempts: 3,
    previousAttempts: [],
    summary: "Implement the adaptive runtime fixture",
    riskLane: "normal",
    intakeMode: "runtime",
    expectedOutput: "The adaptive runtime fixture is persisted.",
    acceptanceCriteria: ["Contract can be written"],
    scope: ["src/a.ts"],
    outOfScope: [],
    protectedPaths: [],
    requiredContext: [],
    contextManifest: [],
    memoryCitations: [],
    mcpCapabilities: [],
    verifyCommands: ["npm test"],
    workPlan: [],
    reviewLenses: [],
    workingTreeDigestAlgorithm: "wt-content-v2",
    baselineChangedFiles: [],
    baselineFileDigests: {},
    observedChangedFiles: [],
    finalWorkingTreeFiles: [],
    finalFileDigests: {},
    changedFiles: [],
    verifyEvidence: [],
    trace: { outcome: "pending" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("adaptive planner contracts budget by phase, pressure, and thinking capability", () => {
  const capability = modelCapabilityFromContext(extensionContext(), "xhigh");
  const plan = planAdaptiveContext({
    prompt: "Fix src/cart.ts quantity handling and update the matching test",
    runtimeIntake: true,
    contextUsage: { tokens: 72_000, contextWindow: 100_000, percent: 72 },
    modelCapability: capability
  });

  assert.equal(plan.phase, "intake");
  assert.equal(plan.shouldInject, true);
  assert.ok(plan.budgetTokens <= 420, `expected contracted budget, got ${plan.budgetTokens}`);
  assert.equal(plan.limit, 4);
  assert.equal(plan.includeCode, true);
  assert.equal(contextPlanAcceptsConfidence(plan, "low"), false);
  assert.equal(contextPlanAcceptsConfidence(plan, "medium"), true);
  assert.match(plan.receipt, /^[a-f0-9]{16}$/);

  const highRiskPlan = planAdaptiveContext({
    prompt: "Review the authentication boundary and production permission behavior",
    runtimeIntake: false,
    modelCapability: capability
  });
  assert.equal(highRiskPlan.minConfidence, "high");
  assert.equal(contextPlanAcceptsConfidence(highRiskPlan, "medium"), false);

  const previousReranker = process.env.PIAGENT_LOCAL_RERANKER;
  process.env.PIAGENT_LOCAL_RERANKER = "on";
  try {
    const unavailableReranker = planAdaptiveContext({
      prompt: "Inspect checkout service behavior for the next implementation step",
      runtimeIntake: false,
      modelCapability: capability
    });
    assert.equal(unavailableReranker.reranker, "off");
    assert.match(unavailableReranker.reasons.join(" "), /local-reranker:unavailable/);
  } finally {
    if (previousReranker === undefined) delete process.env.PIAGENT_LOCAL_RERANKER;
    else process.env.PIAGENT_LOCAL_RERANKER = previousReranker;
  }
});

test("adaptive planner refuses utility/protected/active-task injections", () => {
  const capability = modelCapabilityFromContext(extensionContext({
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 })
  }), "high");
  const usagePlan = planAdaptiveContext({
    prompt: "/usage history",
    runtimeIntake: false,
    modelCapability: capability
  });
  assert.equal(usagePlan.shouldInject, false);

  const activePlan = planAdaptiveContext({
    prompt: "Implement checkout flow",
    runtimeIntake: false,
    activeTask: { trace: { outcome: "pending" } },
    modelCapability: capability
  });
  assert.equal(activePlan.shouldInject, false);
  assert.match(activePlan.reasons.join(" "), /active-task:reuse-working-set/);
});

test("adaptive planner keeps every injectable phase inside the shared hard ceiling", () => {
  const capability = modelCapabilityFromContext(extensionContext(), "xhigh");
  const prompts = [
    "Implement checkout behavior across service and tests",
    "Review authentication security and production permission behavior",
    "Scout the repository architecture before a high-risk migration",
    "Prepare release verification for the package",
    "Fix src/cart.ts and its exact test"
  ];
  for (const prompt of prompts) {
    for (const percent of [0, 42, 58, 72, 95]) {
      const plan = planAdaptiveContext({
        prompt,
        runtimeIntake: /implement|fix/i.test(prompt),
        contextUsage: { percent },
        modelCapability: capability
      });
      if (plan.shouldInject) {
        assert.ok(plan.budgetTokens >= 240);
        assert.ok(plan.budgetTokens <= CONTEXT_PACK_MAX_TOKENS, `${prompt}: ${plan.budgetTokens}`);
      } else {
        assert.equal(plan.budgetTokens, 0);
      }
    }
  }
});

test("task journal appends hash-chained events and replays checkpoints idempotently", (t) => {
  const cwd = temporaryProject(t);
  const first = appendTaskJournalEvent(cwd, {
    eventType: "contract-written",
    taskRunId: "TASK-1",
    taskId: "TASK-1",
    sessionId: "session-a",
    data: { scope: ["src/a.ts"] }
  }, { recordedAt: "2026-08-01T00:00:00.000Z" });
  const second = recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-1",
    sessionId: "session-a",
    checkpointId: "implement",
    idempotencyKey: "implement-1",
    phase: "execute",
    status: "in-progress",
    recordedAt: "2026-08-01T00:01:00.000Z"
  });
  recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-1",
    sessionId: "session-a",
    checkpointId: "implement",
    idempotencyKey: "implement-1",
    phase: "execute",
    status: "done",
    recordedAt: "2026-08-01T00:02:00.000Z"
  });

  assert.equal(second.previousHash, first.hash);
  const journal = readTaskJournal(cwd);
  assert.equal(journal.corruptions.length, 0);
  assert.equal(journal.events.length, 3);
  if (process.platform !== "win32") {
    const paths = taskJournalPaths(cwd);
    assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.events).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.head).mode & 0o777, 0o600);
  }
  assert.equal(readTaskJournal(cwd, { limit: 0 }).events.length, 0);
  assert.deepEqual(taskJournalSnapshot(cwd).byType, {
    "contract-written": 1,
    checkpoint: 2
  });
  const replay = replayTaskCheckpoints(cwd, "task-1");
  assert.equal(replay.checkpoints.length, 1);
  assert.equal(replay.checkpoints[0].status, "in-progress");
  assert.equal(replay.resumeRequired, true);
});

test("task journal treats pre-migration tree evidence as historical and enforces the new namespace after the barrier", (t) => {
  const cwd = temporaryProject(t);
  const migrationTask = {
    taskRunId: "task-digest",
    taskId: "task-digest-contract",
    sessionId: "session-digest",
    workingTreeDigestAlgorithm: "wt-content-v2",
    workingTreeDigestMigration: {
      status: "verification-refresh-required",
      reasonCode: "clean-baseline-rebound",
      archivePath: ".pi/piagent-state/digest-migrations/task-digest.legacy.json",
      archiveDigest: "c".repeat(64),
      baselineEvidenceDigest: workingTreeCarrierDigest("baseline", [], {}),
      finalEvidenceDigest: workingTreeCarrierDigest("final", [], {})
    },
    baselineChangedFiles: [], baselineFileDigests: {}, finalWorkingTreeFiles: [], finalFileDigests: {}
  };
  appendTaskJournalEvent(cwd, {
    eventType: "checkpoint",
    taskRunId: "TASK-DIGEST",
    checkpointId: "legacy-verify",
    data: { phase: "verify", status: "done", evidence: { workingTreeDigest: "a".repeat(64) } }
  });
  assert.equal(readTaskJournal(cwd, { taskRunId: "task-digest" }).corruptions.length, 0);
  appendTaskJournalEvent(cwd, {
    eventType: "digest-migrated",
    taskRunId: "TASK-DIGEST",
    taskId: migrationTask.taskId,
    sessionId: migrationTask.sessionId,
    data: {
      algorithm: "wt-content-v2",
      disposition: "verification-refresh-required",
      reasonCode: "clean-baseline-rebound",
      archivePath: ".pi/piagent-state/digest-migrations/task-digest.legacy.json",
      archiveDigest: "c".repeat(64),
      baselineEvidenceDigest: workingTreeCarrierDigest("baseline", [], {}),
      finalEvidenceDigest: workingTreeCarrierDigest("final", [], {})
    }
  });
  assert.throws(() => recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-DIGEST",
    checkpointId: "bad-current-verify",
    phase: "verify",
    status: "done",
    evidence: { workingTreeDigest: "b".repeat(64) }
  }), /current working-tree digest namespace/);
  recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-DIGEST",
    checkpointId: "current-verify",
    phase: "verify",
    status: "done",
    evidence: { workingTreeDigest: treeDigest("b") }
  });
  const replay = replayTaskCheckpoints(cwd, "task-digest", migrationTask);
  assert.equal(replay.corruptions.length, 0);
  assert.equal(replay.migrationBarrier.sequence, 2);
  assert.deepEqual(replay.checkpoints.map((checkpoint) => checkpoint.checkpointId), ["current-verify"]);
  assert.match(replayTaskCheckpoints(cwd, "task-digest").corruptions.join("; "), /requires Task Contract context/);
  const refreshedTask = structuredClone(migrationTask);
  refreshedTask.workingTreeDigestMigration.status = "refreshed";
  assert.equal(replayTaskCheckpoints(cwd, "task-digest", refreshedTask).corruptions.length, 0);
  const mismatchedTask = structuredClone(migrationTask);
  mismatchedTask.workingTreeDigestMigration.finalEvidenceDigest = "d".repeat(64);
  assert.match(replayTaskCheckpoints(cwd, "task-digest", mismatchedTask).corruptions.join("; "), /does not match the Task Contract/);
  const mismatchedIdentity = structuredClone(migrationTask);
  mismatchedIdentity.sessionId = "different-session";
  assert.match(replayTaskCheckpoints(cwd, "task-digest", mismatchedIdentity).corruptions.join("; "), /does not match the Task Contract/);

  const invalidCwd = temporaryProject(t);
  appendTaskJournalEvent(invalidCwd, {
    eventType: "digest-migrated",
    taskRunId: "TASK-DIGEST-INVALID",
    data: {
      algorithm: "wt-content-v2",
      disposition: "verification-refresh-required",
      reasonCode: "clean-baseline-rebound",
      archivePath: ".pi/piagent-state/digest-migrations/task-digest-invalid.legacy.json"
    }
  });
  assert.match(replayTaskCheckpoints(invalidCwd, "task-digest-invalid").corruptions.join("; "), /marker is invalid/);
});

test("task journal resumes from verified event tail when head update was interrupted", (t) => {
  const cwd = temporaryProject(t);
  appendTaskJournalEvent(cwd, { eventType: "first", taskRunId: "TASK-HEAD" });
  const paths = taskJournalPaths(cwd);
  const staleHead = fs.readFileSync(paths.head, "utf8");
  appendTaskJournalEvent(cwd, { eventType: "persisted-before-head", taskRunId: "TASK-HEAD" });
  fs.writeFileSync(paths.head, staleHead);
  appendTaskJournalEvent(cwd, { eventType: "next-process", taskRunId: "TASK-HEAD" });

  const journal = readTaskJournal(cwd);
  assert.equal(journal.corruptions.length, 0);
  assert.deepEqual(journal.events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual(journal.events.map((event) => event.eventType), ["first", "persisted-before-head", "next-process"]);
});

test("task contract writes and session bindings emit journal audit events", (t) => {
  const cwd = temporaryProject(t);
  const written = writeTaskContract(cwd, contract());
  bindSessionTask(cwd, "session-a", "TASK-1", written);
  const journal = readTaskJournal(cwd, { taskRunId: written.taskRunId });
  assert.equal(journal.corruptions.length, 0);
  assert.deepEqual(journal.events.map((event) => event.eventType), ["contract-written", "session-bound"]);
});

test("task journal reports corruption instead of trusting edited bytes", (t) => {
  const cwd = temporaryProject(t);
  appendTaskJournalEvent(cwd, { eventType: "contract-written", taskRunId: "TASK-1" });
  const paths = taskJournalPaths(cwd);
  fs.appendFileSync(paths.events, "{\"schemaVersion\":1,\"sequence\":99,\"eventType\":\"oops\",\"recordedAt\":\"2026-08-01T00:00:00.000Z\",\"hash\":\"0000000000000000000000000000000000000000000000000000000000000000\"}\n");
  const journal = readTaskJournal(cwd);
  assert.match(journal.corruptions.join("; "), /hash mismatch|sequence gap|previous hash mismatch/);
  assert.throws(() => appendTaskJournalEvent(cwd, { eventType: "must-not-append" }), /chain is corrupt/);
});

test("journal and repository memory refuse symlinked local-state roots", { skip: process.platform === "win32" }, (t) => {
  const cwd = temporaryProject(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-state-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const stateRoot = path.join(cwd, ".pi", "piagent-state");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(stateRoot, "task-journal"));
  assert.throws(() => appendTaskJournalEvent(cwd, { eventType: "blocked" }), /symbolic link/);
  fs.unlinkSync(path.join(stateRoot, "task-journal"));
  fs.symlinkSync(outside, path.join(stateRoot, "repository-memory"));
  assert.throws(() => appendRepositoryMemoryFact(cwd, {
    kind: "fact",
    fact: "Current source keeps local state inside the project boundary.",
    reason: "Verified local state policy.",
    citations: [{ path: "docs/architecture.md", reason: "State ownership" }]
  }), /symbolic link/);
});

test("task journal recovery decision distinguishes resume, retry, pause, and exhausted attempts", (t) => {
  const cwd = temporaryProject(t);
  recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-2",
    checkpointId: "verify",
    phase: "verify",
    status: "failed",
    idempotencyKey: "verify-1"
  });
  const replay = replayTaskCheckpoints(cwd, "task-2");
  assert.equal(taskRecoveryDecision({ attempt: 1, maxAttempts: 3, trace: { outcome: "pending" } }, replay).decision, "retry");
  assert.equal(taskRecoveryDecision({ attempt: 3, maxAttempts: 3, trace: { outcome: "pending" } }, replay).decision, "blocked");

  recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-3",
    checkpointId: "review",
    phase: "review",
    status: "paused",
    idempotencyKey: "review-1"
  });
  assert.equal(taskRecoveryDecision({ attempt: 1, maxAttempts: 3, trace: { outcome: "pending" } }, replayTaskCheckpoints(cwd, "task-3")).decision, "paused");
  assert.equal(taskRecoveryDecision({ trace: { outcome: "completed" } }, replay).decision, "terminal");

  recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-5",
    checkpointId: "a-old",
    phase: "verify",
    status: "failed",
    recordedAt: "2026-08-01T00:00:00.000Z"
  });
  recordTaskCheckpoint(cwd, {
    taskRunId: "TASK-5",
    checkpointId: "z-new",
    phase: "review",
    status: "paused",
    recordedAt: "2026-08-01T00:01:00.000Z"
  });
  assert.equal(
    taskRecoveryDecision({ attempt: 1, maxAttempts: 3, trace: { outcome: "pending" } }, replayTaskCheckpoints(cwd, "task-5")).decision,
    "paused"
  );
  const contractDecision = taskRecoveryDecision({
    attempt: 1,
    maxAttempts: 3,
    trace: { outcome: "pending" },
    workPlan: [{ id: "review", status: "in-progress" }]
  }, replayTaskCheckpoints(cwd, "task-2"));
  assert.equal(contractDecision.decision, "resume");
  assert.equal(contractDecision.checkpointId, "review");
});

test("task journal retention rewrites a valid bounded chain", (t) => {
  const cwd = temporaryProject(t);
  for (let index = 0; index < 5; index += 1) {
    appendTaskJournalEvent(cwd, {
      eventType: "checkpoint",
      taskRunId: "TASK-4",
      checkpointId: `step-${index}`,
      data: { status: "done" }
    });
  }
  const result = pruneTaskJournal(cwd, { maxEvents: 2 });
  assert.deepEqual(result, { pruned: 3, kept: 2, corruptions: [] });
  const journal = readTaskJournal(cwd);
  assert.equal(journal.events.length, 2);
  assert.equal(journal.corruptions.length, 0);
  assert.deepEqual(journal.events.map((event) => event.sequence), [1, 2]);
  assert.equal(journal.events[0].retentionAnchors.length, 1);
  assert.equal(journal.events[0].retentionAnchors[0].prunedEvents, 3);
  assert.match(journal.events[0].retentionAnchors[0].prefixHash, /^[a-f0-9]{64}$/);
});

test("task journal retention preserves a task-bound digest migration barrier", (t) => {
  const cwd = temporaryProject(t);
  const baselineEvidenceDigest = workingTreeCarrierDigest("baseline", [], {});
  const finalEvidenceDigest = workingTreeCarrierDigest("final", [], {});
  const task = {
    taskRunId: "task-retained-migration",
    taskId: "task-retained-contract",
    sessionId: "session-retained",
    workingTreeDigestAlgorithm: "wt-content-v2",
    workingTreeDigestMigration: {
      status: "refreshed",
      reasonCode: "clean-baseline-rebound",
      archivePath: ".pi/piagent-state/digest-migrations/task-retained-migration.legacy.json",
      archiveDigest: "e".repeat(64), baselineEvidenceDigest, finalEvidenceDigest
    }
  };
  appendTaskJournalEvent(cwd, {
    eventType: "checkpoint", taskRunId: task.taskRunId, checkpointId: "legacy",
    data: { status: "done", evidence: { workingTreeDigest: "a".repeat(64) } }
  });
  appendTaskJournalEvent(cwd, {
    eventType: "digest-migrated", taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId,
    data: {
      algorithm: "wt-content-v2", disposition: "verification-refresh-required",
      reasonCode: "clean-baseline-rebound", archivePath: task.workingTreeDigestMigration.archivePath,
      archiveDigest: task.workingTreeDigestMigration.archiveDigest, baselineEvidenceDigest, finalEvidenceDigest
    }
  });
  for (let index = 0; index < 4; index += 1) {
    recordTaskCheckpoint(cwd, {
      taskRunId: task.taskRunId, checkpointId: `current-${index}`, phase: "verify", status: "done",
      evidence: { workingTreeDigest: treeDigest(String(index + 1)) }
    });
  }
  assert.deepEqual(pruneTaskJournal(cwd, { maxEvents: 2 }), { pruned: 3, kept: 3, corruptions: [] });
  const journal = readTaskJournal(cwd);
  assert.deepEqual(journal.events.map((event) => event.eventType), ["digest-migrated", "checkpoint", "checkpoint"]);
  const replay = replayTaskCheckpoints(cwd, task.taskRunId, task);
  assert.equal(replay.corruptions.length, 0);
  assert.equal(replay.migrationBarrier.sequence, 1);
  assert.deepEqual(replay.checkpoints.map((checkpoint) => checkpoint.checkpointId), ["current-2", "current-3"]);
});

test("repository memory stores only cited, sanitized, expiring facts", (t) => {
  const cwd = temporaryProject(t);
  const record = appendRepositoryMemoryFact(cwd, {
    kind: "decision",
    fact: "Use runtime task contracts as the source of truth for final handoff.",
    reason: "Recorded from architecture documentation.",
    confidence: "high",
    citations: [{ path: "docs/architecture.md", reason: "Runtime architecture source" }],
    expiresAt: "2026-09-01T00:00:00.000Z"
  }, { recordedAt: "2026-08-01T00:00:00.000Z" });
  assert.match(record.id, /^[a-f0-9]{16}$/);
  const refreshed = appendRepositoryMemoryFact(cwd, {
    kind: "decision",
    fact: "Use runtime task contracts as the source of truth for final handoff.",
    reason: "Recorded from architecture documentation.",
    confidence: "high",
    citations: [{ path: "docs/architecture.md", reason: "Runtime architecture source" }],
    expiresAt: "2026-09-15T00:00:00.000Z"
  }, { recordedAt: "2026-08-02T00:00:00.000Z" });
  assert.equal(refreshed.id, record.id);
  if (process.platform !== "win32") {
    const memoryRoot = path.join(cwd, ".pi", "piagent-state", "repository-memory");
    assert.equal(fs.statSync(memoryRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(memoryRoot, "facts.jsonl")).mode & 0o777, 0o600);
  }
  assert.equal(readRepositoryMemoryFacts(cwd, { now: "2026-08-02T00:00:00.000Z" }).length, 1);
  assert.equal(readRepositoryMemoryFacts(cwd, { limit: 0, now: "2026-08-02T00:00:00.000Z" }).length, 0);
  assert.equal(readRepositoryMemoryFacts(cwd, { now: "2026-10-02T00:00:00.000Z" }).length, 0);
  assert.throws(
    () => selectRepositoryMemoryFacts(cwd, "task contract final handoff"),
    /requires an explicit excludePatterns array/
  );
  assert.equal(selectRepositoryMemoryFacts(cwd, "task contract final handoff", {
    now: "2026-08-02T00:00:00.000Z",
    excludePatterns: []
  }).length, 1);
  assert.equal(selectRepositoryMemoryFacts(cwd, "task contract final handoff", {
    now: "2026-08-02T00:00:00.000Z",
    excludePatterns: ["docs/**"]
  }).length, 0);
  assert.throws(() => appendRepositoryMemoryFact(cwd, {
    kind: "fact",
    fact: "Store raw prompt and OAuth token for debugging.",
    reason: "bad",
    citations: [{ path: "README.md", reason: "fixture" }]
  }), /must not store raw prompts/);
  assert.throws(() => appendRepositoryMemoryFact(cwd, {
    kind: "fact",
    fact: "The checkout module uses the service boundary.",
    reason: "Copied from a raw prompt for later debugging.",
    citations: [{ path: "src/checkout.ts", reason: "Current source" }]
  }), /reason must not store raw prompts/);
  assert.throws(() => appendRepositoryMemoryFact(cwd, {
    kind: "fact",
    fact: "The checkout module uses the service boundary.",
    reason: "Verified architecture fact.",
    citations: [{ path: "src/checkout.ts", reason: "Contains a raw output transcript" }]
  }), /citation reason must not store raw prompts/);
  assert.doesNotThrow(() => appendRepositoryMemoryFact(cwd, {
    kind: "decision",
    fact: "Use a bounded token budget for context retrieval.",
    reason: "Keeps context injection predictable.",
    citations: [{ path: "docs/architecture.md", reason: "Budget policy" }]
  }));
});

test("repository memory preserves only current namespaced tree citations", (t) => {
  const cwd = temporaryProject(t);
  const current = appendRepositoryMemoryFact(cwd, {
    kind: "fact",
    fact: "The current tree citation remains bound to its digest namespace.",
    reason: "Verified against the current source tree.",
    citations: [{ path: "src/current.ts", reason: "Current source", digest: treeDigest("a") }]
  });
  const historical = appendRepositoryMemoryFact(cwd, {
    kind: "fact",
    fact: "The legacy tree citation remains advisory historical context.",
    reason: "Imported from an older unversioned task record.",
    citations: [{ path: "src/legacy.ts", reason: "Legacy source", digest: "b".repeat(64) }]
  });
  assert.equal(current.citations[0].digest, treeDigest("a"));
  assert.equal(historical.citations[0].digest, undefined);
  const facts = readRepositoryMemoryFacts(cwd);
  assert.equal(facts.find((fact) => fact.id === current.id).citations[0].digest, treeDigest("a"));
  assert.equal(facts.find((fact) => fact.id === historical.id).citations[0].digest, undefined);
});

test("verification intelligence classifies failures and selects targeted groups", () => {
  assert.equal(classifyVerificationFailure("TS2322: Type string is not assignable", 2).category, "compile-typecheck");
  assert.equal(classifyVerificationFailure("Error: timed out waiting for localhost", 1).retryable, true);
  const scope = chooseVerificationScope({
    docs: ["npm run docs:check"],
    frontendSource: ["npm run test:web"],
    backendSource: ["npm run test:api"],
    source: ["npm test"]
  }, ["apps/web/src/Button.tsx"]);
  assert.equal(scope.group, "frontendSource");
  const mixed = chooseVerificationScope({
    frontendSource: ["npm run test:web"],
    backendSource: ["npm run test:api"],
    source: ["npm test"]
  }, ["apps/web/src/Button.tsx", "services/api/order.ts"]);
  assert.equal(mixed.group, "source");
  assert.deepEqual(mixed.commands, ["npm test"]);
  const docsAndFrontend = chooseVerificationScope({
    docs: ["npm run docs:check"],
    frontendSource: ["npm run test:web"],
    source: ["npm test"]
  }, ["docs-site/content/architecture.html", "apps/web/src/Button.tsx"]);
  assert.equal(docsAndFrontend.group, "docs+frontendSource");
  assert.deepEqual(docsAndFrontend.commands, ["npm run docs:check", "npm run test:web"]);
  assert.equal(selectVerificationPlan({
    verifyCommands: {
      docs: ["npm run docs:check"],
      source: ["npm test"]
    }
  }, undefined, "source-change", undefined, ["docs/architecture.md"]).group, "docs");
  assert.equal(verificationRunIdentity("/tmp/project", "npm test", ["b.ts", "a.ts"]), verificationRunIdentity("/tmp/project", "npm test", ["a.ts", "b.ts"]));
});

test("acceptance receipt derives critical auth and validation obligations without a model call", (t) => {
  const cwd = temporaryProject(t);
  fs.mkdirSync(path.join(cwd, "src", "backend"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "backend", "auth.js"), [
    "export function canManage(user, resource) {",
    "  return user?.active !== false && ['owner', 'admin'].includes(user?.role) && Boolean(resource);",
    "}",
    ""
  ].join("\n"));
  const currentDigest = treeDigest("a");
  assert.deepEqual(
    acceptanceProofGuidance("A value is absent only when it is undefined; null, false, 0, and an empty string remain valid."),
    ["Prove undefined falls through while null, false, 0, and empty string are each preserved at the highest-precedence position."]
  );
  assert.ok(acceptanceProofGuidance("Clamp an integer page and throw TypeError for invalid values.").some((item) => /page/.test(item)));
  const transitionGuidance = acceptanceProofGuidance([
    "Revision is a non-negative safe\ninteger. A newly admitted command increments revision exactly once.",
    "Check an idempotency receipt before revision matching: an identical replay succeeds with a stale revision,",
    "returns the identical state object, and reusing the same key for different content throws TypeError.",
    "The key must contain at least one non-whitespace character."
  ].join("\n"));
  assert.ok(transitionGuidance.some((item) => /Number\.MAX_SAFE_INTEGER/.test(item)));
  assert.ok(transitionGuidance.some((item) => /same identity with different content/.test(item)));
  assert.ok(transitionGuidance.some((item) => /stale revision/.test(item)));
  assert.ok(transitionGuidance.some((item) => /exact prior object/.test(item)));
  assert.ok(transitionGuidance.some((item) => /whitespace-only/.test(item)));

  const orderingGuidance = acceptanceProofGuidance([
    "Report replay ids once in first-observed order.",
    "A maxChars capacity allows equality; stop atomically before an item would exceed it, leave state unchanged, and buffer the remainder."
  ].join(" "));
  assert.ok(orderingGuidance.some((item) => /A, B, B, A/.test(item)));
  assert.ok(orderingGuidance.some((item) => /exact equality/.test(item)));
  assert.deepEqual(acceptanceProofGuidance("Return the configured display name."), []);
  const generatedGuidanceFixture = buildAcceptanceReceipt({
    summary: "Fix resolveConfig. A value is absent only when it is undefined; null remains valid.",
    expectedOutput: "Configuration precedence is correct.",
    changeMode: "source-change"
  });
  assert.deepEqual(acceptanceProofGuidance({
    summary: "Fix resolveConfig. A value is absent only when it is undefined; null remains valid.",
    expectedOutput: "Configuration precedence is correct.",
    acceptanceCriteria: generatedGuidanceFixture.acceptanceCriteria
  }), ["Prove undefined falls through while null, false, 0, and empty string are each preserved at the highest-precedence position."]);
  const acceptance = buildAcceptanceReceipt({
    summary: "Fix canManage so owner/admin users must be active and belong to the same non-empty tenant.",
    expectedOutput: "Missing input, inactive users, wrong roles, and cross-tenant resources are denied.",
    acceptanceCriteria: ["The authorization boundary is enforced."],
    changeMode: "source-change",
    source: "runtime",
    generatedAt: "2026-08-03T00:00:00.000Z"
  });
  assert.ok(acceptance.receipt.criteria.some((criterion) => criterion.obligation === "authorization-deny-case"));
  assert.ok(acceptance.receipt.criteria.some((criterion) => criterion.obligation === "tenant-boundary"));

  const incomplete = refreshAcceptanceReceipt(contract({
    acceptanceCriteria: acceptance.acceptanceCriteria,
    acceptanceReceipt: acceptance.receipt,
    changedFiles: ["src/backend/auth.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/auth.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.ok(incomplete.criticalMissing.some((criterion) => criterion.obligation === "tenant-boundary"));

  fs.writeFileSync(path.join(cwd, "src", "backend", "auth.js"), [
    "export function canManage(user, resource) {",
    "  if (!user || !resource || !user.tenantId || !resource.tenantId) return false;",
    "  if (user.active !== true) return false;",
    "  if (!['owner', 'admin'].includes(user.role)) return false;",
    "  return user.tenantId === resource.tenantId;",
    "}",
    ""
  ].join("\n"));
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "test", "auth.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { canManage } from '../src/backend/auth.js';",
    "const resource = { tenantId: 'a' };",
    "assert.equal(canManage({ tenantId: 'a', role: 'owner', active: true }, resource), true);",
    "assert.equal(canManage({ tenantId: 'b', role: 'admin', active: true }, resource), false);",
    "assert.equal(canManage({ tenantId: '', role: 'owner', active: true }, { tenantId: '' }), false);",
    "assert.equal(canManage({ tenantId: 'a', role: 'member', active: true }, { tenantId: 'a' }), false);",
    "assert.equal(canManage({ tenantId: 'a', role: 'admin', active: false }, { tenantId: 'a' }), false);",
    "assert.equal(canManage(null, { tenantId: 'a' }), false);",
    ""
  ].join("\n"));
  const complete = refreshAcceptanceReceipt(contract({
    acceptanceCriteria: acceptance.acceptanceCriteria,
    acceptanceReceipt: acceptance.receipt,
    changedFiles: ["src/backend/auth.js", "test/auth.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/auth.js", "test/auth.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(complete.criticalMissing.map((criterion) => criterion.obligation), []);

  fs.writeFileSync(path.join(cwd, "src", "backend", "auth.js"), [
    "function getTenant(value) { return value?.tenantId ?? value?.tenant; }",
    "export function canManage(user, resource) {",
    "  if (user?.active !== true || !['owner', 'admin'].includes(user?.role)) return false;",
    "  const userTenant = getTenant(user);",
    "  const resourceTenant = getTenant(resource);",
    "  return userTenant !== undefined && userTenant !== '' && resourceTenant !== undefined && resourceTenant !== '' && userTenant === resourceTenant;",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "auth.test.js"), [
    "import assert from 'node:assert/strict';",
    "assert.equal(canManage({ active: true, role: 'owner', tenantId: 'tenant-a' }, { tenantId: 'tenant-a' }), true);",
    "assert.equal(canManage({ active: true, role: 'admin', tenant: 'tenant-a' }, { tenant: 'tenant-a' }), true);",
    "for (const [user, resource] of [",
    "  [{ active: true, role: 'owner', tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }],",
    "  [{ active: true, role: 'owner', tenantId: '' }, { tenantId: 'tenant-a' }],",
    "  [{ active: true, role: 'owner' }, { tenantId: 'tenant-a' }],",
    "]) {",
    "  assert.equal(canManage(user, resource), false);",
    "}",
    "assert.equal(canManage(null, { tenantId: 'tenant-a' }), false);",
    ""
  ].join("\n"));
  const tableDriven = refreshAcceptanceReceipt(contract({
    summary: "Fix canManage so owner/admin users must be active and belong to the same non-empty tenant.",
    expectedOutput: "Missing input, inactive users, wrong roles, and cross-tenant resources are denied.",
    acceptanceCriteria: acceptance.acceptanceCriteria,
    acceptanceReceipt: acceptance.receipt,
    changedFiles: ["src/backend/auth.js", "test/auth.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:02:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/auth.js", "test/auth.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(tableDriven.criticalMissing.map((criterion) => criterion.obligation), []);

  fs.mkdirSync(path.join(cwd, "src", "frontend"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "frontend", "pagination.js"), [
    "export function pageCount(totalItems, pageSize) {",
    "  if (!Number.isInteger(totalItems) || totalItems < 0) throw new TypeError('invalid totalItems');",
    "  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new TypeError('invalid pageSize');",
    "  return Math.ceil(totalItems / pageSize);",
    "}",
    "export function clampPage(page, totalItems, pageSize) {",
    "  if (!Number.isInteger(page)) throw new TypeError('invalid page');",
    "  const count = pageCount(totalItems, pageSize);",
    "  return count === 0 ? 0 : Math.min(Math.max(1, page), count);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "pagination.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { clampPage, pageCount } from '../src/frontend/pagination.js';",
    "assert.throws(() => pageCount(-1, 20), TypeError);",
    "assert.throws(() => pageCount(1, 0), TypeError);",
    "assert.equal(clampPage(99, 21, 20), 2);",
    ""
  ].join("\n"));
  const validation = buildAcceptanceReceipt({
    summary: "Correct pageCount and clampPage with TypeError for invalid non-integer and boundary inputs.",
    expectedOutput: "Zero items and ceiling division behave correctly.",
    acceptanceCriteria: ["Pagination boundaries are correct."],
    changeMode: "source-change"
  });
  assert.ok(validation.receipt.criteria.some((criterion) => criterion.obligation === "invalid-input-rejection"));
  assert.ok(validation.receipt.criteria.some((criterion) => criterion.obligation === "boundary-case"));
  const partialValidation = refreshAcceptanceReceipt(contract({
    summary: "Correct `pageCount(totalItems, pageSize)` and `clampPage(page, totalItems, pageSize)` with TypeError for invalid non-integer and boundary inputs.",
    acceptanceCriteria: validation.acceptanceCriteria,
    acceptanceReceipt: validation.receipt,
    changedFiles: ["src/frontend/pagination.js", "test/pagination.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/frontend/pagination.js", "test/pagination.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.ok(partialValidation.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"));

  fs.writeFileSync(path.join(cwd, "test", "pagination.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { clampPage, pageCount } from '../src/frontend/pagination.js';",
    "assert.throws(() => pageCount(-1, 20), TypeError);",
    "assert.throws(() => pageCount(1, 0), TypeError);",
    "assert.throws(() => clampPage(1.2, 10, 5), TypeError);",
    "assert.equal(clampPage(99, 21, 20), 2);",
    ""
  ].join("\n"));
  const completeValidation = refreshAcceptanceReceipt(contract({
    summary: "Correct `pageCount(totalItems, pageSize)` and `clampPage(page, totalItems, pageSize)` with TypeError for invalid non-integer and boundary inputs.",
    acceptanceCriteria: validation.acceptanceCriteria,
    acceptanceReceipt: validation.receipt,
    changedFiles: ["src/frontend/pagination.js", "test/pagination.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/frontend/pagination.js", "test/pagination.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(completeValidation.criticalMissing.map((criterion) => criterion.obligation), []);

  assert.deepEqual(
    acceptanceSemanticConflicts({
      summary: "clampPage clamps an integer page and throws TypeError for invalid pagination inputs.",
      changeMode: "source-change"
    }, {
      sourceText: "export function clampPage(page, totalItems, pageSize) { return Math.min(page, 1); }"
    }),
    ["missing-integer-guard:page"]
  );
  assert.deepEqual(
    acceptanceSemanticConflicts({
      summary: "clampPage clamps an integer page and throws TypeError for invalid pagination inputs.",
      changeMode: "source-change"
    }, {
      sourceText: "export function clampPage(page, totalItems, pageSize) { if (!Number.isInteger(page)) throw new TypeError('page'); return Math.min(page, 1); }"
    }),
    []
  );
  assert.ok(acceptanceSemanticConflicts({
    summary: "Reject invalid money and basis points with TypeError.",
    changeMode: "source-change"
  }, {
    sourceText: "export function total(value) { if (value < 0) throw new RangeError('value'); return value; }"
  }).includes("rangeerror-conflicts-with-requested-typeerror"));

  fs.mkdirSync(path.join(cwd, "src", "data"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "data", "migration.js"), [
    "export function migrateSettings(input = {}) {",
    "  if (input.version === 2) return { ...input };",
    "  return { version: 2, enabled: input.enabled ?? true, retryLimit: input.retries ?? 3, label: input.name ?? 'default' };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "migration.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { migrateSettings } from '../src/data/migration.js';",
    "assert.deepEqual(migrateSettings({ enabled: false, retries: 0, name: '' }), { version: 2, enabled: false, retryLimit: 0, label: '' });",
    "assert.deepEqual(migrateSettings({ enabled: null, retries: null, name: null }), { version: 2, enabled: true, retryLimit: 3, label: 'default' });",
    ""
  ].join("\n"));
  const migration = buildAcceptanceReceipt({
    summary: "Repair migrateSettings. Preserve intentional falsey values false, 0, and empty string. Defaults apply only when nullish.",
    expectedOutput: "A v2 input is returned as an independent copy.",
    changeMode: "source-change"
  });
  const migrationReceipt = refreshAcceptanceReceipt(contract({
    summary: "Repair `migrateSettings(input)` and preserve intentional falsey values false, 0, and empty string. Defaults apply only when nullish.",
    acceptanceCriteria: migration.acceptanceCriteria,
    acceptanceReceipt: migration.receipt,
    changedFiles: ["src/data/migration.js", "test/migration.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/data/migration.js", "test/migration.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(migrationReceipt.criticalMissing.map((criterion) => criterion.obligation), []);

  fs.mkdirSync(path.join(cwd, "src", "platform"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "platform", "config.js"), [
    "export function resolveConfig(cli = {}, defaults = {}) {",
    "  return { port: cli.port ?? defaults.port };",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "config.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { resolveConfig } from '../src/platform/config.js';",
    "assert.deepEqual(resolveConfig({ port: undefined }, { port: 3000 }), { port: 3000 });",
    "assert.deepEqual(resolveConfig({ port: null }, { port: 3000 }), { port: null });",
    ""
  ].join("\n"));
  const configAcceptance = buildAcceptanceReceipt({
    summary: "Fix resolveConfig. A value is absent only when it is undefined; null, false, 0, and empty string must not fall through.",
    expectedOutput: "CLI values take precedence without mutating inputs.",
    changeMode: "source-change"
  });
  const configTask = contract({
    summary: "Fix `resolveConfig(cli, defaults)`. A value is absent only when it is undefined; null, false, 0, and empty string must not fall through.",
    acceptanceCriteria: configAcceptance.acceptanceCriteria,
    acceptanceReceipt: configAcceptance.receipt,
    changedFiles: ["src/platform/config.js", "test/config.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  });
  const conflictingConfig = refreshAcceptanceReceipt(configTask, {
    cwd,
    changedFiles: configTask.changedFiles,
    currentWorkingTreeDigest: currentDigest
  });
  assert.ok(conflictingConfig.criticalMissing.some((criterion) => criterion.obligation === "boundary-case"));

  fs.writeFileSync(path.join(cwd, "src", "platform", "config.js"), [
    "const firstDefined = (...values) => values.find((value) => value !== undefined);",
    "export function resolveConfig(cli = {}, defaults = {}) {",
    "  return { port: firstDefined(cli.port, defaults.port) };",
    "}",
    ""
  ].join("\n"));
  const correctConfig = refreshAcceptanceReceipt(configTask, {
    cwd,
    changedFiles: configTask.changedFiles,
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(correctConfig.criticalMissing.some((criterion) => criterion.obligation === "boundary-case"), false);

  const discount = buildAcceptanceReceipt({
    summary: "Implement percentage discounts for orders. Preserve both exported APIs and reject no valid zero values.",
    expectedOutput: "Zero subtotal and zero percent remain valid boundary inputs.",
    changeMode: "source-change"
  });
  assert.equal(
    discount.receipt.criteria.some((criterion) => criterion.obligation === "invalid-input-rejection"),
    false
  );
  assert.ok(discount.receipt.criteria.some((criterion) => criterion.obligation === "boundary-case"));
  fs.mkdirSync(path.join(cwd, "src", "sales"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "sales", "discount.js"), [
    "export function discountAmount(subtotal, percent) {",
    "  return subtotal * (percent / 100);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "discount.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { discountAmount } from '../src/sales/discount.js';",
    "assert.equal(discountAmount(20, 0), 0);",
    "assert.equal(discountAmount(20, 100), 20);",
    ""
  ].join("\n"));
  const discountReceipt = refreshAcceptanceReceipt(contract({
    summary: "Implement `discountAmount(subtotal, percent)` and reject no valid zero values.",
    acceptanceCriteria: discount.acceptanceCriteria,
    acceptanceReceipt: discount.receipt,
    changedFiles: ["src/sales/discount.js", "test/discount.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/sales/discount.js", "test/discount.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(discountReceipt.criticalMissing.map((criterion) => criterion.obligation), []);

  fs.mkdirSync(path.join(cwd, "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "auth", "session.js"), [
    "export function isSessionValid(session, now = Date.now()) {",
    "  return session.expiresAt > now;",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "session.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { isSessionValid } from '../src/auth/session.js';",
    "assert.equal(isSessionValid({ expiresAt: 101 }, 100), true);",
    "assert.equal(isSessionValid({ expiresAt: 100 }, 100), false);",
    "assert.equal(isSessionValid({ expiresAt: 99 }, 100), false);",
    ""
  ].join("\n"));
  const sessionExpiry = buildAcceptanceReceipt({
    summary: "Fix session expiry: valid only when expiresAt is later than now; equality is expired.",
    expectedOutput: "Past, future, and exact expiry boundary are covered.",
    changeMode: "source-change"
  });
  const expiryReceipt = refreshAcceptanceReceipt(contract({
    summary: "Fix `isSessionValid(session, now)` so equality is expired and future expiresAt is valid.",
    acceptanceCriteria: sessionExpiry.acceptanceCriteria,
    acceptanceReceipt: sessionExpiry.receipt,
    changedFiles: ["src/auth/session.js", "test/session.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/auth/session.js", "test/session.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(expiryReceipt.criticalMissing.map((criterion) => criterion.obligation), []);

  const staleSearch = buildAcceptanceReceipt({
    summary: "Fix stale request handling. Only a success or failure whose requestId equals the current state's requestId may complete the active search.",
    expectedOutput: "Stale completions return the existing state object unchanged.",
    changeMode: "source-change"
  });
  assert.equal(
    staleSearch.receipt.criteria.some((criterion) => criterion.obligation === "authorization-deny-case"),
    false
  );

  fs.mkdirSync(path.join(cwd, "src", "data"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "data", "csv.js"), [
    "export function parseCsv(input) {",
    "  if (String(input).startsWith('\\\"')) throw new SyntaxError('unterminated quoted field at index 0');",
    "  return [[String(input)]];",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "csv.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { parseCsv } from '../src/data/csv.js';",
    "assert.throws(",
    "  () => parseCsv('\\\"unterminated'),",
    "  (error) => error instanceof SyntaxError && /unterminated quoted field/.test(error.message)",
    ");",
    ""
  ].join("\n"));
  const csv = buildAcceptanceReceipt({
    summary: "Replace `parseCsv(input)` and throw `SyntaxError` for an unterminated quoted field.",
    expectedOutput: "Invalid quoted CSV is rejected.",
    changeMode: "source-change"
  });
  const csvReceipt = refreshAcceptanceReceipt(contract({
    summary: "Replace `parseCsv(input)` and throw `SyntaxError` for an unterminated quoted field.",
    acceptanceCriteria: csv.acceptanceCriteria,
    acceptanceReceipt: csv.receipt,
    changedFiles: ["src/data/csv.js", "test/csv.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/data/csv.js", "test/csv.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(csvReceipt.criticalMissing.map((criterion) => criterion.obligation), []);

  fs.mkdirSync(path.join(cwd, "src", "reliability"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "reliability", "retry.js"), [
    "export async function retry(operation, options = {}) {",
    "  if (typeof operation !== 'function') throw new TypeError('operation must be a function');",
    "  if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');",
    "  return operation(1);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "retry.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { retry } from '../src/reliability/retry.js';",
    "await assert.rejects(",
    "  () => retry(null, { maxAttempts: 1 }),",
    "  TypeError",
    ");",
    "await assert.rejects(",
    "  () => retry(async () => 'ok', { maxAttempts: 0 }),",
    "  TypeError",
    ");",
    ""
  ].join("\n"));
  const retryReceiptSource = buildAcceptanceReceipt({
    summary: "Correct `retry(operation, options)`. `maxAttempts` must be a positive integer and invalid inputs reject with TypeError.",
    expectedOutput: "Async invalid input tests cover operation and options.",
    changeMode: "source-change"
  });
  const retryReceipt = refreshAcceptanceReceipt(contract({
    summary: "Correct `retry(operation, options)` and reject invalid maxAttempts.",
    acceptanceCriteria: retryReceiptSource.acceptanceCriteria,
    acceptanceReceipt: retryReceiptSource.receipt,
    changedFiles: ["src/reliability/retry.js", "test/retry.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/reliability/retry.js", "test/retry.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.deepEqual(retryReceipt.criticalMissing.map((criterion) => criterion.obligation), []);
});

test("acceptance proof scopes named entrypoints to their originating contract clause", (t) => {
  const cwd = temporaryProject(t, "piagent-acceptance-clause-scope-");
  const currentDigest = treeDigest("e");
  const searchCriteria = [
    "[S1] `normalizeQuery(value)` stringifies non-nullish values, applies Unicode NFD normalization, removes every Unicode combining mark, trims, collapses whitespace, and lowercases. Nullish input becomes an empty string.",
    "[S2] `searchCatalog(items, query, options)` requires `items` to be an array and must not mutate it. Import and use the shared `normalizeQuery` to search each normalized name and only tags whose values are strings; ignore all non-string tags. Preserve input order and return at most `limit` results. An empty normalized query matches every item. Omitted `options` defaults to a new empty object; when supplied it must be a non-null, non-array object. `limit` defaults to 20 and must be a positive safe integer or throw `TypeError`.",
    "[S3] `renderSearchResults(results)` requires an array and returns exactly one `<ul aria-label=\"Search results\">` with one ordered `<li data-id=\"...\">` per result. Escape both ids and names for `&`, `<`, `>`, `\"`, and `'`. Empty results return `<ul aria-label=\"Search results\"></ul>`.",
    "Preserve exports and add focused tests. Change only the declared source/test scope."
  ];
  const built = buildAcceptanceReceipt({
    summary: "Implement one shared backend/frontend search contract.",
    expectedOutput: "The requested bounded change is implemented and passes the configured verification.",
    acceptanceCriteria: searchCriteria,
    changeMode: "source-change",
    source: "runtime"
  });
  fs.mkdirSync(path.join(cwd, "packages", "shared", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "services", "catalog", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "apps", "web", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "shared", "src", "search-contract.js"), [
    "export function normalizeQuery(value) {",
    "  return value == null ? '' : String(value).normalize('NFD').replace(/\\p{M}/gu, '').trim().replace(/\\s+/g, ' ').toLowerCase();",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "services", "catalog", "src", "search.js"), [
    "export function searchCatalog(items, query, options = {}) {",
    "  if (!Array.isArray(items) || options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('invalid input');",
    "  const limit = options.limit === undefined ? 20 : options.limit;",
    "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('invalid limit');",
    "  return items.slice(0, limit);",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "apps", "web", "src", "search-view.js"), [
    "export function renderSearchResults(results) {",
    "  if (!Array.isArray(results)) throw new TypeError('results');",
    "  return '<ul aria-label=\"Search results\"></ul>';",
    "}",
    ""
  ].join("\n"));
  const testPath = path.join(cwd, "test", "search-contract.test.js");
  const completeTests = [
    "import assert from 'node:assert/strict';",
    "import { normalizeQuery } from '../packages/shared/src/search-contract.js';",
    "import { searchCatalog } from '../services/catalog/src/search.js';",
    "import { renderSearchResults } from '../apps/web/src/search-view.js';",
    "assert.equal(normalizeQuery(null), '');",
    "assert.throws(() => searchCatalog(null, '', {}), TypeError);",
    "assert.throws(() => searchCatalog([], '', null), TypeError);",
    "assert.throws(() => searchCatalog([], '', { limit: 0 }), TypeError);",
    "assert.throws(() => renderSearchResults(null), TypeError);",
    ""
  ].join("\n");
  fs.writeFileSync(testPath, completeTests);
  const changedFiles = [
    "packages/shared/src/search-contract.js",
    "services/catalog/src/search.js",
    "apps/web/src/search-view.js",
    "test/search-contract.test.js"
  ];
  const task = () => contract({
    summary: "Implement one shared backend/frontend search contract.",
    acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: structuredClone(built.receipt),
    changedFiles,
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-09T00:00:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  });
  const complete = refreshAcceptanceReceipt(task(), { cwd, changedFiles, currentWorkingTreeDigest: currentDigest });
  assert.equal(complete.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"), false);

  fs.writeFileSync(testPath, completeTests
    .split("\n")
    .filter((line) => !line.includes("searchCatalog"))
    .join("\n"));
  const missingTargetProof = refreshAcceptanceReceipt(task(), { cwd, changedFiles, currentWorkingTreeDigest: currentDigest });
  assert.equal(missingTargetProof.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"), true);
});

test("acceptance inference distinguishes lease ownership from access authorization", (t) => {
  const cwd = temporaryProject(t, "piagent-acceptance-lease-owner-");
  const currentDigest = treeDigest("f");
  const leaseCriteria = [
    "[L1] Every store method validates each argument it receives. Keys and owners are strings containing at least one non-whitespace character; they are not otherwise normalized. `now` is finite and non-negative, and `ttlMs` is positive and finite. Invalid input throws `TypeError`. Numeric validation is identical in `acquire` and `renew`.",
    "[L2] `acquire` returns a boolean. It succeeds when the key is absent, when the prior lease is expired at the inclusive boundary (`now >= expiresAt`), or when the same owner reacquires it. A different owner cannot overwrite a live lease. A successful acquire sets `expiresAt` to `now + ttlMs`.",
    "[L3] `renew` and `release` return booleans and succeed only for the current owner. `renew` also requires a live lease (`now < expiresAt`). `current` returns a fresh `{ owner, expiresAt }` snapshot, or `undefined` when absent; it never exposes internal mutable state.",
    "[L4] `withLease` throws an error containing `busy` when acquisition fails. It calls `operation(renew)` with a bare `renew(now)` callback, returns the operation result, and releases in `finally` after success or failure. Its cleanup must not delete a lease that changed owner after expiry.",
    "Preserve signatures and add deterministic concurrency/lifecycle tests. Change only the declared source/test scope."
  ];
  const built = buildAcceptanceReceipt({
    summary: "Complete the lease store and withLease lifecycle.",
    expectedOutput: "The requested bounded change is implemented and passes the configured verification.",
    acceptanceCriteria: leaseCriteria,
    changeMode: "source-change",
    source: "runtime"
  });
  assert.equal(built.receipt.criteria.some((criterion) => criterion.obligation === "authorization-deny-case"), false);
  assert.equal(built.receipt.criteria.some((criterion) => criterion.obligation === "invalid-input-rejection"), true);

  fs.mkdirSync(path.join(cwd, "packages", "lease", "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "lease", "src", "store.js"), [
    "function validText(value) { if (typeof value !== 'string' || !/\\S/.test(value)) throw new TypeError('invalid text'); }",
    "function validNow(value) { if (!Number.isFinite(value) || value < 0) throw new TypeError('invalid now'); }",
    "function validTtl(value) { if (!Number.isFinite(value) || value <= 0) throw new TypeError('invalid ttl'); }",
    "export class LeaseStore {",
    "  acquire(key, owner, now, ttlMs) { validText(key); validText(owner); validNow(now); validTtl(ttlMs); return true; }",
    "  renew(key, owner, now, ttlMs) { validText(key); validText(owner); validNow(now); validTtl(ttlMs); return false; }",
    "  release(key, owner) { validText(key); validText(owner); return false; }",
    "  current(key) { validText(key); return undefined; }",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "packages", "lease", "src", "with-lease.js"), "export async function withLease(store, key, owner, options, operation) { return operation((now) => store.renew(key, owner, now, options.ttlMs)); }\n");
  fs.writeFileSync(path.join(cwd, "test", "lease.test.js"), [
    "import assert from 'node:assert/strict';",
    "assert.throws(() => store.acquire('', 'owner', 0, 1), TypeError);",
    "assert.throws(() => store.acquire('key', 'owner', -1, 1), TypeError);",
    "assert.throws(() => store.renew('key', 'owner', 0, 0), TypeError);",
    "assert.equal(store.acquire('key', 'owner-a', 10, 1), true); // inclusive expiry boundary",
    "assert.equal(store.acquire('key', 'owner-b', 9, 1), false);",
    "assert.equal(store.renew('key', 'owner-b', 9, 1), false);",
    "assert.equal(store.release('key', 'owner-b'), false);",
    ""
  ].join("\n"));
  const changedFiles = ["packages/lease/src/store.js", "packages/lease/src/with-lease.js", "test/lease.test.js"];
  const refreshed = refreshAcceptanceReceipt(contract({
    summary: "Complete the lease store and withLease lifecycle.",
    acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt,
    changedFiles,
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-09T00:00:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), { cwd, changedFiles, currentWorkingTreeDigest: currentDigest });
  assert.equal(refreshed.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"), false);

  const leaseTests = path.join(cwd, "test", "lease.test.js");
  fs.writeFileSync(leaseTests, fs.readFileSync(leaseTests, "utf8")
    .split("\n")
    .filter((line) => !line.includes("store.renew('key', 'owner', 0, 0)"))
    .join("\n"));
  const missingRenewProof = refreshAcceptanceReceipt(contract({
    summary: "Complete the lease store and withLease lifecycle.",
    acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: structuredClone(built.receipt),
    changedFiles,
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-09T00:00:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), { cwd, changedFiles, currentWorkingTreeDigest: currentDigest });
  assert.equal(missingRenewProof.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"), true);

  const ownerAuthorization = buildAcceptanceReceipt({
    summary: "Only the owner user may manage the resource; all other users are denied.",
    expectedOutput: "Unauthorized resource access is rejected.",
    changeMode: "source-change"
  });
  assert.equal(ownerAuthorization.receipt.criteria.some((criterion) => criterion.obligation === "authorization-deny-case"), true);
});

test("acceptance evidence recognizes assertion helpers and tenant-keyed storage without weakening proof", (t) => {
  const cwd = temporaryProject(t);
  const currentDigest = treeDigest("c");
  fs.mkdirSync(path.join(cwd, "src", "backend"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "backend", "invoice.js"), [
    "export function invoiceTotalCents(items, taxBps = 0) {",
    "  if (!Array.isArray(items) || !Number.isSafeInteger(taxBps)) throw new TypeError('invalid invoice');",
    "  return Math.round(items.length * (1 + taxBps / 10_000));",
    "}",
    ""
  ].join("\n"));
  const invoiceAcceptance = buildAcceptanceReceipt({
    summary: "Fix `invoiceTotalCents(items, taxBps)` and reject invalid integer inputs with TypeError.",
    expectedOutput: "Zero and inclusive rounding boundaries remain covered.",
    changeMode: "source-change"
  });
  const invoiceTask = () => contract({
    summary: "Fix `invoiceTotalCents(items, taxBps)` and reject invalid integer inputs with TypeError.",
    acceptanceCriteria: invoiceAcceptance.acceptanceCriteria,
    acceptanceReceipt: invoiceAcceptance.receipt,
    changedFiles: ["src/backend/invoice.js", "test/invoice.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  });
  fs.writeFileSync(path.join(cwd, "test", "invoice.test.js"), [
    "import assert from 'node:assert/strict';",
    "import { invoiceTotalCents } from '../src/backend/invoice.js';",
    "const throwsTypeError = (fn) => assert.throws(fn, TypeError);",
    "throwsTypeError(() => invoiceTotalCents(null, 0));",
    "throwsTypeError(() => invoiceTotalCents([], 1.5));",
    "assert.equal(invoiceTotalCents([], 0), 0);",
    ""
  ].join("\n"));
  const helperProof = refreshAcceptanceReceipt(invoiceTask(), {
    cwd,
    changedFiles: ["src/backend/invoice.js", "test/invoice.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(helperProof.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"), false);

  const weakInvoiceAcceptance = buildAcceptanceReceipt({
    summary: "Fix `invoiceTotalCents(items, taxBps)` and reject invalid integer inputs with TypeError.",
    expectedOutput: "Zero and inclusive rounding boundaries remain covered.",
    changeMode: "source-change"
  });
  fs.writeFileSync(path.join(cwd, "test", "invoice.test.js"), [
    "import { invoiceTotalCents } from '../src/backend/invoice.js';",
    "const throwsTypeError = (fn) => fn();",
    "throwsTypeError(() => invoiceTotalCents(null, 0));",
    ""
  ].join("\n"));
  const weakProof = refreshAcceptanceReceipt(contract({
    summary: "Fix `invoiceTotalCents(items, taxBps)` and reject invalid integer inputs with TypeError.",
    acceptanceCriteria: weakInvoiceAcceptance.acceptanceCriteria,
    acceptanceReceipt: weakInvoiceAcceptance.receipt,
    changedFiles: ["src/backend/invoice.js", "test/invoice.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/invoice.js", "test/invoice.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.ok(weakProof.criticalMissing.some((criterion) => criterion.obligation === "invalid-input-rejection"));

  fs.writeFileSync(path.join(cwd, "src", "backend", "cache.js"), [
    "export class TenantCache {",
    "  #values = new Map();",
    "  set(tenantId, key, value) {",
    "    if (!tenantId) return;",
    "    const tenant = this.#values.get(tenantId) ?? new Map();",
    "    tenant.set(key, value);",
    "    this.#values.set(tenantId, tenant);",
    "  }",
    "  get(tenantId, key) { return tenantId ? this.#values.get(tenantId)?.get(key) : undefined; }",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "cache.test.js"), [
    "import assert from 'node:assert/strict';",
    "// same-tenant allow",
    "assert.equal(cache.get(tenantId, key), 'value');",
    "// cross-tenant / another tenant deny",
    "assert.equal(cache.get(otherTenantId, key), undefined);",
    "// empty or missing tenant deny",
    "assert.equal(cache.get('', key), undefined);",
    ""
  ].join("\n"));
  const tenantAcceptance = buildAcceptanceReceipt({
    summary: "Isolate TenantCache values by tenantId.",
    expectedOutput: "Same-tenant access works; cross-tenant and empty or missing tenant access is denied.",
    changeMode: "source-change"
  });
  const tenantProof = refreshAcceptanceReceipt(contract({
    summary: "Isolate TenantCache values by tenantId.",
    acceptanceCriteria: tenantAcceptance.acceptanceCriteria,
    acceptanceReceipt: tenantAcceptance.receipt,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(tenantProof.criticalMissing.some((criterion) => criterion.obligation === "tenant-storage-isolation"), false);

  fs.writeFileSync(path.join(cwd, "src", "backend", "cache.js"), [
    "export class TenantCache {",
    "  #values = new Map();",
    "  #key(tenantId, entity, id) { return JSON.stringify([String(tenantId), String(entity), String(id)]); }",
    "  set(tenantId, entity, id, value) { this.#values.set(this.#key(tenantId, entity, id), value); }",
    "  get(tenantId, entity, id) { return this.#values.get(this.#key(tenantId, entity, id)); }",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "cache.test.js"), [
    "import assert from 'node:assert/strict';",
    "const cache = new TenantCache();",
    "cache.set('tenant-a', 'invoice', '42', 'first');",
    "cache.set('tenant-b', 'invoice', '42', 'second');",
    "cache.set('tenant:entity', 'id', 'first', 'punctuation');",
    "assert.equal(cache.get('tenant-a', 'invoice', '42'), 'first');",
    "assert.equal(cache.get('tenant-b', 'invoice', '42'), 'second');",
    "assert.equal(cache.get('tenant:entity', 'id', 'first'), 'punctuation');",
    ""
  ].join("\n"));
  const structuredAcceptance = buildAcceptanceReceipt({
    summary: "TenantCache must isolate entries by tenantId, entity, and id without punctuation collisions.",
    expectedOutput: "Structured identity round trips without ambiguous composite keys.",
    changeMode: "source-change"
  });
  const structuredProof = refreshAcceptanceReceipt(contract({
    summary: "TenantCache must isolate entries by tenantId, entity, and id without punctuation collisions.",
    acceptanceCriteria: structuredAcceptance.acceptanceCriteria,
    acceptanceReceipt: structuredAcceptance.receipt,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:01:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(structuredProof.criticalMissing.some((criterion) => criterion.obligation === "tenant-storage-isolation"), false);

  fs.writeFileSync(path.join(cwd, "src", "backend", "cache.js"), [
    "export class TenantCache {",
    "  #values = new Map();",
    "  #key(tenantId, entity, id) {",
    "    return [tenantId, entity, id].map((component) => {",
    "      const value = String(component);",
    "      return `${value.length}:${value}`;",
    "    }).join('|');",
    "  }",
    "  set(tenantId, entity, id, value) { this.#values.set(this.#key(tenantId, entity, id), value); }",
    "  get(tenantId, entity, id) { return this.#values.get(this.#key(tenantId, entity, id)); }",
    "}",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(cwd, "test", "cache.test.js"), [
    "const cache = new TenantCache();",
    "const identity = ['tenant:one', 'entity:id', 'record:1'];",
    "cache.set(...identity, 'value');",
    "assert.equal(cache.get(...identity), 'value');",
    "cache.set('tenant', 'entity:a', 'b:c', 'left');",
    "cache.set('tenant', 'entity:a:b', 'c', 'right');",
    "assert.equal(cache.get('tenant', 'entity:a', 'b:c'), 'left');",
    "assert.equal(cache.get('tenant', 'entity:a:b', 'c'), 'right');",
    ""
  ].join("\n"));
  const lengthPrefixedProof = refreshAcceptanceReceipt(contract({
    summary: "TenantCache must isolate entries by tenantId, entity, and id without punctuation collisions.",
    acceptanceCriteria: structuredAcceptance.acceptanceCriteria,
    acceptanceReceipt: structuredAcceptance.receipt,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:02:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(lengthPrefixedProof.criticalMissing.some((criterion) => criterion.obligation === "tenant-storage-isolation"), false);

  fs.writeFileSync(path.join(cwd, "src", "backend", "cache.js"), [
    "export class TenantCache {",
    "  #values = new Map();",
    "  #key(tenantId, entity, id) {",
    "    return [tenantId, entity, id]",
    "      .map((component) => String(component))",
    "      .map((component) => `${component.length}:${component}`)",
    "      .join('');",
    "  }",
    "  set(tenantId, entity, id, value) { this.#values.set(this.#key(tenantId, entity, id), value); }",
    "  get(tenantId, entity, id) { return this.#values.get(this.#key(tenantId, entity, id)); }",
    "}",
    ""
  ].join("\n"));
  const chainedLengthPrefixedProof = refreshAcceptanceReceipt(contract({
    summary: "TenantCache must isolate entries by tenantId, entity, and id without punctuation collisions.",
    acceptanceCriteria: structuredAcceptance.acceptanceCriteria,
    acceptanceReceipt: structuredAcceptance.receipt,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "pass", recordedAt: "2026-08-03T00:03:00.000Z", observed: true, matchedProfileCommand: true, preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest }]
  }), {
    cwd,
    changedFiles: ["src/backend/cache.js", "test/cache.test.js"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(chainedLengthPrefixedProof.criticalMissing.some((criterion) => criterion.obligation === "tenant-storage-isolation"), false);
});

test("acceptance semantic conflicts preserve the baseline return element representation", (t) => {
  const cwd = temporaryProject(t);
  fs.mkdirSync(path.join(cwd, "src", "platform"), { recursive: true });
  const sourcePath = path.join(cwd, "src", "platform", "workspace.js");
  fs.writeFileSync(sourcePath, [
    "export function workspaceOrder(packages) {",
    "  const byName = new Map(packages.map((item) => [item.name, item]));",
    "  const result = [];",
    "  const visited = new Set();",
    "  function visit(name) {",
    "    if (visited.has(name)) return;",
    "    visited.add(name);",
    "    result.push(name);",
    "    for (const dependency of byName.get(name)?.dependencies ?? []) visit(dependency);",
    "  }",
    "  for (const item of packages) visit(item.name);",
    "  return result;",
    "}",
    ""
  ].join("\n"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "piagent@example.invalid"], { cwd });
  execFileSync("git", ["config", "user.name", "Piagent Test"], { cwd });
  execFileSync("git", ["add", "src/platform/workspace.js"], { cwd });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
  const task = contract({
    summary: "Fix dependency order without changing the public API or mutating input.",
    changedFiles: ["src/platform/workspace.js"]
  });
  assert.deepEqual(acceptanceBaselineGuidance({ ...task, scope: ["src/platform/workspace.js", "test/**"] }, { cwd }), [
    "Existing public return elements in src/platform/workspace.js are names/identifiers, not object values; preserve that representation unless the request explicitly changes it."
  ]);

  fs.writeFileSync(sourcePath, [
    "export function workspaceOrder(packages) {",
    "  const result = [];",
    "  for (const index of packages.keys()) result.push(packages[index]);",
    "  return result;",
    "}",
    ""
  ].join("\n"));
  assert.deepEqual(acceptanceSemanticConflicts(task, {
    cwd,
    changedFiles: task.changedFiles
  }), ["public-return-representation-changed:name-to-object:src/platform/workspace.js"]);

  assert.deepEqual(acceptanceBaselineGuidance({ ...task, scope: ["src/platform/workspace.js", "test/**"] }, { cwd }), [
    "Existing public return elements in src/platform/workspace.js are object values, not names/identifiers; preserve that representation unless the request explicitly changes it."
  ]);

  fs.writeFileSync(sourcePath, [
    "export function workspaceOrder(packages) {",
    "  const byName = new Map(packages.map((item) => [item.name, item]));",
    "  const result = [];",
    "  for (const name of byName.keys()) result.push(byName.get(name));",
    "  return result;",
    "}",
    ""
  ].join("\n"));
  assert.deepEqual(acceptanceSemanticConflicts(task, {
    cwd,
    changedFiles: task.changedFiles
  }), ["public-return-representation-changed:name-to-object:src/platform/workspace.js"]);

  fs.writeFileSync(sourcePath, [
    "export function workspaceOrder(packages) {",
    "  const result = [];",
    "  for (const item of packages) result.push(item.name);",
    "  return result;",
    "}",
    ""
  ].join("\n"));
  assert.deepEqual(acceptanceSemanticConflicts(task, {
    cwd,
    changedFiles: task.changedFiles
  }), []);
  assert.deepEqual(acceptanceBaselineGuidance({ ...task, scope: ["src/platform/workspace.js", "test/**"] }, { cwd }), [
    "Existing public return elements in src/platform/workspace.js are names/identifiers, not object values; preserve that representation unless the request explicitly changes it."
  ]);
});

test("acceptance receipt recognizes read-only boundaries inside source-change plan packets", (t) => {
  const cwd = temporaryProject(t);
  fs.mkdirSync(path.join(cwd, "plans", "2026-08-04-be-to-fe-remediation"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "plans", "2026-08-04-be-to-fe-remediation", "plan.md"), [
    "# BE-to-FE plan",
    "",
    "Backend remains read-only. Do not modify `v-nexus-backend/**`.",
    "All edits in this packet are limited to `plans/**`.",
    ""
  ].join("\n"));
  const currentDigest = treeDigest("b");
  const acceptance = buildAcceptanceReceipt({
    summary: "Create backend-to-frontend markdown plan files without touching backend sources.",
    expectedOutput: "Document BE read-only boundary and keep v-nexus-backend out of scope.",
    acceptanceCriteria: ["Document BE read-only boundary and explicitly keep v-nexus-backend out of scope."],
    changeMode: "source-change",
    source: "runtime",
    generatedAt: "2026-08-04T00:00:00.000Z"
  });
  assert.ok(acceptance.receipt.criteria.some((criterion) => criterion.obligation === "read-only-evidence"));

  const plannedOnly = refreshAcceptanceReceipt(contract({
    summary: "Create backend-to-frontend markdown plan files without touching backend sources.",
    expectedOutput: "Document BE read-only boundary and keep v-nexus-backend out of scope.",
    acceptanceCriteria: acceptance.acceptanceCriteria,
    acceptanceReceipt: acceptance.receipt,
    scope: ["plans/**"],
    outOfScope: ["v-nexus-backend/**"],
    changedFiles: ["plans/2026-08-04-be-to-fe-remediation/plan.md"],
    contextManifest: [{ path: "v-nexus-frontend/docs/frontend/structure-guide.md", reason: "criterion-01 scope target" }]
  }), {
    cwd,
    changedFiles: ["plans/2026-08-04-be-to-fe-remediation/plan.md"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(plannedOnly.criticalMissing.some((criterion) => criterion.obligation === "read-only-evidence"), true,
    "planned criterion context is not observed read-only evidence");

  const complete = refreshAcceptanceReceipt(contract({
    summary: "Create backend-to-frontend markdown plan files without touching backend sources.",
    expectedOutput: "Document BE read-only boundary and keep v-nexus-backend out of scope.",
    acceptanceCriteria: acceptance.acceptanceCriteria,
    acceptanceReceipt: acceptance.receipt,
    scope: ["plans/**"],
    outOfScope: ["v-nexus-backend/**"],
    changedFiles: ["plans/2026-08-04-be-to-fe-remediation/plan.md"],
    contextManifest: [{ path: "v-nexus-frontend/docs/frontend/structure-guide.md", reason: "Runtime observed successful source read." }]
  }), {
    cwd,
    changedFiles: ["plans/2026-08-04-be-to-fe-remediation/plan.md"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(complete.criticalMissing.some((criterion) => criterion.obligation === "read-only-evidence"), false);
  assert.ok(complete.receipt.criteria.some((criterion) => (
    criterion.obligation === "read-only-evidence"
    && criterion.status === "satisfied"
    && criterion.evidence.some((item) => item.kind === "source-change-read-only-boundary")
  )));

  const backendChanged = refreshAcceptanceReceipt(contract({
    summary: "Create backend-to-frontend markdown plan files without touching backend sources.",
    expectedOutput: "Document BE read-only boundary and keep v-nexus-backend out of scope.",
    acceptanceCriteria: acceptance.acceptanceCriteria,
    acceptanceReceipt: acceptance.receipt,
    scope: ["plans/**"],
    outOfScope: ["v-nexus-backend/**"],
    changedFiles: ["v-nexus-backend/src/api.ts"],
    contextManifest: [{ path: "v-nexus-backend/src/api.ts", reason: "Runtime observed successful source read." }]
  }), {
    cwd,
    changedFiles: ["v-nexus-backend/src/api.ts"],
    currentWorkingTreeDigest: currentDigest
  });
  assert.equal(backendChanged.criticalMissing.some((criterion) => criterion.obligation === "read-only-evidence"), true);
});

test("exact final-output contracts reject truncated source-derived values", (t) => {
  const cwd = temporaryProject(t);
  fs.mkdirSync(path.join(cwd, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "logs", "incident.log"),
    "service=jobs root_cause=QUEUE_SATURATION_E99CEB030A\n"
  );
  const task = contract({
    changeMode: "read-only",
    summary: "Investigate logs/incident.log, then finish your response with exactly ROOT_CAUSE=<code> using the code present in the log.",
    expectedOutput: "The read-only incident is diagnosed from observed evidence.",
    acceptanceCriteria: ["The final response addresses the requested diagnostic result."],
    contextManifest: [{ path: "logs/incident.log", reason: "Runtime observed successful source read." }]
  });

  assert.match(exactFinalOutputGuidance(task.summary)[0], /copy the complete value verbatim/i);
  const truncated = evaluateExactFinalOutputContract(
    task,
    "Queue saturation caused the timeout.\nROOT_CAUSE=QUEUE_SATURATION_E99CEB030",
    cwd
  );
  assert.equal(truncated.applicable, true);
  assert.equal(truncated.passed, false);
  assert.deepEqual(truncated.expectedLines, ["ROOT_CAUSE=QUEUE_SATURATION_E99CEB030A"]);
  assert.deepEqual(truncated.evidencePaths, ["logs/incident.log"]);

  const exact = evaluateExactFinalOutputContract(
    task,
    "Queue saturation caused the timeout.\nROOT_CAUSE=QUEUE_SATURATION_E99CEB030A\n",
    cwd
  );
  assert.equal(exact.applicable, true);
  assert.equal(exact.passed, true);
  const plannedOnly = evaluateExactFinalOutputContract({
    ...task,
    contextManifest: [{ path: "logs/incident.log", reason: "criterion-01 scope target" }]
  }, "ROOT_CAUSE=QUEUE_SATURATION_E99CEB030A", cwd);
  assert.equal(plannedOnly.applicable, false, "planned context cannot become exact-output evidence");
  assert.equal(evaluateExactFinalOutputContract({ ...task, summary: "Summarize the incident." }, "Done", cwd).applicable, false);
});

test("execution backend contract keeps OAuth with Pi host and gates experimental mutation", () => {
  const host = resolveExecutionBackend({ backend: "host" });
  assert.equal(host.credentialsOwner, "pi-host");
  assert.equal(executionBackendAllowsMutation(host).allowed, true);
  const docker = resolveExecutionBackend({ backend: "docker" });
  assert.equal(docker.experimental, true);
  assert.equal(docker.available, false);
  assert.equal(executionBackendAllowsMutation(docker).allowed, false);
  assert.equal(executionBackendAllowsMutation(docker, true).allowed, false);
  const installedDocker = resolveExecutionBackend({ backend: "docker", adapterAvailable: true });
  assert.equal(executionBackendAllowsMutation(installedDocker, true).allowed, true);
  assert.equal(executionBackendAllowsMutation(resolveExecutionBackend({ backend: "typo" }), true).allowed, false);
});

test("benchmark trust helpers pick production for release-sensitive changes", () => {
  assert.equal(BENCHMARK_SCOPE_BANDS.find((band) => band.id === "production").scenarios, 18);
  assert.equal(BENCHMARK_SCOPE_BANDS.find((band) => band.id === "deep-logic").scenarios, 7);
  const longHorizon = BENCHMARK_SCOPE_BANDS.find((band) => band.id === "long-horizon");
  assert.equal(longHorizon.availability, "runnable-provider-free");
  assert.equal(longHorizon.scenarios, 1);
  assert.equal(longHorizon.evidenceLane, "evals/long-horizon-v1/lane.json");
  const privateHoldout = BENCHMARK_SCOPE_BANDS.find((band) => band.id === "private-holdout");
  assert.equal(privateHoldout.scenarios, 6);
  assert.equal(privateHoldout.availability, "external-custody-required");
  assert.equal(privateHoldout.claimTier, "private-holdout");
  assert.equal(privateHoldout.readinessMatrix, "evals/fs4-readiness-matrix.v1.json");
  assert.equal(recommendedBenchmarkBand({ releaseCandidate: true }), "production");
  assert.equal(recommendedBenchmarkBand({ recoveryChange: true }), "production");
  assert.equal(requiresLongHorizonEvidence({ recoveryChange: true }), true);
  assert.equal(recommendedBenchmarkBand({}), "core");
  assert.deepEqual(benchmarkTrustChecklist({
    comparison: {
      pairedUsageRuns: 4,
      qualityGate: true,
      safetyGate: true,
      reliabilityGate: true,
      workflowGate: true,
      qualityNonInferior: true,
      efficiencyEvidenceGate: true,
      primaryEfficiencyGate: true,
      comparisonProtocolGate: { passed: true },
      tokenClaimAllowed: true
    }
  }), {
    hasPairedUsage: true,
    hasQualityGate: true,
    hasSafetyGate: true,
    hasReliabilityGate: true,
    hasWorkflowGate: true,
    hasQualityNonInferior: true,
    hasEfficiencyEvidenceGate: true,
    hasEfficiencyBandCoverageGate: false,
    hasOutcomeEvidenceGate: false,
    hasPairedRegressionGate: false,
    hasFailureAwareEfficiencyGate: false,
    hasPrimaryEfficiencyGate: true,
    hasComparisonProtocolGate: true,
    achievedClaimTier: "unavailable",
    generalizationClaimAllowed: false,
    tokenSavingClaimAllowed: true
  });
  assert.equal(benchmarkTrustChecklist({
    comparison: {
      pairedUsageRuns: 4,
      qualityGate: false,
      safetyGate: true,
      reliabilityGate: true,
      workflowGate: true,
      qualityNonInferior: true,
      efficiencyEvidenceGate: true,
      comparisonProtocolGate: { passed: true },
      tokenClaimAllowed: true
    }
  }).tokenSavingClaimAllowed, false);
});
