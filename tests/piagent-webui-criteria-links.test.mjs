import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { hashEvidenceCommand } from "../packages/piagent-core/extensions/runtime-evidence.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { captureVerifierFileSnapshot } from "../packages/piagent-core/runtime/inspection/verifier-snapshot-store.ts";
import { projectCriteriaFileVerifier } from "../packages/piagent-core/runtime/inspection/criteria-links.ts";
import { buildWebUiInspectionProjection } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { buildActivityInspector } from "../packages/piagent-core/runtime/product/activity-inspector.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));
const startedAt = "2026-08-13T14:00:00.000Z";
const observedAt = "2026-08-13T14:01:00.000Z";
const capturedAt = "2026-08-13T14:01:01.000Z";
const identity = { projectRef: "project_01", runtimeInstanceId: "runtime_01", sessionRef: "session_01",
  taskId: "criteria_01", taskRunId: "criteria_01_run_01", agentOperationId: null, toolCallId: null };

function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); }
function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-criteria-links-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Piagent Test");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "search.js"), "export const search = () => [];\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

function task(cwd) {
  const built = buildAcceptanceReceipt({ summary: "Update src/search.js", expectedOutput: "Search behavior is updated",
    acceptanceCriteria: ["Update src/search.js without changing unrelated files.", "The exact npm test verifier passes."],
    changeMode: "source-change", source: "runtime", generatedAt: startedAt });
  const value = { ...structuredClone(fixture), taskId: identity.taskId, taskRunId: identity.taskRunId, sessionId: "criteria-session",
    summary: "Update search", expectedOutput: "Updated search", acceptanceCriteria: built.acceptanceCriteria,
    scope: ["src/search.js"], outOfScope: ["unrelated/**"], verifyCommands: ["npm test"], verifyEvidence: [],
    baselineFileDigests: workingTreeSnapshot(cwd), baselineChangedFiles: [], observedChangedFiles: [], changedFiles: [], finalWorkingTreeFiles: [], finalFileDigests: {},
    workPlan: [], acceptanceReceipt: built.receipt, trace: { outcome: "pending" }, createdAt: startedAt, updatedAt: startedAt };
  value.criterionGraph = compileCriterionGraph({ acceptanceCriteria: value.acceptanceCriteria, scope: value.scope,
    verifyCommands: value.verifyCommands, changeMode: value.changeMode, mode: "criterion-graph", createdAt: startedAt });
  value.authoritySnapshot = createBoundTaskAuthority(value);
  return value;
}

async function baseline(cwd, currentTask) {
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
    sessionId: currentTask.sessionId, capturedAt: startedAt, baselineTreeDigest: workingTreeEvidenceDigest(currentTask.baselineFileDigests) });
}

