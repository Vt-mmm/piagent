import { createHmac } from "node:crypto";

import { canonicalReviewValue } from "./review-state-contract.ts";
import { collectExactGitPatchAuthority, type DiffDocument, type ExactGitPatchAuthority } from "./diff-projection.ts";
import { deriveReviewTarget } from "./review-state-projection.ts";
import { collectSelectedSourceFileState, type SourceChangeDocument, type SourceProjectionOptions, type WebUiIdentity } from "./source-change-projection.ts";
import { collectIndexPreimage, collectSelectedWorkspacePreimage } from "./source-mutation-projection.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/, REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/,
  DIGEST = /^sha256:[a-f0-9]{64}$/, WORKSPACE = /^wt-content-v2:[a-f0-9]{64}$/,
  SAFE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001F\u007F\\]{1,1024}$/;

export type SourceRevertTarget = {
  view: "working-tree"; repoRef: string; fileRef: string; diffRef: string; status: "M"; path: string; oldPath: null;
  effect: "restore-worktree-from-index"; taskRevision: string; workspaceRevision: string; indexRevision: string;
  viewRevision: string; fileRevision: string; workspacePreimage: string; indexPreimage: string; patchPreimage: string;
  contentDigest: string; hunkRefs: string[]; previewRef: string; confirmedPreviewDigest: string; expiresAt: string;
  summary: { files: 1; hunks: number; additionsDiscarded: number; deletionsRestored: number;
    effect: "discard-unstaged-keep-index"; recovery: "not-guaranteed" };
};
export type SourceRevertProjection = {
  schemaVersion: 1; version: "piagent-webui-source-revert-v1"; generatedAt: string; identity: WebUiIdentity;
  action: "source.revert"; state: "ready" | "unavailable"; target: SourceRevertTarget | null;
  preview: { basis: "index-to-working-tree"; hunks: RevertPreviewHunk[]; truncated: false } | null; reasonCode: string | null;
  health: { state: "ok" | "unavailable" | "error"; reasonCode: string | null; message: string | null };
};
type RevertPreviewLine = { kind: "added" | "deleted" | "context" | "meta"; marker: "+" | "-" | " " | "\\"; text: string };
type RevertPreviewHunk = { hunkRef: string; header: string; lines: RevertPreviewLine[] };
export type SourceRevertAuthority = {
  repoRoot: string; repoPath: string; indexObject: string; indexMode: "100644" | "100755";
  target: SourceRevertTarget; patchAuthority: ExactGitPatchAuthority;
};
type CollectOptions = {
  cwd: string; identity: WebUiIdentity; sourceView: SourceChangeDocument; taskView: SourceChangeDocument | null; diff: DiffDocument;
  taskRevision: string; workspaceRevision: string; indexRevision: string; selectedHunkRefs?: string[]; generatedAt?: string;
  confirmationKey: Buffer;
  isProtectedPath?: SourceProjectionOptions["isProtectedPath"]; guardAvailable?: boolean; timeoutMs?: number; maxGitBytes?: number;
};

function confirmationDigest(key: Buffer, value: unknown): string {
  return `sha256:${createHmac("sha256", key).update(canonicalReviewValue(value)).digest("hex")}`;
}
function previewHunk(hunk: ExactGitPatchAuthority["hunks"][number]): RevertPreviewHunk | null {
  const text = hunk.bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(hunk.bytes)) return null;
  const raw = text.split("\n"); if (raw.at(-1) === "") raw.pop();
  const header = raw.shift() ?? ""; if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(header) || header.length > 1024) return null;
  const lines: RevertPreviewLine[] = [];
  for (const line of raw) {
    const marker = line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : line.startsWith("\\") ? "\\" : " ";
    const value = line.slice(1); if (value.length > 16_384 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return null;
    lines.push({ kind: marker === "+" ? "added" : marker === "-" ? "deleted" : marker === "\\" ? "meta" : "context", marker, text: value });
  }
  return { hunkRef: hunk.hunkRef, header, lines };
}
function unavailable(options: CollectOptions, reasonCode: string): { projection: SourceRevertProjection; authority: null } {
  const message = "A confirmed exact Working Tree revert is unavailable";
  return { projection: { schemaVersion: 1, version: "piagent-webui-source-revert-v1", generatedAt: options.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(options.identity), action: "source.revert", state: "unavailable", target: null, preview: null, reasonCode,
    health: { state: "unavailable", reasonCode, message } }, authority: null };
}

