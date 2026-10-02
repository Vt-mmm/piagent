import { useEffect, useState } from "react";
import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import CheckBoxOutlineBlankRounded from "@mui/icons-material/CheckBoxOutlineBlankRounded";
import CheckBoxRounded from "@mui/icons-material/CheckBoxRounded";
import PlayCircleOutlineRounded from "@mui/icons-material/PlayCircleOutlineRounded";
import CallSplitRounded from "@mui/icons-material/CallSplitRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import DifferenceRounded from "@mui/icons-material/DifferenceRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PiagentWebUISourceChangeViewV1 } from "../../contracts/generated/source-change-v1.ts";
import { readSessionSourceChanges } from "./api.ts";
import type { LiveConversation } from "./live-state-view-model.ts";
import { compactTokens } from "./timeline-view-model.ts";
import { liveToolKind } from "./ToolCard.tsx";
import { toneText, type Tone } from "./tone.ts";
import { outcomeText, processTone } from "./ProcessNote.tsx";
import { localize, type UiLocale } from "./ui-preferences.tsx";

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const STATUS_TONE: Record<string, Tone> = { A: "success", M: "warning", D: "error", R: "info", C: "info", U: "success" };

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <Box component="section" sx={{ px: 2, py: 1.75, borderBottom: 1, borderColor: "divider" }}>
    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 650, textTransform: "uppercase", letterSpacing: ".06em" }}>{title}</Typography>
      {action}</Stack>
    {children}
  </Box>;
}

