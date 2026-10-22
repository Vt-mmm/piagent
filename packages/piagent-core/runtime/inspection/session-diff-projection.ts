import { createHash } from "node:crypto";
import { collectExactGitPatchAuthority, collectFileDiff, type FileDiffOptions } from "./diff-projection.ts";
import { collectSelectedSourceFileState } from "./source-change-projection.ts";
import { readWorkspaceFile } from "./workspace-file-reader.ts";
import { sessionAuthoredHunkRefs } from "./session-hunk-provenance.ts";
import type { SessionMutationObservation } from "./session-mutation-observer.ts";

// Attribution is per hunk. A mixed file never inherits whole-file authorship
// merely because an observed agent edit exists somewhere in it.
export async function collectSessionFileDiff(options: FileDiffOptions & {
  sessionObservation?(file: string): SessionMutationObservation | null | undefined;
}) {
  const diff = await collectFileDiff(options), result = { ...diff, agentHunkRefs: [] as string[] };
  if (options.sourceView.view !== "working-tree" || diff.availability.state !== "current"
    || (diff.truncation as any)?.truncated !== false || (diff.redaction as any)?.applied !== false) return result;
  const file = options.sourceView.files.find(item => item.fileRef === options.fileRef);
  if (!file || file.pathDisplay !== "exact-safe" || typeof file.path !== "string") return result;
  try {
    const observation = options.sessionObservation?.(file.path);
    if (!observation) return result;
    const sourceOptions = { cwd: options.cwd, identity: options.identity, taskRevision: options.taskRevision,
      isProtectedPath: options.isProtectedPath, timeoutMs: options.timeoutMs, maxGitBytes: options.maxBytes };
    const selected = await collectSelectedSourceFileState(sourceOptions, "working-tree", options.fileRef, String(file.basisRef), [file.path]);
    if (!selected || selected.file.fileRevision !== file.fileRevision || !selected.record.path.value
      || options.isProtectedPath?.(selected.snapshot.repoRoot, selected.record.path.value)) return result;
    const bytes = readWorkspaceFile(selected.snapshot.repoRoot, selected.record.path.value, 256 * 1024);
    const current = bytes.toString("utf8"), currentDigest = createHash("sha256").update(bytes).digest("hex");
    if (!Buffer.from(current).equals(bytes) || (diff.file as { currentDigest?: string }).currentDigest !== `sha256:${currentDigest}`) return result;
    let authored: string[];
    if (selected.record.kind === "untracked") {
      // A witnessed creation proves the complete new file for display only.
      // It does not mint a Git patch authority or enable file deletion.
      authored = observation.baseline.digest === "absent" && observation.baseline.content === ""
        && observation.currentDigest === currentDigest ? diff.hunks.map(hunk => String(hunk.hunkRef)) : [];
    } else {
      const patch = await collectExactGitPatchAuthority({ snapshot: selected.snapshot, record: selected.record, view: "unstaged",
        fileRef: options.fileRef, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
      if (!patch) return result;
      authored = sessionAuthoredHunkRefs(observation, current, patch);
    }
    const final = await collectSelectedSourceFileState(sourceOptions, "working-tree", options.fileRef, String(file.basisRef), [file.path]);
    if (!final || final.file.fileRevision !== selected.file.fileRevision
      || options.isProtectedPath?.(selected.snapshot.repoRoot, selected.record.path.value)) return result;
    const visible = new Set(diff.hunks.map(hunk => hunk.hunkRef));
    return { ...result, agentHunkRefs: authored.filter(ref => visible.has(ref)) };
  } catch { return result; }
}
