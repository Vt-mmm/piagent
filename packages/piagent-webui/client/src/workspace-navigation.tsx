import { Children, createContext, useContext, type ReactNode } from "react";
import Button from "@mui/material/Button";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
export const WORKSPACE_OPEN_EVENT = "piagent-workspace-open";
export type WorkspaceTarget = { path: string; line: number };
export function workspaceTarget(value: string, line = 1): WorkspaceTarget | null {
  const match = /^(.+?)(?::(\d+)(?::\d+)?)?$/.exec(value.replace(/^@/, ""));
  const file = match?.[1];
  if (!file || file.length > 4096 || /^[~/]/.test(file) || /[\\\x00-\x1f\x7f:]/.test(file)
    || file.split("/").some(part => !part || part === "." || part === "..")) return null;
  return { path: file, line: Math.max(1, Math.min(1_000_000, Number(match?.[2]) || line || 1)) };
}
const Navigation = createContext<((target: WorkspaceTarget) => void) | null>(null);
export function WorkspaceNavigationProvider({ sessionRef, onOpen, children }: { sessionRef?: string; onOpen(): void; children: ReactNode }) {
  return <Navigation.Provider value={sessionRef ? target => {
    onOpen(); window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT, { detail: { sessionRef, ...target } }));
  } : null}>{children}</Navigation.Provider>;
}
export function WorkspaceFileButton({ path, line, children }: { path: string; line?: number; children?: ReactNode }) {
  const open = useContext(Navigation), { locale } = useUiPreferences(), target = workspaceTarget(path, line);
  if (!open || !target) return children ? <>{children}</> : null;
  return <Button size="small" onClick={() => open(target)} sx={{ textTransform: "none", verticalAlign: "baseline" }}>
    {children ?? localize(locale, "Mở trong editor", "Open in editor")}</Button>;
}
export function WorkspaceMentions({ children }: { children: ReactNode }) {
  return <>{Children.map(children, child => {
    if (typeof child !== "string") return child;
    return child.split(/((?<![\w@])@[\w./-]+\.[\w]+(?::\d+)?)/g).map((part, index) =>
      part.startsWith("@") && workspaceTarget(part) ? <WorkspaceFileButton key={index} path={part}>{part}</WorkspaceFileButton> : part);
  })}</>;
}