// The right panel of the workspace: what the agent changed in the project,
// how full the context is, and which helpers run. It follows the session's
// revision, so it refreshes after each turn without polling.
export function ChangesPanel({ session, snapshot, live, locale, onOpenReview, onClose }: { session: SessionRow;
  snapshot?: PiagentWebUICanonicalSnapshotV1; live?: LiveConversation; locale: UiLocale; onOpenReview(): void; onClose?(): void }) {
  const [changes, setChanges] = useState<PiagentWebUISourceChangeViewV1 | null>(), [failed, setFailed] = useState(false);
  const running = Boolean(live && !live.complete);
  useEffect(() => {
    if (running) return;
    const controller = new AbortController(); setFailed(false);
    const timer = window.setTimeout(() => void readSessionSourceChanges(session.sessionRef, "working-tree", controller.signal)
      .then((value) => setChanges(value)).catch(() => { if (!controller.signal.aborted) setFailed(true); }), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [session.sessionRef, session.sessionRevision, running]);
  useEffect(() => { setChanges(undefined); }, [session.sessionRef]);
  const files = changes?.files ?? [];
  const added = files.reduce((sum, file) => sum + (file.stats?.additions ?? 0), 0), removed = files.reduce((sum, file) => sum + (file.stats?.deletions ?? 0), 0);
  const context = snapshot?.usage.context, known = context?.state === "known";
  const percent = known ? context.percent : session.contextUsage.ratio === null ? null : session.contextUsage.ratio * 100;
  const window_ = known ? context.contextWindow : session.contextUsage.contextWindow;
  const used = known ? context.tokens : session.contextUsage.usedTokens;
  const helpers = session.managedHelpers, plan = session.managedPlan, process = session.managedProcess;
  const done = plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const helperRuns = (live?.activities ?? []).filter((activity) => liveToolKind(activity.toolLabel) === "subagent");
  return <Box role="region" sx={{ height: "100%", overflowY: "auto", bgcolor: "background.paper" }} aria-label={localize(locale, "Thay đổi và ngữ cảnh", "Changes and context")}>
    <Stack direction="row" sx={{ alignItems: "center", gap: 1, px: 2, minHeight: 60, borderBottom: 1, borderColor: "divider" }}>
      <Typography sx={{ fontWeight: 600, flex: 1 }}>{localize(locale, "Workspace", "Workspace")}</Typography>
      {onClose && <IconButton size="small" aria-label={localize(locale, "Đóng khung bên", "Close side panel")} onClick={onClose}><CloseRounded fontSize="small" /></IconButton>}
    </Stack>
    <Section title={changes ? localize(locale, `Thay đổi · ${files.length} file`, `Changes · ${files.length} files`) : localize(locale, "Thay đổi", "Changes")}
      action={files.length > 0 ? <Tooltip title={localize(locale, "Xem diff đầy đủ, stage hoặc hoàn tác", "Full diff, stage or revert")}>
        <Button size="small" startIcon={<DifferenceRounded fontSize="small" />} onClick={onOpenReview}>{localize(locale, "Review", "Review")}</Button></Tooltip> : undefined}>
      {(added > 0 || removed > 0) && <Stack direction="row" sx={{ alignItems: "center", gap: .75, mb: 1, color: "text.secondary" }}>
        <CallSplitRounded sx={{ fontSize: 15 }} /><Typography variant="caption">{localize(locale, "Chưa commit", "Uncommitted")}</Typography>
        <Typography variant="caption" sx={{ fontFamily: MONO, ml: "auto" }}>
          <Box component="span" sx={toneText("success")}>+{added}</Box> <Box component="span" sx={toneText("error")}>−{removed}</Box></Typography>
      </Stack>}
      {changes === undefined && !failed && (running ? <Typography variant="body2" color="text.secondary">
        {localize(locale, "Cập nhật khi lượt này chạy xong.", "Updates when this turn finishes.")}</Typography> : <LinearProgress sx={{ borderRadius: 1 }} />)}
      {(failed || changes?.availability.state === "unavailable") && <Typography variant="body2" color="text.secondary">
        {localize(locale, "Chưa đọc được thay đổi (thư mục có thể không phải git repo).", "Changes are unavailable (the folder may not be a git repository).")}</Typography>}
      {changes && changes.availability.state !== "unavailable" && files.length === 0 && <Typography variant="body2" color="text.secondary">
        {localize(locale, "Chưa có thay đổi nào chưa commit.", "No uncommitted changes.")}</Typography>}
      <Stack spacing={.25}>{files.slice(0, 200).map((file) => <Stack key={file.fileRef} direction="row" sx={{ alignItems: "center", gap: 1, py: .4 }}>
        <Typography variant="caption" sx={{ fontFamily: MONO, fontWeight: 700, width: 12, ...(STATUS_TONE[file.status] ? toneText(STATUS_TONE[file.status]) : { color: "text.secondary" }) }}>{file.status}</Typography>
        <Typography variant="body2" noWrap title={file.path} sx={{ fontFamily: MONO, fontSize: 12.5, flex: 1, minWidth: 0 }}>{file.path}</Typography>
        <Typography variant="caption" sx={{ fontFamily: MONO, flexShrink: 0 }}>
          {(file.stats?.additions ?? 0) > 0 && <Box component="span" sx={toneText("success")}>+{file.stats.additions} </Box>}
          {(file.stats?.deletions ?? 0) > 0 && <Box component="span" sx={toneText("error")}>−{file.stats.deletions}</Box>}</Typography>
      </Stack>)}</Stack>
    </Section>
    {(plan || process) && <Section title={plan ? localize(locale, `Kế hoạch · ${done}/${plan.steps.length}`, `Plan · ${done}/${plan.steps.length}`) : localize(locale, "Tiến trình", "Process")}>
      {plan && <Stack component="ol" spacing={.25} sx={{ m: 0, p: 0, listStyle: "none" }} aria-label={localize(locale, "Kế hoạch của agent", "Agent plan")}>{plan.steps.map((step, index) => {
        const Icon = step.status === "completed" ? CheckBoxRounded : step.status === "in_progress" ? PlayCircleOutlineRounded : CheckBoxOutlineBlankRounded;
        return <Stack component="li" key={index} direction="row" sx={{ alignItems: "flex-start", gap: .75, py: .25 }}
          aria-label={`${step.step}: ${step.status === "completed" ? localize(locale, "xong", "done") : step.status === "in_progress" ? localize(locale, "đang làm", "in progress") : localize(locale, "chưa làm", "pending")}`}>
          <Icon sx={{ fontSize: 16, mt: .2, color: step.status === "in_progress" ? "primary.main" : "text.secondary" }} />
          <Typography variant="body2" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", ...(step.status === "completed" ? { color: "text.secondary", textDecoration: "line-through" } : {}),
            ...(step.status === "in_progress" ? { fontWeight: 600 } : {}) }}>{step.step}</Typography></Stack>;
      })}</Stack>}
      {process && process.outcome !== "no_change" && <Typography variant="body2" role="status" sx={{ mt: plan ? 1 : 0, ...toneText(processTone(process)) }}>
        {localize(locale, "Lượt sửa code gần nhất: ", "Last code-changing turn: ")}{outcomeText(process, locale)}</Typography>}
    </Section>}
    <Section title={localize(locale, "Ngữ cảnh", "Context")}>
      <Stack direction="row" sx={{ justifyContent: "space-between", mb: .75 }}>
        <Typography variant="body2">{percent === null || percent === undefined ? "—" : `${Math.round(percent)}%`}</Typography>
        <Typography variant="caption" color="text.secondary">{used ? compactTokens(used) : "—"}{window_ ? ` / ${compactTokens(window_)}` : ""}</Typography></Stack>
      <LinearProgress variant="determinate" value={Math.min(100, Math.max(0, percent ?? 0))} sx={{ height: 6, borderRadius: 3 }}
        color={(percent ?? 0) > 85 ? "warning" : "primary"} aria-label={localize(locale, "Mức dùng ngữ cảnh", "Context usage")} />
    </Section>
    {(helpers || helperRuns.length > 0) && <Section title="Subagent">
      {helpers && <Typography variant="body2" color="text.secondary" sx={{ mb: helperRuns.length ? .75 : 0 }}>
        {localize(locale, `${helpers.active ?? 0}/${helpers.maximum} đang chạy`, `${helpers.active ?? 0}/${helpers.maximum} running`)}</Typography>}
      {helperRuns.map((run) => <Stack key={run.toolCallRef} direction="row" sx={{ alignItems: "center", gap: .75, py: .25 }}>
        <AccountTreeOutlined sx={{ fontSize: 15, color: "text.secondary" }} />
        <Typography variant="body2" sx={{ flex: 1 }}>{run.fileLabel ?? "subagent"}</Typography>
        <Typography variant="caption" color={run.state === "failed" ? "error" : "text.secondary"}>{run.state === "running"
          ? localize(locale, "đang chạy", "running") : run.state === "failed" ? localize(locale, "lỗi", "failed") : localize(locale, "xong", "done")}</Typography>
      </Stack>)}
    </Section>}
  </Box>;
}
