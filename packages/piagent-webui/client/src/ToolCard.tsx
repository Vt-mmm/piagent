import { useState } from "react";
import AccountTreeOutlined from "@mui/icons-material/AccountTreeOutlined";
import BuildOutlined from "@mui/icons-material/BuildOutlined";
import ChecklistRounded from "@mui/icons-material/ChecklistRounded";
import CallSplitRounded from "@mui/icons-material/CallSplitRounded";
import CheckRounded from "@mui/icons-material/CheckRounded";
import CloseRounded from "@mui/icons-material/CloseRounded";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import EditOutlined from "@mui/icons-material/EditOutlined";
import ExpandMoreRounded from "@mui/icons-material/ExpandMoreRounded";
import FolderOpenOutlined from "@mui/icons-material/FolderOpenOutlined";
import HourglassEmptyRounded from "@mui/icons-material/HourglassEmptyRounded";
import LanguageRounded from "@mui/icons-material/LanguageRounded";
import NoteAddOutlined from "@mui/icons-material/NoteAddOutlined";
import PublicRounded from "@mui/icons-material/PublicRounded";
import SearchRounded from "@mui/icons-material/SearchRounded";
import TerminalRounded from "@mui/icons-material/TerminalRounded";
import TravelExploreRounded from "@mui/icons-material/TravelExploreRounded";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Typography from "@mui/material/Typography";

import { companyFailureCopy, failureRole } from "./company-failure.tsx";
import type { TimelineTool } from "./timeline-view-model.ts";
import { toneText } from "./tone.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

type Kind = NonNullable<TimelineTool["summary"]>["kind"];
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const ICONS: Record<Kind, typeof BuildOutlined> = { read: DescriptionOutlined, write: NoteAddOutlined, edit: EditOutlined, command: TerminalRounded,
  search: SearchRounded, list: FolderOpenOutlined, "web-search": TravelExploreRounded, "web-fetch": LanguageRounded, subagent: AccountTreeOutlined,
  network: PublicRounded, git: CallSplitRounded, plan: ChecklistRounded, other: BuildOutlined };
const VERBS: Record<Kind, [string, string]> = { read: ["Đọc", "Read"], write: ["Tạo", "Write"], edit: ["Sửa", "Edit"], command: ["Chạy", "Run"],
  search: ["Tìm", "Search"], list: ["Xem thư mục", "List"], "web-search": ["Tìm web", "Web search"], "web-fetch": ["Đọc trang", "Fetch page"],
  subagent: ["Subagent", "Subagent"], network: ["Chạy có mạng", "Run with network"], git: ["Git", "Git"], plan: ["Kế hoạch", "Plan"], other: ["Công cụ", "Tool"] };
const LIVE_KINDS: Record<string, Kind> = { read: "read", write: "write", edit: "edit", apply_patch: "edit", bash: "command", run_experiment: "command", grep: "search", find: "search", ls: "list",
  web_search: "web-search", web_fetch: "web-fetch", delegate: "subagent", subagent: "subagent", run_with_network: "network", fetch_origin: "git", update_plan: "plan" };

export function liveToolKind(label: string): Kind { return LIVE_KINDS[label.toLowerCase()] ?? "other"; }

function Diff({ preview }: { preview: string }) {
  return <Box component="pre" sx={{ m: 0, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, overflowX: "auto" }}>
    {preview.split("\n").map((row, index) => {
      const sign = row[0], tone = sign === "+" ? "success" : sign === "-" ? "error" : null;
      return <Box key={index} component="div" sx={{ px: 1, whiteSpace: "pre", ...(tone ? toneText(tone) : { color: row === "@@" ? "text.disabled" : "text.secondary" }),
        bgcolor: tone ? `rgba(var(--piagent-palette-${tone}-mainChannel) / .12)` : "transparent" }}>
        {row === "@@" ? "⋯" : row || " "}</Box>;
    })}
  </Box>;
}

