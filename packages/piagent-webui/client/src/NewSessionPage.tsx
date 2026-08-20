import { useEffect, useMemo, useRef, useState } from "react";
import AddRounded from "@mui/icons-material/AddRounded";
import AccountTreeRounded from "@mui/icons-material/AccountTreeRounded";
import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import AttachFileRounded from "@mui/icons-material/AttachFileRounded";
import CancelRounded from "@mui/icons-material/CancelRounded";
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
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { PermissionMode, Workflow } from "../../contracts/generated/session-command-v1.ts";
import { importProjectFolder, readSessionCreationOptions, type SessionCreationOptions, WebUiRequestError } from "./api.ts";
import { dragCarriesFiles, formatSize, MAX_ATTACHMENTS, supportedAttachmentAccept } from "./attachment-intake.ts";
import { ServiceIcon } from "./ServiceIcon.tsx";
import { ActionConfirmationDialog } from "./ActionConfirmationDialog.tsx";
import { label } from "./view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

type CreateValue = { projectRef: string; placeRef: string; modelRef: string | null; thinkingLevel: string; permissionMode: PermissionMode | null;
  workflow: Workflow; message: string; files: readonly File[] };
type MenuKind = "project" | "model" | "thinking" | "workflow" | "permission" | null;

const FALLBACK_WORKFLOWS: Array<{ id: Workflow; changeMode: "source-change" | "read-only" | "plan-only" | "clarification" | "git" | "onboarding" | "platform";
  modelUse: "required"; recommendedFreshSession: boolean }> = [
  { id: "task", changeMode: "source-change", modelUse: "required", recommendedFreshSession: true },
  { id: "scout", changeMode: "read-only", modelUse: "required", recommendedFreshSession: true },
  { id: "be-to-fe", changeMode: "source-change", modelUse: "required", recommendedFreshSession: true },
  { id: "discuss", changeMode: "clarification", modelUse: "required", recommendedFreshSession: false },
  { id: "plan", changeMode: "plan-only", modelUse: "required", recommendedFreshSession: false },
  { id: "review", changeMode: "read-only", modelUse: "required", recommendedFreshSession: false },
  { id: "commit", changeMode: "git", modelUse: "required", recommendedFreshSession: false },
  { id: "pr", changeMode: "git", modelUse: "required", recommendedFreshSession: false },
  { id: "onboard", changeMode: "onboarding", modelUse: "required", recommendedFreshSession: true },
  { id: "platform-improve", changeMode: "platform", modelUse: "required", recommendedFreshSession: true }
];

function workflowCopy(value: Workflow, locale: "vi" | "en"): [string, string] {
  const copy: Record<Workflow, [string, string]> = {
    task: ["Thực hiện task", "Implement task"], scout: ["Khảo sát chỉ đọc", "Read-only scout"],
    "be-to-fe": ["Backend → Frontend", "Backend → Frontend"], discuss: ["Làm rõ ý tưởng", "Clarify idea"],
    plan: ["Lập kế hoạch", "Plan"], review: ["Review thay đổi", "Review changes"], commit: ["Chuẩn bị commit", "Prepare commit"],
    pr: ["Chuẩn bị pull request", "Prepare pull request"], onboard: ["Onboard project", "Onboard project"],
    "platform-improve": ["Cải tiến Piagent", "Improve Piagent"]
  };
  const selected = copy[value];
  return [selected[locale === "vi" ? 0 : 1], value];
}

