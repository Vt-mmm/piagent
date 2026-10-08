import { useEffect, useMemo, useRef, useState } from "react";
import AddRounded from "@mui/icons-material/AddRounded";
import CheckRounded from "@mui/icons-material/CheckRounded";
import CloudOutlined from "@mui/icons-material/CloudOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Popover from "@mui/material/Popover";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { BranchRequestError, readProjectBranches, switchProjectBranch, type GitBranchRow, type ProjectBranches } from "./api.ts";
import { branchTitle, GitBranchLabel } from "./GitBranchLabel.tsx";
import { relativeTime } from "./SessionSidebar.tsx";
import { localize, type UiLocale } from "./ui-preferences.tsx";

const ERRORS: Record<string, [string, string]> = {
  "branch-switch-blocked-running": ["Có cuộc trò chuyện đang chạy trong folder này. Chờ chạy xong hoặc Dừng rồi chuyển nhánh.",
    "A conversation is running in this folder. Wait for it to finish, or stop it, then switch."],
  "branch-switch-local-changes": ["Git không chuyển được: thay đổi chưa commit sẽ bị ghi đè. Commit hoặc stash trước.",
    "Git refused: uncommitted changes would be overwritten. Commit or stash them first."],
  "branch-switch-unfinished-merge": ["Repo đang dở merge hoặc rebase. Xử lý xong rồi chuyển nhánh.", "The repository is in the middle of a merge or rebase. Finish it first."],
  "branch-exists": ["Đã có nhánh tên này.", "A branch with this name already exists."],
  "branch-name-invalid": ["Tên nhánh không hợp lệ với Git.", "Git does not accept this branch name."],
  "branch-not-found": ["Không còn nhánh này.", "This branch no longer exists."],
  "not-a-git-repository": ["Folder này không phải repo Git.", "This folder is not a Git repository."],
  "branch-switch-timeout": ["Git chạy quá lâu nên đã dừng.", "Git took too long and was stopped."]
};

type Target = { branch: string; create?: boolean; remote?: string | null };

