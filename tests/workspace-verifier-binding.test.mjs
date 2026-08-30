import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureWorkspaceRevision, currentWorkspaceRevisionDigest } from "../packages/piagent-core/extensions/workspace-revision.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";
import { normalizeTaskContract, taskContractValidationErrors } from "../packages/piagent-core/extensions/task-state.js";
import { verificationEvidenceProvesStableTree, recordedFailureForObservation, classifyVerificationFailure } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { reuseCurrentTreeExactVerifier } from "../packages/piagent-core/runtime/verification/exact-verifier-reuse.ts";
import { RuntimeSessionState } from "../packages/piagent-core/runtime/session/runtime-state.ts";
import { handoffVerifierBindingErrors } from "../packages/piagent-core/runtime/recovery/handoff-verifier-binding.ts";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
function directory(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-workspace-verifier-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function repository(root, commit = true) {
  fs.mkdirSync(root, { recursive: true }); git(root, "init", "-q");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(root, "source.js"), "export const value = 1;\n");
  if (commit) { git(root, "add", "source.js"); git(root, "commit", "-qm", "baseline"); }
  return root;
}
function observation(snapshot) {
  return { command: "npm test", observed: true, matchedProfileCommand: true, exitCode: 0, summary: "pass",
    recordedAt: "2026-08-30T00:00:00.000Z", observedAt: "2026-08-30T00:00:00.000Z",
    preWorkingTreeDigest: snapshot.digest, workingTreeDigest: snapshot.digest,
    preWorkspaceRevisionDigest: snapshot.workspaceRevisionDigest, workspaceRevisionDigest: snapshot.workspaceRevisionDigest };
}

test("a clean HEAD change invalidates verifier reuse even when the dirty-tree digest is unchanged", (context) => {
  const cwd = repository(directory(context)), before = captureWorkspaceVerificationSnapshot(cwd);
  const entry = observation(before);
  assert.equal(verificationEvidenceProvesStableTree(entry, before.digest, before.workspaceRevisionDigest), true);
  fs.writeFileSync(path.join(cwd, "source.js"), "export const value = 2;\n");
  git(cwd, "add", "source.js"); git(cwd, "commit", "-qm", "new clean baseline");
  const after = captureWorkspaceVerificationSnapshot(cwd);
  assert.equal(before.digest, after.digest); assert.notEqual(before.workspaceRevisionDigest, after.workspaceRevisionDigest);
  assert.equal(verificationEvidenceProvesStableTree(entry, after.digest, after.workspaceRevisionDigest), false);
  const task = { taskRunId: "task-1", changeMode: "source-change", trace: { outcome: "pending" }, workingTreeDigestAlgorithm: "wt-content-v2", verifyCommands: ["npm test"], verifyEvidence: [entry] };
  const input = { command: "npm test" };
  assert.equal(reuseCurrentTreeExactVerifier({ cwd, task, toolName: "bash", toolInput: input }).reused, false);
  assert.equal(input.command, "npm test");
  task.verifyEvidence = [observation(after)];
  assert.equal(reuseCurrentTreeExactVerifier({ cwd, task, toolName: "bash", toolInput: { command: "npm test" } }).reused, true);
});

