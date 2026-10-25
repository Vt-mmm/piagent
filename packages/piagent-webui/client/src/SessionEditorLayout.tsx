import type { WorkspaceSidebarMode } from "./WorkspaceSidebarTabs.tsx";
import { WORKSPACE_OPEN_EVENT, type WorkspaceTarget } from "./workspace-navigation.tsx";
import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseRounded from "@mui/icons-material/CloseRounded";
import FolderOutlined from "@mui/icons-material/FolderOutlined";
import TerminalRounded from "@mui/icons-material/TerminalRounded";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
const QuickOpen = lazy(() => import("./WorkspaceQuickOpen.tsx"));
const TerminalPanel = lazy(() => import("./TerminalPanel.tsx"));
const Explorer = lazy(() => import("./WorkspaceExplorer.tsx"));
// The fixed header above the conversation (SessionHubApp's Toolbar).
const HEADER_HEIGHT = 52, BAR_HEIGHT = 36, MIN_WIDTH = 25, MAX_WIDTH = 75, WIDTH_KEY = "piagent-webui-editor-width";
function storedWidth() {
  try { const value = Number(window.localStorage.getItem(WIDTH_KEY)); return value >= MIN_WIDTH && value <= MAX_WIDTH ? value : 55; } catch { return 55; }
}

// A pressed panel switch reads as on: tinted, in the text colour.
const toggleSx = (on: boolean) => ({ color: on ? "text.primary" : "text.secondary", bgcolor: on ? "action.selected" : "transparent",
  "& .MuiButton-startIcon svg": { fontSize: 16, color: on ? "primary.main" : "inherit" } });

// The title row of a narrow-screen drawer, closed by an icon button.
function DrawerHead({ title, close, onClose }: { title: string; close: string; onClose(): void }) {
  return <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, minHeight: 48, borderBottom: 1, borderColor: "divider" }}>
    <Typography sx={{ fontWeight: 600, flex: 1 }}>{title}</Typography>
    <IconButton size="small" aria-label={close} onClick={onClose}><CloseRounded fontSize="small" /></IconButton></Box>;
}

export function SessionEditorLayout({ sessionRef, children, navigationHost, sidebarMode, onSection }: { sessionRef: string; children: ReactNode; navigationHost?: HTMLElement | null; sidebarMode: WorkspaceSidebarMode; onSection(value: WorkspaceSidebarMode): void }) {
  const { locale } = useUiPreferences(), theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("lg"));
  const [open, setOpen] = useState(false), [quick, setQuick] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [target, setTarget] = useState<{ path: string; line?: number }>();
  const row = useRef<HTMLDivElement>(null), [width, setWidth] = useState(storedWidth);
  const resize = (value: number) => {
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)); setWidth(next);
    try { window.localStorage.setItem(WIDTH_KEY, String(Math.round(next))); } catch { /* best-effort */ }
  };
  const startResize = (event: ReactPointerEvent) => {
    const box = row.current?.getBoundingClientRect(); if (!box) return;
    event.preventDefault(); document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    const move = (moved: PointerEvent) => resize((moved.clientX - box.left) / box.width * 100);
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };
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
  const hideFiles = () => { setOpen(false); onSection("sessions"); };
  const explorer = <Suspense fallback={<CircularProgress size={24} />}><Explorer sessionRef={sessionRef} target={target} navigationHost={wide ? navigationHost : null} sidebarMode={sidebarMode} onHide={hideFiles} fill={wide} /></Suspense>;
  const terminal = <Suspense fallback={<CircularProgress size={24} />}><TerminalPanel sessionRef={sessionRef} onHide={() => setTerminalOpen(false)} /></Suspense>;
  return <>
    {quick && <Suspense fallback={<CircularProgress size={20} />}><QuickOpen sessionRef={sessionRef} onClose={() => setQuick(false)}
      onOpen={path => { setQuick(false); setOpen(true); onSection("files"); setTarget({ path }); }} /></Suspense>}
    {/* The panel switches stay under the header while the conversation scrolls. */}
    <Box sx={{ position: "sticky", top: HEADER_HEIGHT, zIndex: 2, height: BAR_HEIGHT, display: "flex", alignItems: "center", gap: .5, px: 1,
      bgcolor: "background.default", borderBottom: 1, borderColor: "divider" }}>
      <Button size="small" color="inherit" startIcon={<FolderOutlined />} aria-expanded={open} onClick={() => { setOpen(value => !value); onSection(open ? "sessions" : "files"); }}
        sx={toggleSx(open)}>{localize(locale, "Tệp", "Files")}</Button>
      <Button size="small" color="inherit" startIcon={<TerminalRounded />} aria-expanded={terminalOpen} onClick={() => setTerminalOpen(value => !value)}
        sx={toggleSx(terminalOpen)}>Terminal</Button>
      <Box sx={{ flex: 1 }} />
      {wide && <Typography variant="caption" color="text.disabled" sx={{ pr: .5, display: { xs: "none", xl: "block" } }}>
        {localize(locale, "⌘P mở file", "⌘P to open a file")}</Typography>}
    </Box>
    <Box ref={row} sx={{ display: "flex", minWidth: 0 }}>
      {/* Editor above, terminal below, as in an IDE: both share the window height
          and stay in view while the conversation beside them scrolls. */}
      {wide && (open || terminalOpen) && <Box component="section" aria-label={localize(locale, "Editor và terminal", "Editor and terminal")}
        sx={{ position: "sticky", top: HEADER_HEIGHT + BAR_HEIGHT, alignSelf: "flex-start", flexShrink: 0, minWidth: 0,
          width: `clamp(320px, ${width}%, calc(100% - 360px))`, height: `calc(100vh - ${HEADER_HEIGHT + BAR_HEIGHT}px - var(--piagent-status-bar, 0px))`,
          display: "flex", flexDirection: "column", bgcolor: "background.default", zIndex: 1 }}>
        {open && <Box sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{explorer}</Box>}
        {terminalOpen && <Box sx={{ flexShrink: 0, maxHeight: open ? "60%" : "100%", overflow: "auto", ...(open ? {} : { flex: 1 }) }}>{terminal}</Box>}
        <Box role="separator" aria-orientation="vertical" aria-label={localize(locale, "Kéo để đổi độ rộng editor", "Drag to resize the editor")}
          aria-valuenow={Math.round(width)} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} tabIndex={0}
          onPointerDown={startResize} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? -2 : 2)); } }}
          sx={{ position: "absolute", top: 0, right: -3, bottom: 0, width: 6, cursor: "col-resize", zIndex: 2, borderRight: 1, borderColor: "divider",
            "&:hover, &:focus-visible": { borderColor: "primary.main", outline: "none" } }} />
      </Box>}
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
    {!wide && <Drawer anchor="bottom" open={terminalOpen} onClose={() => setTerminalOpen(false)}>
      <DrawerHead title="Terminal" close={localize(locale, "Ẩn terminal", "Hide terminal")} onClose={() => setTerminalOpen(false)} />{terminalOpen && terminal}
    </Drawer>}
    {!wide && <Drawer anchor="left" open={open} onClose={() => setOpen(false)} slotProps={{ paper: { sx: { width: "min(96vw, 800px)" } } }}>
      <DrawerHead title={localize(locale, "Tệp", "Files")} close={localize(locale, "Đóng", "Close")} onClose={() => setOpen(false)} />{open && explorer}
    </Drawer>}
  </>;
}
