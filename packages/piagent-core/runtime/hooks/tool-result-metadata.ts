export function patchLineStats(details: unknown): { additions?: number; deletions?: number } {
  if (!details || typeof details !== "object") return {};
  const patch = (details as Record<string, unknown>).patch;
  if (typeof patch !== "string" || !patch.trim()) return {};
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function editVerificationMarker(identity: { taskId: string; taskRunId: string } | undefined,
  tree: { proofCapable: boolean; digest: string; workspaceRevisionDigest: string | null } | undefined,
  successful: boolean, changedPaths: string[]) {
  return { taskUsageVersion: 1, taskId: identity?.taskId, taskRunId: identity?.taskRunId,
    mutationObserved: successful && changedPaths.length > 0 && tree?.proofCapable === true,
    postWorkingTreeDigest: tree?.proofCapable ? tree.digest : null,
    postWorkspaceRevisionDigest: tree?.proofCapable ? tree.workspaceRevisionDigest : null };
}