export function validateSourceRevertTarget(value: unknown): SourceRevertTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source-revert-target-invalid");
  const target = value as SourceRevertTarget;
  const keys = ["view", "repoRef", "fileRef", "diffRef", "status", "path", "oldPath", "effect", "taskRevision", "workspaceRevision",
    "indexRevision", "viewRevision", "fileRevision", "workspacePreimage", "indexPreimage", "patchPreimage", "contentDigest", "hunkRefs",
    "previewRef", "confirmedPreviewDigest", "expiresAt", "summary"];
  if (canonicalReviewValue(Object.keys(target).sort()) !== canonicalReviewValue(keys.sort()) || target.view !== "working-tree" || target.status !== "M"
    || target.oldPath !== null || target.effect !== "restore-worktree-from-index" || !SAFE_PATH.test(target.path)
    || ![target.repoRef, target.fileRef, target.diffRef, target.previewRef].every((item) => REF.test(item))
    || ![target.taskRevision, target.workspaceRevision, target.indexRevision, target.viewRevision, target.fileRevision].every((item) => REVISION.test(item))
    || !WORKSPACE.test(target.workspacePreimage) || ![target.indexPreimage, target.patchPreimage, target.contentDigest, target.confirmedPreviewDigest].every((item) => DIGEST.test(item))
    || !Array.isArray(target.hunkRefs) || target.hunkRefs.length > 1 || new Set(target.hunkRefs).size !== target.hunkRefs.length
    || target.hunkRefs.some((item) => !REF.test(item)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(target.expiresAt)
    || !target.summary || target.summary.files !== 1 || !Number.isInteger(target.summary.hunks) || target.summary.hunks < 1 || target.summary.hunks > 128
    || ![target.summary.additionsDiscarded, target.summary.deletionsRestored].every((item) => Number.isInteger(item) && item >= 0 && item <= 65_536)
    || target.summary.effect !== "discard-unstaged-keep-index" || target.summary.recovery !== "not-guaranteed") throw new Error("source-revert-target-invalid");
  const parsed = Date.parse(target.expiresAt); if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== target.expiresAt) throw new Error("source-revert-target-invalid");
  return structuredClone(target);
}

