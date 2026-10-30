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
export const readWorkspaceMedia = (session: string, path: string, signal?: AbortSignal) =>
  read<import("../../contracts/generated/workspace-media-v1.ts").PiagentWebUIWorkspaceMediaV1>(session, "media", path, signal);

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

// Saves a project file through the browser: its bytes where the host reads them
// as media, otherwise its text.
export async function saveWorkspaceFile(session: string, path: string): Promise<boolean> {
  const name = path.split("/").at(-1) ?? "file";
  const media = await readWorkspaceMedia(session, path).catch(() => null);
  let href: string | null = media?.data && media.mime ? `data:${media.mime};base64,${media.data}` : null, blob = false;
  if (!href) {
    const file = await readWorkspaceFile(session, path).catch(() => null);
    if (typeof file?.content !== "string") return false;
    href = URL.createObjectURL(new Blob([file.content], { type: "text/plain" })); blob = true;
  }
  const link = document.createElement("a");
  link.href = href; link.download = name; document.body.append(link); link.click(); link.remove();
  if (blob) setTimeout(() => URL.revokeObjectURL(href!), 10_000);
  return true;
}
