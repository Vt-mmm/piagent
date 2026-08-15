import { createHash } from "node:crypto";

import { runReadOnlyGit } from "./git-status-adapter.ts";
import { collectExactGitPatchAuthority, type ExactGitPatchAuthority } from "./diff-projection.ts";
import { deriveReviewTarget } from "./review-state-projection.ts";
import { collectSelectedSourceFileState, type SourceChangeDocument, type SourceProjectionOptions, type WebUiIdentity } from "./source-change-projection.ts";
import type { DiffDocument } from "./diff-projection.ts";
import { hashWorkspaceFile, inspectWorkspaceEntry } from "./workspace-file-reader.ts";

export type SourceMutationAction = "source.stage" | "source.unstage";
export type SourceMutationTarget = {
  view: "working-tree" | "staged";
  repoRef: string;
  fileRef: string;
  diffRef: string;
  status: "A" | "M" | "D" | "R" | "U";
  path: string;
  oldPath: string | null;
  effect: "copy-worktree-to-index" | "restore-index-from-head";
  taskRevision: string;
  workspaceRevision: string;
  indexRevision: string;
  viewRevision: string;
  fileRevision: string;
  workspacePreimage: string;
  indexPreimage: string;
  patchPreimage: string;
  contentDigest: string;
  hunkRefs: string[];
};
export type SourceMutationProjection = {
  schemaVersion: 1;
  version: "piagent-webui-source-mutation-v1";
  generatedAt: string;
  identity: WebUiIdentity;
  action: SourceMutationAction;
  state: "ready" | "unavailable";
  target: SourceMutationTarget | null;
  reasonCode: string | null;
  health: { state: "ok" | "unavailable" | "error"; reasonCode: string | null; message: string | null };
};
export type SourceMutationAuthority = {
  repoRoot: string;
  repoPaths: string[];
  headOid: string | null;
  indexStatus: string;
  worktreeStatus: string;
  target: SourceMutationTarget;
  patchAuthority: ExactGitPatchAuthority | null;
};
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/, REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/,
  DIGEST = /^sha256:[a-f0-9]{64}$/, WORKSPACE = /^wt-content-v2:[a-f0-9]{64}$/,
  SAFE_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001F\u007F\\]{1,1024}$/;

type CollectOptions = {
  cwd: string;
  identity: WebUiIdentity;
  action: SourceMutationAction;
  sourceView: SourceChangeDocument;
  diff: DiffDocument;
  taskRevision: string;
  workspaceRevision: string;
  indexRevision: string | null;
  generatedAt?: string;
  isProtectedPath?: SourceProjectionOptions["isProtectedPath"];
  guardAvailable?: boolean;
  timeoutMs?: number;
  maxGitBytes?: number;
};

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: string | Buffer): string { return `sha256:${sha(value)}`; }
function unavailable(options: CollectOptions, reasonCode: string): { projection: SourceMutationProjection; authority: null } {
  const message = "The exact selected-file Git mutation preview is unavailable";
  return { projection: { schemaVersion: 1, version: "piagent-webui-source-mutation-v1", generatedAt: options.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(options.identity), action: options.action, state: "unavailable", target: null, reasonCode,
    health: { state: "unavailable", reasonCode, message } }, authority: null };
}

