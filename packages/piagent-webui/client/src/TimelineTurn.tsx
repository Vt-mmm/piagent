import { lazy, Suspense, type ReactNode } from "react";
import DescriptionOutlined from "@mui/icons-material/DescriptionOutlined";
import ErrorOutlineRounded from "@mui/icons-material/ErrorOutlineRounded";
import ImageOutlined from "@mui/icons-material/ImageOutlined";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { AttachmentSummary, TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import { attachmentDetail } from "./attachment-intake.ts";
import { companyFailureCopy, failureContinuable, failureRole } from "./company-failure.tsx";
import type { LiveActivity } from "./live-state-view-model.ts";
import { compactTokens, turnSeconds, turnTokensPerSecond, type TimelineFailure, type TimelineTurn } from "./timeline-view-model.ts";
import { liveToolKind, ToolCard } from "./ToolCard.tsx";
import { ProcessNote } from "./ProcessNote.tsx";
import { TurnEndNote } from "./TurnEndNote.tsx";
import { localize, type UiLocale } from "./ui-preferences.tsx";

// Its own chunk, fetched when a conversation opens (preloadMarkdown) rather
// than on the first answer, which showed its markdown as plain text until the
// chunk arrived.
let markdownModule: Promise<typeof import("./MarkdownMessage.tsx")> | null = null;
export const preloadMarkdown = () => (markdownModule ??= import("./MarkdownMessage.tsx"));
const MarkdownMessage = lazy(async () => ({ default: (await preloadMarkdown()).MarkdownMessage }));

export function AssistantText({ children }: { children: string }) {
  return <Suspense fallback={<Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.75 }}>{children}</Typography>}>
    <MarkdownMessage>{children}</MarkdownMessage>
  </Suspense>;
}

export function AttachmentCards({ attachments, locale }: { attachments: readonly (AttachmentSummary | Attachment)[]; locale: UiLocale }) {
  if (!attachments.length) return null;
  return <Stack spacing={.75} sx={{ mb: 1 }} aria-label={localize(locale, "File đã gửi", "Sent files")}>{attachments.map((attachment, index) => {
    const live = "sourceBytes" in attachment;
    const detail = live ? attachmentDetail(attachment, locale) : `${attachment.kind === "document"
      ? localize(locale, "Tài liệu", "Document") : attachment.kind === "image" ? localize(locale, "Ảnh", "Image") : "File"}${attachment.truncated
        ? ` · ${localize(locale, "đã cắt bớt", "truncated")}` : ""}`;
    return <Paper key={`${attachment.displayName}:${index}`} variant="outlined" sx={{ display: "flex", alignItems: "center", gap: 1.1,
      minWidth: 220, maxWidth: 440, px: 1.2, py: 1, borderRadius: 2, bgcolor: "background.paper" }}>
      {attachment.kind === "image" ? <ImageOutlined color="action" /> : <DescriptionOutlined color="action" />}
      <Box sx={{ minWidth: 0 }}><Typography variant="body2" noWrap sx={{ fontWeight: 650 }}>{attachment.displayName}</Typography>
        <Typography variant="caption" color="text.secondary">{detail}</Typography></Box>
    </Paper>;
  })}</Stack>;
}

