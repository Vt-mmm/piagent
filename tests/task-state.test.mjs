import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { createTaskAuthoritySnapshot } from "../packages/piagent-core/capabilities/authority-manifest.ts";
import { compactTaskDetails } from "../packages/piagent-core/extensions/task-contract-view.js";

import {
  activeSessionTask,
  bindSessionTask,
  createTaskRunId,
  hasGitEvidenceRoot,
  isGitWorkingTree,
  listTaskContracts,
  migrateTaskState,
  normalizeTaskContract,
  OPERATOR_REQUEST_MAX_CHARS,
  operatorRequestDigest,
  pathWithinChangeEvidenceRoot,
  repositoryFileManifestDetails,
  resolveTaskContract,
  safeTaskId,
  taskContractValidationErrors,
  taskDigestMigrationArchiveStatus,
  taskStateMigrationStatus,
  usesNestedGitEvidenceRoots,
  workPlanDependencyError,
  workingTreeFiles,
  workingTreeSnapshot,
  workingTreeSnapshotHasUnavailableEvidence,
  writeTaskContract
} from "../packages/piagent-core/extensions/task-state.js";
import { appendTaskJournalEvent, readTaskJournal } from "../packages/piagent-core/extensions/task-journal.js";
import { taskDigestMigrationEvidenceBindings } from "../packages/piagent-core/extensions/task-digest-state.js";
import { versionWorkingTreeHash, workingTreeCarrierDigest, workingTreeEvidenceDigest, workingTreeObservation, workingTreeSnapshotUsesCurrentAlgorithm } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { operatorRequestCarryLines } from "../packages/piagent-core/runtime/session/operator-request-carry.ts";

test("safe task ids stay normalized and idempotent after bounded truncation", () => {
  const longPrompt = "Complete the lease store and withLease lifecycle in packages/lease/src/store.js - preserve every concurrency boundary";
  const taskId = safeTaskId(longPrompt);
  assert.ok(taskId.length <= 80);
  assert.doesNotMatch(taskId, /-$/);
  assert.equal(safeTaskId(taskId), taskId);
});

test("working-tree digest primitives distinguish observed empty state from absent or malformed evidence", () => {
  const digest = versionWorkingTreeHash("a".repeat(64));
  assert.match(workingTreeEvidenceDigest({}), /^wt-content-v2:/);
  for (const value of [null, undefined, [], new Date(0), new Map(), new Set(), { file: 123 }]) {
    assert.match(workingTreeEvidenceDigest(value), /^legacy-untrusted:/);
    assert.equal(workingTreeSnapshotUsesCurrentAlgorithm(value), false);
  }
  assert.equal(workingTreeSnapshotUsesCurrentAlgorithm({}), true);
  assert.equal(workingTreeSnapshotUsesCurrentAlgorithm({ file: digest }), true);
  assert.equal(workingTreeCarrierDigest("baseline", ["file"], { file: digest }), workingTreeCarrierDigest("baseline", ["file"], { file: digest }));
  assert.notEqual(workingTreeCarrierDigest("baseline", ["file"], { file: digest }), workingTreeCarrierDigest("final", ["file"], { file: digest }));
  assert.throws(() => workingTreeCarrierDigest("baseline", ["file"], { file: 1 }), /malformed/);
  const unicodeLeft = { "é.ts": digest, "z.ts": digest, "中.ts": digest }, unicodeRight = { "中.ts": digest, "z.ts": digest, "é.ts": digest };
  assert.equal(workingTreeEvidenceDigest(unicodeLeft), workingTreeEvidenceDigest(unicodeRight));
  assert.equal(workingTreeCarrierDigest("final", Object.keys(unicodeLeft), unicodeLeft), workingTreeCarrierDigest("final", Object.keys(unicodeRight), unicodeRight));
  const mutable = { "z.ts": digest, "a.ts": digest };
  const observation = workingTreeObservation(mutable);
  mutable["a.ts"] = versionWorkingTreeHash("b".repeat(64));
  assert.deepEqual(Object.keys(observation.snapshot), ["a.ts", "z.ts"]);
  assert.equal(observation.snapshot["a.ts"], digest, "an event observation owns one immutable snapshot");
  assert.equal(observation.digest, workingTreeEvidenceDigest(observation.snapshot));
  assert.equal(observation.proofCapable, true);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.snapshot), true);
  const unavailable = workingTreeObservation({ file: `wt-content-v2-unavailable:${"c".repeat(64)}` });
  assert.equal(unavailable.proofCapable, false);
  assert.match(unavailable.digest, /^wt-content-v2-unavailable:/);
  assert.throws(() => workingTreeObservation([]), /snapshot record/);
});

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-state-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
  return cwd;
}

test("repository manifest reports truncation instead of claiming a complete singleton", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "a.test.js"), "a\n");
  fs.writeFileSync(path.join(cwd, "b.test.js"), "b\n");
  fs.writeFileSync(path.join(cwd, "c.test.js"), "c\n");
  const manifest = repositoryFileManifestDetails(cwd, 2);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.candidateCount, 3);
});

function childGitRepo(cwd, files) {
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "fixture"]);
}

test("repository manifest includes loose workspace files beside nested git roots", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-manifest-workspace-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  childGitRepo(path.join(cwd, "service"), { "src/value.js": "export const value = 1;\n" });
  fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "test", "workspace.test.js"), "test('workspace', () => {});\n");

  const manifest = repositoryFileManifestDetails(cwd);
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.files, ["service/src/value.js", "test/workspace.test.js"]);
  const truncated = repositoryFileManifestDetails(cwd, 1);
  assert.equal(truncated.complete, false);
  assert.equal(truncated.candidateCount, 2);
});

