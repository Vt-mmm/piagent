import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { appendMutationProvenance } from "../packages/piagent-core/runtime/inspection/mutation-provenance-store.ts";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { readSourceMutationEvidence } from "../packages/piagent-core/runtime/inspection/source-mutation-store.ts";
import { captureVerifierFileSnapshot, inspectVerifierStaleness } from "../packages/piagent-core/runtime/inspection/verifier-snapshot-store.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { PiSourceMutationGuard } from "../packages/piagent-core/runtime/policy/source-mutation-guard.ts";
import { createReviewCommand } from "../packages/piagent-webui/client/src/review-command.ts";
import { createSourceMutationCommand } from "../packages/piagent-webui/client/src/source-mutation-command.ts";
import { createSourceRevertCommand } from "../packages/piagent-webui/client/src/source-revert-command.ts";
import { ReviewController } from "../packages/piagent-webui/extension/review-controller.ts";
import { SourceMutationController } from "../packages/piagent-webui/extension/source-mutation-controller.ts";
import { SourceRevertController } from "../packages/piagent-webui/extension/source-revert-controller.ts";
import { CoreInspectionProvider } from "../packages/piagent-webui/server/core-inspection-provider.ts";

const root = path.resolve(import.meta.dirname, ".."), taskFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
class Events { retention() { return { eventRetentionCount: 100, eventRetentionSeconds: 3600 }; } currentCursor() { return "cursor.audit"; }
  resyncRequired() { return false; } replay() { return { state: "current", events: [], nextCursor: "cursor.audit", latestCursor: "cursor.audit", reasonCode: null }; } }

