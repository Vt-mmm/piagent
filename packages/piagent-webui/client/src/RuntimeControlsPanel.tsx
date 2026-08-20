import { useEffect, useMemo, useState } from "react";
import CheckCircleOutlineRounded from "@mui/icons-material/CheckCircleOutlineRounded";
import DataObjectRounded from "@mui/icons-material/DataObjectRounded";
import HubRounded from "@mui/icons-material/HubRounded";
import MemoryRounded from "@mui/icons-material/MemoryRounded";
import PersonSearchRounded from "@mui/icons-material/PersonSearchRounded";
import QueryStatsRounded from "@mui/icons-material/QueryStatsRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import type { Action, Receipt } from "../../contracts/generated/runtime-command-v1.ts";
import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { executeRuntimeCommand, type SessionConnections, type SessionCreationOptions } from "./api.ts";
import { ActionConfirmationDialog } from "./ActionConfirmationDialog.tsx";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

type Pending = { action: Action; argument: string | null; title: string; description: string };

function ControlGroup({ icon, title, detail, children }: { icon: React.ReactNode; title: string; detail: string; children: React.ReactNode }) {
  return <Paper variant="outlined" sx={{ p: 2, borderRadius: 2.5 }}><Stack direction="row" spacing={1.25} sx={{ alignItems: "flex-start", mb: 1.5 }}>
    <Box sx={{ width: 38, height: 38, borderRadius: 2, bgcolor: "action.selected", display: "grid", placeItems: "center", flex: "0 0 auto" }}>{icon}</Box>
    <Box><Typography sx={{ fontWeight: 820 }}>{title}</Typography><Typography variant="body2" color="text.secondary">{detail}</Typography></Box>
  </Stack>{children}</Paper>;
}

function ControlButtons({ children }: { children: React.ReactNode }) {
  return <Stack direction="row" sx={{ gap: .75, flexWrap: "wrap" }}>{children}</Stack>;
}

