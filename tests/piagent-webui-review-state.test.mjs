import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { deriveReviewTarget, projectReviewState } from "../packages/piagent-core/runtime/inspection/review-state-projection.ts";
import { appendReviewEvidence, readReviewEvidence } from "../packages/piagent-core/runtime/inspection/review-state-store.ts";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import {
  digestZeroTurnFact,
  providerVisibleToolSchemaDigest,
  runZeroTurnConformance
} from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { ReviewController } from "../packages/piagent-webui/extension/review-controller.ts";
import { controlActionDigest } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { createReviewCommand } from "../packages/piagent-webui/client/src/review-command.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.review", runtimeInstanceId: "runtime.review", sessionRef: "session.review",
  taskId: "task-review", taskRunId: "task-review-run", agentOperationId: null, toolCallId: null };
const revisions = { runtimeRevision: "runtime-rev.review", taskRevision: "task-rev.review", controlRevision: "control-rev.review",
  workspaceRevision: "workspace-rev.review", indexRevision: "index-rev.review", approvalRevision: "approval-rev.review",
  sessionOptionRevision: "option-rev.review", queueRevision: "queue-rev.review" };

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-review-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "review.txt"), "base\n");
  execFileSync("git", ["-C", cwd, "add", "review.txt"]); execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  return cwd;
}

async function evidenceFixture(t) {
  const cwd = repository(t), at = new Date();
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-session-never-persisted-in-review", capturedAt: at.toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  const target = { view: "task", fileRef: "file.review", diffRef: "diff.review", taskRevision: revisions.taskRevision,
    workspaceRevision: revisions.workspaceRevision, indexRevision: revisions.indexRevision, viewRevision: "view-rev.review",
    fileRevision: "file-rev.review", baseDigest: `sha256:${"1".repeat(64)}`, currentDigest: `sha256:${"2".repeat(64)}`,
    patchPreimage: `sha256:${"3".repeat(64)}`, contentDigest: `sha256:${"3".repeat(64)}` };
  return { cwd, at, target };
}

function appendOptions(current, overrides = {}) {
  return { projectRoot: current.cwd, taskId: identity.taskId, taskRunId: identity.taskRunId, projectRef: identity.projectRef,
    runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, commandId: "review-command.one",
    idempotencyKeyDigest: `sha256:${"4".repeat(64)}`, actionDigest: `sha256:${"5".repeat(64)}`, reviewState: "reviewed",
    target: current.target, requestedAt: current.at.toISOString(), recordedAt: new Date(current.at.getTime() + 1_000).toISOString(),
    observedRevisions: revisions, ...overrides };
}

function reviewDiff(view = "task") {
  return { view, basis: { basisRef: `basis.${view}` }, observed: { viewRevision: "view-rev.review", fileRevision: "file-rev.review",
    baseDigest: `sha256:${"1".repeat(64)}`, currentDigest: `sha256:${"2".repeat(64)}` },
  file: { fileRef: "file.review", basisRef: `basis.${view}`, status: "M", content: { kind: "text", access: "available" } },
  availability: { state: "current", reasonCode: null }, fallback: { kind: "none", reasonCode: null },
  truncation: { truncated: false }, redaction: { applied: false, truncated: false }, hunks: [] };
}

test("review targets bind source view and exact preimage while refusing incomplete diffs", () => {
  const task = deriveReviewTarget({ diff: reviewDiff("task"), taskId: identity.taskId, taskRunId: identity.taskRunId,
    taskRevision: revisions.taskRevision, workspaceRevision: revisions.workspaceRevision, indexRevision: revisions.indexRevision });
  const working = deriveReviewTarget({ diff: reviewDiff("working-tree"), taskId: identity.taskId, taskRunId: identity.taskRunId,
    taskRevision: revisions.taskRevision, workspaceRevision: revisions.workspaceRevision, indexRevision: revisions.indexRevision });
  assert.ok(task && working); assert.notEqual(task.diffRef, working.diffRef); assert.notEqual(task.patchPreimage, working.patchPreimage);
  const redacted = reviewDiff(); redacted.redaction.applied = true;
  assert.equal(deriveReviewTarget({ diff: redacted, taskId: identity.taskId, taskRunId: identity.taskRunId,
    taskRevision: revisions.taskRevision, workspaceRevision: revisions.workspaceRevision, indexRevision: revisions.indexRevision }), null);
});

test("browser review command carries exact view, diff and patch authority", async () => {
  const target = deriveReviewTarget({ diff: reviewDiff("task"), taskId: identity.taskId, taskRunId: identity.taskRunId,
    taskRevision: revisions.taskRevision, workspaceRevision: revisions.workspaceRevision, indexRevision: revisions.indexRevision });
  const snapshot = { identity, revision: { ...revisions, eventCursor: null } };
  const projection = projectReviewState({ identity, target, records: [] });
  const command = await createReviewCommand(snapshot, projection, "reviewed");
  const validation = validateFixture(registry, "control-command-v1", command);
  assert.equal(validation.valid, true, validation.errors);
  assert.equal(command.payload.view, "task"); assert.equal(command.payload.diffRef, target.diffRef);
  assert.equal(command.expectedRevisions.patchPreimage, target.patchPreimage);
});

