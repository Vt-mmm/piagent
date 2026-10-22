import type { PiagentWebUIWorkspaceTreeV1 } from "../../contracts/generated/workspace-tree-v1.ts";
import type { PiagentWebUIWorkspaceFileV1 } from "../../contracts/generated/workspace-file-v1.ts";
import { noteUnauthorized } from "./bootstrap.ts";

async function read<T>(sessionRef: string, kind: string, path: string, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ path });
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection/workspace/${kind}?${query}`,
    { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw new Error("workspace-read-failed");
  return await response.json() as T;
}
export const readWorkspaceTree = (session: string, path: string, signal?: AbortSignal) => read<PiagentWebUIWorkspaceTreeV1>(session, "tree", path, signal);
export const readWorkspaceFile = (session: string, path: string, signal?: AbortSignal) => read<PiagentWebUIWorkspaceFileV1>(session, "file", path, signal);

export async function readWorkspacePaths(sessionRef: string, query: string, signal?: AbortSignal) {
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection/workspace/paths?${new URLSearchParams({ query })}`,
    { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw new Error("workspace-read-failed");
  return await response.json() as import("../../contracts/generated/workspace-paths-v1.ts").PiagentWebUIWorkspacePathsV1;
}

export async function searchWorkspaceContent(sessionRef: string, query: string, signal?: AbortSignal) {
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection/workspace/search?${new URLSearchParams({ query })}`,
    { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  if (response.status === 401) noteUnauthorized();
  if (!response.ok) throw new Error("workspace-read-failed");
  return await response.json() as import("../../contracts/generated/workspace-search-v1.ts").PiagentWebUIWorkspaceSearchV1;
}