test("repository manifest captures hidden project source but excludes private and credential state", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-manifest-hidden-workspace-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  childGitRepo(path.join(cwd, "service"), { "src/value.js": "export const value = 1;\n" });
  fs.mkdirSync(path.join(cwd, ".claude", "scripts", "verify"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "notes", ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "scripts", "verify", "check-fe-form-contract.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(cwd, ".codex", "instructions.md"), "local trust state\n");
  fs.writeFileSync(path.join(cwd, "notes", ".cursor", "rules.md"), "local editor state\n");
  fs.writeFileSync(path.join(cwd, ".npmrc"), "registry=https://registry.example.invalid/\n");
  fs.writeFileSync(path.join(cwd, ".pi", "private.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, "notes", "visible.md"), "workspace note\n");

  const manifest = repositoryFileManifestDetails(cwd);
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.files, [
    ".claude/scripts/verify/check-fe-form-contract.sh",
    ".codex/instructions.md",
    "notes/.cursor/rules.md",
    "notes/visible.md",
    "service/src/value.js"
  ]);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, ".claude/scripts/verify/check-fe-form-contract.sh"), true);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, ".codex/instructions.md"), true);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, "notes/.cursor/rules.md"), true);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, ".npmrc"), false);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, ".pi/private.json"), false);

  const before = workingTreeSnapshot(cwd);
  fs.writeFileSync(
    path.join(cwd, ".claude", "scripts", "verify", "check-fe-form-contract.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\n"
  );
  const after = workingTreeSnapshot(cwd);
  assert.ok(before[".claude/scripts/verify/check-fe-form-contract.sh"]);
  assert.notEqual(
    before[".claude/scripts/verify/check-fe-form-contract.sh"],
    after[".claude/scripts/verify/check-fe-form-contract.sh"]
  );
});

test("repository manifest fails completeness closed for unreadable loose workspace directories", {
  skip: process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0
}, (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-manifest-unreadable-"));
  const locked = path.join(cwd, "locked");
  t.after(() => {
    try { fs.chmodSync(locked, 0o700); } catch {}
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  childGitRepo(path.join(cwd, "service"), { "src/value.js": "export const value = 1;\n" });
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, "missed.test.js"), "test('missed', () => {});\n");
  fs.chmodSync(locked, 0o000);

  const manifest = repositoryFileManifestDetails(cwd);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.files.includes("locked/missed.test.js"), false);
  assert.equal(manifest.files.includes("service/src/value.js"), true);
});

test("repository manifest fails completeness closed for a broken child git root", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-manifest-broken-root-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  childGitRepo(path.join(cwd, "service"), { "src/value.js": "export const value = 1;\n" });
  const broken = path.join(cwd, "broken");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, ".git"), "gitdir: /definitely/missing/piagent-git-dir\n");
  fs.writeFileSync(path.join(broken, "missed.test.js"), "test('missed', () => {});\n");

  const manifest = repositoryFileManifestDetails(cwd);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.files.includes("service/src/value.js"), true);
  const snapshot = workingTreeSnapshot(cwd);
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(snapshot), true);
  assert.match(workingTreeEvidenceDigest(snapshot), /^wt-content-v2-unavailable:/);
});

test("working-tree snapshots fail closed for a broken root Git marker", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-snapshot-broken-root-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, ".git"), "gitdir: /definitely/missing/piagent-root-git-dir\n");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const source = true;\n");

  const snapshot = workingTreeSnapshot(cwd);
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(snapshot), true);
  assert.match(workingTreeEvidenceDigest(snapshot), /^wt-content-v2-unavailable:/);
});

function contract(overrides = {}) {
  const now = "2026-07-31T01:02:03.000Z";
  return {
    schemaVersion: 2,
    taskRunId: "task-20260731010203-0123456789",
    taskId: "task",
    sessionId: "session-a",
    sessionName: "TASK-1",
    changeMode: "source-change",
    attempt: 1,
    maxAttempts: 3,
    previousAttempts: [],
    summary: "Implement the bounded fixture task",
    riskLane: "normal",
    expectedOutput: "The fixture contract is persisted safely.",
    acceptanceCriteria: ["Contract can be resolved"],
    scope: ["tracked.txt"],
    outOfScope: [],
    protectedPaths: [],
    requiredContext: [],
    contextManifest: [],
    memoryCitations: [],
    mcpCapabilities: [],
    verifyGroup: "source",
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

test("Task Contract validation rejects scope beyond the criterion graph binding cap", () => {
  const oversized = contract({ scope: Array.from({ length: 2001 }, (_, index) => `src/file-${index}.js`) });
  assert.match(taskContractValidationErrors(oversized).join("; "), /scope must contain at most 2000 entries/);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "task-contract.schema.json"), "utf8"));
  assert.equal(schema.properties.scope.allOf[1].maxItems, 2000);
});

