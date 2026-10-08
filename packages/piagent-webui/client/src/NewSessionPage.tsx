import { companyAccessLabel, companyBypassDetail } from "./SessionComposerControls.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { sendsOnEnter } from "./enter-key.ts";
import AddRounded from "@mui/icons-material/AddRounded";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import AttachFileRounded from "@mui/icons-material/AttachFileRounded";
import CancelRounded from "@mui/icons-material/CancelRounded";
import BusinessRounded from "@mui/icons-material/BusinessRounded";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import ModelTrainingOutlined from "@mui/icons-material/ModelTrainingOutlined";
import SecurityRounded from "@mui/icons-material/SecurityRounded";
import TuneRounded from "@mui/icons-material/TuneRounded";
import SendRounded from "@mui/icons-material/SendRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { PermissionMode, Workflow } from "../../contracts/generated/session-command-v1.ts";
import { companyReason } from "./CompanyReconnect.tsx";
import { connectCompany, importProjectFolder, readCompanyStatus, readSessionCreationOptions, type CompanyStatus, type SessionCreationOptions, WebUiRequestError } from "./api.ts";
import { dragCarriesFiles, formatSize, MAX_ATTACHMENTS, supportedAttachmentAccept } from "./attachment-intake.ts";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { ActionConfirmationDialog } from "./ActionConfirmationDialog.tsx";
import { label } from "./view-model.ts";
import { useComposerSuggestions } from "./ComposerSuggestions.tsx";
import { NEW_CHAT_DRAFT, readComposerMemory, readDraft, writeComposerMemory, writeDraft } from "./composer-drafts.ts";
import { localize, type UiLocale, useUiPreferences } from "./ui-preferences.tsx";

type CreateValue = { projectRef: string; placeRef: string; modelRef: string | null; thinkingLevel: string; permissionMode: PermissionMode | null;
  workflow?: Workflow; message: string; files: readonly File[] };
type MenuKind = "project" | "model" | "thinking" | "permission" | null;
// Company sessions run in the company runtime behind this dashboard; while it
// is not connected the entry explains why and offers to connect.
const COMPANY_PROVIDER = "agent_watch_managed";
// Why a folder could not be added, in words the member can act on.
function importFailureText(code: string | null, status: number, locale: UiLocale): string {
  if (code === "native-project-picker-unavailable" || code === "project-import-picker-failed")
    return localize(locale, "Không mở được hộp chọn thư mục của máy. Thử lại; nếu vẫn lỗi, mở cuộc trò chuyện từ Terminal trong thư mục đó (pi hoặc piagent studio).",
      "The folder picker could not open. Try again; if it still fails, start a conversation from a Terminal in that folder (pi or piagent studio).");
  if (code === "project-import-folder-invalid")
    return localize(locale, "Không dùng được thư mục này: thư mục gốc của ổ đĩa hoặc một liên kết (symlink). Chọn thư mục thật của project.",
      "This folder cannot be used: a drive's root or a symbolic link. Choose the project's real folder.");
  if (status === 429) return localize(locale, "Thao tác quá nhanh. Đợi vài giây rồi thử lại.", "Too many attempts. Wait a few seconds and try again.");
  return localize(locale, "Không thể thêm thư mục. Thử lại; nếu vẫn lỗi, chạy piagent dashboard doctor.", "Could not add this folder. Try again; if it still fails, run piagent dashboard doctor.");
}

