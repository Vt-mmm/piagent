import type { WorkspaceSidebarMode } from "./WorkspaceSidebarTabs.tsx";
import { WORKSPACE_OPEN_EVENT, type WorkspaceTarget } from "./workspace-navigation.tsx";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
const QuickOpen = lazy(() => import("./WorkspaceQuickOpen.tsx"));
const TerminalPanel = lazy(() => import("./TerminalPanel.tsx"));
const Explorer = lazy(() => import("./WorkspaceExplorer.tsx"));

export function SessionEditorLayout({ sessionRef, children, navigationHost, sidebarMode, onSection }: { sessionRef: string; children: ReactNode; navigationHost?: HTMLElement | null; sidebarMode: WorkspaceSidebarMode; onSection(value: WorkspaceSidebarMode): void }) {
  const { locale } = useUiPreferences(), theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("lg"));
  const [open, setOpen] = useState(false), [quick, setQuick] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [target, setTarget] = useState<{ path: string; line?: number }>();
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault(); setQuick(true);
      }
    };
    const openFile = (event: Event) => {
      const value = (event as CustomEvent<WorkspaceTarget & { sessionRef: string }>).detail;
      if (value?.sessionRef === sessionRef) { setTarget({ path: value.path, line: value.line }); setOpen(true); onSection("files"); }
    };
    window.addEventListener("keydown", shortcut); window.addEventListener(WORKSPACE_OPEN_EVENT, openFile);
    return () => { window.removeEventListener("keydown", shortcut); window.removeEventListener(WORKSPACE_OPEN_EVENT, openFile); };
  }, [sessionRef]);
  useEffect(() => { if (sidebarMode !== "sessions") setOpen(true); }, [sidebarMode]);
  const explorer = <Suspense fallback={<CircularProgress size={24} />}><Explorer sessionRef={sessionRef} target={target} navigationHost={wide ? navigationHost : null} sidebarMode={sidebarMode} /></Suspense>;
  const terminal = <Suspense fallback={<CircularProgress size={24} />}><TerminalPanel sessionRef={sessionRef} /></Suspense>;
  return <>
    {quick && <Suspense fallback={<CircularProgress size={20} />}><QuickOpen sessionRef={sessionRef} onClose={() => setQuick(false)}
      onOpen={path => { setQuick(false); setOpen(true); onSection("files"); setTarget({ path }); }} /></Suspense>}
    <Button aria-expanded={open} onClick={() => { setOpen(value => !value); onSection(open ? "sessions" : "files"); }}>{localize(locale, "Tệp", "Files")}</Button>
    <Button aria-expanded={terminalOpen} onClick={() => setTerminalOpen(value => !value)}>Terminal</Button>
    <Box sx={{ display: "flex", minWidth: 0 }}>
      {wide && (open || terminalOpen) && <Box component="section" sx={{ width: "58%", minWidth: 0, borderRight: 1, borderColor: "divider" }}>{open && explorer}{terminalOpen && terminal}</Box>}
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
    {!wide && <Drawer anchor="bottom" open={terminalOpen} onClose={() => setTerminalOpen(false)}>
      <Button onClick={() => setTerminalOpen(false)}>{localize(locale, "Ẩn terminal", "Hide terminal")}</Button>{terminalOpen && terminal}
    </Drawer>}
    {!wide && <Drawer anchor="left" open={open} onClose={() => setOpen(false)} slotProps={{ paper: { sx: { width: "min(96vw, 800px)" } } }}>
      <Button onClick={() => setOpen(false)}>{localize(locale, "Đóng", "Close")}</Button>{open && explorer}
    </Drawer>}
  </>;
}
