import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { collectFileDiff } from "../packages/piagent-core/runtime/inspection/diff-projection.ts";
import { collectSourceChangeViews } from "../packages/piagent-core/runtime/inspection/source-change-projection.ts";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { appendSourceMutationEvidence, readSourceMutationEvidence } from "../packages/piagent-core/runtime/inspection/source-mutation-store.ts";
import { collectSourceMutationPreview } from "../packages/piagent-core/runtime/inspection/source-mutation-projection.ts";
import { PiSourceMutationGuard } from "../packages/piagent-core/runtime/policy/source-mutation-guard.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { SourceMutationController } from "../packages/piagent-webui/extension/source-mutation-controller.ts";
import { createSourceMutationCommand } from "../packages/piagent-webui/client/src/source-mutation-command.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const registry = createWebUiSchemaRegistry();
const identity = { projectRef: "project.mutation", runtimeInstanceId: "runtime.mutation", sessionRef: "session.mutation",
  taskId: "task-mutation", taskRunId: "task-mutation-run", agentOperationId: null, toolCallId: null };
const taskRevision = "task-revision.mutation";
const revisions = { runtimeRevision: "runtime-revision.mutation", taskRevision, controlRevision: "control-revision.mutation",
  workspaceRevision: "workspace-revision.mutation", indexRevision: "index-revision.mutation", approvalRevision: null,
  sessionOptionRevision: null, queueRevision: null };

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-mutation-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "A BASE\n"); fs.writeFileSync(path.join(cwd, "b.txt"), "B BASE\n");
  execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "base"]);
  return cwd;
}

function boundGuard(t, cwd, options = {}) {
  const guard = new PiSourceMutationGuard(), rawSessionId = "raw-mutation-session";
  const unbind = guard.bind({ cwd, rawSessionId, guardInstanceId: "guard-instance.mutation", facts: () => ({
    taskId: identity.taskId, taskRunId: identity.taskRunId, taskRevision, controlRevision: revisions.controlRevision,
    taskState: options.taskState ?? "active", idle: options.idle ?? true, isProtectedPath: options.isProtectedPath ?? (() => false)
  }) });
  t.after(unbind);
  return { available: () => guard.available(cwd, rawSessionId),
    mutate: (input) => guard.execute({ cwd, rawSessionId, ...input }) };
}

function guardRequest(action, authority, selectedHunkRefs = []) {
  return { identity: { projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef,
    taskId: identity.taskId, taskRunId: identity.taskRunId }, action, expectedTaskRevision: taskRevision,
  expectedControlRevision: revisions.controlRevision, expectedIndexPreimage: authority.target.indexPreimage,
  expectedWorkspacePreimage: authority.target.workspacePreimage, selectedHunkRefs, authority };
}

async function selected(cwd, action, filename, guardAvailable = true) {
  const generatedAt = new Date().toISOString(), views = await collectSourceChangeViews({ cwd, identity, taskRevision, generatedAt });
  const source = action === "source.stage" ? views.workingTree : views.staged;
  const file = source.files.find((candidate) => candidate.path === filename);
  assert.ok(file, `${filename} must be present in ${source.view}: ${JSON.stringify(source.files.map((item) => [item.status, item.oldPath, item.path]))}`);
  const diff = await collectFileDiff({ cwd, identity, sourceView: source, fileRef: file.fileRef,
    precondition: { expectedViewRevision: source.viewRevision, expectedFileRevision: file.fileRevision,
      expectedBaseDigest: file.baseDigest, expectedCurrentDigest: file.currentDigest }, taskRevision,
    revalidationMode: "selected-file", selectedRepoPaths: [file.oldPath, file.path].filter(Boolean) });
  return collectSourceMutationPreview({ cwd, identity, action, sourceView: source, diff, taskRevision,
    workspaceRevision: views.workingTree.viewRevision, indexRevision: views.staged.viewRevision, generatedAt, guardAvailable });
}