test("existing v2 contracts remain readable losslessly beyond new task-intake traffic limits", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const legacyCommands = [
    `node --test ${"x".repeat(901)}`,
    "npm test\r\nnpm run lint",
    "  npm test -- --runInBand  "
  ];
  const legacyCriteria = Array.from({ length: 13 }, (_item, index) => `Legacy criterion ${index + 1}: ${"c".repeat(1001)}`);
  const legacy = contract({
    summary: `LEGACY_100K_PRIVATE_SENTINEL ${"s".repeat(100_000)}`,
    expectedOutput: `Legacy output ${"e".repeat(2001)}`,
    acceptanceCriteria: legacyCriteria,
    verifyCommands: legacyCommands
  });
  assert.deepEqual(taskContractValidationErrors(legacy), []);
  const normalized = normalizeTaskContract(legacy);
  assert.equal(normalized.summary, legacy.summary);
  assert.equal(normalized.expectedOutput, legacy.expectedOutput);
  assert.deepEqual(normalized.acceptanceCriteria, legacyCriteria);
  assert.deepEqual(normalized.verifyCommands, legacyCommands);

  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, `${legacy.taskRunId}.json`), `${JSON.stringify(legacy)}\n`);
  assert.deepEqual(migrateTaskState(cwd), { migrated: 0, current: 1, warnings: [] });
  const [resumed] = listTaskContracts(cwd);
  assert.equal(resumed.summary, legacy.summary);
  assert.deepEqual(resumed.acceptanceCriteria, legacyCriteria);
  assert.deepEqual(resumed.verifyCommands, legacyCommands);

  const taskSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "task-contract.schema.json"), "utf8"));
  const profileSchema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "project-profile.schema.json"), "utf8"));
  assert.equal(taskSchema.properties.summary.maxLength, undefined);
  assert.equal(taskSchema.properties.expectedOutput.maxLength, undefined);
  assert.equal(taskSchema.properties.acceptanceCriteria.allOf[1].maxItems, undefined);
  assert.equal(taskSchema.properties.verifyCommands.$ref, "#/$defs/stringList");
  assert.equal(profileSchema.properties.verifyCommands.additionalProperties.maxItems, undefined);
  assert.equal(profileSchema.properties.verifyCommands.additionalProperties.items.maxLength, undefined);
});

test("Task Contract binds a bounded full operator request to its private digest", () => {
  const operatorRequest = "PRIVATE_OPERATOR_REQUEST_SENTINEL: implement every clause, including the omitted cleanup ownership rule.";
  const valid = contract({ operatorRequest, operatorRequestDigest: operatorRequestDigest(operatorRequest) });
  assert.deepEqual(taskContractValidationErrors(valid), []);
  const tampered = { ...valid, operatorRequestDigest: operatorRequestDigest(`${operatorRequest}!`) };
  assert.match(taskContractValidationErrors(tampered).join("; "), /does not match/);
  assert.deepEqual(operatorRequestCarryLines(tampered), [], "tampered operator truth must never enter provider context");
  assert.deepEqual(operatorRequestCarryLines(valid).slice(1, 2), [operatorRequest], "valid private truth remains lossless in the provider carry");
  assert.equal(JSON.stringify(compactTaskDetails(valid)).includes("PRIVATE_OPERATOR_REQUEST_SENTINEL"), false, "public task details must omit the private request");
  assert.match(taskContractValidationErrors(contract({ operatorRequest })).join("; "), /must be present together/);
  const overlong = "🧪".repeat(OPERATOR_REQUEST_MAX_CHARS + 1);
  assert.match(taskContractValidationErrors(contract({ operatorRequest: overlong, operatorRequestDigest: operatorRequestDigest(overlong) })).join("; "), /at most 8000 Unicode characters/);
  const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "task-contract.schema.json"), "utf8"));
  assert.equal(schema.properties.operatorRequest.maxLength, OPERATOR_REQUEST_MAX_CHARS);
  assert.deepEqual(schema.dependentRequired.operatorRequest, ["operatorRequestDigest"]);
});

function persistLegacyV2(cwd, overrides = {}) {
  const task = contract({ workingTreeDigestAlgorithm: undefined, ...overrides });
  const target = path.join(cwd, ".pi", "piagent-state", "tasks", `${task.taskRunId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(task, null, 2)}\n`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { task, target, bytes };
}

test("task run IDs preserve collision entropy for long task names", () => {
  const first = createTaskRunId("x".repeat(200), "session-a", "2026-07-31T01:02:03.000Z");
  const second = createTaskRunId("x".repeat(200), "session-a", "2026-07-31T01:02:03.000Z");
  assert.notEqual(first, second);
  assert.match(first, /^x{48}-20260731010203-[a-f0-9]{10}$/);
});

test("resolves identical task IDs only inside their bound sessions", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const first = writeTaskContract(cwd, contract());
  const second = writeTaskContract(cwd, contract({
    taskRunId: "task-20260731010303-abcdef0123",
    sessionId: "session-b",
    sessionName: "TASK-1 second window"
  }));
  bindSessionTask(cwd, "session-a", first.sessionName, first);
  bindSessionTask(cwd, "session-b", second.sessionName, second);

  assert.equal(activeSessionTask(cwd, "session-a").taskRunId, first.taskRunId);
  assert.equal(activeSessionTask(cwd, "session-b").taskRunId, second.taskRunId);
  assert.equal(resolveTaskContract(cwd, "task", "session-a").taskRunId, first.taskRunId);
  assert.equal(resolveTaskContract(cwd, second.taskRunId, "session-a"), undefined);
  assert.throws(() => bindSessionTask(cwd, "session-b", "wrong", first), /Cannot bind task/);
});

test("refuses every rewrite after a task contract becomes terminal", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const pending = writeTaskContract(cwd, contract());
  const terminal = writeTaskContract(cwd, {
    ...pending,
    trace: {
      outcome: "completed",
      recordedAt: "2026-07-31T01:04:03.000Z"
    }
  });

  assert.equal(terminal.trace.outcome, "completed");
  assert.throws(() => writeTaskContract(cwd, terminal), /immutable after completed/);
  assert.throws(() => writeTaskContract(cwd, {
    ...terminal,
    trace: { outcome: "pending" }
  }), /immutable after completed/);
  assert.equal(resolveTaskContract(cwd, terminal.taskRunId, terminal.sessionId).trace.outcome, "completed");
});