test("workspace identity covers every child baseline, topology, canonical root, and unborn/detached HEAD", (context) => {
  const cwd = directory(context), first = repository(path.join(cwd, "first")), second = repository(path.join(cwd, "second"), false);
  const before = captureWorkspaceRevision(cwd);
  assert.equal(before.repositories.length, 2);
  assert.match(before.repositories[1].head, /^unborn:refs\/heads\//);
  git(second, "add", "source.js"); git(second, "commit", "-qm", "second baseline");
  assert.notEqual(currentWorkspaceRevisionDigest(cwd), before.digest);
  const committed = captureWorkspaceRevision(cwd);
  git(first, "switch", "--detach", "-q", "HEAD");
  assert.equal(currentWorkspaceRevisionDigest(cwd), committed.digest, "identical commit bytes remain the same baseline");
  repository(path.join(cwd, "third"));
  assert.notEqual(currentWorkspaceRevisionDigest(cwd), committed.digest);
  assert.notEqual(currentWorkspaceRevisionDigest(first), currentWorkspaceRevisionDigest(second));
});

test("missing, malformed, partial, or contradictory revision evidence cannot prove a current verifier", (context) => {
  const cwd = repository(directory(context)), snapshot = captureWorkspaceVerificationSnapshot(cwd), entry = observation(snapshot);
  for (const revision of [null, "bad", snapshot.digest]) assert.equal(verificationEvidenceProvesStableTree(entry, snapshot.digest, revision), false);
  for (const field of ["preWorkspaceRevisionDigest", "workspaceRevisionDigest"]) {
    const partial = { ...entry }; delete partial[field];
    assert.equal(verificationEvidenceProvesStableTree(partial, snapshot.digest, snapshot.workspaceRevisionDigest), false);
  }
  assert.equal(verificationEvidenceProvesStableTree(entry, snapshot.digest), false, "bound entries require an explicit current revision");
  assert.equal(verificationEvidenceProvesStableTree({ ...entry, isError: true }, snapshot.digest, snapshot.workspaceRevisionDigest), false);
  const unknownRoot = directory(context);
  assert.equal(currentWorkspaceRevisionDigest(unknownRoot), null);
  fs.writeFileSync(path.join(unknownRoot, ".git"), "gitdir: absent\n");
  assert.equal(captureWorkspaceVerificationSnapshot(unknownRoot).proofCapable, false);
});

test("parallel equal commands retain distinct before-snapshots and reject cross-call/session/task results", (context) => {
  const cwd = repository(directory(context));
  const ctx = { cwd, sessionManager: { getSessionId: () => "session-1" } };
  const state = new RuntimeSessionState({ maxObservedContext: 10 });
  state.cacheTaskIdentity(ctx, { taskId: "one", taskRunId: "one-run" });
  const input = { command: "npm test" };
  state.rememberShellMutationSnapshot(ctx, "bash", input, "call-1");
  fs.writeFileSync(path.join(cwd, "source.js"), "export const value = 2;\n");
  git(cwd, "add", "source.js"); git(cwd, "commit", "-qm", "between calls");
  state.rememberShellMutationSnapshot(ctx, "bash", input, "call-2");
  assert.equal(state.consumeShellVerificationSnapshot(ctx, "bash", input, "wrong"), undefined);
  assert.equal(state.consumeShellVerificationSnapshot(ctx, "bash", { command: "npm run lint" }, "call-1"), undefined);
  const second = state.consumeShellVerificationSnapshot(ctx, "bash", input, "call-2");
  const first = state.consumeShellVerificationSnapshot(ctx, "bash", input, "call-1");
  assert.equal(first.digest, second.digest); assert.notEqual(first.workspaceRevisionDigest, second.workspaceRevisionDigest);
  assert.equal(state.consumeShellVerificationSnapshot(ctx, "bash", input, "call-1"), undefined);
  for (let index = 0; index < 3; index++) state.rememberShellMutationSnapshot(ctx, "bash", input, "ambiguous");
  assert.equal(state.consumeShellVerificationSnapshot(ctx, "bash", input, "ambiguous"), undefined);
  state.rememberShellMutationSnapshot(ctx, "bash", input, "old-task");
  state.cacheTaskIdentity(ctx, { taskId: "two", taskRunId: "two-run" });
  assert.equal(state.consumeShellVerificationSnapshot(ctx, "bash", input, "old-task"), undefined);
  state.rememberShellMutationSnapshot(ctx, "bash", input, "new-task");
  assert.equal(state.consumeShellVerificationSnapshot({ ...ctx, sessionManager: { getSessionId: () => "another" } }, "bash", input, "new-task"), undefined);
  state.clearShellMutationSnapshots(ctx);
  assert.equal(state.consumeShellVerificationSnapshot(ctx, "bash", input, "new-task"), undefined);
});

test("task normalization preserves baseline bindings and rejects malformed replacements", (context) => {
  const cwd = repository(directory(context)), entry = observation(captureWorkspaceVerificationSnapshot(cwd));
  const fixture = JSON.parse(fs.readFileSync(new URL("../evals/fixtures/task-contract.valid.json", import.meta.url), "utf8"));
  fixture.verifyEvidence = [entry];
  assert.deepEqual(taskContractValidationErrors(fixture), []);
  assert.equal(normalizeTaskContract(fixture).verifyEvidence[0].workspaceRevisionDigest, entry.workspaceRevisionDigest);
  fixture.verifyEvidence[0].workspaceRevisionDigest = entry.workingTreeDigest;
  assert.ok(taskContractValidationErrors(fixture).includes("verifyEvidence entries are invalid"));
});

test("failed checkpoint classification and serialized handoff claims are baseline-bound too", (context) => {
  const cwd = repository(directory(context)), snapshot = captureWorkspaceVerificationSnapshot(cwd), entry = { ...observation(snapshot), exitCode: 1 };
  const classification = classifyVerificationFailure("AssertionError: expected correct result", 1);
  const checkpoints = [{ phase: "verify", status: "failed", evidence: { failureClassification: classification, verificationObservation: { ...entry } } }];
  assert.equal(recordedFailureForObservation(checkpoints, entry, snapshot.digest, snapshot.workspaceRevisionDigest).category, "test-assertion");
  assert.equal(recordedFailureForObservation(checkpoints, entry, snapshot.digest, `workspace-revision-v1:${"f".repeat(64)}`), undefined);
  delete checkpoints[0].evidence.verificationObservation.preWorkspaceRevisionDigest;
  assert.equal(recordedFailureForObservation(checkpoints, entry, snapshot.digest, snapshot.workspaceRevisionDigest), undefined);
  const tree = { currentDigest: snapshot.digest, workspaceRevisionDigest: snapshot.workspaceRevisionDigest, latestVerifierMatchesCurrentTree: true };
  assert.deepEqual(handoffVerifierBindingErrors(tree, observation(snapshot)), []);
  assert.ok(handoffVerifierBindingErrors({ ...tree, workspaceRevisionDigest: `workspace-revision-v1:${"f".repeat(64)}` }, observation(snapshot)).includes("latest verifier tree claim is invalid"));
  const unbound = observation(snapshot); delete unbound.workspaceRevisionDigest;
  assert.ok(handoffVerifierBindingErrors(tree, unbound).length > 0);
});
