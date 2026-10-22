import { searchWorkspace } from "../../extensions/workspace-search.ts";
import { loadProjectContextIndexPolicy } from "../../extensions/workspace-policy.js";
import { inspectWorkspaceFile, inspectWorkspaceTree, inspectWorkspacePaths } from "../../extensions/workspace-inspection.ts";
import { inspectWorkspaceEntry } from "../../security/workspace-file-reader.ts";

// Bundled with its policy assets under managed/dist. The worker runs only
// after the tool boundary has entered the conversation's sandbox.
export async function inspectManagedWorkspace(cwd: string, assets: string, request: unknown) {
  const input = request as { kind?: unknown; path?: unknown } | null;
  if (!input || !["tree", "file", "paths", "search"].includes(String(input.kind)) || typeof input.path !== "string"
    || Object.keys(input).some(key => key !== "kind" && key !== "path")) throw new Error("workspace-request-invalid");
  try {
    const stat = inspectWorkspaceEntry(cwd, ".pi/piagent-profile.json");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("workspace-policy-unavailable");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { policy, profile } = loadProjectContextIndexPolicy(assets, cwd);
  const context = { policy, profile, readOnly: profile.permissionProfile === "read-only" };
  return input.kind === "search" ? await searchWorkspace(cwd, input.path, context) : input.kind === "paths" ? await inspectWorkspacePaths(cwd, input.path, context) : input.kind === "tree" ? inspectWorkspaceTree(cwd, input.path, context) : inspectWorkspaceFile(cwd, input.path, context);
}
