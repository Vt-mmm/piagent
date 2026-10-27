import { WorkspaceReadError } from "../../piagent-core/security/workspace-file-reader.ts";

export type WorkspaceRead = (kind: "tree" | "file" | "media" | "paths" | "search", path: string) => unknown | Promise<unknown>;
export type WorkspaceRouteResult = { handled: false } | { handled: true; status: number; value: unknown };

// Authentication and company forwarding belong to the session router. This
// parser accepts only project-relative paths, including an empty tree root.
export async function routeWorkspaceRead(url: URL, read?: WorkspaceRead): Promise<WorkspaceRouteResult> {
  const match = /^\/api\/v1\/workspace\/(tree|file|media|paths|search)$/.exec(url.pathname);
  if (!match) return { handled: false };
  const refused = (status: number, code: string): WorkspaceRouteResult => ({ handled: true, status, value: { error: { code } } });
  if (!read) return refused(503, "workspace-unavailable");
  const parameter = ["paths", "search"].includes(match[1]) ? "query" : "path";
  const relative = url.searchParams.get(parameter) ?? "";
  if ([...url.searchParams.keys()].some(key => key !== parameter) || url.searchParams.getAll(parameter).length > 1
    || relative.length > (parameter === "query" ? 512 : 4096) || /[\x00-\x1f\x7f]/.test(relative)
    || (match[1] !== "search" && (relative.includes("\\") || relative.startsWith("/")))
    || (match[1] === "search" && !relative.trim())
    || (parameter === "path" && (relative ? relative.split("/").some(part => !part || part === "." || part === "..") : match[1] !== "tree"))) {
    return refused(400, "workspace-path-invalid");
  }
  try { return { handled: true, status: 200, value: await read(match[1] as "tree" | "file" | "media" | "paths" | "search", relative) }; }
  catch (error) {
    if (error instanceof WorkspaceReadError) return refused(error.code === "changed-during-read" ? 409 : 400, error.code);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return refused(404, "workspace-path-not-found");
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM" || (error as Error)?.message === "workspace-path-protected") {
      return refused(403, "workspace-path-protected");
    }
    return refused(503, "workspace-unavailable");
  }
}
