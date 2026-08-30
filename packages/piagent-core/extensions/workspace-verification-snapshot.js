import { workingTreeSnapshot } from "./task-state.js";
import { workingTreeObservation } from "./working-tree-digest.js";
import { currentWorkspaceRevisionDigest } from "./workspace-revision.js";

/** Bracket content capture with baseline checks; neither alone proves current code. */
export function captureWorkspaceVerificationSnapshot(cwd, options = {}) {
  const before = currentWorkspaceRevisionDigest(cwd);
  const observation = workingTreeObservation(workingTreeSnapshot(cwd, options));
  const after = currentWorkspaceRevisionDigest(cwd);
  const workspaceRevisionDigest = before !== null && before === after ? before : null;
  return Object.freeze({ ...observation, workspaceRevisionDigest,
    proofCapable: observation.proofCapable && workspaceRevisionDigest !== null });
}