// A turn that ended without an answer must say so; otherwise the chat looks
// like it is still thinking. Provider detail stays out of the browser.
export const LIVE_FAILURES = new Set(["assistant-response-failed", "operation-failed"]);
export function turnFailureText(code: string, locale: UiLocale): string {
  switch (code) {
    case "provider-auth-expired": return localize(locale, "Phiên đăng nhập model đã hết hạn. Mở Cài đặt → Nhà cung cấp & model để kết nối lại.",
      "The model sign-in expired. Open Settings → Providers & models to reconnect.");
    case "provider-auth-required": return localize(locale, "Model cần đăng nhập lại. Mở Cài đặt → Nhà cung cấp & model.",
      "The model needs to sign in again. Open Settings → Providers & models.");
    case "provider-rate-limited": return localize(locale, "Model đang bị giới hạn lượt gọi hoặc đã hết hạn mức. Thử lại sau.",
      "The model is rate limited or out of quota. Try again later.");
    case "provider-unavailable": return localize(locale, "Model hoặc máy chủ trung gian đang không phục vụ yêu cầu này. Thử lại; nếu lỗi lặp lại, kiểm tra model đang dùng.",
      "The model or its gateway did not serve this request. Retry; if it repeats, check the model in use.");
    case "assistant-output-incomplete": return localize(locale, "Câu trả lời dừng giữa chừng vì chạm giới hạn độ dài. Gửi “tiếp tục” để model viết tiếp.",
      "The answer stopped at the length limit. Send “continue” to resume.");
    default: return localize(locale, "Model trả lỗi và chưa có câu trả lời. Gửi lại; nếu lỗi lặp lại, kiểm tra model đang dùng.",
      "The model returned an error without an answer. Send again; if it repeats, check the model in use.");
  }
}
// A company failure says who failed (a harness role), what kind of failure it
// is and what to do; its code and Studio's request id are there for an
// administrator. Personal sessions keep the provider wording.
export function TurnFailure({ code, detail, locale, onContinue }: { code: string; detail?: TimelineFailure | null; locale: UiLocale; onContinue?: () => void }) {
  const company = companyFailureCopy(code, detail?.code ?? null, locale);
  // The last turn of a conversation can be picked up where it stopped.
  const action = onContinue && failureContinuable(code) ? <Button color="inherit" size="small" onClick={onContinue}>{localize(locale, "Tiếp tục", "Continue")}</Button> : undefined;
  if (!company) return <Alert severity="error" variant="outlined" icon={<ErrorOutlineRounded />} action={action} sx={{ alignSelf: "stretch" }}>{turnFailureText(code, locale)}</Alert>;
  return <Alert severity="error" variant="outlined" icon={<ErrorOutlineRounded />} action={action} sx={{ alignSelf: "stretch" }}>
    <AlertTitle sx={{ fontSize: "inherit", fontWeight: 650, mb: .25 }}>{failureRole(detail?.role ?? "main", locale)} {localize(locale, "lỗi", "failed")} · {company.title}</AlertTitle>
    {company.text}
    {detail && <Typography variant="caption" component="div" color="text.secondary" sx={{ mt: .5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflowWrap: "anywhere" }}
      title={detail.requestRef ?? undefined}>{localize(locale, "Mã", "Code")}: {detail.code}{detail.requestRef ? ` · request ${detail.requestRef.slice(0, 8)}` : ""}</Typography>}
  </Alert>;
}

export function UserBubble({ text, attachments, note, locale }: { text: string | null; attachments: readonly (AttachmentSummary | Attachment)[];
  note?: string | null; locale: UiLocale }) {
  return <Box sx={{ alignSelf: "flex-end", maxWidth: "82%", bgcolor: "action.selected", borderRadius: 3, px: 2, py: 1.4 }}>
    <AttachmentCards attachments={attachments} locale={locale} />
    {text && <Typography sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.7 }}>{text}</Typography>}
    {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
  </Box>;
}

// The agent's side of a turn: its steps, then its answer, under one mark.
export function AgentBlock({ children }: { children: ReactNode }) {
  return <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}><Box className="brand-mark" aria-hidden="true">π</Box>
    <Stack spacing={1} sx={{ minWidth: 0, flex: 1 }}><Typography sx={{ fontWeight: 600 }}>Piagent</Typography>{children}</Stack></Box>;
}

function contentNote(item: TranscriptItem, locale: UiLocale): string | null {
  return item.content.redacted ? localize(locale, "Đã ẩn dữ liệu nhạy cảm", "Sensitive data hidden")
    : item.content.truncated ? localize(locale, "Nội dung đã rút gọn", "Content truncated") : null;
}

export function TurnFooter({ turn, locale }: { turn: TimelineTurn; locale: UiLocale }) {
  const seconds = turnSeconds(turn), parts = [`${turn.requests} request`];
  if (turn.tokens) parts.push(`${compactTokens(turn.tokens)} token`);
  if (seconds !== null && seconds > 0) parts.push(seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);
  const rate = turnTokensPerSecond(turn);
  if (rate !== null) parts.push(`${rate} tok/s`);
  if (turn.model) parts.push(turn.model);
  return <Typography variant="caption" color="text.disabled" title={localize(locale, "Request model, token, thời gian và tốc độ sinh token (token đầu ra mỗi giây, tính cả thời gian chờ) của lượt này",
    "Model requests, tokens, time and output speed (output tokens per second, waiting included) of this turn")}>{parts.join(" · ")}</Typography>;
}