export function NewSessionPage({ active, defaultProjectRef, busy, error, onCancel, onCreate }: { active: boolean;
  defaultProjectRef?: string; busy: boolean; error: string | null; onCancel(): void; onCreate(value: CreateValue): void }) {
  const { locale } = useUiPreferences();
  const [options, setOptions] = useState<SessionCreationOptions>();
  const [failed, setFailed] = useState(false), [projectRef, setProjectRef] = useState(""), [modelRef, setModelRef] = useState("");
  const [thinking, setThinking] = useState("high"), [workflow, setWorkflow] = useState<Workflow>("task");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null), [message, setMessage] = useState("");
  const [pendingPermission, setPendingPermission] = useState<"trusted-full-access" | null>(null);
  const [files, setFiles] = useState<readonly File[]>([]), [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire again for every child the pointer crosses, so a
  // boolean set on leave clears the highlight while the file is still over the
  // composer. Counting entries against leaves tracks the region as a whole.
  const dragDepth = useRef(0);
  const [menu, setMenu] = useState<MenuKind>(null), [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [importing, setImporting] = useState(false), [importError, setImportError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setOptions(undefined); setFailed(false); setMessage(""); setImportError(null); setFiles([]); setFileError(null); setDragging(false); setAdvancedOpen(false); dragDepth.current = 0;
    void readSessionCreationOptions(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setOptions(value);
      setProjectRef(value.projects.some((project) => project.projectRef === defaultProjectRef)
        ? defaultProjectRef! : value.projects[0]?.projectRef ?? "");
      setModelRef(value.defaultModelRef ?? ""); setThinking(value.defaultThinkingLevel ?? "high"); setWorkflow("task"); setPermissionMode(null);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
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
  const model = options?.models.find((value) => value.modelRef === modelRef);
  const defaultModel = options?.models.find((value) => value.modelRef === options.defaultModelRef);
  const workflows = options?.workflows?.length ? options.workflows : FALLBACK_WORKFLOWS;
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
  const canAttach = !busy && !failed && files.length < MAX_ATTACHMENTS;
  const submit = () => project && message.trim() && onCreate({ projectRef, placeRef: project.placeRef, modelRef: modelRef || null,
    thinkingLevel: thinking, permissionMode, workflow, message: message.trim(), files });

  return <Box sx={{ minHeight: "calc(100vh - 68px)", display: "flex", flexDirection: "column" }}>
    <Box sx={{ p: { xs: 1.5, sm: 2 } }}><IconButton aria-label={localize(locale, "Quay lại", "Back")} onClick={onCancel}><ArrowBackRounded /></IconButton></Box>
    <Stack sx={{ flex: 1, alignItems: "center", justifyContent: "center", px: 2, pb: { xs: 5, md: 12 } }} spacing={4}>
      <Typography component="h1" sx={{ fontSize: { xs: "2rem", md: "2.45rem" }, fontWeight: 500, letterSpacing: "-.035em", textAlign: "center" }}>
        {localize(locale, "Anh muốn làm gì?", "What should we work on?")}
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
            onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
            }} onPaste={(event) => {
              if (!event.clipboardData?.files.length) return;
              event.preventDefault();
              if (canAttach) selectFiles(event.clipboardData.files);
            }} placeholder={localize(locale, "Nhắn cho Piagent…", "Message Piagent…")} variant="standard"
            slotProps={{ input: { disableUnderline: true }, htmlInput: { maxLength: 32_768 } }} sx={{ px: .5 }} />
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
                <Button size="small" color="inherit" startIcon={<AccountTreeRounded />} endIcon={<ExpandMoreRounded />} onClick={openMenu("workflow")}>
                  {workflowCopy(workflow, locale)[0]}</Button>
                <Button size="small" color="inherit" startIcon={<TuneRounded />} endIcon={<ExpandMoreRounded />} onClick={openMenu("thinking")}>
                  {label(thinking, locale)}</Button>
                <Button size="small" color="inherit" startIcon={<SecurityRounded />} endIcon={<ExpandMoreRounded />} onClick={openMenu("permission")}>
                  {permissionMode ? label(permissionMode, locale) : localize(locale, "Quyền theo profile", "Profile access")}</Button>
                <Button component="label" size="small" color="inherit" startIcon={<AttachFileRounded />} disabled={!canAttach}
                  aria-label={`${localize(locale, "Thêm file", "Add files")} (${files.length}/${MAX_ATTACHMENTS})`}>
                  {localize(locale, "Đính kèm", "Attach")}
                  <input type="file" hidden multiple disabled={!canAttach} accept={supportedAttachmentAccept}
                    onChange={(event) => { selectFiles(event.target.files); event.currentTarget.value = ""; }} />
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: .75 }}>
                {localize(locale,
                  `Workflow “${workflowCopy(workflow, locale)[0]}” chỉ áp dụng cho tin nhắn đầu tiên. Trong session này anh vẫn có thể gửi việc khác hoặc chọn workflow khác ở từng tin nhắn.`,
                  `“${workflowCopy(workflow, locale)[0]}” applies only to the first message. You can send different work or choose another workflow for any later message in this session.`)}
              </Typography>
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
            <Button size="small" color="inherit" startIcon={<ModelTrainingOutlined />} endIcon={<ExpandMoreRounded />} onClick={openMenu("model")}
              aria-label={`${localize(locale, "Model", "Model")}: ${model?.displayName ?? defaultModel?.displayName ?? localize(locale, "Mặc định của Pi", "Pi default")}`}
              sx={{ minWidth: 0, maxWidth: { xs: 142, sm: 250 }, px: { xs: .75, sm: 1 }, "& .MuiButton-startIcon": { display: { xs: "none", sm: "inherit" } } }}>
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {model ? `${model.displayName}${model.modelRef === options?.defaultModelRef ? localize(locale, " · mặc định", " · default") : ""}`
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
        <ListItemText primary={value.label} /></MenuItem>)}
      <Divider /><MenuItem disabled={importing || options?.projectImport?.status !== "available"} onClick={() => void importFolder()}>
        <ListItemIcon><AddRounded /></ListItemIcon><ListItemText primary={importing ? localize(locale, "Đang chọn…", "Choosing…")
          : localize(locale, "Thêm một hoặc nhiều folder", "Add one or more folders")} /></MenuItem>
    </Menu>
    <Menu anchorEl={anchor} open={menu === "model"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 360, maxHeight: 440 } } }}>
      {!options?.defaultModelRef && <MenuItem selected={!modelRef} onClick={() => { setModelRef(""); closeMenu(); }}>
        <ListItemIcon><ModelTrainingOutlined /></ListItemIcon><ListItemText primary={localize(locale, "Model mặc định của Pi", "Pi default model")} /></MenuItem>}
      {(options?.models ?? []).map((value) => <MenuItem key={value.modelRef} selected={modelRef === value.modelRef}
        onClick={() => { setModelRef(value.modelRef); closeMenu(); }}><ListItemIcon><ServiceIcon name={value.provider} size={26} /></ListItemIcon>
        <ListItemText primary={value.displayName} secondary={value.modelRef === options?.defaultModelRef
          ? localize(locale, `Mặc định · ${value.provider} · High`, `Default · ${value.provider} · High`) : value.provider} /></MenuItem>)}
    </Menu>
    <Menu anchorEl={anchor} open={menu === "workflow"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 360, maxHeight: 470 } } }}>
      {workflows.map((value) => <MenuItem key={value.id} selected={workflow === value.id}
        onClick={() => { setWorkflow(value.id); closeMenu(); }}><ListItemIcon><AccountTreeRounded /></ListItemIcon>
        <ListItemText primary={workflowCopy(value.id, locale)[0]} secondary={`${label(value.changeMode, locale)} · ${localize(locale,
          "chỉ cho tin nhắn này", "this message only")}`} /></MenuItem>)}
    </Menu>
    <Menu anchorEl={anchor} open={menu === "thinking"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 250, maxHeight: 400 } } }}>
      {thinkingLevels.map((value) => <MenuItem value={value} key={value} selected={thinking === value}
        onClick={() => { setThinking(value); closeMenu(); }}><ListItemIcon><TuneRounded /></ListItemIcon>
        <ListItemText primary={label(value, locale)} /></MenuItem>)}
    </Menu>
    <Menu anchorEl={anchor} open={menu === "permission"} onClose={closeMenu} slotProps={{ paper: { sx: { width: 310 } } }}>
      <MenuItem selected={permissionMode === null} onClick={() => { setPermissionMode(null); closeMenu(); }}><ListItemIcon><SecurityRounded /></ListItemIcon>
        <ListItemText primary={localize(locale, "Theo profile project", "Project profile default")} /></MenuItem>
      {(["read-only", "workspace-write", "trusted-full-access"] as const).map((value) => <MenuItem key={value} selected={permissionMode === value}
        onClick={() => { closeMenu(); if (value === "trusted-full-access") setPendingPermission(value); else setPermissionMode(value); }}>
        <ListItemIcon><SecurityRounded /></ListItemIcon><ListItemText primary={label(value, locale)} /></MenuItem>)}
    </Menu>
    <ActionConfirmationDialog open={pendingPermission !== null} title={localize(locale, "Tạo session với toàn quyền?", "Create with full access?")}
      description={localize(locale, "Session mới được phép đọc, sửa file và chạy command trong runtime. Xóa dữ liệu và gửi ra ngoài vẫn cần xác nhận riêng.",
        "The new session may read and edit files and run commands. Deletion and external transfer still require separate approval.")}
      cancelLabel={localize(locale, "Hủy", "Cancel")} confirmLabel={localize(locale, "Dùng toàn quyền", "Use full access")}
      onCancel={() => setPendingPermission(null)} onConfirm={() => { setPendingPermission(null); setPermissionMode("trusted-full-access"); }} />
  </Box>;
}