test("review evidence is owner-only, bounded, integrity checked and automatically stale", async (t) => {
  const current = await evidenceFixture(t), record = appendReviewEvidence(appendOptions(current));
  const mode = fs.statSync(path.join(current.cwd, ".pi", "piagent-state", "source-evidence",
    `run-${await import("node:crypto").then(({ createHash }) => createHash("sha256").update(identity.taskRunId).digest("hex"))}`, "reviews", `${record.recordId}.json`)).mode & 0o777;
  assert.equal(mode, 0o600);
  const ledger = readReviewEvidence(current.cwd, identity.taskRunId); assert.equal(ledger.corruptions.length, 0); assert.equal(ledger.records.length, 1);
  const projected = projectReviewState({ identity, target: current.target, records: ledger.records });
  assert.equal(projected.state, "reviewed"); assert.equal(validateFixture(registry, "review-state-v1", projected).valid, true);
  const changed = { ...current.target, fileRevision: "file-rev.changed" };
  const stale = projectReviewState({ identity, target: changed, records: ledger.records });
  assert.equal(stale.state, "stale"); assert.equal(stale.reasonCode, "review-target-changed");
  assert.equal(JSON.stringify(ledger.records).includes("raw-session-never-persisted-in-review"), false);
});

test("corrupt review evidence fails closed instead of trusting a partial ledger", async (t) => {
  const current = await evidenceFixture(t), record = appendReviewEvidence(appendOptions(current));
  const file = fs.readdirSync(path.dirname((await import("../packages/piagent-core/runtime/inspection/source-evidence-store.ts")).taskBaselineManifestPath(current.cwd, identity.taskRunId)))
    .includes("reviews"); assert.equal(file, true);
  const reviewDirectory = path.join(path.dirname((await import("../packages/piagent-core/runtime/inspection/source-evidence-store.ts")).taskBaselineManifestPath(current.cwd, identity.taskRunId)), "reviews");
  fs.writeFileSync(path.join(reviewDirectory, `${record.recordId}.json`), "{broken\n");
  const ledger = readReviewEvidence(current.cwd, identity.taskRunId); assert.equal(ledger.records.length, 0); assert.equal(ledger.corruptions.length, 1);
  const projected = projectReviewState({ identity, target: current.target, records: [], corruptions: ledger.corruptions });
  assert.equal(projected.state, "unavailable"); assert.equal(projected.health.state, "error");
});

test("review controller revalidates current target, deduplicates and never mutates source", async (t) => {
  const current = await evidenceFixture(t), sourceBefore = fs.readFileSync(path.join(current.cwd, "review.txt"), "utf8");
  let target = current.target, resolves = 0;
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions, taskState: "active", liveness: "idle" }) };
  const controller = new ReviewController({ bridge, projectRoot: current.cwd, now: () => new Date(current.at.getTime() + 2_000),
    resolve: async () => { resolves += 1; return projectReviewState({ identity, target, records: readReviewEvidence(current.cwd, identity.taskRunId).records }); } });
  const command = { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "command", commandId: "review-command.controller",
    idempotencyKey: "review-controller-idempotency-key-000000000000", requestedAt: current.at.toISOString(),
    expiresAt: new Date(current.at.getTime() + 60_000).toISOString(), capabilityScope: "reviewActions", action: "review.mark", actionDigest: "",
    identity, expectedRevisions: { ...revisions, workspacePreimage: null, indexPreimage: null, patchPreimage: target.patchPreimage },
    payload: { view: target.view, fileRef: target.fileRef, diffRef: target.diffRef, reviewState: "reviewed", contentDigest: target.contentDigest } };
  command.actionDigest = controlActionDigest(command);
  const observe = () => ({
    providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    continuationConsumed: 0, turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: null,
    messageSetDigest: digestZeroTurnFact("messages", []),
    taskContractDigest: digestZeroTurnFact("task", { taskId: identity.taskId, taskRunId: identity.taskRunId }),
    journalHead: null, promptDigest: digestZeroTurnFact("prompt", "unchanged"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([]), latestCausalSequence: 0, causalEvents: []
  });
  const zeroTurn = await runZeroTurnConformance({ action: "review.mark", commandId: command.commandId,
    concurrency: "quiescent", mutationClass: "control" }, observe, () => controller.execute(command));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
  const receipt = zeroTurn.result; assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "reviewed");
  assert.equal(validateFixture(registry, "control-command-v1", receipt).valid, true); assert.equal(resolves, 1);
  const replay = await controller.execute(command); assert.equal(replay.deduplicated, true); assert.equal(resolves, 1);
  assert.equal(readReviewEvidence(current.cwd, identity.taskRunId).records.length, 1);
  assert.equal(fs.readFileSync(path.join(current.cwd, "review.txt"), "utf8"), sourceBefore);

  const unreview = structuredClone(command); unreview.commandId = "review-command.unreview";
  unreview.idempotencyKey = "review-controller-unreview-key-00000000000000"; unreview.payload.reviewState = "unreviewed";
  unreview.actionDigest = controlActionDigest(unreview);
  const unreviewed = await controller.execute(unreview); assert.equal(unreviewed.phase, "settled"); assert.equal(unreviewed.resultCode, "unreviewed");
  assert.equal(validateFixture(registry, "control-command-v1", unreviewed).valid, true);
  const unreviewedProjection = projectReviewState({ identity, target, records: readReviewEvidence(current.cwd, identity.taskRunId).records });
  assert.equal(unreviewedProjection.state, "unreviewed"); assert.equal(unreviewedProjection.recordedState, "unreviewed");

  const staleCommand = structuredClone(command); staleCommand.commandId = "review-command.stale";
  staleCommand.idempotencyKey = "review-controller-stale-key-0000000000000000"; target = { ...target, fileRevision: "file-rev.changed",
    diffRef: "diff.changed", patchPreimage: `sha256:${"6".repeat(64)}`, contentDigest: `sha256:${"6".repeat(64)}` };
  staleCommand.actionDigest = controlActionDigest(staleCommand);
  const stale = await controller.execute(staleCommand); assert.equal(stale.phase, "rejected"); assert.equal(stale.resultCode, "stale-revision");
  assert.equal(readReviewEvidence(current.cwd, identity.taskRunId).records.length, 2);
});
