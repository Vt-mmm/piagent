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
import { activeFileRef, fileStats, provenanceLabel, relatedEvidence, sourceSummary, sourceTabs } from "../packages/piagent-webui/client/src/source-view-model.ts";
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
  const task = {
    ...structuredClone(taskFixture), taskId: "view-diff-task", taskRunId: "view-diff-task-run-1", sessionId: "view-diff-session",
    sessionName: "View diff", baselineChangedFiles: Object.keys(baseline), baselineFileDigests: baseline,
    createdAt: "2026-08-13T13:00:00.000Z", updatedAt: "2026-08-13T13:00:00.000Z", trace: { outcome: "pending" }
  };
  task.authoritySnapshot = createBoundTaskAuthority(task);
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: task.taskId, taskRunId: task.taskRunId,
    sessionId: task.sessionId, capturedAt: task.createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  fs.writeFileSync(path.join(cwd, "shared.txt"), "AFTER TASK\nkept\n");
  const eventStore = {
    retention: () => ({ eventRetentionCount: 0, eventRetentionSeconds: 0 }), currentCursor: () => "event-cursor.view-diff",
    resyncRequired: () => false, replay: () => ({ state: "current", events: [], nextCursor: "event-cursor.view-diff", latestCursor: "event-cursor.view-diff", reasonCode: null })
  };
  return new CoreInspectionProvider({ cwd, sessionId: task.sessionId, runtimeInstanceId: "runtime.view-diff", eventStore, task: () => task,
    sourceMutationGuardAvailable: () => true });
}

describe("Piagent WebUI source tabs and diff projection", () => {
  it("keeps Task, Working Tree and Staged as three independent views", () => {
    assert.deepEqual(sourceTabs.map((tab) => tab.view), ["task", "working-tree", "staged"]);
    assert.equal(new Set(sourceTabs.map((tab) => tab.view)).size, 3);
    assert.equal(sourceSummary(source), "1 file");
    const unavailable = structuredClone(source);
    unavailable.availability = { state: "unavailable", reasonCode: "no-active-task", message: "No task baseline" };
    assert.equal(sourceSummary(unavailable), "No task baseline");
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
    assert.doesNotMatch(api, /diffs\/\$\{[^}]*path/);
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
    const provider = await dirtyBaselineProvider();
    const taskView = await provider.sourceChanges("task");
    const workingTreeView = await provider.sourceChanges("working-tree");
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
});
