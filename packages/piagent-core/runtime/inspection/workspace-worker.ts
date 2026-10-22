import { writeWorkspaceFile, WorkspaceWriteError, type WorkspaceWriteInput } from "../../extensions/workspace-write.ts";
import { searchWorkspace } from "../../extensions/workspace-search.ts";
import { loadProjectContextIndexPolicy } from "../../extensions/workspace-policy.js";
import { inspectWorkspaceFile, inspectWorkspaceTree, inspectWorkspacePaths } from "../../extensions/workspace-inspection.ts";
import { inspectWorkspaceEntry } from "../../security/workspace-file-reader.ts";

// Bundled with its policy assets under managed/dist. The worker runs only
// after the tool boundary has entered the conversation's sandbox.
export async function inspectManagedWorkspace(cwd: string, assets: string, request: unknown, readOnly = false) {
  const input = request as { kind?: unknown; path?: unknown; payload?: unknown } | null;
  const writing = input?.kind === "write", state = input?.kind === "write-state";
  if (!input || (!writing && !state && (!["tree", "file", "paths", "search"].includes(String(input.kind)) || typeof input.path !== "string"))
    || Object.keys(input).some(key => key !== "kind" && key !== (writing ? "payload" : state ? "kind" : "path"))) throw new Error("workspace-request-invalid");
  try {
    const stat = inspectWorkspaceEntry(cwd, ".pi/piagent-profile.json");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("workspace-policy-unavailable");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { policy, profile } = loadProjectContextIndexPolicy(assets, cwd);
  const context = { policy, profile, readOnly: readOnly || profile.permissionProfile === "read-only" };
  if (state) return { writable: !context.readOnly };
  if (writing) {
    try { return { state: "saved", ...writeWorkspaceFile(cwd, input.payload as WorkspaceWriteInput, context) }; }
    catch (error) {
      if (error instanceof WorkspaceWriteError) return { state: "rejected", code: error.code, currentDigest: error.currentDigest };
      throw error;
    }
  }
  const relative = input.path as string;
  return input.kind === "search" ? await searchWorkspace(cwd, relative, context) : input.kind === "paths" ? await inspectWorkspacePaths(cwd, relative, context) : input.kind === "tree" ? inspectWorkspaceTree(cwd, relative, context) : inspectWorkspaceFile(cwd, relative, context);
}
