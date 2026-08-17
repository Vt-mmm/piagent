import { useEffect, useMemo, useState } from "react";
import AddRounded from "@mui/icons-material/AddRounded";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import AttachFileRounded from "@mui/icons-material/AttachFileRounded";
import CancelRounded from "@mui/icons-material/CancelRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import ModelTrainingOutlined from "@mui/icons-material/ModelTrainingOutlined";
import TuneRounded from "@mui/icons-material/TuneRounded";
import SendRounded from "@mui/icons-material/SendRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { importProjectFolder, readSessionCreationOptions, type SessionCreationOptions, WebUiRequestError } from "./api.ts";
import { formatSize, MAX_ATTACHMENTS, supportedAttachmentAccept } from "./attachment-intake.ts";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { label } from "./view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

type CreateValue = { projectRef: string; placeRef: string; modelRef: string | null; thinkingLevel: string; message: string; files: readonly File[] };
type MenuKind = "project" | "model" | "thinking" | null;

export function NewSessionPage({ active, defaultProjectRef, busy, error, onCancel, onCreate }: { active: boolean;
  defaultProjectRef?: string; busy: boolean; error: string | null; onCancel(): void; onCreate(value: CreateValue): void }) {
  const { locale } = useUiPreferences();
  const [options, setOptions] = useState<SessionCreationOptions>();
  const [failed, setFailed] = useState(false), [projectRef, setProjectRef] = useState(""), [modelRef, setModelRef] = useState("");
  const [thinking, setThinking] = useState("high"), [message, setMessage] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]), [fileError, setFileError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuKind>(null), [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setOptions(undefined); setFailed(false); setMessage(""); setImportError(null); setFiles([]); setFileError(null);
    void readSessionCreationOptions(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setOptions(value);
      setProjectRef(value.projects.some((project) => project.projectRef === defaultProjectRef)
        ? defaultProjectRef! : value.projects[0]?.projectRef ?? "");
      setModelRef(""); setThinking("high");
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [active, defaultProjectRef]);
  const project = options?.projects.find((value) => value.projectRef === projectRef);
  const model = options?.models.find((value) => value.modelRef === modelRef);
  const thinkingLevels = useMemo(() => model?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"], [model]);
  useEffect(() => {
    if (!thinkingLevels.includes(thinking)) setThinking(thinkingLevels.includes("high") ? "high" : thinkingLevels[0] ?? "off");
  }, [modelRef, thinkingLevels]);
  const openMenu = (kind: Exclude<MenuKind, null>) => (event: React.MouseEvent<HTMLElement>) => { setMenu(kind); setAnchor(event.currentTarget); };
  const closeMenu = () => { setMenu(null); setAnchor(null); };
  const importFolder = async () => {
    setImporting(true); setImportError(null);
    try {
      const result = await importProjectFolder();
      const imported = result.projects?.length ? result.projects : [result.project];
      setOptions((current) => current ? { ...current, projects: [...current.projects.filter((item) => !imported.some((project) => project.projectRef === item.projectRef)), ...imported] } : current);
      setProjectRef(result.project.projectRef); closeMenu();
    } catch (cause) {
      if (cause instanceof WebUiRequestError && cause.status === 409) setImportError(null);
      else setImportError(localize(locale, "Không thể thêm thư mục", "Could not add this folder"));
    } finally { setImporting(false); }
  };
  const selectFiles = (selected: FileList | null) => {
    if (!selected?.length) return;
    const merged = [...files]; let overflow = false;
    for (const file of [...selected]) {
      if (merged.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
      if (merged.length === MAX_ATTACHMENTS) { overflow = true; continue; }
      merged.push(file);
    }
    setFiles(merged); setFileError(overflow
      ? localize(locale, `Mỗi tin nhắn nhận tối đa ${MAX_ATTACHMENTS} file.`, `Each message accepts at most ${MAX_ATTACHMENTS} files.`) : null);
  };
  const submit = () => project && message.trim() && onCreate({ projectRef, placeRef: project.placeRef, modelRef: modelRef || null,
    thinkingLevel: thinking, message: message.trim(), files });

  return <Box sx={{ minHeight: "calc(100vh - 68px)", display: "flex", flexDirection: "column" }}>
    <Box sx={{ p: { xs: 1.5, sm: 2 } }}><IconButton aria-label={localize(locale, "Quay lại", "Back")} onClick={onCancel}><ArrowBackRounded /></IconButton></Box>
    <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", px: 2, pb: { xs: 5, md: 12 } }} spacing={4}>
      <Typography component="h1" sx={{ fontSize: { xs: "2rem", md: "2.45rem" }, fontWeight: 500, letterSpacing: "-.035em", textAlign: "center" }}>
        {localize(locale, "Anh muốn làm gì?", "What should we work on?")}
      </Typography>
      <Box sx={{ width: "100%", maxWidth: 820, border: 1, borderColor: "divider", borderRadius: 3.5, bgcolor: "background.paper",
        p: 1.25, boxShadow: "0 18px 55px rgba(0,0,0,.13)" }}>
        {!options && !failed ? <Stack direction="row" spacing={1.5} sx={{ minHeight: 126, alignItems: "center", justifyContent: "center" }}>
          <CircularProgress size={20} /><Typography color="text.secondary">{localize(locale, "Đang mở…", "Opening…")}</Typography></Stack>
          : <><TextField autoFocus fullWidth multiline minRows={3} maxRows={8} value={message} disabled={busy || failed}
            onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
            }} placeholder={localize(locale, "Nhắn cho Piagent…", "Message Piagent…")} variant="standard"
            slotProps={{ input: { disableUnderline: true }, htmlInput: { maxLength: 32_768 } }} sx={{ px: .5 }} />
          {files.length > 0 && <Stack direction="row" sx={{ flexWrap: "wrap", gap: .75, px: .5, pt: .75 }}
            aria-label={localize(locale, "File sẽ gửi cùng tin nhắn đầu tiên", "Files for the first message")}>
            {files.map((file) => <Chip key={`${file.name}:${file.size}:${file.lastModified}`} size="small" variant="outlined"
              label={`${file.name} · ${formatSize(file.size)}`}
              onDelete={busy ? undefined : () => { setFiles((current) => current.filter((item) => item !== file)); setFileError(null); }}
              deleteIcon={<CancelRounded aria-label={`${localize(locale, "Bỏ", "Remove")} ${file.name}`} role="button" />} />)}
          </Stack>}
          <Stack direction="row" sx={{ mt: 1, alignItems: "center", gap: .75, flexWrap: "wrap" }}>
            <Button size="small" color="inherit" startIcon={<FolderOpenOutlined />} endIcon={<ExpandMoreRounded />} onClick={openMenu("project")}>
              {project?.label ?? localize(locale, "Chọn project", "Choose project")}</Button>
            <Button size="small" color="inherit" startIcon={<ModelTrainingOutlined />} endIcon={<ExpandMoreRounded />} onClick={openMenu("model")}>
              {model?.displayName ?? localize(locale, "Model mặc định", "Default model")}</Button>
            <Button size="small" color="inherit" startIcon={<TuneRounded />} endIcon={<ExpandMoreRounded />} onClick={openMenu("thinking")}>
              {label(thinking, locale)}</Button>
            <Tooltip title={localize(locale, "Thêm file vào tin nhắn đầu tiên", "Add files to the first message")}>
              <IconButton component="label" size="small" disabled={busy || files.length >= MAX_ATTACHMENTS}
                aria-label={`${localize(locale, "Thêm file", "Add files")} (${files.length}/${MAX_ATTACHMENTS})`}>
                <AttachFileRounded fontSize="small" />
                <input type="file" hidden multiple disabled={busy || files.length >= MAX_ATTACHMENTS} accept={supportedAttachmentAccept}
                  onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = ""; }} />
              </IconButton>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            <IconButton aria-label={localize(locale, "Gửi", "Send")} disabled={busy || failed || !project || !message.trim()} onClick={submit}
              sx={{ bgcolor: "primary.main", color: "primary.contrastText", "&:hover": { bgcolor: "primary.dark" }, "&.Mui-disabled": { bgcolor: "action.disabledBackground" } }}>
              <SendRounded fontSize="small" /></IconButton>
          </Stack></>}
        {(fileError || importError || error || failed) && <Typography role="status" color="error" variant="caption" sx={{ display: "block", px: .5, pt: 1 }}>
          {fileError ?? importError ?? error ?? localize(locale, "Không tải được lựa chọn", "Could not load choices")}</Typography>}
      </Box>
    </Stack>
    <Menu anchorEl={anchor} open={menu === "project"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 310, maxHeight: 380 } } }}>
      {(options?.projects ?? []).map((value) => <MenuItem key={value.projectRef} selected={projectRef === value.projectRef}
        onClick={() => { setProjectRef(value.projectRef); closeMenu(); }}><ListItemIcon><ServiceIcon name="folder" size={26} /></ListItemIcon>
        <ListItemText primary={value.label} /></MenuItem>)}
      <Divider /><MenuItem disabled={importing || options?.projectImport?.status !== "available"} onClick={() => void importFolder()}>
        <ListItemIcon><AddRounded /></ListItemIcon><ListItemText primary={importing ? localize(locale, "Đang chọn…", "Choosing…")
          : localize(locale, "Thêm một hoặc nhiều folder", "Add one or more folders")} /></MenuItem>
    </Menu>
    <Menu anchorEl={anchor} open={menu === "model"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 360, maxHeight: 440 } } }}>
      <MenuItem selected={!modelRef} onClick={() => { setModelRef(""); closeMenu(); }}>
        <ListItemIcon><ModelTrainingOutlined /></ListItemIcon><ListItemText primary={localize(locale, "Model mặc định của Pi", "Pi default model")} /></MenuItem>
      {(options?.models ?? []).map((value) => <MenuItem key={value.modelRef} selected={modelRef === value.modelRef}
        onClick={() => { setModelRef(value.modelRef); closeMenu(); }}><ListItemIcon><ServiceIcon name={value.provider} size={26} /></ListItemIcon>
        <ListItemText primary={value.displayName} secondary={value.provider} /></MenuItem>)}
    </Menu>
    <Menu anchorEl={anchor} open={menu === "thinking"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 250, maxHeight: 400 } } }}>
      {thinkingLevels.map((value) => <MenuItem value={value} key={value} selected={thinking === value}
        onClick={() => { setThinking(value); closeMenu(); }}><ListItemIcon><TuneRounded /></ListItemIcon>
        <ListItemText primary={label(value, locale)} /></MenuItem>)}
    </Menu>
  </Box>;
}
