import { Children, createContext, useContext, type ReactNode } from "react";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import { readDocumentIndex } from "./api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
import { workspaceTarget, type FileLink, type WorkspaceTarget } from "./file-link.ts";
export { fileLink, workspaceTarget, type FileLink, type WorkspaceTarget } from "./file-link.ts";
export const WORKSPACE_OPEN_EVENT = "piagent-workspace-open";
// An absolute path as a project path, by the project folder the document
// index reports for this conversation; null when it lies outside.
async function projectPath(sessionRef: string, absolute: string): Promise<string | null> {
  const listing = await readDocumentIndex(sessionRef);
  const root = listing.roots.find(item => item.source === "project" && absolute.startsWith(`${item.path.replace(/\/+$/, "")}/`));
  return root ? absolute.slice(root.path.replace(/\/+$/, "").length + 1) : null;
}
// The project path a link names: itself, or an absolute path made relative.
export async function resolveProjectPath(sessionRef: string, link: FileLink): Promise<string | null> {
  return link.absolute ? projectPath(sessionRef, link.path) : link.path;
}
const Session = createContext<string | null>(null);
export function useWorkspaceSession(): string | null { return useContext(Session); }
const Navigation = createContext<((target: WorkspaceTarget | FileLink) => void) | null>(null);
export function WorkspaceNavigationProvider({ sessionRef, onOpen, children }: { sessionRef?: string; onOpen(): void; children: ReactNode }) {
  const open = (target: WorkspaceTarget) => {
    onOpen(); window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT, { detail: { sessionRef, ...target } }));
  };
  return <Navigation.Provider value={sessionRef ? target => {
    if (!("absolute" in target) || !target.absolute) { open({ path: target.path, line: target.line }); return; }
    // Outside the project there is nothing the explorer may read: the path is shown as it is.
    void projectPath(sessionRef, target.path).then(relative => { if (relative) open({ path: relative, line: target.line }); }, () => undefined);
  } : null}><Session.Provider value={sessionRef ?? null}>{children}</Session.Provider></Navigation.Provider>;
}
export function WorkspaceFileButton({ path, line, children }: { path: string; line?: number; children?: ReactNode }) {
  const open = useContext(Navigation), { locale } = useUiPreferences(), target = workspaceTarget(path, line);
  if (!open || !target) return children ? <>{children}</> : null;
  return <Button size="small" onClick={() => open(target)} sx={{ textTransform: "none", verticalAlign: "baseline" }}>
    {children ?? localize(locale, "Mở trong editor", "Open in editor")}</Button>;
}
// A link or `code` in an answer that names a file opens it in the explorer.
export function WorkspaceFileLink({ link, children }: { link: FileLink; children: ReactNode }) {
  const open = useContext(Navigation), { locale } = useUiPreferences();
  if (!open) return <>{children}</>;
  return <Link component="button" type="button" underline="hover" onClick={() => open(link)} title={localize(locale, `Mở ${link.path}`, `Open ${link.path}`)}
    sx={{ font: "inherit", verticalAlign: "baseline", textAlign: "left" }}>{children}</Link>;
}
export function WorkspaceMentions({ children }: { children: ReactNode }) {
  return <>{Children.map(children, child => {
    if (typeof child !== "string") return child;
    return child.split(/((?<![\w@])@[\w./-]+\.[\w]+(?::\d+)?)/g).map((part, index) =>
      part.startsWith("@") && workspaceTarget(part) ? <WorkspaceFileButton key={index} path={part}>{part}</WorkspaceFileButton> : part);
  })}</>;
}
