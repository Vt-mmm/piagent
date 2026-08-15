import fs from "node:fs";
import path from "node:path";

import { collectSelectedSourceFileState, type SourceChangeDocument, type SourceProjectionOptions, type WebUiIdentity } from "./source-change-projection.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/, REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/,
  DIGEST = /^sha256:[a-f0-9]{64}$/;

export type SourceOpenTarget = { fileRef: string; taskRevision: string; workspaceRevision: string; fileRevision: string; contentDigest: string };
export type SourceOpenAuthority = { projectRoot: string; repoRoot: string; repoPath: string; absolutePath: string; target: SourceOpenTarget };

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function resolveSourceOpenTarget(options: { cwd: string; identity: WebUiIdentity; sourceView: SourceChangeDocument;
  fileRef: string; taskRevision: string; workspaceRevision: string; generatedAt?: string;
  isProtectedPath?: SourceProjectionOptions["isProtectedPath"]; timeoutMs?: number; maxGitBytes?: number }): Promise<SourceOpenAuthority | null> {
  if (options.sourceView.view !== "working-tree" || options.sourceView.availability.state !== "current" || !REF.test(options.fileRef)
    || !REVISION.test(options.taskRevision) || !REVISION.test(options.workspaceRevision)) return null;
  const file = options.sourceView.files.find((candidate: any) => candidate.fileRef === options.fileRef) as Record<string, any> | undefined;
  if (!file || file.pathDisplay !== "exact-safe" || file.oldPath !== null || ["D", "R", "C"].includes(String(file.status))
    || file.content?.access !== "available" || file.content?.kind !== "text" || !DIGEST.test(String(file.currentDigest ?? ""))) return null;
  const selected = await collectSelectedSourceFileState({ cwd: options.cwd, identity: options.identity, taskRevision: options.taskRevision,
    generatedAt: options.generatedAt, isProtectedPath: options.isProtectedPath, timeoutMs: options.timeoutMs, maxGitBytes: options.maxGitBytes },
  "working-tree", options.fileRef, String(file.basisRef), [file.path]);
  const selectedContent = selected?.file.content as { access?: unknown; kind?: unknown } | undefined;
  if (!selected || selected.file.fileRevision !== file.fileRevision || selected.record.kind !== "ordinary" || selected.record.oldPath
    || selectedContent?.access !== "available" || selectedContent.kind !== "text") return null;
  const repoPath = selected.record.path.value; if (!repoPath || options.isProtectedPath?.(selected.snapshot.repoRoot, repoPath) === true) return null;
  const projectRoot = fs.realpathSync.native(options.cwd), repoRoot = fs.realpathSync.native(selected.snapshot.repoRoot);
  const unresolved = path.resolve(repoRoot, repoPath); if (!inside(projectRoot, unresolved) || !inside(repoRoot, unresolved)) return null;
  const stat = fs.lstatSync(unresolved); if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const absolutePath = fs.realpathSync.native(unresolved); if (absolutePath !== unresolved || !inside(projectRoot, absolutePath)) return null;
  return { projectRoot, repoRoot, repoPath, absolutePath, target: { fileRef: options.fileRef, taskRevision: options.taskRevision,
    workspaceRevision: options.workspaceRevision, fileRevision: String(file.fileRevision), contentDigest: String(file.currentDigest) } };
}