export function NewSessionPage({ active, defaultProjectRef, busy, error, onCancel, onCreate }: { active: boolean;
  defaultProjectRef?: string; busy: boolean; error: string | null; onCancel(): void; onCreate(value: CreateValue): Promise<void> | void }) {
  const { locale } = useUiPreferences();
  const [options, setOptions] = useState<SessionCreationOptions>();
  // undefined while loading; null on the company runtime's own page (no relay).
  const [companyStatus, setCompanyStatus] = useState<CompanyStatus | null | undefined>(undefined), [connecting, setConnecting] = useState(false);
  const managed = companyStatus === null && options?.models.length === 1 && options.models[0].provider === 'agent_watch_managed';
  const [failed, setFailed] = useState(false), [projectRef, setProjectRef] = useState(""), [modelRef, setModelRef] = useState("");
  const [thinking, setThinking] = useState("high");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null), [message, setMessageText] = useState(() => readDraft(NEW_CHAT_DRAFT));
  // Kept when the member opens a conversation and comes back (composer-drafts.ts).
  const setMessage = (value: string) => { setMessageText(value); writeDraft(NEW_CHAT_DRAFT, value); };
  const [pendingPermission, setPendingPermission] = useState<"trusted-full-access" | null>(null);
  const [files, setFiles] = useState<readonly File[]>(() => readComposerMemory<readonly File[]>(NEW_CHAT_DRAFT) ?? []), [fileError, setFileError] = useState<string | null>(null);
  useEffect(() => { writeComposerMemory(NEW_CHAT_DRAFT, files.length ? files : null); }, [files]);
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire again for every child the pointer crosses, so a
  // boolean set on leave clears the highlight while the file is still over the
  // composer. Counting entries against leaves tracks the region as a whole.
  const dragDepth = useRef(0);
  const [menu, setMenu] = useState<MenuKind>(null), [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    // The message and files the member left here stay (composer-drafts.ts).
    const controller = new AbortController(); setOptions(undefined); setFailed(false); setImportError(null); setFileError(null); setDragging(false); setAdvancedOpen(false); dragDepth.current = 0;
    void readSessionCreationOptions(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setOptions(value);
      setProjectRef(value.projects.some((project) => project.projectRef === defaultProjectRef)
        ? defaultProjectRef! : value.projects[0]?.projectRef ?? "");
      setModelRef(value.defaultModelRef ?? ""); setThinking(value.defaultThinkingLevel ?? "high"); setPermissionMode(null);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    setCompanyStatus(undefined);
    void readCompanyStatus(controller.signal).then((value) => { if (!controller.signal.aborted) setCompanyStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setCompanyStatus(null); });
    return () => controller.abort();
  }, [active, defaultProjectRef]);
  useEffect(() => {
    if (!active) return;
    // A file dropped anywhere the composer does not cover is navigated to by the
    // browser, which replaces the Gateway with the file.
    const block = (event: DragEvent) => { if (dragCarriesFiles(event.dataTransfer)) event.preventDefault(); };
    window.addEventListener("dragover", block); window.addEventListener("drop", block);
    return () => { window.removeEventListener("dragover", block); window.removeEventListener("drop", block); };
  }, [active]);
  const project = options?.projects.find((value) => value.projectRef === projectRef);
  const mentions = useComposerSuggestions({ projectRef: project?.projectRef, value: message, onChange: setMessage, locale });
  const model = options?.models.find((value) => value.modelRef === modelRef);
  const company = !managed && model?.provider === COMPANY_PROVIDER;
  const companyModels = managed ? [] : options?.models.filter((value) => value.provider === COMPANY_PROVIDER) ?? [];
  const personalModels = managed ? options?.models ?? [] : options?.models.filter((value) => value.provider !== COMPANY_PROVIDER) ?? [];
  const connect = async () => {
    setConnecting(true);
    try {
      const status = await connectCompany().catch(() => null);
      const next = await readSessionCreationOptions();
      setOptions(next); setCompanyStatus(status ?? await readCompanyStatus().catch(() => null));
      const entry = next.models.find((value) => value.provider === COMPANY_PROVIDER);
      if (entry) { setModelRef(entry.modelRef); closeMenu(); }
    } catch { setFailed(true); } finally { setConnecting(false); }
  };
  const defaultModel = options?.models.find((value) => value.modelRef === options.defaultModelRef);
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
      else setImportError(importFailureText(cause instanceof WebUiRequestError ? cause.code : null, cause instanceof WebUiRequestError ? cause.status : 0, locale));
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
  const canAttach = !busy && !failed && files.length < MAX_ATTACHMENTS;
  // One conversation per send: a second Enter or click while the first is
  // being created (before `busy` reaches this page) is ignored.
  const creating = useRef(false);
  const submit = () => {
    if (creating.current || busy || !project || !message.trim()) return;
    creating.current = true;
    void Promise.resolve(onCreate({ projectRef, placeRef: project.placeRef, modelRef: modelRef || null,
      thinkingLevel: thinking, permissionMode, message, files })).finally(() => { creating.current = false; });
  };

  return <Box sx={{ minHeight: "calc(100vh - 68px)", display: "flex", flexDirection: "column" }}>
    <Box sx={{ p: { xs: 1.5, sm: 2 } }}><IconButton aria-label={localize(locale, "Quay lại", "Back")} onClick={onCancel}><ArrowBackRounded /></IconButton></Box>
    <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", px: 2, pb: { xs: 5, md: 12 } }} spacing={4}>
      <Typography component="h1" sx={{ fontSize: { xs: "2rem", md: "2.45rem" }, fontWeight: 500, letterSpacing: "-.035em", textAlign: "center" }}>
        {localize(locale, "Hôm nay làm gì?", "What should we work on?")}
      </Typography>
      <Box sx={{ position: "relative", width: "100%", maxWidth: 820, border: 1, borderColor: dragging ? "primary.main" : "divider",
        borderStyle: dragging ? "dashed" : "solid", borderRadius: 3.5, bgcolor: "background.paper",
        p: 1.25, boxShadow: "0 18px 55px rgba(0,0,0,.13)" }}
      onDragEnter={(event) => { if (dragCarriesFiles(event.dataTransfer)) { dragDepth.current += 1; setDragging(true); } }}
      onDragOver={(event) => { if (dragCarriesFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? "copy" : "none"; } }}
      onDragLeave={(event) => { if (dragCarriesFiles(event.dataTransfer)) { dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } } }}
      onDrop={(event) => {
        if (!dragCarriesFiles(event.dataTransfer)) return;
        event.preventDefault(); dragDepth.current = 0; setDragging(false);
        if (canAttach) selectFiles(event.dataTransfer.files);
      }}>
        {dragging && <Box role="status" sx={{ position: "absolute", inset: 0, zIndex: 3, display: "grid", alignContent: "center",
          justifyItems: "center", gap: .5, borderRadius: 3.5, bgcolor: "background.paper", opacity: .96, pointerEvents: "none", textAlign: "center" }}>
          <Typography sx={{ fontWeight: 750 }}>{canAttach ? localize(locale, "Thả tài liệu vào đây", "Drop documents here")
            : files.length >= MAX_ATTACHMENTS ? localize(locale, `Đã đủ ${MAX_ATTACHMENTS} file cho tin nhắn đầu tiên`, `The first message already holds ${MAX_ATTACHMENTS} files`)
              : localize(locale, "Chưa nhận file lúc này", "Files cannot be attached right now")}</Typography>
          {canAttach && <Typography variant="caption" color="text.secondary">
            {localize(locale, ".md .txt .csv .json .yaml .docx .pdf và ảnh", ".md .txt .csv .json .yaml .docx .pdf and images")}</Typography>}
        </Box>}
        {!options && !failed ? <Stack direction="row" spacing={1.5} sx={{ minHeight: 126, alignItems: "center", justifyContent: "center" }}>
          <CircularProgress size={20} /><Typography color="text.secondary">{localize(locale, "Đang mở…", "Opening…")}</Typography></Stack>
          : <><TextField autoFocus fullWidth multiline minRows={3} maxRows={8} value={message} disabled={busy || failed}
            inputRef={mentions.inputRef} {...mentions.inputProps}
            onChange={(event) => { setMessage(event.target.value); mentions.track(event); }} onKeyDown={(event) => {
              if (mentions.onKeyDown(event)) return;
              if (sendsOnEnter(event)) { event.preventDefault(); submit(); }
            }} onPaste={(event) => {
              if (!event.clipboardData?.files.length) return;
              event.preventDefault();
              if (canAttach) selectFiles(event.clipboardData.files);
            }} placeholder={localize(locale, "Nhắn cho Piagent… (@ để chọn file, folder)", "Message Piagent… (@ for files and folders)")} variant="standard"
            slotProps={{ input: { disableUnderline: true }, htmlInput: { maxLength: 32_768, ...mentions.htmlInput } }} sx={{ px: .5 }} />
          {mentions.menu}
          {files.length > 0 && <Stack direction="row" sx={{ flexWrap: "wrap", gap: .75, px: .5, pt: .75 }}
            aria-label={localize(locale, "File sẽ gửi cùng tin nhắn đầu tiên", "Files for the first message")}>
            {files.map((file) => <Chip key={`${file.name}:${file.size}:${file.lastModified}`} size="small" variant="outlined"
              label={`${file.name} · ${formatSize(file.size)}`}
              onDelete={busy ? undefined : () => { setFiles((current) => current.filter((item) => item !== file)); setFileError(null); }}
              deleteIcon={<CancelRounded aria-label={`${localize(locale, "Bỏ", "Remove")} ${file.name}`} role="button" />} />)}
          </Stack>}
          <Collapse in={advancedOpen} id="piagent-new-session-options">
            <Box sx={{ mx: .35, mt: 1, px: 1.1, py: 1, borderRadius: 2, bgcolor: "action.hover" }}>
              <Typography variant="caption" sx={{ display: "block", mb: .75, fontWeight: 750 }}>
                {localize(locale, "Tùy chọn cho tin nhắn đầu tiên", "Options for the first message")}
              </Typography>
              <Stack direction="row" sx={{ alignItems: "center", gap: .75, flexWrap: "wrap" }}>
                <Button size="small" color="inherit" startIcon={<TuneRounded />} endIcon={<ExpandMoreRounded />} onClick={openMenu("thinking")}>
                  {label(thinking, locale)}</Button>
                <Button size="small" color="inherit" startIcon={<SecurityRounded />} endIcon={<ExpandMoreRounded />} onClick={openMenu("permission")}>
                  {managed || company ? companyAccessLabel(permissionMode, locale) : permissionMode ? label(permissionMode, locale) : localize(locale, "Quyền theo profile", "Profile access")}</Button>
                <Button component="label" size="small" color="inherit" startIcon={<AttachFileRounded />} disabled={!canAttach}
                  aria-label={`${localize(locale, "Thêm file", "Add files")} (${files.length}/${MAX_ATTACHMENTS})`}>
                  {localize(locale, "Đính kèm", "Attach")}
                  <input type="file" hidden multiple disabled={!canAttach} accept={supportedAttachmentAccept}
                    onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = ""; }} />
                </Button>
              </Stack>
              {company && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .75 }}>
                {localize(locale, "Model và quyền theo Harness công ty; thinking chọn ở đây.", "Models and access follow the company Harness; choose thinking here.")}
              </Typography>}

            </Box>
          </Collapse>
          <Stack direction="row" sx={{ mt: 1, alignItems: "center", gap: .65, flexWrap: "nowrap", minWidth: 0 }}>
            <Tooltip title={advancedOpen ? localize(locale, "Ẩn tùy chọn", "Hide options") : localize(locale, "Thêm tùy chọn", "More options")}>
              <IconButton size="small" aria-label={advancedOpen ? localize(locale, "Ẩn tùy chọn", "Hide options") : localize(locale, "Thêm tùy chọn", "More options")}
                aria-expanded={advancedOpen} aria-controls="piagent-new-session-options" onClick={() => setAdvancedOpen((value) => !value)}
                sx={{ flex: "0 0 auto", bgcolor: advancedOpen ? "action.selected" : "transparent" }}>
                <AddRounded fontSize="small" sx={{ transition: "transform .16s ease", transform: advancedOpen ? "rotate(45deg)" : "none" }} />
              </IconButton>
            </Tooltip>
            <Button size="small" color="inherit" startIcon={<FolderOpenOutlined />} endIcon={<ExpandMoreRounded />} onClick={openMenu("project")}
              aria-label={`${localize(locale, "Project", "Project")}: ${project?.label ?? localize(locale, "Chọn project", "Choose project")}`}
              sx={{ minWidth: 0, maxWidth: { xs: 118, sm: 250 }, px: { xs: .75, sm: 1 }, "& .MuiButton-startIcon": { display: { xs: "none", sm: "inherit" } } }}>
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {project?.label ?? localize(locale, "Chọn project", "Choose project")}</Box></Button>
            <Button size="small" color="inherit" startIcon={company ? <BusinessRounded /> : <ModelTrainingOutlined />} endIcon={<ExpandMoreRounded />} onClick={openMenu("model")}
              aria-label={`${localize(locale, "Model", "Model")}: ${company ? localize(locale, "Công ty · agent-watch-auto", "Company · agent-watch-auto") : model?.displayName ?? defaultModel?.displayName ?? localize(locale, "Mặc định của Pi", "Pi default")}`}
              sx={{ minWidth: 0, maxWidth: { xs: 142, sm: 250 }, px: { xs: .75, sm: 1 }, "& .MuiButton-startIcon": { display: { xs: "none", sm: "inherit" } } }}>
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {company ? localize(locale, "Công ty · agent-watch-auto", "Company · agent-watch-auto") : model ? `${model.displayName}${model.modelRef === options?.defaultModelRef ? localize(locale, " · mặc định", " · default") : ""}`
                  : defaultModel?.displayName ?? localize(locale, "Mặc định của Pi", "Pi default")}</Box></Button>
            <Box sx={{ flex: 1, minWidth: 0 }} />
            <IconButton aria-label={localize(locale, "Gửi", "Send")} disabled={busy || failed || !project || !message.trim()} onClick={submit}
              sx={{ flex: "0 0 auto",
                bgcolor: "primary.main", color: "primary.contrastText", "&:hover": { bgcolor: "primary.dark" }, "&.Mui-disabled": { bgcolor: "action.disabledBackground" } }}>
              <SendRounded fontSize="small" /></IconButton>
          </Stack></>}
        {(fileError || importError || error || failed) && <Typography role="status" color="error" variant="caption" sx={{ display: "block", px: .5, pt: 1 }}>
          {fileError ?? importError ?? error ?? localize(locale, "Không tải được lựa chọn", "Could not load choices")}</Typography>}
      </Box>
    </Stack>
    <Menu anchorEl={anchor} open={menu === "project"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 310, maxHeight: 380 } } }}>
      {(options?.projects ?? []).map((value) => <MenuItem key={value.projectRef} selected={projectRef === value.projectRef}
        onClick={() => { setProjectRef(value.projectRef); closeMenu(); }}><ListItemIcon><ServiceIcon name="folder" size={26} /></ListItemIcon>
        <ListItemText primary={value.label} secondary={value.hint} slotProps={{ secondary: { noWrap: true, title: value.hint } }} /></MenuItem>)}
      <Divider /><MenuItem disabled={importing || options?.projectImport?.status !== "available"} onClick={() => void importFolder()}>
        <ListItemIcon><AddRounded /></ListItemIcon><ListItemText primary={importing ? localize(locale, "Đang chọn…", "Choosing…")
          : localize(locale, "Thêm một hoặc nhiều folder", "Add one or more folders")} /></MenuItem>
    </Menu>
    <Menu anchorEl={anchor} open={menu === "model"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 360, maxHeight: 440 } } }}>
      {!managed && (companyModels.length > 0 || companyStatus?.available) && [
        <ListSubheader key="company-heading">{localize(locale, "Công ty", "Company")}</ListSubheader>,
        ...(companyModels.length ? companyModels.map((value) => <MenuItem key={value.modelRef} selected={modelRef === value.modelRef}
          onClick={() => { setModelRef(value.modelRef); closeMenu(); }}><ListItemIcon><BusinessRounded /></ListItemIcon>
          <ListItemText primary="agent-watch-auto" secondary={localize(locale, "Harness công ty · Studio quản lý model", "Company Harness · models managed by Studio")} /></MenuItem>)
          : [<MenuItem key="company-connect" disabled={connecting} onClick={() => void connect()}><ListItemIcon>{connecting
            ? <CircularProgress size={20} /> : <BusinessRounded />}</ListItemIcon>
            <ListItemText primary="agent-watch-auto" secondary={connecting ? localize(locale, "Đang kết nối…", "Connecting…") : companyReason(companyStatus, locale)}
              slotProps={{ secondary: { sx: { whiteSpace: "normal" } } }} /></MenuItem>]),
        <ListSubheader key="personal-heading">{localize(locale, "Cá nhân", "Personal")}</ListSubheader>]}
      {!options?.defaultModelRef && <MenuItem selected={!modelRef} onClick={() => { setModelRef(""); closeMenu(); }}>
        <ListItemIcon><ModelTrainingOutlined /></ListItemIcon><ListItemText primary={localize(locale, "Model mặc định của Pi", "Pi default model")} /></MenuItem>}
      {personalModels.map((value) => <MenuItem key={value.modelRef} selected={modelRef === value.modelRef}
        onClick={() => { setModelRef(value.modelRef); closeMenu(); }}><ListItemIcon><ServiceIcon name={value.provider} size={26} /></ListItemIcon>
        <ListItemText primary={value.displayName} secondary={value.modelRef === options?.defaultModelRef
          ? localize(locale, `Mặc định · ${value.provider} · High`, `Default · ${value.provider} · High`) : value.provider} /></MenuItem>)}
    </Menu>
    <Menu anchorEl={anchor} open={menu === "thinking"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 250, maxHeight: 400 } } }}>
      {thinkingLevels.map((value) => <MenuItem value={value} key={value} selected={thinking === value}
        onClick={() => { setThinking(value); closeMenu(); }}><ListItemIcon><TuneRounded /></ListItemIcon>
        <ListItemText primary={label(value, locale)} /></MenuItem>)}
    </Menu>
    <Menu anchorEl={anchor} open={menu === "permission"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 310 } } }}>
      {managed || company ? [<MenuItem key="ask" selected={permissionMode !== "trusted-full-access"} onClick={() => { setPermissionMode(null); closeMenu(); }}>
          <ListItemIcon><SecurityRounded /></ListItemIcon><ListItemText primary={companyAccessLabel(null, locale)}
            secondary={localize(locale, "Hỏi trước mỗi lệnh cần internet", "Asks before each command that needs the internet")} /></MenuItem>,
        <MenuItem key="bypass" selected={permissionMode === "trusted-full-access"} onClick={() => { closeMenu(); setPendingPermission("trusted-full-access"); }}>
          <ListItemIcon><SecurityRounded color="warning" /></ListItemIcon><ListItemText primary="Bypass"
            secondary={localize(locale, "Chỉ hỏi việc bắt buộc phải xác nhận", "Asks only what must be confirmed")} /></MenuItem>] : <>
      <MenuItem selected={permissionMode === null} onClick={() => { setPermissionMode(null); closeMenu(); }}><ListItemIcon><SecurityRounded /></ListItemIcon>
        <ListItemText primary={localize(locale, "Theo profile project", "Project profile default")} /></MenuItem>
      {(["read-only", "workspace-write", "trusted-full-access"] as const).map((value) => <MenuItem key={value} selected={permissionMode === value}
        onClick={() => { closeMenu(); if (value === "trusted-full-access") setPendingPermission(value); else setPermissionMode(value); }}>
        <ListItemIcon><SecurityRounded /></ListItemIcon><ListItemText primary={label(value, locale)} /></MenuItem>)}</>}
    </Menu>
    <ActionConfirmationDialog open={pendingPermission !== null} title={managed || company ? localize(locale, "Tạo cuộc trò chuyện với Bypass?", "Create with Bypass?") : localize(locale, "Tạo session với toàn quyền?", "Create with full access?")}
      description={managed || company ? companyBypassDetail(locale) : localize(locale, "Session mới được phép đọc, sửa file và chạy command trong runtime. Xóa dữ liệu và gửi ra ngoài vẫn cần xác nhận riêng.",
        "The new session may read and edit files and run commands. Deletion and external transfer still require separate approval.")}
      cancelLabel={localize(locale, "Hủy", "Cancel")} confirmLabel={managed || company ? localize(locale, "Dùng Bypass", "Use Bypass") : localize(locale, "Dùng toàn quyền", "Use full access")}
      onCancel={() => setPendingPermission(null)} onConfirm={() => { setPendingPermission(null); setPermissionMode("trusted-full-access"); }} />
  </Box>;
}