// `onContinue` is given for the last turn of an idle conversation: a turn that
// failed, or one with no answer at all (stopped, or the app or the machine
// went down while it ran), offers to go on from the steps already taken.
export function TimelineTurnView({ turn, locale, onContinue }: { turn: TimelineTurn; locale: UiLocale; onContinue?: () => void }) {
  const unanswered = Boolean(onContinue) && !turn.answer && !turn.failure && !turn.end;
  const agent = turn.steps.length > 0 || turn.answer || turn.failure || unanswered || turn.process || turn.end;
  return <Stack spacing={1.5}>
    <UserBubble text={turn.user.content.text} attachments={turn.user.attachments ?? []} note={contentNote(turn.user, locale)} locale={locale} />
    {agent && <AgentBlock>
      {turn.steps.map((step) => step.kind === "tool" ? <ToolCard key={step.key} tool={step.tool} locale={locale} />
        : step.kind === "process" ? <ProcessNote key={step.key} process={step.process} locale={locale} />
        : <Box key={step.key} sx={{ color: "text.secondary", fontSize: ".875rem", "& .MuiTypography-root": { fontSize: "inherit" } }}>
          <AssistantText>{step.text}</AssistantText></Box>)}
      {turn.failure && <TurnFailure code={turn.failure} detail={turn.failureDetail} locale={locale} onContinue={onContinue} />}
      {unanswered && <Alert severity="info" variant="outlined" sx={{ alignSelf: "stretch" }}
        action={<Button color="inherit" size="small" onClick={onContinue}>{localize(locale, "Tiếp tục", "Continue")}</Button>}>
        {localize(locale, "Lượt này chưa có câu trả lời: nó đã bị dừng, hoặc ứng dụng hay máy tắt khi đang chạy. Các bước đã làm vẫn được giữ; bấm Tiếp tục để làm tiếp.",
          "This turn has no answer: it was stopped, or the app or the machine went down while it ran. Its steps are kept; press Continue to go on.")}</Alert>}
      {turn.answer && <Box><AssistantText>{turn.answer}</AssistantText></Box>}
      {turn.process && <ProcessNote process={turn.process} locale={locale} />}
      {turn.end && <TurnEndNote end={turn.end} locale={locale} onContinue={turn.failure ? undefined : onContinue} />}
      {turn.requests > 0 && <TurnFooter turn={turn} locale={locale} />}
    </AgentBlock>}
  </Stack>;
}

// Steps of a running turn that are not tools get a sentence of their own.
function liveStepName(label: string, locale: UiLocale): string {
  if (label === "compaction") return localize(locale, "Tóm tắt phần cũ của cuộc trò chuyện", "Summarise the older part of the conversation");
  if (label === "capacity-wait") return localize(locale, "Chờ tài khoản công ty rảnh (Studio đang bận, sẽ tự gửi lại)", "Wait for a free company account (Studio is busy; it is sent again by itself)");
  return label;
}

// The running turn, from Gateway live events until the durable transcript
// has it: tools as they run, the answer as it streams, then the outcome.
export function LiveTurnView({ user, attachments, activities, assistant, running, failure, status, locale }: { user: string | null;
  attachments: readonly Attachment[]; activities: readonly LiveActivity[]; assistant: string | null; running: boolean; failure: string | null;
  status: ReactNode; locale: UiLocale }) {
  return <Stack spacing={1.5}>
    {user && <UserBubble text={user} attachments={attachments} locale={locale} />}
    <AgentBlock>
      {activities.map((activity) => <ToolCard key={activity.toolCallRef} live locale={locale} waiting={activity.toolLabel === "capacity-wait"} tool={{ toolName: liveStepName(activity.toolLabel, locale), state: activity.state,
        summary: { kind: liveToolKind(activity.toolLabel), target: activity.fileLabel ?? null, detail: null } }} />)}
      {failure && <TurnFailure code={failure} locale={locale} />}
      {assistant && <Box><AssistantText>{assistant}</AssistantText></Box>}
      {running && status}
    </AgentBlock>
  </Stack>;
}
