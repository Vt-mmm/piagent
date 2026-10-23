import { useWorkspaceComments } from './use-workspace-comments.tsx';
import { useWorkspaceRevert } from './use-workspace-revert.tsx';
import { useWorkspaceReview } from './use-workspace-review.ts';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import { useWorkspaceEditing } from './use-workspace-editing.tsx';
import { tabDirty } from './workspace-editor-tabs.ts';
import { workspaceTarget } from './workspace-navigation.tsx';
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
import { readWorkspaceFile, readWorkspaceTree } from "./workspace-api.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";
const CodeEditor = lazy(() => import("./WorkspaceCodeEditor.tsx"));

export default function WorkspaceExplorer({ sessionRef, target, navigationHost, sidebarMode }: { sessionRef: string; target?: { path: string; line?: number }; navigationHost?: HTMLElement | null; sidebarMode?: "sessions" | "files" | "search" }) {
  const { locale } = useUiPreferences();
  const [section, setSection] = useState("files"), [newFile, setNewFile] = useState(false), [newPath, setNewPath] = useState(""), [compare, setCompare] = useState(false);
  const [renaming, setRenaming] = useState<string>(), [renamePath, setRenamePath] = useState("");
  const editing = useWorkspaceEditing(sessionRef), { tabs, active } = editing;
  const [folder, setFolder] = useState(""), [tree, setTree] = useState<PiagentWebUIWorkspaceTreeV1>();
  const [error, setError] = useState(false), [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const saved = (event: Event) => { if ((event as CustomEvent).detail?.sessionRef === sessionRef) setRefresh(value => value + 1); };
    window.addEventListener('piagent-workspace-saved', saved);
    return () => window.removeEventListener('piagent-workspace-saved', saved);
  }, [sessionRef]);
  useEffect(() => {
    const controller = new AbortController(); setTree(undefined); setError(false);
    void readWorkspaceTree(sessionRef, folder, controller.signal).then(value => { if (!controller.signal.aborted) setTree(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [sessionRef, folder, refresh]);
  useEffect(() => () => pending.current?.abort(), []);
  const open = async (path: string, line = 1) => {
    pending.current?.abort(); setLoading(false);
    const existing = tabs.find(tab => tab.file.path === path);
    if (existing) { editing.select(path, line); return; }
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(false);
    try {
      const file = await readWorkspaceFile(sessionRef, path, controller.signal);
      if (controller.signal.aborted) return;
      if (file.protected) { setError(true); return; }
      editing.load(file, line);
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => { if (target) void open(target.path, target.line ?? 1); }, [target]);
  useEffect(() => { if (sidebarMode && sidebarMode !== "sessions") setSection(sidebarMode); }, [sidebarMode]);
  const tab = tabs.find(tab => tab.file.path === active), file = tab?.file;
  const review = useWorkspaceReview(sessionRef, tabs, active);
  const revert = useWorkspaceRevert(sessionRef, file?.path, file?.digest ?? null, !!tab && !tabDirty(tab), review.diff);
  const lineReview = useWorkspaceComments(sessionRef, file?.path, tab?.draft ?? '', review.hunks);
  const conflictTab = tabs.find(tab => tab.file.path === editing.conflict?.path);
  const navigation = <Box component="nav" aria-label={localize(locale, "Tệp dự án", "Project files")} sx={{ width: navigationHost ? "100%" : 180, flexShrink: 0, overflow: "auto", borderRight: 1, borderColor: "divider" }}>
      {!navigationHost && <Tabs value={section} onChange={(_, value) => setSection(value)} aria-label={localize(locale, "Khám phá project", "Explore project")}>
        <Tab value="files" label={localize(locale, "Tệp", "Files")} /><Tab value="search" label={localize(locale, "Tìm kiếm", "Search")} />
      </Tabs>}
      {section === "search" ? <WorkspaceSearch sessionRef={sessionRef} onOpen={(path, line) => void open(path, line)} /> : <>
      <Button disabled={!editing.authority?.writable} onClick={() => { setNewPath(folder ? `${folder}/` : ""); setNewFile(true); }}>{localize(locale, "Tệp mới", "New file")}</Button>
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
  return <>{revert.dialog}{lineReview.dialog}<Stack direction="row" sx={{ height: "calc(100vh - 150px)", minHeight: 320 }}>
    {navigationHost ? createPortal(navigation, navigationHost) : navigation}
    <Box sx={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
      {error && <Alert severity="warning">{localize(locale, "Chưa đọc được tệp hoặc thư mục này.", "This file or folder could not be read.")}</Alert>}
      {lineReview.bar}
      {editing.message && <Alert severity="warning">{editing.message}</Alert>}
      {editing.authority?.agentRunning && <Alert severity="info">{localize(locale, "Agent đang chạy và có thể sửa tệp này.", "The agent is running and may change this file.")}</Alert>}
      {!!tabs.length && <Tabs value={active ?? false} onChange={(_, value) => editing.select(value)} variant="scrollable" scrollButtons="auto" aria-label={localize(locale, "Các tệp đang mở", "Open files")}>
        {tabs.map(tab => <Tab key={tab.file.path} value={tab.file.path} label={`${tab.file.path}${tabDirty(tab) ? " ●" : ""}${review.counts.get(tab.file.path) ? ` (${review.counts.get(tab.file.path)})` : ""}`} />)}</Tabs>}
      {loading && <CircularProgress size={20} />}
      {file && <Stack direction="row">{revert.hasPending && <Button onClick={revert.checkPending}>{localize(locale, "Kiểm tra hoàn tác", "Check revert")}</Button>}
        <Button size="small" disabled={!editing.authority?.writable || file.readOnly || !tab || (!tabDirty(tab) && !tab.pending) || editing.saving} onClick={() => void editing.save(file.path)}>{localize(locale, "Lưu", "Save")}</Button>
        <Button size="small" onClick={() => editing.close(file.path)}>{localize(locale, "Đóng tệp", "Close file")}</Button>
        <Button size="small" disabled={!editing.authority?.writable || file.readOnly || !file.digest || editing.saving} onClick={() => { setRenamePath(file.path); setRenaming(file.path); }}>{localize(locale, "Đổi tên", "Rename")}</Button>
        <Button size="small" color="error" disabled={!editing.authority?.writable || file.readOnly || !file.digest || editing.saving}
          onClick={() => { if (window.confirm(localize(locale, `Xóa ${file.path}? Có thể khôi phục bằng Git nếu tệp đã commit.`, `Delete ${file.path}? Git can restore it if it was committed.`))) void editing.move(file.path); }}>{localize(locale, "Xóa", "Delete")}</Button>
        <Button size="small" onClick={() => { if (!tab || !tabDirty(tab) || window.confirm(localize(locale, "Bỏ thay đổi chưa lưu và tải lại?", "Discard unsaved changes and reload?"))) void editing.reload(file.path); }}>{localize(locale, "Tải lại", "Reload")}</Button>
      </Stack>}
      {file?.binary || file?.oversized ? <Alert severity="info">{localize(locale, "Tệp nhị phân hoặc quá lớn để hiển thị.", "This file is binary or too large to display.")}</Alert>
        : file?.content !== null && file?.content !== undefined ? <Box sx={{ flex: 1, minHeight: 0 }}><Suspense fallback={<CircularProgress size={20} />}>
          <CodeEditor onComment={lineReview.open} hunks={review.hunks} onKeep={review.keep} onRevert={editing.authority?.writable ? ref => void revert.request(ref) : undefined} content={tab?.draft ?? file.content} path={file.path} line={tab?.line ?? 1} readOnly={!editing.authority?.writable || file.readOnly}
            onChange={value => editing.change(file.path, value)} onSave={() => void editing.save(file.path)} /></Suspense></Box>
          : <Typography sx={{ p: 2 }}>{localize(locale, "Chọn một tệp để mở.", "Select a file to open.")}</Typography>}
    </Box>
  </Stack>
    <Dialog open={newFile} onClose={() => setNewFile(false)} fullWidth>
      <DialogTitle>{localize(locale, "Tạo tệp mới", "Create a new file")}</DialogTitle>
      <DialogContent><TextField autoFocus fullWidth label={localize(locale, "Đường dẫn trong project", "Path in project")} value={newPath} onChange={event => setNewPath(event.target.value)} /></DialogContent>
      <DialogActions><Button onClick={() => setNewFile(false)}>{localize(locale, "Hủy", "Cancel")}</Button><Button disabled={!workspaceTarget(newPath) || !editing.authority?.writable} onClick={() => {
        const target = workspaceTarget(newPath); if (!target || !editing.authority) return;
        if (tabs.some(tab => tab.file.path === target.path)) editing.select(target.path);
        else editing.load({ schemaVersion: 1, version: "piagent-webui-workspace-file-v1", generatedAt: new Date().toISOString(), identity: editing.authority.identity,
          path: target.path, language: "text", protected: false, readOnly: false, binary: false, oversized: false, content: "", digest: null, revision: null }, 1, true);
        setNewFile(false);
      }}>{localize(locale, "Tạo", "Create")}</Button></DialogActions>
    </Dialog>
    <Dialog open={!!renaming} onClose={() => setRenaming(undefined)} fullWidth>
      <DialogTitle>{localize(locale, "Đổi tên tệp", "Rename file")}</DialogTitle>
      <DialogContent><TextField autoFocus fullWidth label={localize(locale, "Đường dẫn mới trong project", "New path in project")} value={renamePath} onChange={event => setRenamePath(event.target.value)} /></DialogContent>
      <DialogActions><Button onClick={() => setRenaming(undefined)}>{localize(locale, "Hủy", "Cancel")}</Button><Button disabled={!workspaceTarget(renamePath) || workspaceTarget(renamePath)?.path === renaming || editing.saving} onClick={() => {
        const target = workspaceTarget(renamePath); if (!target || !renaming) return;
        void editing.move(renaming, target.path).then(done => { if (done) setRenaming(undefined); });
      }}>{localize(locale, "Đổi tên", "Rename")}</Button></DialogActions>
    </Dialog>
    <Dialog open={!!editing.conflict} onClose={() => { editing.setConflict(undefined); setCompare(false); }} fullWidth maxWidth={compare ? "lg" : "sm"}>
      <DialogTitle>{localize(locale, "Tệp đã thay đổi trên đĩa", "The file changed on disk")}</DialogTitle>
      <DialogContent><Typography>{editing.conflict?.path}</Typography><Typography>{localize(locale, "Bản sửa của bạn vẫn được giữ. Chọn cách xử lý xung đột.", "Your draft is preserved. Choose how to resolve the conflict.")}</Typography>
        {compare && editing.conflict && conflictTab && <Stack direction="row" spacing={1}>
          <Box sx={{ width: "50%", height: 360 }}><Typography>{localize(locale, "Trên đĩa", "On disk")}</Typography><Suspense fallback={<CircularProgress size={20} />}><CodeEditor path={editing.conflict.path} content={editing.conflict.content ?? ""} /></Suspense></Box>
          <Box sx={{ width: "50%", height: 360 }}><Typography>{localize(locale, "Bản sửa của bạn", "Your draft")}</Typography><Suspense fallback={<CircularProgress size={20} />}><CodeEditor path={conflictTab.file.path} content={conflictTab.draft} /></Suspense></Box>
        </Stack>}
      </DialogContent><DialogActions>
        <Button onClick={() => { editing.setConflict(undefined); setCompare(false); }}>{localize(locale, "Để sau", "Later")}</Button>
        <Button onClick={() => { if (editing.conflict) { editing.load(editing.conflict); editing.setConflict(undefined); setCompare(false); } }}>{localize(locale, "Tải lại", "Reload")}</Button>
        <Button onClick={() => setCompare(true)}>{localize(locale, "Xem khác biệt", "Compare")}</Button>
        <Button disabled={editing.saving || !editing.conflict?.digest || editing.conflict.protected || editing.conflict.readOnly} onClick={() => { if (editing.conflict) void editing.save(editing.conflict.path, editing.conflict); }}>{localize(locale, "Ghi đè", "Overwrite")}</Button>
      </DialogActions>
    </Dialog>
  </>;
}