export async function collectSourceRevertPreview(options: CollectOptions): Promise<{ projection: SourceRevertProjection; authority: SourceRevertAuthority | null }> {
  const selectedHunkRefs = options.selectedHunkRefs ?? [];
  if (!Buffer.isBuffer(options.confirmationKey) || options.confirmationKey.length < 32) return unavailable(options, "revert-confirmation-authority-unavailable");
  if (options.guardAvailable !== true) return unavailable(options, "mutation-guard-unavailable");
  if (options.sourceView.view !== "working-tree" || options.sourceView.availability.state !== "current" || !options.identity.taskId || !options.identity.taskRunId
    || !options.taskRevision || !options.workspaceRevision || !options.indexRevision || selectedHunkRefs.length > 1 || new Set(selectedHunkRefs).size !== selectedHunkRefs.length)
    return unavailable(options, "revert-authority-unavailable");
  const file = options.sourceView.files.find((candidate: any) => candidate.fileRef === (options.diff as any).file?.fileRef) as Record<string, any> | undefined;
  if (!file || file.status !== "M" || file.git?.worktreeStatus !== "M" || file.oldPath !== null || file.pathDisplay !== "exact-safe"
    || file.content?.kind !== "text" || file.content?.access !== "available") return unavailable(options, "revert-target-unavailable");
  const taskFile = options.taskView?.files.find((candidate: any) => candidate.path === file.path && candidate.currentDigest === file.currentDigest) as Record<string, any> | undefined;
  if (!taskFile || taskFile.provenance?.classification !== "runtime-observed-agent" || taskFile.provenance?.evidence !== "exact"
    || !Array.isArray(taskFile.provenance?.mutationEvidenceRefs) || taskFile.provenance.mutationEvidenceRefs.length === 0)
    return unavailable(options, "revert-provenance-unavailable");
  const review = deriveReviewTarget({ diff: options.diff, taskId: options.identity.taskId, taskRunId: options.identity.taskRunId,
    taskRevision: options.taskRevision, workspaceRevision: options.workspaceRevision, indexRevision: options.indexRevision });
  if (!review || review.view !== "working-tree" || review.fileRef !== file.fileRef || (options.diff as any).truncation?.truncated !== false
    || (options.diff as any).redaction?.applied !== false) return unavailable(options, "revert-preview-incomplete");
  const selected = await collectSelectedSourceFileState({ cwd: options.cwd, identity: options.identity, taskRevision: options.taskRevision,
    generatedAt: options.generatedAt, isProtectedPath: options.isProtectedPath, timeoutMs: options.timeoutMs, maxGitBytes: options.maxGitBytes },
  "working-tree", file.fileRef, String(file.basisRef), [file.path]);
  if ((selected?.file as Record<string, any> | undefined)?.content?.access === "protected") return unavailable(options, "protected-path");
  if (!selected || selected.file.fileRevision !== file.fileRevision || selected.record.kind !== "ordinary" || selected.record.oldPath
    || selected.record.worktreeStatus !== "M" || !selected.record.indexObject || !["100644", "100755"].includes(String(selected.record.indexMode)))
    return unavailable(options, "revert-target-stale");
  const repoPath = selected.record.path.value;
  if (!repoPath || options.isProtectedPath?.(selected.snapshot.repoRoot, repoPath) === true) return unavailable(options, "protected-path");
  try {
    const patchAuthority = await collectExactGitPatchAuthority({ snapshot: selected.snapshot, record: selected.record, view: "unstaged",
      fileRef: String(file.fileRef), timeoutMs: options.timeoutMs, maxBytes: options.maxGitBytes });
    if (!patchAuthority || patchAuthority.hunks.length === 0 || patchAuthority.hunks.length > 128
      || selectedHunkRefs.some((item) => !patchAuthority.hunks.some((hunk) => hunk.hunkRef === item))) return unavailable(options, "revert-hunk-unavailable");
    const selectedAuthorityHunks = patchAuthority.hunks.filter((hunk) => selectedHunkRefs.length === 0 || selectedHunkRefs.includes(hunk.hunkRef));
    const selectedRefs = selectedAuthorityHunks.map((hunk) => hunk.hunkRef);
    if (selectedHunkRefs.length && canonicalReviewValue(selectedRefs) !== canonicalReviewValue(selectedHunkRefs)) return unavailable(options, "revert-hunk-unavailable");
    const previewHunks = selectedAuthorityHunks.map(previewHunk);
    if (previewHunks.some((hunk) => !hunk) || previewHunks.reduce((count, hunk) => count + (hunk?.lines.length ?? 0), 0) > 5_000)
      return unavailable(options, "revert-preview-incomplete");
    const exactPreviewHunks = previewHunks as RevertPreviewHunk[];
    const workspacePreimage = collectSelectedWorkspacePreimage(selected.snapshot.repoRoot, [repoPath]);
    const indexPreimage = await collectIndexPreimage(selected.snapshot.repoRoot, options.timeoutMs, options.maxGitBytes);
    const generatedAt = options.generatedAt ?? new Date().toISOString(), expiresAt = new Date(Date.parse(generatedAt) + 5 * 60_000).toISOString();
    const confirmation = { projectRef: options.identity.projectRef, sessionRef: options.identity.sessionRef, taskRunId: options.identity.taskRunId,
      fileRef: file.fileRef, hunkRefs: selectedHunkRefs, taskRevision: options.taskRevision, workspaceRevision: options.workspaceRevision,
      indexRevision: options.indexRevision, viewRevision: review.viewRevision, fileRevision: review.fileRevision,
      workspacePreimage, indexPreimage, patchPreimage: review.patchPreimage, contentDigest: review.contentDigest };
    const confirmedPreviewDigest = confirmationDigest(options.confirmationKey,
      { domain: "piagent-webui-source-revert-preview-v1", confirmation });
    const target: SourceRevertTarget = { view: "working-tree", repoRef: String(file.repoRef), fileRef: String(file.fileRef), diffRef: review.diffRef,
      status: "M", path: String(file.path), oldPath: null, effect: "restore-worktree-from-index", taskRevision: options.taskRevision,
      workspaceRevision: options.workspaceRevision, indexRevision: options.indexRevision, viewRevision: review.viewRevision,
      fileRevision: review.fileRevision, workspacePreimage, indexPreimage, patchPreimage: review.patchPreimage, contentDigest: review.contentDigest,
      hunkRefs: [...selectedHunkRefs], previewRef: `revert-preview.${confirmedPreviewDigest.slice(7)}`, confirmedPreviewDigest, expiresAt,
      summary: { files: 1, hunks: exactPreviewHunks.length,
        additionsDiscarded: exactPreviewHunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === "added").length, 0),
        deletionsRestored: exactPreviewHunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.kind === "deleted").length, 0),
        effect: "discard-unstaged-keep-index", recovery: "not-guaranteed" } };
    validateSourceRevertTarget(target);
    return { projection: { schemaVersion: 1, version: "piagent-webui-source-revert-v1", generatedAt, identity: structuredClone(options.identity),
      action: "source.revert", state: "ready", target, preview: { basis: "index-to-working-tree", hunks: exactPreviewHunks, truncated: false },
      reasonCode: null, health: { state: "ok", reasonCode: null, message: null } },
    authority: { repoRoot: selected.snapshot.repoRoot, repoPath, indexObject: selected.record.indexObject,
      indexMode: selected.record.indexMode as "100644" | "100755", target, patchAuthority } };
  } catch { return unavailable(options, "revert-preimage-unavailable"); }
}