export function validateSourceMutationTarget(value: unknown): SourceMutationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mutation-target-invalid");
  const target = value as SourceMutationTarget, keys = ["view", "repoRef", "fileRef", "diffRef", "status", "path", "oldPath", "effect",
    "taskRevision", "workspaceRevision", "indexRevision", "viewRevision", "fileRevision", "workspacePreimage", "indexPreimage", "patchPreimage", "contentDigest", "hunkRefs"];
  if (JSON.stringify(Object.keys(target).sort()) !== JSON.stringify(keys.sort()) || !["working-tree", "staged"].includes(target.view)
    || ![target.repoRef, target.fileRef, target.diffRef].every((item) => REF.test(item)) || !["A", "M", "D", "R", "U"].includes(target.status)
    || !SAFE_PATH.test(target.path) || target.oldPath !== null && !SAFE_PATH.test(target.oldPath)
    || ![target.taskRevision, target.workspaceRevision, target.indexRevision, target.viewRevision, target.fileRevision].every((item) => REVISION.test(item))
    || !WORKSPACE.test(target.workspacePreimage) || ![target.indexPreimage, target.patchPreimage, target.contentDigest].every((item) => DIGEST.test(item))
    || target.patchPreimage !== target.contentDigest || !Array.isArray(target.hunkRefs) || target.hunkRefs.length > 128
    || new Set(target.hunkRefs).size !== target.hunkRefs.length || target.hunkRefs.some((item) => !REF.test(item))
    || target.view === "working-tree" && target.effect !== "copy-worktree-to-index"
    || target.view === "staged" && target.effect !== "restore-index-from-head") throw new Error("mutation-target-invalid");
  return structuredClone(target);
}