describe("Piagent WebUI criterion, file, and verifier projection", () => {
  it("links deterministic relations without turning a related pending criterion into satisfied", async () => {
    const cwd = repository(), currentTask = task(cwd);
    await baseline(cwd, currentTask);
    fs.writeFileSync(path.join(cwd, "src", "search.js"), "export const search = () => ['ready'];\n");
    const verifiedSnapshot = workingTreeSnapshot(cwd), treeDigest = workingTreeEvidenceDigest(verifiedSnapshot);
    const record = captureVerifierFileSnapshot({ projectRoot: cwd, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
      sessionId: currentTask.sessionId, toolCallId: "tool-verifier-01", commandHash: hashEvidenceCommand("npm test"),
      observedAt, capturedAt, exitCode: 0, treeDigest, snapshot: verifiedSnapshot });
    assert.ok(record);
    currentTask.verifyEvidence.push({ command: "npm test", exitCode: 0, summary: "pass", recordedAt: capturedAt,
      observed: true, observedAt, matchedProfileCommand: true, workingTreeDigest: treeDigest });
    currentTask.acceptanceReceipt.criteria[0].status = "satisfied";
    currentTask.acceptanceReceipt.criteria[0].evidence = [{ kind: "scoped-diff", summary: "Search file changed",
      paths: ["src/search.js"], command: "npm test", exitCode: 0, workingTreeDigest: treeDigest, recordedAt: capturedAt }];
    const views = await collectSourceChangeViews({ cwd, identity, generatedAt: capturedAt, taskRevision: "task_rev_01" });
    const linked = projectCriteriaFileVerifier({ cwd, task: currentTask, sourceViews: views, currentSnapshot: verifiedSnapshot,
      events: [{ event: "tool_call", sessionId: currentTask.sessionId, taskRunId: currentTask.taskRunId, toolCallId: "tool-verifier-01", toolName: "bash", command: "npm test", recordedAt: "2026-08-13T14:00:30.000Z" }], at: new Date(capturedAt) });
    const file = linked.sourceViews.task.files.find((entry) => entry.path === "src/search.js");
    assert.ok(file.criterionIds.includes(currentTask.acceptanceReceipt.criteria[0].id));
    assert.ok(file.verifierAttemptIds.includes(record.attemptRef));
    assert.equal(linked.criteria[0].state, "satisfied");
    const verifierCriterion = linked.criteria.find((criterion) => criterion.obligation.includes("verifier passes"));
    assert.equal(verifierCriterion.state, "pending", "a verifier relation must not infer criterion satisfaction");
    assert.ok(verifierCriterion.verifierAttemptRefs.includes(record.attemptRef));
    assert.equal(linked.verification.state, "current");
    assert.equal(linked.verification.latest.startedAt, "2026-08-13T14:00:30.000Z");
    assert.ok(linked.relations.some((relation) => relation.source === "target-hint" && relation.fileRef === file.fileRef));
    const incomplete = structuredClone(currentTask);
    incomplete.verifyCommands.push("npm run lint");
    const partial = projectCriteriaFileVerifier({ cwd, task: incomplete, sourceViews: views, currentSnapshot: verifiedSnapshot, at: new Date(capturedAt) });
    assert.equal(partial.verification.state, "unavailable", "one current verifier must not stand in for every configured verifier");
    assert.equal(partial.verification.reasonCode, "required-verifier-incomplete");
  });

  it("projects exact stale files and makes Inspector v2 a formatter over the same canonical snapshot", async () => {
    const cwd = repository(), currentTask = task(cwd);
    await baseline(cwd, currentTask);
    fs.writeFileSync(path.join(cwd, "src", "search.js"), "export const search = () => ['verified'];\n");
    const verifiedSnapshot = workingTreeSnapshot(cwd), treeDigest = workingTreeEvidenceDigest(verifiedSnapshot);
    captureVerifierFileSnapshot({ projectRoot: cwd, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
      sessionId: currentTask.sessionId, toolCallId: "tool-verifier-02", commandHash: hashEvidenceCommand("npm test"), observedAt,
      capturedAt, exitCode: 0, treeDigest, snapshot: verifiedSnapshot });
    currentTask.verifyEvidence.push({ command: "npm test", exitCode: 0, summary: "pass", recordedAt: capturedAt,
      observed: true, observedAt, matchedProfileCommand: true, workingTreeDigest: treeDigest });
    fs.writeFileSync(path.join(cwd, "src", "search.js"), "export const search = () => ['stale'];\n");
    const generatedAt = "2026-08-13T14:02:00.000Z";
    const events = [{ activityId: "call-02", event: "tool_call", sessionId: currentTask.sessionId, taskRunId: currentTask.taskRunId,
      toolCallId: "tool-verifier-02", toolName: "bash", command: "npm test", recordedAt: "2026-08-13T14:00:30.000Z" },
    { activityId: "result-02", event: "tool_result", sessionId: currentTask.sessionId, taskRunId: currentTask.taskRunId,
      toolCallId: "tool-verifier-02", toolName: "bash", exitCode: 0, exitCodeExact: true, recordedAt: observedAt }];
    const direct = await buildWebUiInspectionProjection({ cwd, sessionId: currentTask.sessionId, task: currentTask, events, generatedAt });
    assert.equal(direct.snapshot.verification.state, "stale");
    assert.deepEqual(direct.snapshot.verification.latest.staleByPaths, ["src/search.js"]);
    const registry = createWebUiSchemaRegistry(), validation = validateFixture(registry, "snapshot-v1", direct.snapshot);
    assert.equal(validation.valid, true, validation.errors);
    const inspector = await buildActivityInspector({ cwd, sessionId: currentTask.sessionId, task: currentTask, events, generatedAt });
    assert.equal(inspector.schemaVersion, 2);
    assert.deepEqual(inspector.snapshot, direct.snapshot, "Inspector JSON and WebUI must share one canonical projection");
    assert.equal(inspector.verification.state, "stale");
    assert.deepEqual(inspector.verification.latest.staleByPaths, ["src/search.js"]);
  });
});