// One step of the agent: what it did, on what, and how it ended. The body
// (diff, result preview, task) opens on demand; edits and failures start open.
// A step of a running turn that is not a tool (waiting in line) has its own icon.
export function ToolCard({ tool, locale, live, waiting }: { tool: TimelineTool | { toolName: string; state: "running" | "completed" | "failed";
  summary: { kind: Kind; target: string | null; detail: string | null } }; locale: UiLocale; live?: boolean; waiting?: boolean }) {
  const summary = tool.summary ?? { kind: "other" as const, target: null, detail: null };
  const change = "change" in tool ? tool.change : undefined, result = "result" in tool ? tool.result : undefined;
  const failed = tool.state === "failed" || result?.isError === true;
  // A failed helper or company search: who failed and why, from its code.
  const failure = "failure" in tool && tool.failure ? { detail: tool.failure, copy: companyFailureCopy(tool.failure.reasonCode, tool.failure.code, locale) } : null;
  const running = live ? tool.state === "running" : tool.state === "requested";
  const [open, setOpen] = useState(() => failed || (summary.kind === "edit" || summary.kind === "write") && Boolean(change?.preview));
  const expandable = Boolean(change?.preview || result?.text || failure?.copy || summary.detail && summary.kind !== "read");
  const Icon = waiting ? HourglassEmptyRounded : ICONS[summary.kind], verb = VERBS[summary.kind][locale === "vi" ? 0 : 1];
  const title = summary.kind === "other" ? tool.toolName : verb;
  return <Box sx={{ border: 1, borderColor: failed ? "error.main" : "divider", borderRadius: 2, bgcolor: "background.paper", overflow: "hidden" }}>
    <ButtonBase component="div" disabled={!expandable} onClick={() => setOpen((value) => !value)} aria-expanded={expandable ? open : undefined}
      sx={{ width: "100%", display: "flex", alignItems: "center", gap: 1, px: 1.25, py: .85, textAlign: "left", justifyContent: "flex-start" }}>
      <Icon sx={{ fontSize: 17, color: failed ? "error.main" : "text.secondary", flexShrink: 0 }} />
      <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0 }}>{title}</Typography>
      {summary.target && <Typography variant="body2" noWrap title={summary.target}
        sx={{ fontFamily: MONO, fontSize: 12.5, color: "text.secondary", minWidth: 0, flex: 1 }}>{summary.target}</Typography>}
      {!summary.target && <Box sx={{ flex: 1 }} />}
      {summary.kind === "read" && summary.detail && <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
        {localize(locale, `dòng ${summary.detail}`, `lines ${summary.detail}`)}</Typography>}
      {change && (change.added > 0 || change.removed > 0) && <Typography variant="caption" sx={{ fontFamily: MONO, flexShrink: 0 }}>
        {change.added > 0 && <Box component="span" sx={toneText("success")}>+{change.added} </Box>}
        {change.removed > 0 && <Box component="span" sx={toneText("error")}>−{change.removed}</Box>}</Typography>}
      {failed && !running && <Typography variant="caption" sx={{ flexShrink: 0, fontWeight: 600, ...toneText("error") }}>{localize(locale, "Lỗi", "Failed")}</Typography>}
      {running ? <CircularProgress size={14} thickness={5} aria-label={localize(locale, "Đang chạy", "Running")} />
        : failed ? <CloseRounded sx={{ fontSize: 16, color: "error.main" }} aria-hidden="true" />
          : <CheckRounded sx={{ fontSize: 16, color: "success.main" }} aria-label={localize(locale, "Xong", "Done")} />}
      {expandable && <ExpandMoreRounded sx={{ fontSize: 18, color: "text.disabled", transition: "transform .15s", transform: open ? "rotate(180deg)" : "none" }} />}
    </ButtonBase>
    <Collapse in={open && expandable} unmountOnExit>
      <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "action.hover", maxHeight: 360, overflow: "auto" }}>
        {summary.detail && summary.kind !== "read" && <Typography variant="body2" color="text.secondary" sx={{ px: 1.25, py: .75, whiteSpace: "pre-wrap",
          overflowWrap: "anywhere", ...(summary.kind === "command" ? { fontFamily: MONO, fontSize: 12 } : {}) }}>
          {summary.detail}</Typography>}
        {failure?.copy && <Box sx={{ px: 1.25, py: .75 }}>
          <Typography variant="body2" sx={{ fontWeight: 650, ...toneText("error") }}>{failureRole(failure.detail.role, locale)} {localize(locale, "lỗi", "failed")} · {failure.copy.title}</Typography>
          <Typography variant="body2" color="text.secondary">{failure.copy.text}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, overflowWrap: "anywhere" }} title={failure.detail.requestRef ?? undefined}>
            {localize(locale, "Mã", "Code")}: {failure.detail.code}{failure.detail.requestRef ? ` · request ${failure.detail.requestRef.slice(0, 8)}` : ""}</Typography>
        </Box>}
        {change?.preview && <Box sx={{ py: .5 }}><Diff preview={change.preview} /></Box>}
        {result?.text && !failure?.copy && <Box component="pre" sx={{ m: 0, px: 1.25, py: .75, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap",
          overflowWrap: "anywhere", color: result.isError ? "error.main" : "text.secondary" }}>{result.text}</Box>}
        {(change?.truncated || result?.truncated) && <Typography variant="caption" color="text.disabled" sx={{ display: "block", px: 1.25, pb: .75 }}>
          {localize(locale, "Đã rút gọn", "Truncated")}</Typography>}
      </Box>
    </Collapse>
  </Box>;
}