export function collectSelectedWorkspacePreimage(repoRoot: string, repoPaths: string[]): string {
  const entries = [...new Set(repoPaths)].sort().map((repoPath) => {
    try {
      const stat = inspectWorkspaceEntry(repoRoot, repoPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsupported-workspace-entry");
      return [repoPath, `sha256:${hashWorkspaceFile(repoRoot, repoPath)}`];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [repoPath, null];
      throw error;
    }
  });
  const material = JSON.stringify({ schemaVersion: 1, entries });
  return `wt-content-v2:${sha(`piagent-webui-selected-workspace\0${material}`)}`;
}

export async function collectIndexPreimage(repoRoot: string, timeoutMs?: number, maxGitBytes?: number): Promise<string> {
  const index = await runReadOnlyGit(repoRoot, ["ls-files", "--stage", "-z"], { timeoutMs, maxBytes: maxGitBytes ?? 64 * 1024 * 1024 });
  return digest(`piagent-webui-index-v1\0${index.toString("base64")}`);
}

export async function collectSourceMutationPreview(options: CollectOptions): Promise<{ projection: SourceMutationProjection; authority: SourceMutationAuthority | null }> {
  const expectedView = options.action === "source.stage" ? "working-tree" : "staged";
  if (options.guardAvailable !== true) return unavailable(options, "mutation-guard-unavailable");
  if (options.sourceView.view !== expectedView || options.sourceView.availability.state !== "current" || !options.indexRevision
    || !options.identity.taskId || !options.identity.taskRunId || !options.taskRevision || !options.workspaceRevision) return unavailable(options, "mutation-authority-unavailable");
  const file = options.sourceView.files.find((candidate: any) => candidate.fileRef === (options.diff as any).file?.fileRef) as Record<string, any> | undefined;
  if (!file || file.pathDisplay !== "exact-safe" || file.status === "C" || !["A", "M", "D", "R", "U"].includes(file.status)
    || file.content?.kind !== "text" || file.content?.access !== "available") return unavailable(options, "mutation-target-unavailable");
  const review = deriveReviewTarget({ diff: options.diff, taskId: options.identity.taskId, taskRunId: options.identity.taskRunId,
    taskRevision: options.taskRevision, workspaceRevision: options.workspaceRevision, indexRevision: options.indexRevision });
  if (!review || review.view !== expectedView || review.fileRef !== file.fileRef) return unavailable(options, "mutation-preview-incomplete");
  const selected = await collectSelectedSourceFileState({ cwd: options.cwd, identity: options.identity, taskRevision: options.taskRevision,
    generatedAt: options.generatedAt, isProtectedPath: options.isProtectedPath, timeoutMs: options.timeoutMs, maxGitBytes: options.maxGitBytes },
  expectedView, file.fileRef, String(file.basisRef), [file.oldPath, file.path].filter((value): value is string => typeof value === "string"));
  if (!selected || selected.file.fileRevision !== file.fileRevision || selected.file.pathDisplay !== "exact-safe") return unavailable(options, "mutation-target-stale");
  if (options.action === "source.stage" && selected.record.kind !== "untracked" && [".", "!", "?"].includes(selected.record.worktreeStatus))
    return unavailable(options, "no-unstaged-change");
  if (options.action === "source.unstage" && [".", "!", "?"].includes(selected.record.indexStatus)) return unavailable(options, "no-staged-change");
  const repoPaths = [selected.record.oldPath?.value, selected.record.path.value].filter((value): value is string => Boolean(value));
  if (!repoPaths.length || repoPaths.some((repoPath) => options.isProtectedPath?.(selected.snapshot.repoRoot, repoPath) === true)) return unavailable(options, "protected-path");
  const core = { view: expectedView, repoRef: String(file.repoRef), fileRef: String(file.fileRef), status: String(file.status), path: String(file.path),
    oldPath: typeof file.oldPath === "string" ? file.oldPath : null, viewRevision: review.viewRevision, fileRevision: review.fileRevision,
    baseDigest: review.baseDigest, currentDigest: review.currentDigest };
  let workspacePreimage: string, indexPreimage: string, patchAuthority: ExactGitPatchAuthority | null = null;
  try {
    workspacePreimage = collectSelectedWorkspacePreimage(selected.snapshot.repoRoot, repoPaths);
    indexPreimage = await collectIndexPreimage(selected.snapshot.repoRoot, options.timeoutMs, options.maxGitBytes);
    const projectedHunkRefs = (options.diff.hunks as Array<Record<string, unknown>>).map((hunk) => String(hunk.hunkRef));
    if (selected.record.kind === "ordinary" && !selected.record.oldPath && core.status === "M" && projectedHunkRefs.length > 0
      && (options.diff as any).truncation?.truncated === false && (options.diff as any).redaction?.applied === false) {
      const exact = await collectExactGitPatchAuthority({ snapshot: selected.snapshot, record: selected.record,
        view: options.action === "source.stage" ? "unstaged" : "staged",
        fileRef: core.fileRef, timeoutMs: options.timeoutMs, maxBytes: options.maxGitBytes });
      if (exact && exact.hunks.every((hunk) => projectedHunkRefs.includes(hunk.hunkRef))) patchAuthority = exact;
    }
  } catch { return unavailable(options, "mutation-preimage-unavailable"); }
  const target: SourceMutationTarget = { view: expectedView, repoRef: core.repoRef, fileRef: core.fileRef, diffRef: review.diffRef,
    status: core.status as SourceMutationTarget["status"], path: core.path, oldPath: core.oldPath,
    effect: options.action === "source.stage" ? "copy-worktree-to-index" : "restore-index-from-head", taskRevision: options.taskRevision,
    workspaceRevision: options.workspaceRevision, indexRevision: options.indexRevision, viewRevision: review.viewRevision, fileRevision: review.fileRevision,
    workspacePreimage, indexPreimage, patchPreimage: review.patchPreimage, contentDigest: review.contentDigest,
    hunkRefs: patchAuthority?.hunks.map((hunk) => hunk.hunkRef) ?? [] };
  validateSourceMutationTarget(target);
  return { projection: { schemaVersion: 1, version: "piagent-webui-source-mutation-v1", generatedAt: options.generatedAt ?? new Date().toISOString(),
    identity: structuredClone(options.identity), action: options.action, state: "ready", target, reasonCode: null,
    health: { state: "ok", reasonCode: null, message: null } },
  authority: { repoRoot: selected.snapshot.repoRoot, repoPaths, headOid: selected.snapshot.headOid,
    indexStatus: selected.record.indexStatus, worktreeStatus: selected.record.worktreeStatus, target, patchAuthority } };
}
