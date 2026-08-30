import { isCurrentWorkingTreeDigest } from "../../extensions/working-tree-digest.js";
import { isWorkspaceRevisionDigest } from "../../extensions/workspace-revision.js";

export type HandoffVerifierBinding = { preWorkingTreeDigest: string | null; workingTreeDigest: string | null;
  preWorkspaceRevisionDigest: string | null; workspaceRevisionDigest: string | null };

/** Validate claims within a serialized projection; this does not authenticate it. */
export function handoffVerifierBindingErrors(tree: Record<string, any> | undefined, latest: Record<string, any> | undefined): string[] {
  const errors: string[] = [];
  if (tree?.workspaceRevisionDigest != null && !isWorkspaceRevisionDigest(tree.workspaceRevisionDigest)) errors.push("tree workspace revision is invalid");
  for (const field of ["preWorkingTreeDigest", "workingTreeDigest"]) {
    if (latest?.[field] != null && !isCurrentWorkingTreeDigest(latest[field])) errors.push(`latest verifier ${field} is invalid`);
  }
  for (const field of ["preWorkspaceRevisionDigest", "workspaceRevisionDigest"]) {
    if (latest?.[field] != null && !isWorkspaceRevisionDigest(latest[field])) errors.push(`latest verifier ${field} is invalid`);
  }
  if (tree?.latestVerifierMatchesCurrentTree === true && (latest?.exitCode !== 0 || latest?.isError === true || latest?.matchedProfileCommand !== true
    || !isCurrentWorkingTreeDigest(latest?.preWorkingTreeDigest) || latest?.preWorkingTreeDigest !== tree.currentDigest
    || latest?.workingTreeDigest !== tree.currentDigest || !isWorkspaceRevisionDigest(tree.workspaceRevisionDigest)
    || latest?.preWorkspaceRevisionDigest !== tree.workspaceRevisionDigest || latest?.workspaceRevisionDigest !== tree.workspaceRevisionDigest)) {
    errors.push("latest verifier tree claim is invalid");
  }
  return errors;
}