export function RuntimeControlsPanel({ session, options, connections, onCompleted }: { session?: SessionRow; options?: SessionCreationOptions;
  connections?: SessionConnections; onCompleted?(): Promise<void> | void }) {
  const { locale } = useUiPreferences();
  const [busy, setBusy] = useState(false), [receipt, setReceipt] = useState<Receipt>(), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(session?.sessionRevision ?? ""), [pending, setPending] = useState<Pending | null>(null);
  const [profile, setProfile] = useState(""), [contextQuery, setContextQuery] = useState(""), [preflight, setPreflight] = useState("");
  const [connection, setConnection] = useState("");
  useEffect(() => { setRevision(session?.sessionRevision ?? ""); setReceipt(undefined); setError(null); }, [session?.sessionRef]);
  useEffect(() => { if (session?.sessionRevision) setRevision(session.sessionRevision); }, [session?.sessionRevision]);
  const disabled = busy || !session || !revision || session.liveState === "running" || session.liveState === "waiting-approval";
  const profileOptions = options?.profiles ?? [];
  const connectionOptions = useMemo(() => (connections?.connections ?? []).filter((item) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(item.name)), [connections]);

  const run = async (action: Action, argument: string | null = null, confirmed = false) => {
    if (!session || !revision) return;
    setBusy(true); setError(null);
    try {
      const value = await executeRuntimeCommand({ schemaVersion: 1, version: "piagent-runtime-command-v1", messageType: "command",
        requestId: `runtime_${crypto.randomUUID().replaceAll("-", "_")}`, sessionRef: session.sessionRef,
        expectedSessionRevision: revision, action, argument, confirmed });
      setReceipt(value);
      if (value.sessionRevisionAfter) setRevision(value.sessionRevisionAfter);
      if (value.state !== "settled") setError(value.reasonCode ?? value.resultCode);
      await onCompleted?.();
    } catch {
      setError(localize(locale, "Gateway chưa thể chạy điều khiển này.", "The Gateway could not run this control."));
    } finally { setBusy(false); }
  };
  const confirm = (action: Action, argument: string | null, title: string, description: string) => setPending({ action, argument, title, description });
  const small = { size: "small" as const, variant: "outlined" as const, disabled };

  return <><Typography component="h1" variant="h1" sx={{ mb: .75 }}>{localize(locale, "Điều khiển project", "Project controls")}</Typography>
    <Typography color="text.secondary" sx={{ mb: 2.5 }}>{localize(locale,
      "Cùng logic với Terminal: Web UI gửi đúng slash command vào Pi runtime. Các nút xem trạng thái không gọi model; thao tác ghi luôn hỏi xác nhận.",
      "The same logic as Terminal: Web UI sends the exact slash command to the Pi runtime. Status controls do not call the model; writes always require confirmation.")}</Typography>
    {!session && <Paper variant="outlined" sx={{ p: 2, borderRadius: 2.5, mb: 2 }}><Typography color="text.secondary">{localize(locale,
      "Hãy chọn một cuộc trò chuyện để điều khiển project tương ứng.", "Select a chat to control its project.")}</Typography></Paper>}
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "repeat(2,minmax(0,1fr))" }, gap: 1.25 }}>
      <ControlGroup icon={<QueryStatsRounded color="primary" />} title={localize(locale, "Runtime & token", "Runtime & tokens")}
        detail={localize(locale, "Tình trạng, inspector, lịch sử usage và preflight — 0 model token.", "Status, inspector, usage history and preflight — zero model tokens.")}>
        <ControlButtons><Button {...small} onClick={() => void run("runtime.status")}>Pi status</Button><Button {...small} onClick={() => void run("runtime.inspector")}>Inspector</Button>
          <Button {...small} onClick={() => void run("orchestration.status")}>Orchestration</Button><Button {...small} onClick={() => void run("usage.live")}>Usage live</Button>
          <Button {...small} onClick={() => void run("usage.history")}>History</Button><Button {...small} onClick={() => void run("usage.logs")}>Logs</Button>
          <Button {...small} onClick={() => void run("usage.efficiency")}>Efficiency</Button></ControlButtons>
        <Stack direction={{ xs: "column", sm: "row" }} sx={{ mt: 1, gap: .75 }}><TextField size="small" fullWidth label={localize(locale, "Mô tả tác vụ sắp chạy", "Upcoming task")}
          value={preflight} onChange={(event) => setPreflight(event.target.value)} slotProps={{ htmlInput: { maxLength: 2048 } }} />
          <Button {...small} sx={{ whiteSpace: "nowrap" }} onClick={() => void run("usage.preflight", preflight.trim() || null)}>Preflight</Button></Stack>
      </ControlGroup>

      <ControlGroup icon={<PersonSearchRounded color="primary" />} title={localize(locale, "Onboarding & profile", "Onboarding & profile")}
        detail={localize(locale, "Kiểm tra project và áp dụng profile dùng chung có kiểm soát.", "Inspect the project and apply a controlled reusable profile.")}>
        <ControlButtons><Button {...small} onClick={() => void run("onboarding.status")}>Onboard status</Button>
          <Button {...small} onClick={() => void run("onboarding.profile")}>Profile check</Button><Button {...small} onClick={() => void run("onboarding.tech")}>Tech check</Button>
          <Button {...small} onClick={() => void run("profile.status")}>{localize(locale, "Profile hiện tại", "Current profile")}</Button></ControlButtons>
        <Stack direction={{ xs: "column", sm: "row" }} sx={{ mt: 1, gap: .75 }}><Select size="small" fullWidth displayEmpty value={profile}
          onChange={(event) => setProfile(event.target.value)} disabled={disabled} renderValue={(value) => value
            ? profileOptions.find((item) => item.id === value)?.displayName ?? value : localize(locale, "Chọn profile…", "Select profile…") }>
          {profileOptions.map((item) => <MenuItem key={item.id} value={item.id}>{item.displayName}</MenuItem>)}</Select>
          <Button {...small} disabled={disabled || !profile} sx={{ whiteSpace: "nowrap" }} onClick={() => confirm("profile.apply", profile,
            localize(locale, "Áp dụng profile?", "Apply profile?"), localize(locale,
              "Piagent sẽ cập nhật policy profile của project. Có thể xem diff trong Source Changes sau khi chạy.",
              "Piagent will update the project's profile policy. You can inspect the diff in Source Changes afterward."))}>{localize(locale, "Áp dụng", "Apply")}</Button>
          <Button {...small} onClick={() => confirm("profile.auto", null, localize(locale, "Tự nhận diện profile?", "Auto-detect profile?"), localize(locale,
            "Piagent sẽ kiểm tra dấu hiệu công nghệ và ghi profile phù hợp vào project.", "Piagent will inspect technology markers and write the matching project profile."))}>Auto</Button></Stack>
      </ControlGroup>

      <ControlGroup icon={<DataObjectRounded color="primary" />} title={localize(locale, "Context engine", "Context engine")}
        detail={localize(locale, "Tìm, đóng gói, đo tác động và rebuild context theo cùng policy Terminal.", "Search, pack, measure impact and rebuild context under the same Terminal policy.")}>
        <ControlButtons><Button {...small} onClick={() => void run("context.status")}>Index status</Button><Button {...small} onClick={() => void run("context.efficiency")}>Efficiency</Button>
          <Button {...small} onClick={() => void run("context.impact")}>Impact</Button><Button {...small} color="warning" onClick={() => confirm("context.rebuild", null,
            localize(locale, "Rebuild context index?", "Rebuild context index?"), localize(locale,
              "Thao tác này cập nhật index cục bộ của project và không gọi model.", "This updates the project's local index and does not call the model."))}>Rebuild</Button></ControlButtons>
        <Stack direction={{ xs: "column", sm: "row" }} sx={{ mt: 1, gap: .75 }}><TextField size="small" fullWidth label={localize(locale, "Câu hỏi hoặc mục tiêu", "Question or goal")}
          value={contextQuery} onChange={(event) => setContextQuery(event.target.value)} slotProps={{ htmlInput: { maxLength: 2048 } }} />
          <Button {...small} disabled={disabled || !contextQuery.trim()} onClick={() => void run("context.search", contextQuery.trim())}>Search</Button>
          <Button {...small} disabled={disabled || !contextQuery.trim()} onClick={() => void run("context.pack", contextQuery.trim())}>Pack</Button>
          <Button {...small} color="warning" onClick={() => confirm("context.compact", contextQuery.trim() || null,
            localize(locale, "Compact context bằng model?", "Compact context with the model?"), localize(locale,
              "Đây là điều khiển duy nhất trong bảng có thể dùng model token. Piagent vẫn giữ model hiện tại.",
              "This is the only control in this panel that may use model tokens. Piagent keeps the current model."))}>Compact</Button></Stack>
      </ControlGroup>

      <ControlGroup icon={<MemoryRounded color="primary" />} title={localize(locale, "Memory", "Memory")}
        detail={localize(locale, "Xem chế độ, phạm vi và policy ghi nhớ đang có hiệu lực.", "Inspect the active memory mode, scope and write policy.")}>
        <ControlButtons><Button {...small} onClick={() => void run("memory.status")}>{localize(locale, "Kiểm tra memory", "Check memory")}</Button></ControlButtons>
      </ControlGroup>

      <ControlGroup icon={<HubRounded color="primary" />} title={localize(locale, "MCP governance", "MCP governance")}
        detail={localize(locale, "Doctor, trust decision và reset dùng cùng registry với Terminal.", "Doctor, trust decisions and reset use the same registry as Terminal.")}>
        <ControlButtons><Button {...small} onClick={() => void run("mcp.status")}>MCP status</Button><Button {...small} onClick={() => void run("mcp.doctor")}>Doctor</Button></ControlButtons>
        <Stack direction={{ xs: "column", sm: "row" }} sx={{ mt: 1, gap: .75 }}><Select size="small" fullWidth displayEmpty value={connection}
          onChange={(event) => setConnection(event.target.value)} disabled={disabled} renderValue={(value) => value || localize(locale, "Chọn MCP…", "Select MCP…") }>
          {connectionOptions.map((item) => <MenuItem key={item.connectionRef} value={item.name}>{item.name}</MenuItem>)}</Select>
          <Button {...small} disabled={disabled || !connection} onClick={() => void run("mcp.detail", connection)}>Detail</Button>
          <Button {...small} disabled={disabled || !connection} onClick={() => confirm("mcp.approve", connection, localize(locale, "Phê duyệt MCP?", "Approve MCP?"),
            localize(locale, "Project sẽ tin cậy cấu hình MCP đã chọn.", "The project will trust the selected MCP configuration."))}>Approve</Button>
          <Button {...small} disabled={disabled || !connection} color="warning" onClick={() => confirm("mcp.reject", connection, localize(locale, "Từ chối MCP?", "Reject MCP?"),
            localize(locale, "Project sẽ ghi quyết định từ chối cho MCP đã chọn.", "The project will record a rejection for the selected MCP."))}>Reject</Button>
          <Button {...small} disabled={disabled || !connection} color="warning" onClick={() => confirm("mcp.reset", connection, localize(locale, "Reset quyết định MCP?", "Reset MCP decision?"),
            localize(locale, "Quyết định trust hiện tại của MCP sẽ được xóa để đánh giá lại.", "The MCP's current trust decision will be cleared for reevaluation."))}>Reset</Button></Stack>
      </ControlGroup>
    </Box>

    {(busy || receipt || error) && <Paper aria-live="polite" variant="outlined" sx={{ mt: 2, p: 2, borderRadius: 2.5 }}>
      {busy ? <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}><CircularProgress size={18} /><Typography>{localize(locale, "Đang chạy trong Pi runtime…", "Running in the Pi runtime…")}</Typography></Stack>
        : <><Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}><CheckCircleOutlineRounded color={receipt?.state === "settled" ? "success" : "warning"} />
          <Typography sx={{ fontWeight: 800 }}>{receipt ? receipt.action : localize(locale, "Không hoàn tất", "Not completed")}</Typography>
          {receipt && <Chip size="small" color={receipt.state === "settled" ? "success" : "warning"} variant="outlined" label={receipt.resultCode} />}
          {receipt?.effect === "read-only" && <Chip size="small" color={receipt.modelCallObserved ? "warning" : "success"} variant="outlined"
            label={receipt.modelCallObserved ? localize(locale, "Đã phát hiện model call", "Model call detected") : "0 model token"} />}</Stack>
          {error && <Typography color="error" variant="body2" sx={{ mt: 1 }}>{error}</Typography>}
          {receipt?.outputs.map((output, index) => <Box component="pre" key={`${output.customType}-${index}`} sx={{ m: 0, mt: 1, p: 1.25,
            borderRadius: 1.5, bgcolor: "action.hover", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12.5, maxHeight: 260, overflow: "auto" }}>{output.content}</Box>)}</>}
    </Paper>}
    <ActionConfirmationDialog open={pending !== null} title={pending?.title ?? ""} description={pending?.description ?? ""}
      cancelLabel={localize(locale, "Hủy", "Cancel")} confirmLabel={localize(locale, "Xác nhận và chạy", "Confirm and run")}
      onCancel={() => setPending(null)} onConfirm={() => { const value = pending; setPending(null); if (value) void run(value.action, value.argument, true); }} />
  </>;
}
