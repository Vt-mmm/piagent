import { createPortal } from "react-dom";
import { WorkspaceSearch } from "./WorkspaceSearch.tsx";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { PiagentWebUIWorkspaceTreeV1 } from "../../contracts/generated/workspace-tree-v1.ts";
import type { PiagentWebUIWorkspaceFileV1 } from "../../contracts/generated/workspace-file-v1.ts";
import { readWorkspaceFile, readWorkspaceTree } from "./workspace-api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
const CodeEditor = lazy(() => import("./WorkspaceCodeEditor.tsx"));

export default function WorkspaceExplorer({ sessionRef, target, navigationHost, sidebarMode }: { sessionRef: string; target?: { path: string; line?: number }; navigationHost?: HTMLElement | null; sidebarMode?: "sessions" | "files" | "search" }) {
  const { locale } = useUiPreferences();
  const [section, setSection] = useState("files"), [lines, setLines] = useState<Record<string, number>>({});
  const [folder, setFolder] = useState(""), [tree, setTree] = useState<PiagentWebUIWorkspaceTreeV1>();
  const [tabs, setTabs] = useState<PiagentWebUIWorkspaceFileV1[]>([]), [active, setActive] = useState<string>();
  const [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setTree(undefined); setError(false);
    void readWorkspaceTree(sessionRef, folder, controller.signal).then(value => { if (!controller.signal.aborted) setTree(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [sessionRef, folder]);
  useEffect(() => () => pending.current?.abort(), []);
  const open = async (path: string, line = 1) => {
    setLines(current => ({ ...current, [path]: line }));
    pending.current?.abort(); setLoading(false);
    const existing = tabs.find(tab => tab.path === path);
    if (existing) { setActive(path); return; }
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(false);
    try {
      const file = await readWorkspaceFile(sessionRef, path, controller.signal);
      if (controller.signal.aborted) return;
      if (file.protected) { setError(true); return; }
      setTabs(current => [...current.filter(tab => tab.path !== path), file]); setActive(path);
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => { if (target) void open(target.path, target.line ?? 1); }, [target]);
  useEffect(() => { if (sidebarMode && sidebarMode !== "sessions") setSection(sidebarMode); }, [sidebarMode]);
  const file = tabs.find(tab => tab.path === active);
  const navigation = <Box component="nav" aria-label={localize(locale, "Tệp dự án", "Project files")} sx={{ width: navigationHost ? "100%" : 180, flexShrink: 0, overflow: "auto", borderRight: 1, borderColor: "divider" }}>
      {!navigationHost && <Tabs value={section} onChange={(_, value) => setSection(value)} aria-label={localize(locale, "Khám phá project", "Explore project")}>
        <Tab value="files" label={localize(locale, "Tệp", "Files")} /><Tab value="search" label={localize(locale, "Tìm kiếm", "Search")} />
      </Tabs>}
      {section === "search" ? <WorkspaceSearch sessionRef={sessionRef} onOpen={(path, line) => void open(path, line)} /> : <>
      {folder && <Button onClick={() => setFolder(folder.split("/").slice(0, -1).join("/"))}>{localize(locale, "Thư mục cha", "Parent folder")}</Button>}
      <Typography variant="caption" sx={{ p: 1, overflowWrap: "anywhere" }}>{folder || "/"}</Typography>
      {!tree && !error && <CircularProgress size={18} />}
      {tree?.entries.map(entry => <Button key={entry.path} fullWidth disabled={entry.protected || entry.kind === "symlink" || entry.kind === "other"}
        aria-label={entry.protected ? `${entry.name} (${localize(locale, "được bảo vệ", "protected")})` : entry.name}
        onClick={() => entry.kind === "directory" ? setFolder(entry.path) : void open(entry.path)} sx={{ justifyContent: "flex-start", textTransform: "none", overflowWrap: "anywhere" }}>
        {entry.kind === "directory" ? "▸ " : ""}{entry.name}{entry.protected ? " 🔒" : ""}</Button>)}
      {tree?.truncated && <Typography variant="caption">{localize(locale, "Danh sách đã được giới hạn.", "Listing limit reached.")}</Typography>}
      </>}
    </Box>;
  return <Stack direction="row" sx={{ height: "calc(100vh - 150px)", minHeight: 320 }}>
    {navigationHost ? createPortal(navigation, navigationHost) : navigation}
    <Box sx={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
      {error && <Alert severity="warning">{localize(locale, "Chưa đọc được tệp hoặc thư mục này.", "This file or folder could not be read.")}</Alert>}
      {!!tabs.length && <Tabs value={active ?? false} onChange={(_, value) => setActive(value)} variant="scrollable" scrollButtons="auto" aria-label={localize(locale, "Các tệp đang mở", "Open files")}>
        {tabs.map(tab => <Tab key={tab.path} value={tab.path} label={tab.path} />)}</Tabs>}
      {loading && <CircularProgress size={20} />}
      {file && <Button size="small" onClick={() => { setTabs(tabs.filter(tab => tab.path !== file.path)); setActive(tabs.find(tab => tab.path !== file.path)?.path); }}>{localize(locale, "Đóng tệp", "Close file")}</Button>}
      {file?.binary || file?.oversized ? <Alert severity="info">{localize(locale, "Tệp nhị phân hoặc quá lớn để hiển thị.", "This file is binary or too large to display.")}</Alert>
        : file?.content !== null && file?.content !== undefined ? <Box sx={{ flex: 1, minHeight: 0 }}><Suspense fallback={<CircularProgress size={20} />}>
          <CodeEditor content={file.content} path={file.path} line={lines[file.path] ?? 1} /></Suspense></Box>
          : <Typography sx={{ p: 2 }}>{localize(locale, "Chọn một tệp để mở.", "Select a file to open.")}</Typography>}
    </Box>
  </Stack>;
}