test("keeps acceptance receipt runtime validation aligned with its closed JSON schema", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const acceptanceReceipt = buildAcceptanceReceipt({
    summary: "Verify the task contract acceptance receipt boundary",
    expectedOutput: "The receipt remains strict and evidence-backed.",
    acceptanceCriteria: ["The configured verifier passes against the final working tree."],
    changeMode: "source-change",
    source: "runtime",
    generatedAt: "2026-07-31T01:02:03.000Z"
  }).receipt;
  const valid = contract({ acceptanceReceipt });

  assert.deepEqual(taskContractValidationErrors(valid), []);
  assert.doesNotThrow(() => writeTaskContract(cwd, valid));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "task-contract.schema.json"), "utf8")).properties.acceptanceReceipt.$ref,
    "#/$defs/acceptanceReceipt"
  );

  const injected = structuredClone(acceptanceReceipt);
  injected.criteria[0].internal = true;
  assert.match(taskContractValidationErrors(contract({ acceptanceReceipt: injected })).join("; "), /criterion is invalid/);
});

test("preserves all twelve Task Contract criteria and binds an immutable authority snapshot to exact task identity", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const acceptanceCriteria = Array.from({ length: 12 }, (_, index) => `Criterion ${index + 1} is preserved exactly.`);
  const base = contract({ acceptanceCriteria });
  const acceptanceReceipt = buildAcceptanceReceipt({
    summary: base.summary,
    expectedOutput: base.expectedOutput,
    acceptanceCriteria,
    changeMode: base.changeMode,
    source: "runtime",
    generatedAt: base.createdAt
  }).receipt;
  const authoritySnapshot = createTaskAuthoritySnapshot({ taskId: base.taskId, taskRunId: base.taskRunId, capturedAt: base.createdAt });
  const valid = { ...base, acceptanceReceipt, authoritySnapshot };
  assert.equal(valid.acceptanceReceipt.criteria.length, 12);
  assert.deepEqual(taskContractValidationErrors(valid), []);
  const written = writeTaskContract(cwd, valid);
  assert.deepEqual(written.acceptanceCriteria, acceptanceCriteria);
  assert.equal(written.authoritySnapshot.snapshotDigest, authoritySnapshot.snapshotDigest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.cwd(), "schemas", "task-contract.schema.json"), "utf8")).properties.authoritySnapshot.$ref, "https://github.com/Vt-mmm/piagent/schemas/task-authority-snapshot.schema.json");
  const mismatched = structuredClone(valid); mismatched.authoritySnapshot.taskRunId = "other-run";
  assert.match(taskContractValidationErrors(mismatched).join("; "), /authoritySnapshot .*identity\/time|authoritySnapshot .*snapshotDigest/);
});

test("migrates v1 contracts without assigning unrelated history to the resumed session", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  for (const taskId of ["TASK-1", "TASK-2"]) {
    const legacy = contract({
      schemaVersion: 1,
      taskRunId: undefined,
      taskId,
      sessionId: undefined,
      baselineFileDigests: undefined,
      finalFileDigests: undefined
    });
    fs.writeFileSync(path.join(tasks, `${taskId.toLowerCase()}.json`), `${JSON.stringify(legacy)}\n`);
  }

  assert.equal(taskStateMigrationStatus(cwd).legacy, 2);
  const result = migrateTaskState(cwd, { taskId: "TASK-1", sessionId: "session-resumed", sessionName: "TASK-1" });
  assert.equal(result.migrated, 2);
  const migrated = listTaskContracts(cwd);
  assert.equal(migrated.find((item) => item.taskId === "task-1").sessionId, "session-resumed");
  assert.equal(migrated.find((item) => item.taskId === "task-2").sessionId, "legacy");
  assert.equal(taskStateMigrationStatus(cwd).legacy, 0);
  assert.equal(fs.readdirSync(path.join(tasks, "legacy-v1")).length, 2);
});

test("migrates a long v1 task without truncating away legacy run entropy", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  const taskId = `investigate-${"long-task-name-".repeat(8)}`;
  const sourceName = safeTaskId(taskId);
  const legacy = contract({
    schemaVersion: 1,
    taskRunId: undefined,
    taskId,
    sessionId: undefined,
    baselineFileDigests: undefined,
    finalFileDigests: undefined
  });
  fs.writeFileSync(path.join(tasks, `${sourceName}.json`), `${JSON.stringify(legacy)}\n`);

  const result = migrateTaskState(cwd);
  const [migrated] = listTaskContracts(cwd);
  assert.deepEqual(result, { migrated: 1, current: 0, warnings: [] });
  assert.equal(migrated.taskId, sourceName);
  assert.notEqual(migrated.taskRunId, sourceName);
  assert.match(migrated.taskRunId, /-legacy-[a-f0-9]{12}$/);
  assert.equal(migrated.taskRunId.length, 80);
  assert.equal(taskStateMigrationStatus(cwd).current, 1);
  const archived = JSON.parse(fs.readFileSync(path.join(tasks, "legacy-v1", `${sourceName}.json`), "utf8"));
  assert.equal(archived.schemaVersion, 1);
});

test("archives a colliding v1 source before writing its v2 contract", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  const legacy = contract({
    schemaVersion: 1,
    taskRunId: "task",
    sessionId: undefined,
    baselineFileDigests: undefined,
    finalFileDigests: undefined
  });
  fs.writeFileSync(path.join(tasks, "task.json"), `${JSON.stringify(legacy)}\n`);

  const result = migrateTaskState(cwd);
  const current = JSON.parse(fs.readFileSync(path.join(tasks, "task.json"), "utf8"));
  const archived = JSON.parse(fs.readFileSync(path.join(tasks, "legacy-v1", "task.json"), "utf8"));
  assert.deepEqual(result, { migrated: 1, current: 0, warnings: [] });
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.taskRunId, "task");
  assert.equal(archived.schemaVersion, 1);
  assert.equal(taskStateMigrationStatus(cwd).current, 1);
});