// The Git branch of a conversation's project, as a button: it lists the
// project's branches and switches the folder to one of them, or to a new one
// made from the current commit. A switch waits while any conversation in the
// folder runs; Git's own refusals (changes it would overwrite) are shown as
// Git said them.
export function BranchSwitcher({ projectRef, projectLabel, branch, locale, onSwitched, maxWidth = 220 }: { projectRef: string; projectLabel: string;
  branch: SessionRow["gitBranch"]; locale: UiLocale; onSwitched?(): void; maxWidth?: number | string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<ProjectBranches | null>(null), [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; detail: string | null } | null>(null);
  const loading = useRef<AbortController | null>(null);
  const open = Boolean(anchor);

  const load = () => {
    loading.current?.abort(); const controller = new AbortController(); loading.current = controller;
    setLoadError(false);
    readProjectBranches(projectRef, controller.signal).then((value) => { if (!controller.signal.aborted) setList(value); },
      () => { if (!controller.signal.aborted) setLoadError(true); });
  };
  useEffect(() => { if (open) load(); return () => loading.current?.abort(); }, [open, projectRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each opening reads the branches again: a stale "running" or "free" must
  // never decide what the member can press.
  const close = () => { if (busy) return; loading.current?.abort(); setAnchor(null); setQuery(""); setError(null); setList(null); setLoadError(false); };
  const switchTo = async (target: Target) => {
    setBusy(target.branch); setError(null);
    try {
      await switchProjectBranch(projectRef, target);
      onSwitched?.(); setAnchor(null); setQuery(""); setList(null);
    } catch (failure) {
      setError(failure instanceof BranchRequestError ? { code: failure.code, detail: failure.detail } : { code: "branch-switch-failed", detail: null });
      load();
    } finally { setBusy(null); }
  };

  const repository = list?.repository ? list : null;
  const typed = query.trim();
  const shown = useMemo(() => (repository?.branches ?? []).filter((item) => !typed || item.name.toLowerCase().includes(typed.toLowerCase())), [repository, typed]);
  const local = shown.filter((item) => !item.remote), remote = shown.filter((item) => item.remote);
  const exact = (repository?.branches ?? []).some((item) => item.name === typed);
  const blocked = (list?.running ?? 0) > 0;
  const row = (item: GitBranchRow) => <ListItemButton key={`${item.remote ?? ""}/${item.name}`} dense disabled={!item.current && (blocked || Boolean(busy))}
    selected={item.current} aria-current={item.current || undefined} onClick={() => item.current ? close() : void switchTo({ branch: item.name, remote: item.remote })} sx={{ borderRadius: 1, py: .4 }}>
    <ListItemIcon sx={{ minWidth: 26 }}>{busy === item.name ? <CircularProgress size={14} />
      : item.current ? <CheckRounded sx={{ fontSize: 16 }} /> : item.remote ? <CloudOutlined sx={{ fontSize: 15, color: "text.disabled" }} /> : null}</ListItemIcon>
    <ListItemText primary={item.name} secondary={[item.remote, item.committedAt ? relativeTime(item.committedAt, locale) : null].filter(Boolean).join(" · ") || undefined}
      slotProps={{ primary: { noWrap: true, sx: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 } },
        secondary: { noWrap: true, sx: { fontSize: 11 } } }} /></ListItemButton>;

  if (!branch) return null;
  return <>
    <Tooltip describeChild title={`${branchTitle(branch, locale)} · ${localize(locale, "bấm để đổi nhánh", "click to switch")}`}>
    <ButtonBase onClick={(event) => { event.stopPropagation(); setAnchor(event.currentTarget); }} aria-haspopup="dialog" aria-expanded={open}
      aria-label={branch.detached
        ? localize(locale, `Đổi nhánh Git của ${projectLabel} (detached HEAD tại ${branch.name})`, `Switch ${projectLabel}'s Git branch (detached HEAD at ${branch.name})`)
        : localize(locale, `Đổi nhánh Git của ${projectLabel} (đang ở ${branch.name})`, `Switch ${projectLabel}'s Git branch (on ${branch.name})`)}
      sx={{ minWidth: 0, maxWidth, borderRadius: .75, px: .4, mx: -.4, font: "inherit", color: "inherit", justifyContent: "flex-start",
        "&:hover": { bgcolor: "action.hover", color: "text.primary" }, "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "primary.main" } }}>
      <GitBranchLabel branch={branch} locale={locale} maxWidth="100%" tooltip={false} /></ButtonBase></Tooltip>
    <Popover open={open} anchorEl={anchor} onClose={close} anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      slotProps={{ paper: { role: "dialog", "aria-label": localize(locale, "Nhánh Git", "Git branches"),
        sx: { width: "min(360px, calc(100vw - 32px))", maxHeight: "min(520px, 70vh)", display: "flex", flexDirection: "column", p: 1.25, gap: 1 } } }}>
      <Box><Typography variant="subtitle2" sx={{ fontWeight: 650 }}>{localize(locale, "Nhánh Git", "Git branches")}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap component="div">{projectLabel}</Typography></Box>
      {blocked && <Alert severity="warning" sx={{ py: 0, fontSize: 12.5 }}>{localize(locale,
        `${list!.running} cuộc trò chuyện đang chạy trong folder này. Chờ chạy xong hoặc Dừng rồi mới chuyển nhánh.`,
        `${list!.running} conversation(s) running in this folder. Wait for them to finish, or stop them, before switching.`)}</Alert>}
      {repository && repository.changedFiles > 0 && !blocked && <Typography variant="caption" color="text.secondary">{localize(locale,
        `${repository.changedFiles} file đang sửa dở sẽ đi theo sang nhánh mới; Git từ chối nếu chúng bị ghi đè.`,
        `${repository.changedFiles} changed file(s) come along to the new branch; Git refuses if they would be overwritten.`)}</Typography>}
      {error && <Alert severity="error" sx={{ py: 0, fontSize: 12.5 }}>{localize(locale, ...(ERRORS[error.code] ?? ["Không chuyển được nhánh.", "The branch could not be switched."]))}
        {error.detail && <Box component="pre" sx={{ m: 0, mt: .5, whiteSpace: "pre-wrap", font: "11px ui-monospace, monospace", opacity: .85 }}>{error.detail}</Box>}</Alert>}
      <TextField autoFocus size="small" value={query} onChange={(event) => setQuery(event.target.value)} disabled={!repository || Boolean(busy)}
        placeholder={localize(locale, "Tìm hoặc đặt tên nhánh mới", "Find a branch or name a new one")}
        slotProps={{ htmlInput: { maxLength: 200, "aria-label": localize(locale, "Tìm nhánh", "Find a branch") } }}
        onKeyDown={(event) => { if (event.key === "Enter" && typed && !blocked && !busy) {
          const match = repository?.branches.find((item) => item.name === typed);
          void switchTo(match ? { branch: match.name, remote: match.remote } : { branch: typed, create: true }); } }} />
      <Box sx={{ overflowY: "auto", minHeight: 0, mx: -.5 }}>
        {!list && !loadError && <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}><CircularProgress size={18} /></Box>}
        {loadError && <Alert severity="error" sx={{ py: 0, fontSize: 12.5 }}>{localize(locale, "Không đọc được danh sách nhánh.", "The branches could not be read.")}</Alert>}
        {list && !list.repository && <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>{localize(locale, ...ERRORS["not-a-git-repository"])}</Typography>}
        {repository && <List dense disablePadding>
          {typed && !exact && <ListItemButton dense disabled={blocked || Boolean(busy)} onClick={() => void switchTo({ branch: typed, create: true })} sx={{ borderRadius: 1 }}>
            <ListItemIcon sx={{ minWidth: 26 }}>{busy === typed ? <CircularProgress size={14} /> : <AddRounded sx={{ fontSize: 16 }} />}</ListItemIcon>
            <ListItemText primary={localize(locale, `Tạo nhánh mới “${typed}”`, `Create branch “${typed}”`)}
              secondary={localize(locale, `từ ${repository.head?.name ?? "HEAD"}`, `from ${repository.head?.name ?? "HEAD"}`)}
              slotProps={{ primary: { noWrap: true, sx: { fontSize: 12.5 } }, secondary: { sx: { fontSize: 11 } } }} /></ListItemButton>}
          {local.map(row)}
          {remote.length > 0 && <ListSubheader disableSticky sx={{ lineHeight: "26px", fontSize: 11, bgcolor: "transparent" }}>{localize(locale, "Trên remote", "On a remote")}</ListSubheader>}
          {remote.map(row)}
          {shown.length === 0 && !typed && <Typography variant="body2" color="text.secondary" sx={{ px: 1 }}>{localize(locale, "Chưa có nhánh nào.", "No branches yet.")}</Typography>}
          {repository.truncated && <Typography variant="caption" color="text.disabled" sx={{ px: 1 }}>{localize(locale, "Chỉ hiện 200 nhánh có commit mới nhất.", "Showing the 200 most recently committed branches.")}</Typography>}
        </List>}
      </Box>
    </Popover>
  </>;
}