test("guarded file stage and unstage preserve worktree bytes and unrelated index entries", async (t) => {
  const cwd = repository(t), capturedAt = new Date(), guard = boundGuard(t, cwd);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-session-not-evidence", capturedAt: capturedAt.toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  fs.writeFileSync(path.join(cwd, "a.txt"), "A OPERATOR SAW\n");
  fs.writeFileSync(path.join(cwd, "b.txt"), "B STAGED\n"); execFileSync("git", ["-C", cwd, "add", "b.txt"]);
  fs.writeFileSync(path.join(cwd, "b.txt"), "B WORKTREE\n");
  const worktreeBefore = { a: fs.readFileSync(path.join(cwd, "a.txt")), b: fs.readFileSync(path.join(cwd, "b.txt")) };
  const stagedB = execFileSync("git", ["-C", cwd, "show", ":b.txt"]);

  const stage = await selected(cwd, "source.stage", "a.txt");
  assert.equal(stage.projection.state, "ready"); assert.ok(stage.authority);
  assert.equal(validateFixture(registry, "source-mutation-v1", stage.projection).valid, true);
  assert.equal(guard.available(), true);
  const staged = await guard.mutate(guardRequest("source.stage", stage.authority));
  assert.equal(staged.state, "settled", staged.reasonCode); assert.notEqual(staged.afterIndexPreimage, staged.beforeIndexPreimage);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), worktreeBefore.a); assert.deepEqual(fs.readFileSync(path.join(cwd, "b.txt")), worktreeBefore.b);
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":a.txt"]), worktreeBefore.a);
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":b.txt"]), stagedB);

  const unstage = await selected(cwd, "source.unstage", "a.txt");
  assert.equal(unstage.projection.state, "ready"); assert.ok(unstage.authority);
  const unstaged = await guard.mutate(guardRequest("source.unstage", unstage.authority));
  assert.equal(unstaged.state, "settled", unstaged.reasonCode);
  assert.equal(execFileSync("git", ["-C", cwd, "diff", "--cached", "--", "a.txt"]).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), worktreeBefore.a); assert.deepEqual(fs.readFileSync(path.join(cwd, "b.txt")), worktreeBefore.b);
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":b.txt"]), stagedB);

  const common = { projectRoot: cwd, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef,
    taskId: identity.taskId, taskRunId: identity.taskRunId, commandId: "mutation-command.one", idempotencyKeyDigest: `sha256:${"4".repeat(64)}`,
    actionDigest: `sha256:${"5".repeat(64)}`, action: "source.stage", target: stage.authority.target, requestedAt: capturedAt.toISOString(),
    beforeIndexPreimage: staged.beforeIndexPreimage, beforeWorkspacePreimage: staged.beforeWorkspacePreimage, observedRevisionsBefore: revisions,
    selectedHunkRefs: [], failureCode: null };
  appendSourceMutationEvidence({ ...common, phase: "requested", resultCode: "mutation-requested", recordedAt: new Date(capturedAt.getTime() + 1_000).toISOString(),
    afterIndexPreimage: null, afterWorkspacePreimage: null, observedRevisionsAfter: null });
  appendSourceMutationEvidence({ ...common, phase: "settled", resultCode: "staged", recordedAt: new Date(capturedAt.getTime() + 2_000).toISOString(),
    afterIndexPreimage: staged.afterIndexPreimage, afterWorkspacePreimage: staged.afterWorkspacePreimage, observedRevisionsAfter: revisions });
  const evidence = readSourceMutationEvidence(cwd, identity.taskRunId);
  assert.equal(evidence.corruptions.length, 0); assert.equal(evidence.records.length, 2);
  assert.equal(JSON.stringify(evidence.records).includes("A OPERATOR SAW"), false);
});

test("stale workspace and held index lock reject before mutation", async (t) => {
  const cwd = repository(t), guard = boundGuard(t, cwd); fs.writeFileSync(path.join(cwd, "a.txt"), "A PREVIEW\n");
  const stage = await selected(cwd, "source.stage", "a.txt"); assert.ok(stage.authority);
  fs.writeFileSync(path.join(cwd, "a.txt"), "A CHANGED AFTER PREVIEW\n");
  assert.equal(stage.authority.target.hunkRefs.length, 1);
  const stale = await guard.mutate(guardRequest("source.stage", stage.authority, [stage.authority.target.hunkRefs[0]]));
  assert.equal(stale.state, "rejected"); assert.equal(stale.reasonCode, "mutation-preimage-stale");
  assert.equal(execFileSync("git", ["-C", cwd, "diff", "--cached", "--", "a.txt"]).length, 0);

  const staleIndexPreview = await selected(cwd, "source.stage", "a.txt"); assert.ok(staleIndexPreview.authority);
  fs.writeFileSync(path.join(cwd, "b.txt"), "B CONCURRENT INDEX\n"); execFileSync("git", ["-C", cwd, "add", "b.txt"]);
  assert.equal(staleIndexPreview.authority.target.hunkRefs.length, 1);
  const staleIndex = await guard.mutate(guardRequest("source.stage", staleIndexPreview.authority, [staleIndexPreview.authority.target.hunkRefs[0]]));
  assert.equal(staleIndex.state, "rejected"); assert.equal(staleIndex.reasonCode, "mutation-preimage-stale");
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":b.txt"]), Buffer.from("B CONCURRENT INDEX\n"));

  const fresh = await selected(cwd, "source.stage", "a.txt"); assert.ok(fresh.authority);
  const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(gitDir, "index.lock"), "owned elsewhere");
  t.after(() => fs.rmSync(path.join(gitDir, "index.lock"), { force: true }));
  const locked = await guard.mutate(guardRequest("source.stage", fresh.authority));
  assert.equal(locked.state, "rejected"); assert.equal(locked.reasonCode, "git-index-locked");
  assert.equal(fs.readFileSync(path.join(gitDir, "index.lock"), "utf8"), "owned elsewhere");
});