test("rebinds only a clean pending legacy v2 task and requires one current exact-verifier refresh", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "changed during retained task\n");
  const runId = "task-20260731010203-0123456789";
  const { bytes } = persistLegacyV2(cwd, {
    taskRunId: runId,
    verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "legacy pass", recordedAt: "2026-07-31T01:03:03.000Z", observed: true, matchedProfileCommand: true, workingTreeDigest: "a".repeat(64) }]
  });

  assert.deepEqual(migrateTaskState(cwd, { taskRunId: runId, sessionId: "session-a" }), { migrated: 1, current: 0, warnings: [] });
  const [migrated] = listTaskContracts(cwd);
  assert.equal(migrated.workingTreeDigestAlgorithm, "wt-content-v2");
  assert.equal(migrated.workingTreeDigestMigration.status, "verification-refresh-required");
  assert.deepEqual(migrated.baselineFileDigests, {});
  assert.deepEqual(migrated.verifyEvidence, []);
  assert.deepEqual(migrated.finalWorkingTreeFiles, ["tracked.txt"]);
  assert.match(migrated.finalFileDigests["tracked.txt"], /^wt-content-v2:/);
  const archive = path.join(cwd, migrated.workingTreeDigestMigration.archivePath);
  assert.ok(fs.readFileSync(archive).equals(bytes));
  assert.equal(migrated.workingTreeDigestMigration.archiveDigest, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(taskDigestMigrationArchiveStatus(cwd, migrated), { required: true, valid: true, reason: "verification-refresh-required" });
  const barriers = readTaskJournal(cwd, { taskRunId: runId }).events.filter((event) => event.eventType === "digest-migrated");
  assert.equal(barriers.length, 1);
  assert.deepEqual({ baselineEvidenceDigest: barriers[0].data.baselineEvidenceDigest, finalEvidenceDigest: barriers[0].data.finalEvidenceDigest }, taskDigestMigrationEvidenceBindings(migrated));
  const archiveMtime = fs.statSync(archive).mtimeMs;
  assert.deepEqual(migrateTaskState(cwd), { migrated: 0, current: 1, warnings: [] });
  assert.equal(readTaskJournal(cwd, { taskRunId: runId }).events.filter((event) => event.eventType === "digest-migrated").length, 1);
  assert.equal(fs.statSync(archive).mtimeMs, archiveMtime);
});

test("never attributes one retained working tree to an unbound or different pending task", (t) => {
  const offline = fixture();
  t.after(() => fs.rmSync(offline, { recursive: true, force: true }));
  const offlineRun = "offline-run-1";
  persistLegacyV2(offline, { taskRunId: offlineRun, taskId: "offline" });
  fs.writeFileSync(path.join(offline, "tracked.txt"), "operator change\n");
  assert.deepEqual(migrateTaskState(offline), { migrated: 1, current: 0, warnings: [] });
  const [blocked] = listTaskContracts(offline);
  assert.equal(blocked.workingTreeDigestMigration.reasonCode, "active-task-binding-unavailable");
  assert.deepEqual(blocked.finalFileDigests, {});
  assert.deepEqual(migrateTaskState(offline), { migrated: 0, current: 1, warnings: [] });

  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const activeRun = "active-run-1", inactiveRun = "inactive-run-1";
  persistLegacyV2(cwd, { taskRunId: activeRun, taskId: "active", sessionId: "session-a" });
  persistLegacyV2(cwd, { taskRunId: inactiveRun, taskId: "inactive", sessionId: "session-b" });
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "active task change\n");
  assert.deepEqual(migrateTaskState(cwd, { taskRunId: activeRun, sessionId: "session-a" }), { migrated: 2, current: 0, warnings: [] });
  const migrated = new Map(listTaskContracts(cwd).map((task) => [task.taskRunId, task]));
  assert.equal(migrated.get(activeRun).workingTreeDigestMigration.status, "verification-refresh-required");
  assert.ok(migrated.get(activeRun).finalFileDigests["tracked.txt"]);
  assert.equal(migrated.get(inactiveRun).workingTreeDigestMigration.reasonCode, "active-task-binding-unavailable");
  assert.deepEqual(migrated.get(inactiveRun).finalFileDigests, {});

  const mismatch = fixture();
  t.after(() => fs.rmSync(mismatch, { recursive: true, force: true }));
  const mismatchRun = "mismatch-run-1";
  persistLegacyV2(mismatch, { taskRunId: mismatchRun, taskId: "mismatch", sessionId: "session-a" });
  assert.deepEqual(migrateTaskState(mismatch, { taskRunId: mismatchRun, sessionId: "session-b" }), { migrated: 1, current: 0, warnings: [] });
  assert.equal(listTaskContracts(mismatch)[0].workingTreeDigestMigration.reasonCode, "active-task-binding-unavailable");
  assert.deepEqual(migrateTaskState(mismatch, { taskRunId: mismatchRun, sessionId: "session-a" }), { migrated: 0, current: 1, warnings: [] });
});

