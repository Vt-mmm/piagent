import { searchWorkspace } from "../../piagent-core/extensions/workspace-search.ts";
import { loadProjectContextIndexPolicy } from "../../piagent-core/extensions/workspace-policy.js";
import { inspectWorkspaceFile, inspectWorkspaceMedia, inspectWorkspaceTree, inspectWorkspacePaths } from "../../piagent-core/extensions/workspace-inspection.ts";
import { inspectWorkspaceEntry } from "../../piagent-core/security/workspace-file-reader.ts";
import type { WorkspaceRead } from "./workspace-read-routes.ts";

// Re-read policy on every request; changing a profile must not leave a warm
// editor with the permissions that happened to exist when it first opened.
export function personalWorkspaceReader(options: {
  cwd: string; packageRoot: string; identity(): Record<string, unknown> | Promise<Record<string, unknown>>;
}): WorkspaceRead {
  return async (kind, relative) => {
    try {
      const stat = inspectWorkspaceEntry(options.cwd, ".pi/piagent-profile.json");
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("workspace-policy-unavailable");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const { policy, profile } = loadProjectContextIndexPolicy(options.packageRoot, options.cwd);
    const context = { policy, profile, readOnly: profile.permissionProfile === "read-only" };
    const value = kind === "search" ? await searchWorkspace(options.cwd, relative, context) : kind === "paths" ? await inspectWorkspacePaths(options.cwd, relative, context) : kind === "tree" ? inspectWorkspaceTree(options.cwd, relative, context) : kind === "media" ? inspectWorkspaceMedia(options.cwd, relative, context) : inspectWorkspaceFile(options.cwd, relative, context);
    return { schemaVersion: 1, version: `piagent-webui-workspace-${kind}-v1`, generatedAt: new Date().toISOString(),
      identity: await options.identity(), ...value };
  };
}