test("guarded staging binds rename aliases and never invokes repository clean filters", async (t) => {
  const cwd = repository(t), guard = boundGuard(t, cwd), sentinel = path.join(cwd, "filter-ran"), filterScript = path.join(os.tmpdir(), `piagent-filter-probe-${process.pid}-${Date.now()}.cjs`);
  t.after(() => fs.rmSync(filterScript, { force: true }));
  const original = "LINE 1\nLINE 2\nLINE 3\nLINE 4\nLINE 5\n";
  fs.writeFileSync(path.join(cwd, "a.txt"), original); execFileSync("git", ["-C", cwd, "add", "a.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "rename source"]);
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.txt filter=hostile\n");
  execFileSync("git", ["-C", cwd, "add", ".gitattributes"]); execFileSync("git", ["-C", cwd, "commit", "-qm", "attributes"]);
  fs.writeFileSync(filterScript, "const fs=require('node:fs');fs.writeFileSync('filter-ran',process.env.GIT_INDEX_FILE||'real-index');process.stdin.pipe(process.stdout);\n");
  execFileSync("git", ["-C", cwd, "config", "filter.hostile.clean", `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)}`]);
  execFileSync("git", ["-C", cwd, "mv", "a.txt", "renamed.txt"]);
  const renamed = "LINE 1\nLINE 2\nLINE 3\nLINE 4\nRENAMED RAW\n"; fs.writeFileSync(path.join(cwd, "renamed.txt"), renamed);
  fs.rmSync(sentinel, { force: true });
  const stage = await selected(cwd, "source.stage", "renamed.txt"); assert.ok(stage.authority);
  assert.equal(fs.existsSync(sentinel), false, "read-side Git collector must disable clean filters");
  assert.equal(stage.authority.target.status, "R"); assert.deepEqual(new Set(stage.authority.repoPaths), new Set(["a.txt", "renamed.txt"]));
  const staged = await guard.mutate(guardRequest("source.stage", stage.authority));
  assert.equal(staged.state, "settled", staged.reasonCode); assert.equal(fs.existsSync(sentinel), false,
    fs.existsSync(sentinel) ? `clean filter executed with index ${fs.readFileSync(sentinel, "utf8")}` : "clean filter must not execute");
  assert.equal(execFileSync("git", ["-C", cwd, "show", ":renamed.txt"], { encoding: "utf8" }), renamed);
  assert.throws(() => execFileSync("git", ["-C", cwd, "show", ":a.txt"], { stdio: "pipe" }));
  const unstage = await selected(cwd, "source.unstage", "renamed.txt"); assert.ok(unstage.authority);
  assert.deepEqual(new Set(unstage.authority.repoPaths), new Set(["a.txt", "renamed.txt"]));
  assert.equal(fs.existsSync(sentinel), false);
  const unstaged = await guard.mutate(guardRequest("source.unstage", unstage.authority));
  assert.equal(unstaged.state, "settled", unstaged.reasonCode); assert.equal(fs.existsSync(sentinel), false);
  assert.equal(execFileSync("git", ["-C", cwd, "show", ":a.txt"], { encoding: "utf8" }), original);
  assert.throws(() => execFileSync("git", ["-C", cwd, "show", ":renamed.txt"], { stdio: "pipe" }));
});

test("selected hunk Stage and Unstage preserve the other hunk and worktree", async (t) => {
  const cwd = repository(t), guard = boundGuard(t, cwd);
  const baseLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`), changedLines = [...baseLines];
  fs.writeFileSync(path.join(cwd, "a.txt"), `${baseLines.join("\n")}\n`); execFileSync("git", ["-C", cwd, "add", "a.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "hunk baseline"]);
  changedLines[1] = "line 2 changed"; changedLines[20] = "line 21 changed";
  const worktree = `${changedLines.join("\n")}\n`; fs.writeFileSync(path.join(cwd, "a.txt"), worktree);

  const stage = await selected(cwd, "source.stage", "a.txt"); assert.ok(stage.authority);
  assert.equal(stage.authority.target.hunkRefs.length, 2); assert.ok(stage.authority.patchAuthority);
  const browserSnapshot = { identity, revision: { ...revisions, workspaceRevision: stage.authority.target.workspaceRevision,
    indexRevision: stage.authority.target.indexRevision, eventCursor: null } };
  await assert.rejects(createSourceMutationCommand(browserSnapshot, stage.projection,
    [...stage.authority.target.hunkRefs].reverse()), /hunk-unavailable/);
  const duplicate = await guard.mutate(guardRequest("source.stage", stage.authority,
    [stage.authority.target.hunkRefs[0], stage.authority.target.hunkRefs[0]]));
  assert.equal(duplicate.state, "rejected"); assert.equal(duplicate.reasonCode, "mutation-guard-request-invalid");
  const firstStage = await guard.mutate(guardRequest("source.stage", stage.authority, [stage.authority.target.hunkRefs[0]]));
  assert.equal(firstStage.state, "settled", firstStage.reasonCode);
  const firstOnly = [...baseLines]; firstOnly[1] = changedLines[1];
  assert.equal(execFileSync("git", ["-C", cwd, "show", ":a.txt"], { encoding: "utf8" }), `${firstOnly.join("\n")}\n`);
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), worktree);

  const remaining = await selected(cwd, "source.stage", "a.txt"); assert.ok(remaining.authority);
  assert.equal(remaining.authority.target.hunkRefs.length, 1);
  const stageRest = await guard.mutate(guardRequest("source.stage", remaining.authority));
  assert.equal(stageRest.state, "settled", stageRest.reasonCode);
  assert.equal(execFileSync("git", ["-C", cwd, "show", ":a.txt"], { encoding: "utf8" }), worktree);

  const unstage = await selected(cwd, "source.unstage", "a.txt"); assert.ok(unstage.authority);
  assert.equal(unstage.authority.target.hunkRefs.length, 2);
  const reordered = await guard.mutate(guardRequest("source.unstage", unstage.authority, [...unstage.authority.target.hunkRefs].reverse()));
  assert.equal(reordered.state, "rejected"); assert.equal(reordered.reasonCode, "mutation-guard-request-invalid");
  const firstUnstage = await guard.mutate(guardRequest("source.unstage", unstage.authority, [unstage.authority.target.hunkRefs[0]]));
  assert.equal(firstUnstage.state, "settled", firstUnstage.reasonCode);
  const secondOnly = [...baseLines]; secondOnly[20] = changedLines[20];
  assert.equal(execFileSync("git", ["-C", cwd, "show", ":a.txt"], { encoding: "utf8" }), `${secondOnly.join("\n")}\n`);
  assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), worktree);
  const foreign = await guard.mutate(guardRequest("source.unstage", unstage.authority, ["hunk.foreign"]));
  assert.equal(foreign.state, "rejected"); assert.equal(foreign.reasonCode, "mutation-guard-request-invalid");
});

test("selected hunk preserves an exact no-final-newline index image", async (t) => {
  const cwd = repository(t), guard = boundGuard(t, cwd);
  const baseLines = Array.from({ length: 24 }, (_, index) => `no-newline ${index + 1}`), changedLines = [...baseLines];
  const baseline = Buffer.from(baseLines.join("\n"));
  fs.writeFileSync(path.join(cwd, "a.txt"), baseline); execFileSync("git", ["-C", cwd, "add", "a.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "no final newline baseline"]);
  changedLines[1] = "no-newline 2 changed"; changedLines[20] = "no-newline 21 changed";
  const worktree = Buffer.from(changedLines.join("\n")); fs.writeFileSync(path.join(cwd, "a.txt"), worktree);

  const stage = await selected(cwd, "source.stage", "a.txt"); assert.ok(stage.authority);
  assert.equal(stage.authority.target.hunkRefs.length, 2);
  const second = await guard.mutate(guardRequest("source.stage", stage.authority, [stage.authority.target.hunkRefs[1]]));
  assert.equal(second.state, "settled", second.reasonCode);
  const secondOnly = [...baseLines]; secondOnly[20] = changedLines[20];
  const stagedBytes = execFileSync("git", ["-C", cwd, "show", ":a.txt"]);
  assert.deepEqual(stagedBytes, Buffer.from(secondOnly.join("\n"))); assert.notEqual(stagedBytes.at(-1), "\n".charCodeAt(0));
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), worktree);

  const unstage = await selected(cwd, "source.unstage", "a.txt"); assert.ok(unstage.authority);
  assert.equal(unstage.authority.target.hunkRefs.length, 1);
  const restored = await guard.mutate(guardRequest("source.unstage", unstage.authority, [unstage.authority.target.hunkRefs[0]]));
  assert.equal(restored.state, "settled", restored.reasonCode);
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":a.txt"]), baseline);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "a.txt")), worktree);
});

test("missing or rejecting Pi guard cannot advertise or execute a source mutation", async (t) => {
  const cwd = repository(t); fs.writeFileSync(path.join(cwd, "a.txt"), "A GUARDED\n");
  const unavailable = await selected(cwd, "source.stage", "a.txt", false);
  assert.equal(unavailable.projection.state, "unavailable"); assert.equal(unavailable.projection.reasonCode, "mutation-guard-unavailable");
  const ready = await selected(cwd, "source.stage", "a.txt"); assert.ok(ready.authority);
  const unbound = new PiSourceMutationGuard();
  const absent = await unbound.execute({ cwd, rawSessionId: "raw-mutation-session", ...guardRequest("source.stage", ready.authority) });
  assert.equal(absent.state, "rejected"); assert.equal(absent.reasonCode, "mutation-guard-unavailable");
  const protectedGuard = boundGuard(t, cwd, { isProtectedPath: (candidate) => candidate === "a.txt" });
  const blocked = await protectedGuard.mutate(guardRequest("source.stage", ready.authority));
  assert.equal(blocked.state, "rejected"); assert.equal(blocked.reasonCode, "mutation-guard-precondition-stale");
  assert.equal(execFileSync("git", ["-C", cwd, "diff", "--cached", "--", "a.txt"]).length, 0);
});

test("source mutation controller binds browser intent, persists receipt and deduplicates retry", async (t) => {
  const cwd = repository(t), capturedAt = new Date(), guard = boundGuard(t, cwd);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-controller-session", capturedAt: capturedAt.toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  fs.writeFileSync(path.join(cwd, "a.txt"), "A THROUGH CONTROLLER\n");
  const preview = await selected(cwd, "source.stage", "a.txt"); assert.ok(preview.authority);
  const bridgeRevisions = { ...revisions, workspaceRevision: preview.authority.target.workspaceRevision, indexRevision: preview.authority.target.indexRevision };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions: bridgeRevisions, taskState: "active", liveness: "idle" }) };
  let resolves = 0;
  const controller = new SourceMutationController({ bridge, projectRoot: cwd,
    resolve: async (action, fileRef) => { resolves += 1; const current = await selected(cwd, action, "a.txt");
      return current.projection.target?.fileRef === fileRef ? current : { projection: { ...current.projection, state: "unavailable", target: null, reasonCode: "not-found" }, authority: null }; },
    revisions: async () => { const views = await collectSourceChangeViews({ cwd, identity, taskRevision, generatedAt: new Date().toISOString() });
      return { ...bridgeRevisions, workspaceRevision: views.workingTree.viewRevision, indexRevision: views.staged.viewRevision }; },
    mutate: guard.mutate });
  const snapshot = { identity, revision: { ...bridgeRevisions, eventCursor: null } };
  assert.equal(preview.projection.target.hunkRefs.length, 1);
  await assert.rejects(createSourceMutationCommand(snapshot, preview.projection, ["hunk.foreign"]), /hunk-unavailable/);
  await assert.rejects(createSourceMutationCommand(snapshot, preview.projection,
    [preview.projection.target.hunkRefs[0], preview.projection.target.hunkRefs[0]]), /hunk-unavailable/);
  const command = await createSourceMutationCommand(snapshot, preview.projection, [preview.projection.target.hunkRefs[0]]);
  assert.equal(validateFixture(registry, "control-command-v1", command).valid, true);
  const zeroTurnState = { providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    continuationConsumed: 0, turnTriggers: 0, sessionRef: identity.sessionRef, leafMessageRef: "message.mutation",
    messageSetDigest: digestZeroTurnFact("messages", ["message.mutation"]), taskContractDigest: digestZeroTurnFact("task", identity.taskRunId),
    journalHead: "journal.mutation", promptDigest: digestZeroTurnFact("prompt", "stable"),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", parameters: { type: "object" } }]), latestCausalSequence: 0, causalEvents: [] };
  const zeroTurn = await runZeroTurnConformance({ action: "source.stage", commandId: command.commandId,
    concurrency: "quiescent", mutationClass: "control" }, () => structuredClone(zeroTurnState), () => controller.execute(command));
  assert.equal(zeroTurn.passed, true, zeroTurn.violations.join(", "));
  const receipt = zeroTurn.result;
  assert.equal(receipt.phase, "settled"); assert.equal(receipt.resultCode, "staged");
  assert.equal(validateFixture(registry, "control-command-v1", receipt).valid, true);
  assert.deepEqual(execFileSync("git", ["-C", cwd, "show", ":a.txt"]), Buffer.from("A THROUGH CONTROLLER\n"));
  const replay = await controller.execute(command);
  assert.equal(replay.phase, "settled"); assert.equal(replay.deduplicated, true); assert.equal(resolves, 1);
  const records = readSourceMutationEvidence(cwd, identity.taskRunId).records;
  assert.equal(records.length, 2); assert.deepEqual(records.map((record) => record.selectedHunkRefs), [command.payload.hunkRefs, command.payload.hunkRefs]);
  assert.equal(JSON.stringify(records).includes("A THROUGH CONTROLLER"), false);
});

test("controller durably rejects a selected hunk under a foreign index lock and deduplicates retry", async (t) => {
  const cwd = repository(t), capturedAt = new Date(), guard = boundGuard(t, cwd);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: identity.taskId, taskRunId: identity.taskRunId,
    sessionId: "raw-controller-lock-session", capturedAt: capturedAt.toISOString(), baselineTreeDigest: workingTreeEvidenceDigest(workingTreeSnapshot(cwd)) });
  fs.writeFileSync(path.join(cwd, "a.txt"), "A LOCKED HUNK\n");
  const preview = await selected(cwd, "source.stage", "a.txt"); assert.ok(preview.authority);
  const bridgeRevisions = { ...revisions, workspaceRevision: preview.authority.target.workspaceRevision, indexRevision: preview.authority.target.indexRevision };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions: bridgeRevisions, taskState: "active", liveness: "idle" }) };
  let mutations = 0;
  const controller = new SourceMutationController({ bridge, projectRoot: cwd,
    resolve: async () => await selected(cwd, "source.stage", "a.txt"),
    revisions: async () => bridgeRevisions,
    mutate: async (input) => { mutations += 1; return guard.mutate(input); } });
  const snapshot = { identity, revision: { ...bridgeRevisions, eventCursor: null } };
  const command = await createSourceMutationCommand(snapshot, preview.projection, [preview.projection.target.hunkRefs[0]]);
  const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  const lockPath = path.join(gitDir, "index.lock"); fs.writeFileSync(lockPath, "foreign writer");
  t.after(() => fs.rmSync(lockPath, { force: true }));
  const rejected = await controller.execute(command);
  assert.equal(rejected.phase, "rejected"); assert.equal(rejected.resultCode, "capability-unavailable");
  assert.equal(rejected.error?.code, "git-index-locked"); assert.equal(validateFixture(registry, "control-command-v1", rejected).valid, true);
  fs.rmSync(lockPath, { force: true });
  const replay = await controller.execute(command);
  assert.equal(replay.phase, "rejected"); assert.equal(replay.deduplicated, true); assert.equal(mutations, 1);
  assert.equal(execFileSync("git", ["-C", cwd, "diff", "--cached", "--", "a.txt"]).length, 0);
  const records = readSourceMutationEvidence(cwd, identity.taskRunId).records;
  assert.deepEqual(records.map((record) => [record.phase, record.resultCode, record.failureCode]), [
    ["requested", "mutation-requested", null], ["rejected", "mutation-rejected", "git-index-locked"]]);
  assert.deepEqual(records.map((record) => record.selectedHunkRefs), [command.payload.hunkRefs, command.payload.hunkRefs]);
});
