import type { PiagentWebUIBoundedFileDiffV1 as Diff } from '../../contracts/generated/diff-v1.ts';
export function editorReviewHunks(diff: Diff | undefined, path: string, digest: string | null, clean: boolean, kept: ReadonlySet<string>) {
  if (!diff || !clean || !digest || diff.file.path !== path || diff.file.currentDigest !== `sha256:${digest}`
    || diff.availability.state !== 'current' || diff.truncation.truncated || diff.redaction.applied) return [];
  const authored = new Set(diff.agentHunkRefs ?? []);
  return diff.hunks.filter(hunk => authored.has(hunk.hunkRef) && !kept.has(`${path}:${digest}:${hunk.hunkRef}`));
}