test("archives dirty, semantic-repair, and ambiguous legacy v2 evidence once without a recovery loop", (t) => {
  const cases = [
    { name: "dirty", overrides: { baselineChangedFiles: ["tracked.txt"], baselineFileDigests: { "tracked.txt": "a".repeat(64) } }, reason: "baseline-not-provably-clean" },
    { name: "ambiguous", overrides: { workingTreeDigestAlgorithm: "unknown-v3", workingTreeDigestMigration: { crafted: true } }, reason: "legacy-carrier-key-mismatch" },
    { name: "partial", overrides: { workingTreeDigestMigration: { crafted: true } }, reason: "legacy-carrier-key-mismatch" },
    { name: "legacy-digest", overrides: { verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "legacy", recordedAt: "2026-07-31T01:03:03.000Z", observed: true, matchedProfileCommand: true, workingTreeDigest: `legacy-untrusted:${"a".repeat(64)}` }] }, reason: "legacy-carrier-key-mismatch" },
    { name: "unknown-digest", overrides: { verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "unknown", recordedAt: "2026-07-31T01:03:03.000Z", observed: true, matchedProfileCommand: true, workingTreeDigest: `wt-content-v3:${"a".repeat(64)}` }] }, reason: "legacy-carrier-key-mismatch" },
    { name: "no-op-verifier", overrides: { verifyCommands: ["true"] }, reason: "exact-verifier-plan-missing" },
    { name: "semantic", overrides: {}, reason: "semantic-repair-state-present", semantic: true }
  ];
  for (const item of cases) {
    const cwd = fixture();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const runId = `${item.name}-run-1`;
    persistLegacyV2(cwd, { taskRunId: runId, taskId: item.name, ...item.overrides });
    if (item.semantic) {
      const carrier = path.join(cwd, ".pi", "piagent-state", "semantic-repair", `${runId}.json`);
      fs.mkdirSync(path.dirname(carrier), { recursive: true });
      fs.writeFileSync(carrier, "{}\n");
    }
    assert.deepEqual(migrateTaskState(cwd), { migrated: 1, current: 0, warnings: [] });
    const [migrated] = listTaskContracts(cwd);
    assert.equal(migrated.workingTreeDigestAlgorithm, "legacy-untrusted");
    assert.equal(migrated.workingTreeDigestMigration.status, "new-attempt-required");
    assert.equal(migrated.workingTreeDigestMigration.reasonCode, item.reason);
    assert.equal(migrated.trace.outcome, "blocked");
    assert.deepEqual(migrated.verifyEvidence, []);
    assert.deepEqual(migrated.finalFileDigests, {});
    if (item.semantic) assert.equal(fs.existsSync(path.join(cwd, ".pi", "piagent-state", "digest-migrations", `${runId}.carriers`, "semantic-repair-state.json")), true);
    assert.deepEqual(migrateTaskState(cwd), { migrated: 0, current: 1, warnings: [] });
  }
});

test("refuses a journal migration barrier whose descriptor does not match the archived task", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const runId = "barrier-mismatch-run-1";
  const { bytes, target } = persistLegacyV2(cwd, { taskRunId: runId, taskId: "barrier-mismatch" });
  const archiveDigest = crypto.createHash("sha256").update(bytes).digest("hex");
  appendTaskJournalEvent(cwd, { eventType: "digest-migrated", taskRunId: runId, taskId: "barrier-mismatch", sessionId: "session-a", data: {
    algorithm: "wt-content-v2", disposition: "verification-refresh-required", reasonCode: "wrong-reason",
    archivePath: ".pi/piagent-state/digest-migrations/wrong-run.legacy.json", archiveDigest,
    baselineEvidenceDigest: "b".repeat(64), finalEvidenceDigest: "f".repeat(64)
  }});
  const result = migrateTaskState(cwd);
  assert.equal(result.migrated, 0);
  assert.match(result.warnings.join("; "), /barrier descriptor conflict/);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).workingTreeDigestAlgorithm, undefined);
});

test("working-tree snapshots distinguish a file already dirty before the task from a later edit", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "dirty before\n");
  const before = workingTreeSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "changed during task\n");
  const after = workingTreeSnapshot(cwd);
  assert.notEqual(before["tracked.txt"], after["tracked.txt"]);
});

test("working-tree snapshots bind tracked, untracked, mode, and symlink carriers without following links", (t) => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-tree-outside-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "tracked change\n");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "untracked\n");
  fs.chmodSync(path.join(cwd, "tracked.txt"), 0o755);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret-v1\n");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "external-link"));

  const first = workingTreeSnapshot(cwd);
  assert.deepEqual(Object.keys(first).sort(), ["external-link", "tracked.txt", "untracked.txt"]);
  const trackedAt755 = first["tracked.txt"];
  const linkTargetEvidence = first["external-link"];
  fs.chmodSync(path.join(cwd, "tracked.txt"), 0o700);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret-v2 must not be followed\n");
  const second = workingTreeSnapshot(cwd);
  assert.notEqual(second["tracked.txt"], trackedAt755, "POSIX mode participates in current-tree identity");
  assert.equal(second["external-link"], linkTargetEvidence, "symlink evidence binds the link, not external bytes");
  fs.unlinkSync(path.join(cwd, "external-link"));
  fs.symlinkSync(path.join(outside, "other.txt"), path.join(cwd, "external-link"));
  assert.notEqual(workingTreeSnapshot(cwd)["external-link"], linkTargetEvidence);
});

test("working-tree snapshots stream and distinguish files beyond the former 32 MiB diff ceiling", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const size = 33 * 1024 * 1024;
  const writeSparse = (name, marker, offset) => {
    const descriptor = fs.openSync(path.join(cwd, name), "w");
    try {
      fs.ftruncateSync(descriptor, size);
      fs.writeSync(descriptor, Buffer.from([marker]), 0, 1, offset);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  writeSparse("large-a.bin", 0x41, 0);
  writeSparse("large-b.bin", 0x42, size - 1);
  const before = workingTreeSnapshot(cwd);
  assert.ok(before["large-a.bin"]);
  assert.ok(before["large-b.bin"]);
  assert.notEqual(before["large-a.bin"], before["large-b.bin"]);
  const descriptor = fs.openSync(path.join(cwd, "large-a.bin"), "r+");
  try {
    fs.writeSync(descriptor, Buffer.from([0x43]), 0, 1, Math.floor(size / 2));
  } finally {
    fs.closeSync(descriptor);
  }
  const after = workingTreeSnapshot(cwd);
  assert.notEqual(before["large-a.bin"], after["large-a.bin"]);
  assert.doesNotMatch(after["large-a.bin"], /missing-or-unavailable/);
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(after), false);
});

test("unavailable file evidence is stable inventory but never proof-capable", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const unreadable = path.join(cwd, "unreadable.txt");
  fs.writeFileSync(unreadable, "hidden\n");
  fs.chmodSync(unreadable, 0o000);
  const first = workingTreeSnapshot(cwd);
  const second = workingTreeSnapshot(cwd);
  assert.match(first["unreadable.txt"], /^wt-content-v2-unavailable:/);
  assert.equal(first["unreadable.txt"], second["unreadable.txt"], "unchanged unavailable evidence must not invent a mutation loop");
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(first), true);
});