test("mutation audit chains and review/verifier invalidation follow exact index and content effects", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-invalidation-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]); execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]); fs.writeFileSync(path.join(cwd, "a.txt"), "BASE\n");
  execFileSync("git", ["-C", cwd, "add", "a.txt"]); execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  const baseline = workingTreeSnapshot(cwd), now = new Date(), task = { ...structuredClone(taskFixture), taskId: "audit-task",
    taskRunId: "audit-task-run", sessionId: "audit-session", sessionName: "Audit session", summary: "Mutation invalidation",
    baselineChangedFiles: [], baselineFileDigests: baseline, trace: { outcome: "pending" }, createdAt: now.toISOString(), updatedAt: now.toISOString() };
  task.authoritySnapshot = createBoundTaskAuthority(task);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
    capturedAt: task.createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  fs.writeFileSync(path.join(cwd, "a.txt"), "AFTER TASK\n"); const afterTask = workingTreeSnapshot(cwd);
  assert.ok(appendMutationProvenance({ projectRoot: cwd, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
    toolCallId: "tool.audit-write", toolName: "write", recordedAt: new Date(now.getTime() + 1_000).toISOString(), beforeSnapshot: baseline,
    afterSnapshot: afterTask, changedPaths: ["a.txt"], recordedDigests: { "a.txt": afterTask["a.txt"] },
    recordedContentDigests: { "a.txt": createHash("sha256").update("AFTER TASK\n").digest("hex") },
    proofModes: { "a.txt": "full-content" }, protectedPaths: [] }));
  const runtimeInstanceId = "runtime.audit", identity = { projectRef: "project.audit", runtimeInstanceId, sessionRef: "session.audit",
    taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  const bridgeRevisions = { runtimeRevision: "runtime-revision.audit", taskRevision: `task-revision.audit`, controlRevision: "control-revision.audit",
    workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: "queue-revision.audit" };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions: bridgeRevisions, liveness: "idle", taskState: "active" }) };
  const guard = new PiSourceMutationGuard(), unbind = guard.bind({ cwd, rawSessionId: task.sessionId, guardInstanceId: "guard.audit",
    facts: () => ({ taskId: task.taskId, taskRunId: task.taskRunId, taskRevision: bridgeRevisions.taskRevision,
      controlRevision: bridgeRevisions.controlRevision, taskState: "active", idle: true, isProtectedPath: () => false }) }); t.after(unbind);
  const provider = new CoreInspectionProvider({ cwd, sessionId: task.sessionId, runtimeInstanceId, eventStore: new Events(), task: () => task,
    sessionEntries: () => [], chatControl: () => ({ state: "ready", liveness: "idle", taskState: "active", identity,
      revisions: bridgeRevisions, heldCount: 0, queueRevision: bridgeRevisions.queueRevision }),
    sourceMutationGuardAvailable: () => guard.available(cwd, task.sessionId) });
  const review = new ReviewController({ bridge, projectRoot: cwd, resolve: (view, fileRef) => provider.review(view, fileRef) });
  const mutation = new SourceMutationController({ bridge, projectRoot: cwd, resolve: (action, fileRef) => provider.sourceMutationAuthority(action, fileRef),
    revisions: () => provider.canonicalRevisions(), mutate: (input) => guard.execute({ cwd, rawSessionId: task.sessionId, ...input }) });
  const revert = new SourceRevertController({ bridge, projectRoot: cwd, resolve: (fileRef, refs) => provider.sourceRevertAuthority(fileRef, refs),
    revisions: () => provider.canonicalRevisions(), mutate: (input) => guard.executeRevert({ cwd, rawSessionId: task.sessionId, ...input }) });

  let snapshot = await provider.snapshot(), source = await provider.sourceChanges("working-tree"), fileRef = source.files[0].fileRef;
  let reviewState = await provider.review("working-tree", fileRef), reviewReceipt = await review.execute(await createReviewCommand(snapshot, reviewState, "reviewed"));
  assert.equal(reviewReceipt.resultCode, "reviewed"); provider.invalidate(); assert.equal((await provider.review("working-tree", fileRef)).state, "reviewed");
  const verifierTree = workingTreeSnapshot(cwd), verifier = captureVerifierFileSnapshot({ projectRoot: cwd, taskId: task.taskId,
    taskRunId: task.taskRunId, sessionId: task.sessionId, toolCallId: "tool.audit-verifier", commandHash: "a".repeat(64),
    observedAt: new Date(now.getTime() + 2_000).toISOString(), capturedAt: new Date(now.getTime() + 2_001).toISOString(), exitCode: 0,
    treeDigest: workingTreeEvidenceDigest(verifierTree), snapshot: verifierTree, protectedPaths: [] }); assert.ok(verifier);

  let preview = await provider.sourceMutation("source.stage", fileRef), stage = await mutation.execute(await createSourceMutationCommand(snapshot, preview));
  assert.equal(stage.resultCode, "staged"); assert.equal(stage.auditRef, stage.settlementEvidenceRef); assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "AFTER TASK\n");
  assert.equal(inspectVerifierStaleness(verifier, workingTreeSnapshot(cwd), []).state, "current");
  provider.invalidate(); assert.equal((await provider.review("working-tree", fileRef)).state, "stale", "index-bound review must stale after Stage");

  snapshot = await provider.snapshot(); source = await provider.sourceChanges("staged"); fileRef = source.files[0].fileRef;
  preview = await provider.sourceMutation("source.unstage", fileRef); const unstage = await mutation.execute(await createSourceMutationCommand(snapshot, preview));
  assert.equal(unstage.resultCode, "unstaged"); assert.equal(unstage.auditRef, unstage.settlementEvidenceRef);
  assert.equal(inspectVerifierStaleness(verifier, workingTreeSnapshot(cwd), []).state, "current");

  provider.invalidate(); snapshot = await provider.snapshot(); source = await provider.sourceChanges("working-tree"); fileRef = source.files[0].fileRef;
  reviewState = await provider.review("working-tree", fileRef); reviewReceipt = await review.execute(await createReviewCommand(snapshot, reviewState, "reviewed"));
  assert.equal(reviewReceipt.resultCode, "reviewed"); provider.invalidate(); assert.equal((await provider.review("working-tree", fileRef)).state, "reviewed");
  const revertPreview = await provider.sourceRevert(fileRef, null), revertReceipt = await revert.execute(await createSourceRevertCommand(snapshot, revertPreview));
  assert.equal(revertReceipt.resultCode, "reverted"); assert.equal(revertReceipt.auditRef, revertReceipt.settlementEvidenceRef);
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "BASE\n"); provider.invalidate();
  const currentSource = await provider.sourceChanges("working-tree");
  assert.equal(currentSource.files.length, 0); // review target no longer exists; stored evidence remains non-current rather than accepted.
  const staleVerifier = inspectVerifierStaleness(verifier, workingTreeSnapshot(cwd), []);
  assert.equal(staleVerifier.state, "stale"); assert.deepEqual(staleVerifier.invalidatedByFiles, ["a.txt"]); assert.equal(staleVerifier.filesKnown, true);

  const ledger = readSourceMutationEvidence(cwd, task.taskRunId); assert.deepEqual(ledger.corruptions, []);
  assert.equal(ledger.records.length, 6); assert.deepEqual(ledger.records.map((record) => record.phase),
    ["requested", "settled", "requested", "settled", "requested", "settled"]);
  for (const receipt of [stage, unstage, revertReceipt]) assert.ok(ledger.records.some((record) => record.phase === "settled"
    && record.evidenceRef === receipt.auditRef && record.evidenceRef === receipt.settlementEvidenceRef));
});
