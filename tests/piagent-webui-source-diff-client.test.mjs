import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { activeFileRef, currentSourceDocument, fileStats, provenanceLabel, relatedEvidence, sourceDocumentMatchesSnapshot,
  sourceDetailUnavailableNeedsRecovery, sourceDiffMatchesSnapshot, sourceSummary,
  sourceTabs } from "../packages/piagent-webui/client/src/source-view-model.ts";
import { tokenizeDiffLine } from "../packages/piagent-webui/client/src/diff-syntax.ts";
import { CoreInspectionProvider } from "../packages/piagent-webui/server/core-inspection-provider.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const source = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/source-change-v1.valid.json"), "utf8"));
const diff = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/diff-v1.valid.json"), "utf8"));
const taskFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const registry = createWebUiSchemaRegistry();

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-view-diff-"));
  execFileSync("git", ["init", "-q", cwd]);
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Piagent Test");
  fs.writeFileSync(path.join(cwd, "shared.txt"), "HEAD BASE\nkept\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "baseline");
  return cwd;
}

async function dirtyBaselineProvider() {
  const cwd = repository();
  fs.writeFileSync(path.join(cwd, "shared.txt"), "DIRTY AT TASK START\nkept\n");
  const baseline = workingTreeSnapshot(cwd);
  let task = {
    ...structuredClone(taskFixture), taskId: "view-diff-task", taskRunId: "view-diff-task-run-1", sessionId: "view-diff-session",
    sessionName: "View diff", baselineChangedFiles: Object.keys(baseline), baselineFileDigests: baseline,
    createdAt: "2026-08-13T13:00:00.000Z", updatedAt: "2026-08-13T13:00:00.000Z", trace: { outcome: "pending" }
  };
  task.authoritySnapshot = createBoundTaskAuthority(task);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: task.taskId, taskRunId: task.taskRunId,
    sessionId: task.sessionId, capturedAt: task.createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  fs.writeFileSync(path.join(cwd, "shared.txt"), "AFTER TASK\nkept\n");
  let eventCursor = "event-cursor.view-diff";
  const eventStore = {
    retention: () => ({ eventRetentionCount: 0, eventRetentionSeconds: 0 }), currentCursor: () => eventCursor,
    resyncRequired: () => false, replay: () => ({ state: "current", events: [], nextCursor: eventCursor, latestCursor: eventCursor, reasonCode: null })
  };
  const provider = new CoreInspectionProvider({ cwd, sessionId: task.sessionId, runtimeInstanceId: "runtime.view-diff", eventStore, task: () => task,
    sourceMutationGuardAvailable: () => true });
  return { provider, cwd, eventStore, task: () => task,
    setEventCursor(value) { eventCursor = value; provider.invalidate(); },
    setTaskUpdatedAt(value) { task = { ...task, updatedAt: value }; provider.invalidate(); } };
}