test("working-tree snapshots remain truthful before the repository has its first commit", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-unborn-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  fs.writeFileSync(path.join(cwd, "first.txt"), "before\n");
  execFileSync("git", ["-C", cwd, "add", "first.txt"]);
  const before = workingTreeSnapshot(cwd);
  fs.writeFileSync(path.join(cwd, "first.txt"), "after\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
  const after = workingTreeSnapshot(cwd);

  assert.ok(before["first.txt"]);
  assert.notEqual(before["first.txt"], after["first.txt"]);
  assert.ok(after["new.txt"]);
});

test("working-tree snapshots retain both ends of a staged rename", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.renameSync(path.join(cwd, "tracked.txt"), path.join(cwd, "renamed.txt"));
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  const snapshot = workingTreeSnapshot(cwd);
  assert.deepEqual(Object.keys(snapshot).sort(), ["renamed.txt", "tracked.txt"]);
  assert.notEqual(snapshot["tracked.txt"], snapshot["renamed.txt"]);
});

test("working-tree snapshots aggregate direct child Git repos from a workspace parent", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-multi-repo-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const frontend = path.join(cwd, "v-nexus-frontend");
  const backend = path.join(cwd, "v-nexus-backend");
  childGitRepo(frontend, { "src/app.ts": "export const app = 'base';\n" });
  childGitRepo(backend, { "src/contract.ts": "export const contract = 'base';\n" });

  fs.writeFileSync(path.join(frontend, "src", "app.ts"), "export const app = 'changed';\n");
  fs.mkdirSync(path.join(frontend, "plans"), { recursive: true });
  fs.writeFileSync(path.join(frontend, "plans", "plan.md"), "# Plan\n");
  fs.mkdirSync(path.join(cwd, "plans"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "plans", "root-plan.md"), "# Root Plan\n");
  fs.writeFileSync(path.join(backend, "src", "contract.ts"), "export const contract = 'changed';\n");

  assert.equal(isGitWorkingTree(cwd), false);
  assert.equal(hasGitEvidenceRoot(cwd), true);
  assert.equal(usesNestedGitEvidenceRoots(cwd), true);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, "v-nexus-frontend/plans/plan.md"), true);
  assert.equal(pathWithinChangeEvidenceRoot(cwd, "plans/root-plan.md"), true);
  assert.deepEqual(workingTreeFiles(cwd), [
    "plans/root-plan.md",
    "v-nexus-backend/src/contract.ts",
    "v-nexus-frontend/plans/plan.md",
    "v-nexus-frontend/src/app.ts"
  ]);
  const snapshot = workingTreeSnapshot(cwd);
  assert.ok(snapshot["plans/root-plan.md"]);
  assert.ok(snapshot["v-nexus-frontend/src/app.ts"]);
  assert.ok(snapshot["v-nexus-frontend/plans/plan.md"]);
  assert.ok(snapshot["v-nexus-backend/src/contract.ts"]);
});

test("workspace evidence fully covers root plans and side folders beyond the former non-git cap", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-multi-repo-large-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  childGitRepo(path.join(cwd, "v-nexus-frontend"), { "src/app.ts": "export const app = 'base';\n" });
  childGitRepo(path.join(cwd, "v-nexus-backend"), { "src/contract.ts": "export const contract = 'base';\n" });
  const bulk = path.join(cwd, "aaa-bulk");
  fs.mkdirSync(bulk, { recursive: true });
  for (let index = 0; index < 2010; index += 1) {
    fs.writeFileSync(path.join(bulk, `${String(index).padStart(4, "0")}.txt`), "bulk\n");
  }
  fs.mkdirSync(path.join(cwd, "plans", "2026-08-04-be-to-fe-remediation"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "plans", "2026-08-04-be-to-fe-remediation", "plan.md"), "# Plan\n");

  const files = workingTreeFiles(cwd);
  assert.ok(files.includes("plans/2026-08-04-be-to-fe-remediation/plan.md"));
  assert.equal(files.filter((file) => file.startsWith("aaa-bulk/")).length, 2010, "the former 2,000-file ceiling must not truncate a real workspace");
  const snapshot = workingTreeSnapshot(cwd);
  assert.ok(snapshot["plans/2026-08-04-be-to-fe-remediation/plan.md"]);
  assert.ok(snapshot["aaa-bulk/2009.txt"]);
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(snapshot), false);
});

test("working-tree snapshots fail closed when non-git workspace enumeration is incomplete", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-task-multi-repo-truncated-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  childGitRepo(path.join(cwd, "service"), { "src/app.ts": "export const app = 'base';\n" });
  const loose = path.join(cwd, "shared");
  fs.mkdirSync(loose, { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(loose, name), `${name}\n`);

  const complete = workingTreeSnapshot(cwd);
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(complete), false);
  assert.ok(complete["shared/c.txt"]);

  const incomplete = workingTreeSnapshot(cwd, { maxNonGitWorkspaceFiles: 2 });
  assert.equal(incomplete["shared/c.txt"], undefined, "the bounded walker exposes the omitted carrier in this fixture");
  assert.equal(workingTreeSnapshotHasUnavailableEvidence(incomplete), true, "partial enumeration must never remain proof-capable");
  assert.match(workingTreeEvidenceDigest(incomplete), /^wt-content-v2-unavailable:/);
});

test("rejects corrupted v2 contracts instead of silently normalizing them", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const invalid = contract({ sessionId: "", maxAttempts: 0 });
  assert.deepEqual(taskContractValidationErrors(invalid).filter((item) => /sessionId|maxAttempts/.test(item)), [
    "sessionId is required",
    "maxAttempts must be between 1 and 10",
    "attempt exceeds maxAttempts"
  ]);
  assert.equal(normalizeTaskContract(invalid), undefined);
  assert.throws(() => writeTaskContract(cwd, invalid), /Task contract is invalid/);
});

test("rejects unavailable source-change baseline evidence before resume can authorize mutation", () => {
  const invalid = contract({ baselineChangedFiles: ["tracked.txt"], baselineFileDigests: { "tracked.txt": `wt-content-v2-unavailable:${"a".repeat(64)}` } });
  assert.match(taskContractValidationErrors(invalid).join("; "), /baseline evidence must be proof-capable/);
});

test("binds digest migration reason, archive path, and chronology to the exact task", () => {
  const recordedAt = "2026-08-10T00:00:00.000Z";
  const migration = {
    status: "verification-refresh-required", source: "legacy-unversioned", reasonCode: "clean-baseline-rebound", requiredAction: "rerun-exact-verifier",
    archivePath: ".pi/piagent-state/digest-migrations/task-20260731010203-0123456789.legacy.json",
    archiveDigest: "a".repeat(64), archiveBytes: 10, baselineEvidenceDigest: "b".repeat(64), finalEvidenceDigest: "c".repeat(64), recordedAt
  };
  assert.deepEqual(taskContractValidationErrors(contract({ workingTreeDigestMigration: migration })), []);
  assert.match(taskContractValidationErrors(contract({ workingTreeDigestMigration: { ...migration, archivePath: ".pi/piagent-state/digest-migrations/other-run.legacy.json" } })).join("; "), /workingTreeDigestMigration is invalid/);
  assert.match(taskContractValidationErrors(contract({ workingTreeDigestMigration: { ...migration, reasonCode: "terminal-legacy-evidence" } })).join("; "), /workingTreeDigestMigration is invalid/);
  assert.match(taskContractValidationErrors(contract({ workingTreeDigestMigration: { ...migration, status: "refreshed", requiredAction: "none", refreshedAt: "2026-08-09T23:59:59.000Z" } })).join("; "), /workingTreeDigestMigration is invalid/);
});

test("rejects malformed nested work-plan state and a v2 filename that lies about its run ID", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const invalidPlan = contract({
    workPlan: [{ id: "edit", title: "Edit", role: "parent", mode: "single-writer", status: "invented" }]
  });
  assert.match(taskContractValidationErrors(invalidPlan).join("; "), /workPlan entries are invalid/);

  const tasks = path.join(cwd, ".pi", "piagent-state", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  fs.writeFileSync(path.join(tasks, "different-run.json"), `${JSON.stringify(contract())}\n`);
  assert.equal(listTaskContracts(cwd).length, 0);
  assert.deepEqual(taskStateMigrationStatus(cwd).unreadable, ["different-run.json"]);
  assert.match(migrateTaskState(cwd).warnings.join("; "), /taskRunId does not match filename/);
});

test("keeps runtime validation aligned with closed nested schema objects", () => {
  const variants = [
    contract({ contextManifest: [{ path: "README.md", reason: "Task context", hidden: true }] }),
    contract({ previousAttempts: [{ taskRunId: "prior", attempt: 1, outcome: "failed", recordedAt: "2026-07-31T00:00:00.000Z", injected: "x" }] }),
    contract({ workPlan: [{ id: "edit", title: "Edit", role: "parent", mode: "single-writer", status: "pending", internal: true }] }),
    contract({ verifyEvidence: [{ command: "npm test", exitCode: 0, summary: "passed", recordedAt: "2026-07-31T00:00:00.000Z", observedAt: "not-a-date" }] }),
    contract({ trace: { outcome: "pending", internal: true } }),
    contract({ orchestration: { mode: "solo-first", subagents: "not-used", reason: "Bounded task", modelRoles: { planner: "strong", unknown: "x" } } })
  ];
  for (const variant of variants) {
    assert.ok(taskContractValidationErrors(variant).length > 0);
    assert.equal(normalizeTaskContract(variant), undefined);
  }
});

test("legacy migration whitelists nested evidence instead of carrying unknown fields into v2", () => {
  const migrated = normalizeTaskContract(contract({
    schemaVersion: 1,
    taskRunId: undefined,
    sessionId: undefined,
    contextManifest: [{ path: "README.md", reason: "Task context", hidden: true }],
    workPlan: [{ id: "edit", title: "Edit", role: "parent", mode: "single-writer", status: "pending", internal: true }],
    orchestration: {
      mode: "solo-first",
      subagents: "not-used",
      reason: "Bounded task",
      internal: true,
      modelRoles: { planner: "strong", unknown: "x" }
    }
  }), { sourceName: "legacy" });

  assert.deepEqual(migrated.contextManifest, [{ path: "README.md", reason: "Task context" }]);
  assert.equal("internal" in migrated.workPlan[0], false);
  assert.equal("internal" in migrated.orchestration, false);
  assert.deepEqual(migrated.orchestration.modelRoles, { planner: "strong" });
  assert.deepEqual(taskContractValidationErrors(migrated), []);
});

test("rejects self-references and dependency cycles in persisted work plans", () => {
  const self = [{ id: "edit", dependsOn: ["edit"] }];
  const cycle = [
    { id: "plan", dependsOn: ["edit"] },
    { id: "edit", dependsOn: ["plan"] }
  ];
  assert.match(workPlanDependencyError(self), /depends on itself/);
  assert.match(workPlanDependencyError(cycle), /cycle/);
  assert.match(taskContractValidationErrors(contract({
    workPlan: cycle.map((step) => ({
      ...step,
      title: step.id,
      role: "parent",
      mode: "single-writer",
      status: "pending"
    }))
  })).join("; "), /cycle/);
});