describe("Piagent WebUI source tabs and diff projection", () => {
  it("keeps Task, Working Tree and Staged as three independent views", () => {
    assert.deepEqual(sourceTabs.map((tab) => tab.view), ["task", "working-tree", "staged"]);
    assert.equal(new Set(sourceTabs.map((tab) => tab.view)).size, 3);
    assert.equal(sourceSummary(source), "1 file");
    const unavailable = structuredClone(source);
    unavailable.availability = { state: "unavailable", reasonCode: "no-active-task", message: "No task baseline" };
    assert.equal(sourceSummary(unavailable), "No task baseline");
    const stale = structuredClone(source);
    stale.availability = { state: "stale", reasonCode: "git-race", message: "Workspace changed" };
    assert.equal(sourceSummary(stale), "Đang đồng bộ lại…");
  });

  it("keeps Git status, line counts, evidence and provenance on separate axes", () => {
    const file = source.files[0];
    assert.equal(file.status, "M");
    assert.equal(fileStats(file), "+1  −0");
    assert.equal(provenanceLabel(file), "Có sẵn trước task");
    assert.equal(relatedEvidence(file), "0 tiêu chí · 0 verifier");
    const degraded = structuredClone(file); degraded.stats = { state: "unavailable", additions: null, deletions: null, reasonCode: "binary" };
    assert.equal(fileStats(degraded), "Dòng thay đổi chưa xác định");
    assert.notEqual(file.status, file.health.state);
  });

  it("renders bounded inline/split lines and explicit fallback without accepting paths as authority", () => {
    assert.deepEqual(diff.hunks[0].lines.map((line) => line.kind), ["deleted", "added"]);
    assert.equal(diff.file.criterionIds.length, 1);
    assert.equal(diff.file.verifierAttemptIds.length, 1);
    const component = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/SourceWorkspace.tsx"), "utf8");
    const api = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/api.ts"), "utf8");
    assert.match(component, /<Tabs className="source-tabs"/);
    assert.match(component, /selectionFollowsFocus/);
    assert.match(component, /<ToggleButtonGroup className="mode-switch"/);
    assert.match(component, /value="split"/);
    assert.match(component, /unchangedRegions/);
    assert.match(component, /fallback\.kind/);
    assert.doesNotMatch(component, /dangerouslySetInnerHTML/);
    assert.match(api, /diffs\/\$\{encodeURIComponent\(fileRef\)\}\?view=\$\{encodeURIComponent\(view\)\}/);
    assert.match(api, /reviews\/\$\{encodeURIComponent\(fileRef\)\}\?view=\$\{encodeURIComponent\(view\)\}/);
    assert.match(api, /source-mutations\/\$\{encodeURIComponent\(fileRef\)\}\?action=\$\{encodeURIComponent\(action\)\}/);
    assert.match(component, /Đánh dấu đã review/);
    assert.match(component, /Stage file/); assert.match(component, /Unstage file/);
    assert.match(component, /Stage hunk/); assert.match(component, /Unstage hunk/);
    for (const projection of ["diff", "review", "mutation", "revert"])
      assert.match(component, new RegExp(`const ${projection}Mismatch = Boolean\\(detailCurrent`));
    assert.match(component, /const detailMismatch = diffMismatch \|\| reviewMismatch \|\| mutationMismatch \|\| revertMismatch/);
    assert.match(component, /const detailLoadError = diffLoadError \|\| reviewLoadError \|\| mutationLoadError \|\| revertLoadError/);
    assert.match(component, /const detailRecoveryRequired = detailMismatch \|\| detailLoadError/);
    assert.match(component, /const presentedDiff:[\s\S]*?: diffMismatch \|\| diffLoadError \? \{ state: "error" \} : diff/);
    assert.match(component, /const presentedReview:[\s\S]*?: reviewMismatch \|\| reviewLoadError \? \{ state: "error" \} : review/);
    assert.match(component, /const presentedMutation:[\s\S]*?: mutationMismatch \|\| mutationLoadError \? \{ state: "error" \} : mutation/);
    assert.match(component, /const presentedRevert:[\s\S]*?: revertMismatch \|\| revertLoadError \? \{ state: "error" \} : revert/);
    assert.match(component, /\[selected, view, detailRevisions, refreshEpoch, sessionRef, reviewCapabilityKey, detailRequestKey\]/);
    assert.match(component, /detailRecoveryAttemptsRef\.current\.has\(detailRecoveryScope\)/);
    assert.match(component, /beginDetailRecovery\(true\)/);
    assert.match(component, /stagedAuthorityRef\.current === submittedAuthority\) setCommitStatus/);
    assert.doesNotMatch(api, /diffs\/\$\{[^}]*path/);
  });

  it("rejects a diff that self-reports stale or changed during the read", () => {
    const snapshot = { identity: structuredClone(diff.identity) };
    const args = [diff.view, diff.file.fileRef, diff.precondition.expectedViewRevision,
      diff.precondition.expectedFileRevision, snapshot];
    assert.equal(sourceDiffMatchesSnapshot(diff, ...args), true);
    const staleAvailability = structuredClone(diff); staleAvailability.availability.state = "stale";
    assert.equal(sourceDiffMatchesSnapshot(staleAvailability, ...args), false);
    const staleFallback = structuredClone(diff); staleFallback.fallback.kind = "stale";
    assert.equal(sourceDiffMatchesSnapshot(staleFallback, ...args), false);
    const changedDuringRead = structuredClone(diff); changedDuringRead.observed.fileRevision = "file-rev.changed-during-read";
    assert.equal(sourceDiffMatchesSnapshot(changedDuringRead, ...args), false);
  });

  it("recovers transient unavailable detail projections without retrying stable limitations", () => {
    const unavailable = (reasonCode) => ({ state: "unavailable", target: null, reasonCode });
    for (const reasonCode of ["mutation-target-stale", "mutation-preview-incomplete", "mutation-preimage-unavailable",
      "mutation-authority-unavailable", "revert-target-stale", "revert-preview-incomplete", "revert-preimage-unavailable",
      "revert-authority-unavailable", "revert-confirmation-authority-unavailable"])
      assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable(reasonCode), diff), true, reasonCode);

    assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable("no-unstaged-change"), diff), true,
      "a current diff with hunks contradicts a no-change mutation preview");
    assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable("no-staged-change"), diff), true);
    assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable("review-target-unavailable"), diff), true,
      "an exact current diff contradicts a missing review target");
    const withoutHunks = structuredClone(diff); withoutHunks.hunks = [];
    assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable("no-unstaged-change"), withoutHunks), false,
      "a stable no-change projection must not create a refresh loop");
    const staleDiff = structuredClone(diff); staleDiff.availability.state = "stale";
    assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable("no-staged-change"), staleDiff), false,
      "stale hunks cannot prove that the current mutation projection is contradictory");
    assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable("review-target-unavailable"), staleDiff), false);

    for (const reasonCode of ["mutation-target-unavailable", "revert-target-unavailable", "mutation-guard-unavailable",
      "revert-provenance-unavailable", "protected-path", "revert-hunk-unavailable", "not-found"])
      assert.equal(sourceDetailUnavailableNeedsRecovery(unavailable(reasonCode), diff), false, reasonCode);
    assert.equal(sourceDetailUnavailableNeedsRecovery({ state: "unavailable", target: {}, reasonCode: "mutation-target-stale" }, diff), false,
      "a projection that still has a target is not an unavailable-detail recovery signal");
    assert.equal(sourceDetailUnavailableNeedsRecovery({ state: "ready", target: {}, reasonCode: "mutation-target-stale" }, diff), false);
    assert.equal(sourceDetailUnavailableNeedsRecovery(undefined, diff), false);
  });

  it("tokenizes source lines as escaped React text for syntax-aware diffs", () => {
    const tokens = tokenizeDiffLine('const ready = true; // verified', "src/example.ts");
    assert.deepEqual(tokens.filter((token) => token.kind !== "plain"), [
      { kind: "keyword", text: "const" }, { kind: "literal", text: "true" }, { kind: "comment", text: "// verified" }
    ]);
    assert.deepEqual(tokenizeDiffLine('"name": 42', "package.json").filter((token) => token.kind !== "plain"), [
      { kind: "property", text: '"name"' }, { kind: "number", text: "42" }
    ]);
  });

  it("binds a shared fileRef to the selected tab so Task and Working Tree cannot cross-read", async () => {
    const fixture = await dirtyBaselineProvider();
    const { provider, setEventCursor, setTaskUpdatedAt } = fixture;
    const snapshot = await provider.snapshot();
    const taskView = await provider.sourceChanges("task");
    const workingTreeView = await provider.sourceChanges("working-tree");
    const expectedBinding = { sourceProjectionRevision: snapshot.sourceChanges.projectionRevision,
      taskViewRevision: snapshot.sourceChanges.task.revision, workspaceRevision: snapshot.sourceChanges.workingTree.revision,
      indexRevision: snapshot.sourceChanges.staged.revision };
    assert.deepEqual(taskView.snapshotBinding, expectedBinding);
    assert.deepEqual(workingTreeView.snapshotBinding, expectedBinding);
    assert.equal(validateFixture(registry, "source-change-v1", taskView).valid, true);
    assert.equal(validateFixture(registry, "source-change-v1", workingTreeView).valid, true);
    setEventCursor("event-cursor.view-diff-next");
    const runtimeOnlySnapshot = await provider.snapshot(), runtimeOnlyWorkingTree = await provider.sourceChanges("working-tree");
    assert.notEqual(runtimeOnlySnapshot.revision.runtimeRevision, snapshot.revision.runtimeRevision);
    assert.equal(runtimeOnlySnapshot.sourceChanges.projectionRevision, snapshot.sourceChanges.projectionRevision,
      "runtime event churn must not invalidate the source-only projection");
    assert.equal(runtimeOnlyWorkingTree.snapshotBinding.sourceProjectionRevision, expectedBinding.sourceProjectionRevision);
    setTaskUpdatedAt("2026-08-13T13:00:01.000Z");
    const authorityOnlySnapshot = await provider.snapshot();
    assert.notEqual(authorityOnlySnapshot.revision.taskRevision, runtimeOnlySnapshot.revision.taskRevision);
    assert.equal(authorityOnlySnapshot.sourceChanges.projectionRevision, snapshot.sourceChanges.projectionRevision,
      "a task authority revision without source-facing changes must not reload the file list");

    const alignedIdentity = structuredClone(authorityOnlySnapshot.identity);
    const alignedRevisions = { runtimeRevision: "runtime-rev.control-aligned",
      taskRevision: authorityOnlySnapshot.revision.taskRevision, controlRevision: "control-rev.control-aligned",
      workspaceRevision: authorityOnlySnapshot.revision.workspaceRevision, indexRevision: authorityOnlySnapshot.revision.indexRevision,
      approvalRevision: null, sessionOptionRevision: null, queueRevision: "queue-rev.control-aligned" };
    const controlledProvider = (controlIdentity, controlRevisions = alignedRevisions) => new CoreInspectionProvider({ cwd: fixture.cwd,
      sessionId: fixture.task().sessionId, runtimeInstanceId: "runtime.view-diff", eventStore: fixture.eventStore, task: fixture.task,
      sourceMutationGuardAvailable: () => true, sourceOpenAvailable: () => true, chatControl: () => ({ state: "ready", identity: controlIdentity,
        revisions: controlRevisions, liveness: "idle", taskState: "active", heldCount: 0,
        queueRevision: controlRevisions.queueRevision }) });
    const assertSourceAuthorityWithheld = async (candidate, snapshot, document) => {
      const fileRef = document.files[0]?.fileRef; assert.ok(fileRef);
      assert.equal(snapshot.capabilities.capabilities.reviewActions.status, "unavailable");
      assert.equal(snapshot.capabilities.capabilities.reviewActions.reason.code, "source-binding-resync-required");
      await assert.rejects(candidate.diff("working-tree", fileRef));
      await assert.rejects(candidate.review("working-tree", fileRef));
      await assert.rejects(candidate.sourceMutationAuthority("source.stage", fileRef));
      await assert.rejects(candidate.sourceRevertAuthority(fileRef, []));
      await assert.rejects(candidate.sourceOpenAuthority(fileRef));
      await assert.rejects(candidate.commitSummary());
    };
    for (const [field, value] of [["projectRef", "project.transition"], ["runtimeInstanceId", "runtime.transition"],
      ["sessionRef", "session.transition"]]) {
      const mismatchedProvider = controlledProvider({ ...alignedIdentity, [field]: value });
      const mismatchedSnapshot = await mismatchedProvider.snapshot(), mismatchedDocument = await mismatchedProvider.sourceChanges("working-tree");
      const mismatchedBinding = { sourceProjectionRevision: mismatchedSnapshot.sourceChanges.projectionRevision,
        taskViewRevision: mismatchedSnapshot.sourceChanges.task.revision,
        workspaceRevision: mismatchedSnapshot.sourceChanges.workingTree.revision,
        indexRevision: mismatchedSnapshot.sourceChanges.staged.revision };
      assert.notEqual(mismatchedDocument.identity[field], mismatchedSnapshot.identity[field],
        `${field} from an unrelated control binding must not relabel source evidence`);
      assert.equal(sourceDocumentMatchesSnapshot(mismatchedDocument, "working-tree", mismatchedBinding,
        mismatchedSnapshot.identity), false);
      await assertSourceAuthorityWithheld(mismatchedProvider, mismatchedSnapshot, mismatchedDocument);
    }

    const staleTaskRevisionProvider = controlledProvider(alignedIdentity,
      { ...alignedRevisions, taskRevision: "task-rev.control-stale" });
    const staleTaskRevisionSnapshot = await staleTaskRevisionProvider.snapshot();
    const staleTaskRevisionDocument = await staleTaskRevisionProvider.sourceChanges("working-tree");
    await assertSourceAuthorityWithheld(staleTaskRevisionProvider, staleTaskRevisionSnapshot, staleTaskRevisionDocument);

    const successorIdentity = { ...alignedIdentity, taskId: "view-diff-task-next", taskRunId: "view-diff-task-run-next" };
    const successorRevisions = { ...alignedRevisions, runtimeRevision: "runtime-rev.task-transition",
      taskRevision: "task-rev.task-transition", controlRevision: "control-rev.task-transition",
      queueRevision: "queue-rev.task-transition" };
    const transitionProvider = controlledProvider(successorIdentity, successorRevisions);
    const transitionSnapshot = await transitionProvider.snapshot();
    const transitionDocument = await transitionProvider.sourceChanges("working-tree");
    const transitionBinding = { sourceProjectionRevision: transitionSnapshot.sourceChanges.projectionRevision,
      taskViewRevision: transitionSnapshot.sourceChanges.task.revision,
      workspaceRevision: transitionSnapshot.sourceChanges.workingTree.revision,
      indexRevision: transitionSnapshot.sourceChanges.staged.revision };
    assert.equal(transitionSnapshot.identity.taskRunId, successorIdentity.taskRunId);
    assert.notEqual(transitionDocument.identity.taskRunId, successorIdentity.taskRunId,
      "a source projection from the previous task must not be relabelled as the successor task");
    assert.equal(sourceDocumentMatchesSnapshot(transitionDocument, "working-tree", transitionBinding,
      transitionSnapshot.identity), false);
    await assertSourceAuthorityWithheld(transitionProvider, transitionSnapshot, transitionDocument);
    const taskFile = taskView.files.find((file) => file.path === "shared.txt");
    const workingTreeFile = workingTreeView.files.find((file) => file.path === "shared.txt");
    assert.ok(taskFile && workingTreeFile);
    assert.equal(taskFile.fileRef, workingTreeFile.fileRef, "the collision fixture must exercise a shared opaque ref");

    const taskDiff = await provider.diff("task", taskFile.fileRef);
    const workingTreeDiff = await provider.diff("working-tree", workingTreeFile.fileRef);
    const taskLines = taskDiff.hunks.flatMap((hunk) => hunk.lines);
    const workingTreeLines = workingTreeDiff.hunks.flatMap((hunk) => hunk.lines);
    assert.equal(taskDiff.view, "task");
    assert.equal(workingTreeDiff.view, "working-tree");
    assert.equal(taskLines.some((line) => line.kind === "deleted" && line.text === "DIRTY AT TASK START"), true);
    assert.equal(taskLines.some((line) => line.text === "HEAD BASE"), false);
    assert.equal(workingTreeLines.some((line) => line.kind === "deleted" && line.text === "HEAD BASE"), true);
    assert.equal(workingTreeLines.some((line) => line.text === "DIRTY AT TASK START"), false);

    const taskReview = await provider.review("task", taskFile.fileRef);
    const workingReview = await provider.review("working-tree", workingTreeFile.fileRef);
    assert.equal(validateFixture(registry, "review-state-v1", taskReview).valid, true);
    assert.equal(validateFixture(registry, "review-state-v1", workingReview).valid, true);
    assert.equal(taskReview.state, "unreviewed"); assert.equal(workingReview.state, "unreviewed");
    assert.notEqual(taskReview.target.diffRef, workingReview.target.diffRef);
    assert.notEqual(taskReview.target.patchPreimage, workingReview.target.patchPreimage);

    const stagePreview = await provider.sourceMutation("source.stage", workingTreeFile.fileRef);
    assert.equal(validateFixture(registry, "source-mutation-v1", stagePreview).valid, true);
    assert.equal(stagePreview.state, "ready"); assert.equal(stagePreview.target.view, "working-tree");
    assert.equal(stagePreview.target.fileRef, workingTreeFile.fileRef);
  });

  it("opens a file whenever the list holds one, whatever the remembered ref says", () => {
    const files = [{ fileRef: "file_a" }, { fileRef: "file_b" }];
    // The reader's own choice is kept while it still exists in the list.
    assert.equal(activeFileRef(files, "file_b"), "file_b");
    // Nothing remembered, or a ref belonging to a view that is no longer shown,
    // falls back to the first file rather than leaving the diff pane asking the
    // reader to pick from a list holding exactly one row.
    assert.equal(activeFileRef(files, null), "file_a");
    assert.equal(activeFileRef(files, "file_from_another_view"), "file_a");
    assert.equal(activeFileRef([{ fileRef: "only" }], null), "only");
    // An empty list is the one case with nothing to open.
    assert.equal(activeFileRef([], null), null);
    assert.equal(activeFileRef([], "file_a"), null);
  });

  it("withholds a stale source document until it matches the canonical snapshot revision", () => {
    const binding = { sourceProjectionRevision: "source.projection", taskViewRevision: "task.view",
      workspaceRevision: source.viewRevision, indexRevision: "index.revision" };
    const bound = structuredClone(source); bound.snapshotBinding = binding;
    assert.equal(currentSourceDocument(bound, "snapshot.before", "snapshot.before", binding, bound.identity, "working-tree"), bound);
    assert.equal(currentSourceDocument(bound, "snapshot.before", "snapshot.after", binding, bound.identity, "working-tree"), null);
    assert.equal(currentSourceDocument(bound, undefined, "snapshot.after", binding, bound.identity, "working-tree"), null);
    assert.equal(currentSourceDocument(bound, "snapshot.before", "snapshot.before",
      { ...binding, indexRevision: "index.after" }, bound.identity, "working-tree"), null);
    assert.equal(currentSourceDocument(bound, "snapshot.before", "snapshot.before", binding,
      { ...bound.identity, sessionRef: "another-session" }, "working-tree"), null);
    assert.equal(sourceDocumentMatchesSnapshot({ ...bound, view: "staged" }, "working-tree", binding, bound.identity), false);
    const stale = structuredClone(bound);
    stale.availability = { state: "stale", reasonCode: "git-race", message: "Workspace changed during projection" };
    assert.equal(sourceDocumentMatchesSnapshot(stale, "working-tree", binding, stale.identity), false,
      "a source document must not become current by matching revisions while self-reporting stale");
    assert.equal(currentSourceDocument(stale, "snapshot.before", "snapshot.before", binding, stale.identity, "working-tree"), null);

    const legacyBinding = { sourceProjectionRevision: null, taskViewRevision: null,
      workspaceRevision: source.viewRevision, indexRevision: null };
    assert.equal(sourceDocumentMatchesSnapshot(source, "working-tree", legacyBinding, source.identity), true,
      "a legacy v1 pair without either binding remains readable by exact view revision");
    assert.equal(sourceDocumentMatchesSnapshot(source, "working-tree", binding, source.identity), false,
      "a new snapshot must not accept an unbound legacy document");
    assert.equal(sourceDocumentMatchesSnapshot(bound, "working-tree", legacyBinding, source.identity), false,
      "a legacy snapshot must not accept a document bound to an unknown projection");
    const unavailable = structuredClone(source);
    unavailable.availability = { state: "unavailable", reasonCode: "git-unavailable", message: "Git unavailable" };
    assert.equal(sourceDocumentMatchesSnapshot(unavailable, "working-tree", { ...legacyBinding, workspaceRevision: null },
      unavailable.identity), true, "null legacy revisions only admit unavailable documents");
    assert.equal(sourceDocumentMatchesSnapshot(source, "working-tree", { ...legacyBinding, workspaceRevision: null }, source.identity), false);
    const component = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/SourceWorkspace.tsx"), "utf8");
    assert.match(component, /if \(!controller\.signal\.aborted\) setDocuments/);
    assert.match(component, /state=\{presentedDiff\}/); assert.match(component, /mutation=\{presentedMutation\}/);
  });
});
