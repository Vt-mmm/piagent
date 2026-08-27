import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FolderOpenRounded from "@mui/icons-material/FolderOpenRounded";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ListItemButton from "@mui/material/ListItemButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Command, Receipt } from "../../contracts/generated/control-command-v1.ts";
import type { PiagentWebUIBoundedFileDiffV1 } from "../../contracts/generated/diff-v1.ts";
import type { PiagentWebUIDigestBoundSelectedFileReviewStateV1 } from "../../contracts/generated/review-state-v1.ts";
import type { PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1 } from "../../contracts/generated/source-mutation-v1.ts";
import type { PiagentWebUIConfirmedExactSourceRevertPreviewV1 } from "../../contracts/generated/source-revert-v1.ts";
import type { PiagentWebUIDeterministicStagedCommitSummaryV1 } from "../../contracts/generated/commit-summary-v1.ts";
import type { FileChange, PiagentWebUISourceChangeViewV1, View } from "../../contracts/generated/source-change-v1.ts";
import { readCommitSummary, readFileDiff, readReviewState, readSessionCommitSummary, readSessionFileDiff, readSessionReviewState,
  readSessionSourceChanges, readSessionSourceMutation, readSessionSourceRevert, readSourceChanges, readSourceMutation, readSourceRevert, sendChatCommand,
  sendReviewCommand, sendSourceMutationCommand, sendSourceOpenCommand, sendSourceRevertCommand } from "./api.ts";
import { createChatCommand } from "./chat-command.ts";
import { createReviewCommand } from "./review-command.ts";
import { createSourceMutationCommand } from "./source-mutation-command.ts";
import { createSourceRevertCommand } from "./source-revert-command.ts";
import { createSourceOpenCommand } from "./source-open-command.ts";
import { tokenizeDiffLine } from "./diff-syntax.ts";
import { activeFileRef, currentSourceDocument, fileStats, localizedSourceTabs, provenanceLabel, relatedEvidence,
  sourceDiffMatchesSnapshot, sourceDocumentMatchesSnapshot, sourceSnapshotRevisionKey, sourceSummary,
  sourceDetailUnavailableNeedsRecovery,
  type SourceSnapshotBinding } from "./source-view-model.ts";
import { label, tone } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

type LoadState<T> = { state: "idle" | "loading" | "ready" | "error"; value?: T };
type SourceDocumentLoadState = LoadState<PiagentWebUISourceChangeViewV1> & { revisionKey?: string };
type SourceDetailLoadState<T> = LoadState<T> & { requestKey?: string };
type BoundSourceWarning = { scope: string; generation: number; message: string };

function reviewTargetKey(value?: PiagentWebUIDigestBoundSelectedFileReviewStateV1): string {
  const target = value?.target;
  if (!target) return "no-target";
  return [target.view, target.fileRef, target.diffRef, target.taskRevision, target.workspaceRevision, target.indexRevision ?? "",
    target.viewRevision, target.fileRevision, target.patchPreimage, target.contentDigest].join("\u001f");
}

function reviewPreimageKey(value?: PiagentWebUIDigestBoundSelectedFileReviewStateV1): string {
  if (!value) return "no-review-state";
  return [reviewTargetKey(value), value.state, value.recordedState ?? "", value.recordedAt ?? "", value.evidenceRef ?? ""].join("\u001d");
}

function sameReviewIdentity(command: Command, receipt: Receipt): boolean {
  return command.identity.projectRef === receipt.identity.projectRef
    && command.identity.runtimeInstanceId === receipt.identity.runtimeInstanceId
    && command.identity.sessionRef === receipt.identity.sessionRef
    && command.identity.taskId === receipt.identity.taskId
    && command.identity.taskRunId === receipt.identity.taskRunId
    && command.identity.agentOperationId === receipt.identity.agentOperationId
    && command.identity.toolCallId === receipt.identity.toolCallId;
}

function validReviewSettlement(command: Command, receipt: Receipt, expectedResult: "reviewed" | "unreviewed",
  idempotencyKeyDigest: string): boolean {
  return receipt.phase === "settled" && receipt.resultCode === expectedResult && receipt.action === "review.mark"
    && receipt.commandId === command.commandId && receipt.actionDigest === command.actionDigest
    && receipt.idempotencyKeyDigest === idempotencyKeyDigest && sameReviewIdentity(command, receipt)
    && typeof receipt.settledAt === "string" && typeof receipt.settlementEvidenceRef === "string";
}

type SourceDetailTarget = { view: string; fileRef: string; taskRevision: string; workspaceRevision: string; indexRevision: string | null;
  viewRevision: string; fileRevision: string };
type SourceDetailIdentity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null; taskRunId: string | null };
type SourceDetailProjection = PiagentWebUIDigestBoundSelectedFileReviewStateV1 | PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1
  | PiagentWebUIConfirmedExactSourceRevertPreviewV1;
function sourceDetailIdentityMatches(identity: SourceDetailIdentity | undefined, expected: SourceDetailIdentity): boolean {
  return Boolean(identity && identity.projectRef === expected.projectRef && identity.runtimeInstanceId === expected.runtimeInstanceId
    && identity.sessionRef === expected.sessionRef && identity.taskId === expected.taskId && identity.taskRunId === expected.taskRunId);
}
function sourceDetailTargetMatches(target: SourceDetailTarget, view: View, fileRef: string, viewRevision: string, fileRevision: string,
  snapshot: PiagentWebUICanonicalSnapshotV1): boolean {
  return target.view === view && target.fileRef === fileRef && target.taskRevision === snapshot.revision.taskRevision
    && target.workspaceRevision === snapshot.sourceChanges.workingTree.revision
    && target.indexRevision === snapshot.sourceChanges.staged.revision
    && target.viewRevision === viewRevision && target.fileRevision === fileRevision;
}

export function sourceDetailProjectionMatchesSnapshot(value: SourceDetailProjection | undefined, view: View, fileRef: string,
  viewRevision: string, fileRevision: string, snapshot: PiagentWebUICanonicalSnapshotV1,
  currentDiff?: PiagentWebUIBoundedFileDiffV1): boolean {
  if (!value || !sourceDetailIdentityMatches(value.identity, snapshot.identity)) return false;
  if (!value.target) return value.state === "unavailable" && !sourceDetailUnavailableNeedsRecovery(value, currentDiff);
  return sourceDetailTargetMatches(value.target, view, fileRef, viewRevision, fileRevision, snapshot);
}

async function digestText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value), result = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function CommitSummaryPanel({ state, busy, status, deterministicEnabled, modelEnabled, locale, onGenerate, onCopy, onModel }: {
  state: LoadState<PiagentWebUIDeterministicStagedCommitSummaryV1>; busy: boolean; status: string | null;
  deterministicEnabled: boolean; modelEnabled: boolean; locale: UiLocale; onGenerate(): void; onCopy(): void; onModel(): void;
}) {
  const summary = state.value?.state === "ready" ? state.value.summary : null;
  return <section className="commit-summary-panel" aria-labelledby="commit-summary-title">
    <div><p className="section-kicker">Commit summary</p><h3 id="commit-summary-title">{localize(locale, "Tóm tắt phần đã stage", "Staged changes summary")}</h3>
      <span>{localize(locale, "Bản deterministic dùng 0 model token. Không commit hoặc push.", "The deterministic version uses 0 model tokens. It does not commit or push.")}</span></div>
    {!summary ? <button type="button" disabled={!deterministicEnabled || busy} onClick={onGenerate}>
      {busy ? localize(locale, "Đang tạo…", "Generating…") : localize(locale, "Tạo summary · 0 token", "Generate summary · 0 tokens")}</button> : <div className="commit-summary-output">
      <strong>{summary.title}</strong>{summary.bodyLines.map((line, index) => <code key={`${summary.summaryRef}.${index}`}>{line}</code>)}
      <div><button type="button" onClick={onCopy}>Copy</button>
        <button type="button" disabled={!modelEnabled || busy} onClick={onModel}>{localize(locale, "Nhờ Pi viết lại · tốn model token", "Ask Pi to rewrite · uses model tokens")}</button></div>
    </div>}
    {status && <p className="commit-summary-status" role="status">{status}</p>}
  </section>;
}

function FileRow({ file, selected, onSelect, locale }: { file: FileChange; selected: boolean; onSelect(): void; locale: UiLocale }) {
  const slash = file.path.lastIndexOf("/");
  const name = slash < 0 ? file.path : file.path.slice(slash + 1);
  return (
    <ListItemButton component="button" className="file-row" selected={selected} data-selected={selected} onClick={onSelect} type="button"
      aria-label={`${file.status} ${file.path} ${fileStats(file, locale)}`} aria-pressed={selected}>
      <span className={`file-status status-${file.status}`}>{file.status}</span>
      <span className="file-name"><strong>{name}</strong>{file.oldPath && <small>{localize(locale, "từ", "from")} {file.oldPath}</small>}</span>
      <span className="file-provenance">{provenanceLabel(file, locale)}</span>
      <span className="file-evidence">{relatedEvidence(file, locale)}</span>
      <span className="file-stats">{fileStats(file, locale)}</span>
    </ListItemButton>
  );
}

function HighlightedLine({ text, path }: { text: string; path: string }) {
  return <>{tokenizeDiffLine(text, path).map((token, index) => <span className={`syntax-${token.kind}`}
    key={`${index}.${token.kind}`}>{token.text}</span>)}</>;
}

function DiffLine({ line, side, path }: { line: PiagentWebUIBoundedFileDiffV1["hunks"][number]["lines"][number];
  side: "inline" | "split"; path: string }) {
  const old = line.oldLineNumber ?? "";
  const next = line.newLineNumber ?? "";
  if (side === "inline") return <div className={`diff-line diff-${line.kind}`}><span>{old}</span><span>{next}</span><b>{line.marker}</b>
    <code><HighlightedLine text={line.text} path={path} /></code></div>;
  const left = line.kind === "added" ? "" : line.text;
  const right = line.kind === "deleted" ? "" : line.text;
  return <div className={`split-line diff-${line.kind}`}><span>{old}</span><code><HighlightedLine text={left} path={path} /></code>
    <span>{next}</span><code><HighlightedLine text={right} path={path} /></code></div>;
}

function DiffViewer({ state, review, mutation, revert, reviewEnabled, reviewBusy, reviewError, mutationEnabled, mutationBusy, mutationError,
  revertEnabled, revertBusy, openEnabled, openBusy, openStatus, detailError, mode, onMode, onReview, onMutation, onRevert, onOpen,
  onRetry, locale }: {
  state: LoadState<PiagentWebUIBoundedFileDiffV1>; review: LoadState<PiagentWebUIDigestBoundSelectedFileReviewStateV1>; reviewEnabled: boolean;
  reviewBusy: boolean; reviewError: string | null; mode: "inline" | "split"; onMode(value: "inline" | "split"): void;
  onReview(value: "reviewed" | "unreviewed"): void; mutation: LoadState<PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1>;
  mutationEnabled: boolean; mutationBusy: boolean; mutationError: string | null; onMutation(hunkRefs: string[]): void;
  revert: LoadState<PiagentWebUIConfirmedExactSourceRevertPreviewV1>; revertEnabled: boolean; revertBusy: boolean; locale: UiLocale;
  onRevert(hunkRef: string | null): void; openEnabled: boolean; openBusy: boolean; openStatus: string | null; onOpen(): void;
  detailError: boolean; onRetry?: () => void;
}) {
  if (state.state === "idle") return <div className="diff-empty"><p>{localize(locale, "Chọn một file để xem diff và bằng chứng liên quan.", "Select a file to inspect its diff and related evidence.")}</p></div>;
  if (state.state === "loading") return <div className="diff-empty"><p>{localize(locale, "Đang dựng diff từ Git và task baseline…", "Building the diff from Git and the task baseline…")}</p></div>;
  if (state.state === "error" || !state.value) return <div className="diff-empty error-state">
    <p>{localize(locale, "Diff chưa thể đồng bộ với revision hiện tại.", "The diff could not be reconciled with the current revision.")}</p>
    {onRetry && <button type="button" onClick={onRetry}>{localize(locale, "Thử đồng bộ lại", "Retry reconciliation")}</button>}
  </div>;
  const diff = state.value;
  return (
    <Box className="diff-viewer" sx={{ minWidth: 0, bgcolor: "background.paper" }}>
      <Box component="header" className="diff-toolbar" sx={{ position: "sticky", top: 0, zIndex: 2, bgcolor: "background.paper" }}>
        <div><strong>{diff.file.path}</strong><Chip size="small" variant="outlined" className={`access-badge tone-${tone(diff.availability.state)}`} label={label(diff.availability.state, locale)} /></div>
        <div className="diff-actions">
          {review.state === "ready" && review.value && <div className={`review-state review-${review.value.state}`}>
            <span>{review.value.state === "reviewed" ? localize(locale, "Đã review", "Reviewed") : review.value.state === "stale" ? localize(locale, "Review đã cũ", "Review stale") : review.value.state === "unavailable" ? localize(locale, "Không thể review", "Review unavailable") : localize(locale, "Chưa review", "Not reviewed")}</span>
            {review.value.target && review.value.state !== "unavailable" && <button type="button" disabled={!reviewEnabled || reviewBusy}
              onClick={() => onReview(review.value!.state === "reviewed" ? "unreviewed" : "reviewed")}>
              {reviewBusy ? localize(locale, "Đang ghi…", "Saving…") : review.value.state === "reviewed" ? localize(locale, "Bỏ dấu review", "Mark unreviewed") : review.value.state === "stale" ? localize(locale, "Review lại", "Review again") : localize(locale, "Đánh dấu đã review", "Mark reviewed")}
            </button>}
          </div>}
          {mutation.state === "ready" && mutation.value?.state === "ready" && mutation.value.target && <div className="source-mutation-preview">
            <span>{mutation.value.action === "source.stage" ? localize(locale, "Chuẩn bị đúng thay đổi file này để commit", "Prepare this exact file change for commit") : localize(locale, "Bỏ khỏi vùng commit; giữ nguyên file đang làm việc", "Remove from commit while keeping the working file")}</span>
            <button type="button" disabled={!mutationEnabled || mutationBusy} onClick={() => onMutation([])}>
              {mutationBusy ? localize(locale, "Đang cập nhật Git…", "Updating Git…") : mutation.value.action === "source.stage" ? "Stage file" : "Unstage file"}
            </button>
          </div>}
          {revert.state === "ready" && revert.value?.state === "ready" && revert.value.target && <div className="source-revert-preview">
            <span>{localize(locale, "Hoàn tác phần chưa stage; giữ nguyên index", "Revert unstaged changes while preserving the index")}</span>
            <button type="button" disabled={!revertEnabled || revertBusy} onClick={() => onRevert(null)}>
              {revertBusy ? localize(locale, "Đang dựng preview…", "Building preview…") : "Revert file"}
            </button>
          </div>}
          {openEnabled && <div className="source-open-action">
            <button type="button" disabled={openBusy} onClick={onOpen}>{openBusy ? localize(locale, "Đang mở…", "Opening…") : localize(locale, "Mở trong VS Code", "Open in VS Code")}</button>
          </div>}
          <ToggleButtonGroup className="mode-switch" exclusive size="small" value={mode} aria-label={localize(locale, "Kiểu hiển thị diff", "Diff layout")}
            onChange={(_, value: "inline" | "split" | null) => value && onMode(value)}>
            <ToggleButton value="inline" aria-label="Inline">Inline</ToggleButton>
            <ToggleButton value="split" aria-label={localize(locale, "Hai cột", "Side by side")}>{localize(locale, "Hai cột", "Side by side")}</ToggleButton>
          </ToggleButtonGroup>
        </div>
      </Box>
      {reviewError && <div className="review-error" role="status">{reviewError}</div>}
      {mutationError && <div className="review-error" role="status">{mutationError}</div>}
      {openStatus && <div className="source-open-status" role="status">{openStatus}</div>}
      {detailError && <div className="detail-reconciliation-warning" role="status">
        <span>{localize(locale, "Một thao tác source chưa đồng bộ; diff hiện tại vẫn chính xác.",
          "A source action is not reconciled yet; the current diff remains exact.")}</span>
        {onRetry && <button type="button" onClick={onRetry}>{localize(locale, "Thử đồng bộ lại", "Retry reconciliation")}</button>}
      </div>}
      <div className="diff-context"><span>{provenanceLabel(diff.file, locale)}</span><span>{relatedEvidence(diff.file, locale)}</span><span className="additions">+{diff.file.stats.additions ?? "?"}</span><span className="deletions">−{diff.file.stats.deletions ?? "?"}</span></div>
      {diff.fallback.kind !== "none" && <div className="diff-fallback"><strong>{label(diff.fallback.kind, locale)}</strong><span>{diff.fallback.message ?? diff.fallback.reasonCode ?? localize(locale, "Nội dung diff không sẵn sàng", "Diff content unavailable")}</span></div>}
      {diff.hunks.map((hunk, index) => <section className="diff-hunk" key={hunk.hunkRef} aria-label={`${localize(locale, "Vùng thay đổi", "Change region")} ${index + 1}`}>
        <div className="hunk-header"><span>{hunk.header}</span>
          <span className="hunk-actions">
          {mutation.value?.state === "ready" && mutation.value.target?.hunkRefs.includes(hunk.hunkRef) && <button type="button"
            disabled={!mutationEnabled || mutationBusy} onClick={() => onMutation([hunk.hunkRef])}>
            {mutation.value.action === "source.stage" ? "Stage hunk" : "Unstage hunk"}
          </button>}
          {revert.value?.state === "ready" && revert.value.target && revert.value.preview?.hunks.some((item) => item.hunkRef === hunk.hunkRef)
            && <button className="revert-action" type="button"
            disabled={!revertEnabled || revertBusy} onClick={() => onRevert(hunk.hunkRef)}>Revert hunk</button>}
          </span>
        </div>
        <div className={mode === "split" ? "split-code" : "inline-code"}>{hunk.lines.map((line) => <DiffLine key={line.lineRef}
          line={line} side={mode} path={diff.file.path} />)}</div>
        {diff.unchangedRegions[index] && <div className="unchanged-region">… {diff.unchangedRegions[index].lineCount} {localize(locale, "dòng không đổi đã thu gọn", "unchanged lines collapsed")} …</div>}
      </section>)}
      {diff.truncation.truncated && <div className="diff-fallback"><strong>{localize(locale, "Diff đã rút gọn", "Diff truncated")}</strong><span>{localize(locale, "Còn", "Another")} {diff.truncation.omittedLines} {localize(locale, "dòng chưa hiển thị.", "lines are not shown.")}</span></div>}
    </Box>
  );
}

export function SourceWorkspace({ snapshot, refreshSnapshot, sessionRef }: { snapshot: PiagentWebUICanonicalSnapshotV1;
  refreshSnapshot?: () => Promise<PiagentWebUICanonicalSnapshotV1 | undefined>; sessionRef?: string }) {
  const { locale } = useUiPreferences();
  const hasTaskView = Boolean(snapshot.task && snapshot.sourceChanges.task?.state !== "unavailable" && snapshot.sourceChanges.task?.revision);
  const availableTabs = useMemo(() => localizedSourceTabs(locale), [locale]);
  const [view, setView] = useState<View>(() => hasTaskView ? "task" : "working-tree");
  const [documents, setDocuments] = useState<Partial<Record<View, SourceDocumentLoadState>>>({});
  const [selectedFileRef, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<SourceDetailLoadState<PiagentWebUIBoundedFileDiffV1>>({ state: "idle" });
  const [review, setReview] = useState<SourceDetailLoadState<PiagentWebUIDigestBoundSelectedFileReviewStateV1>>({ state: "idle" });
  const [mutation, setMutation] = useState<SourceDetailLoadState<PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1>>({ state: "idle" });
  const [revert, setRevert] = useState<SourceDetailLoadState<PiagentWebUIConfirmedExactSourceRevertPreviewV1>>({ state: "idle" });
  const [revertConfirmation, setRevertConfirmation] = useState<PiagentWebUIConfirmedExactSourceRevertPreviewV1 | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [openStatus, setOpenStatus] = useState<string | null>(null);
  const [sourceActionWarning, setSourceActionWarning] = useState<BoundSourceWarning | null>(null);
  const [commitSummary, setCommitSummary] = useState<LoadState<PiagentWebUIDeterministicStagedCommitSummaryV1>>({ state: "idle" });
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitStatus, setCommitStatus] = useState<string | null>(null);
  const [modelSummaryConfirmation, setModelSummaryConfirmation] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [mode, setMode] = useState<"inline" | "split">("inline");
  const sourceBinding: SourceSnapshotBinding = { sourceProjectionRevision: snapshot.sourceChanges.projectionRevision ?? null,
    taskViewRevision: snapshot.sourceChanges.task.revision, workspaceRevision: snapshot.sourceChanges.workingTree.revision,
    indexRevision: snapshot.sourceChanges.staged.revision };
  const revisions = sourceSnapshotRevisionKey(sourceBinding, snapshot.identity);
  const sourceRequestKey = [revisions, refreshEpoch].join("\u001e");
  const detailRevisions = [revisions, snapshot.revision.taskRevision ?? "no-task-revision"].join("\u001e");
  const sourceRecoveryScope = [sessionRef ?? "default-session", view, snapshot.identity.projectRef,
    snapshot.identity.runtimeInstanceId, snapshot.identity.sessionRef, snapshot.identity.taskId ?? "no-task",
    snapshot.identity.taskRunId ?? "no-run"].join("\u001e");
  const sourceRecoveryScopeRef = useRef(sourceRecoveryScope); sourceRecoveryScopeRef.current = sourceRecoveryScope;
  const sourceRecoveryGenerationRef = useRef(0), previousSourceRecoveryScopeRef = useRef(sourceRecoveryScope);
  if (previousSourceRecoveryScopeRef.current !== sourceRecoveryScope) {
    previousSourceRecoveryScopeRef.current = sourceRecoveryScope;
    sourceRecoveryGenerationRef.current += 1;
  }
  const sourceRecoveryGeneration = sourceRecoveryGenerationRef.current;
  const sourceResyncAttemptRef = useRef<string | null>(null);

  const loadedView = documents[view];
  const currentViewDocument = loadedView?.state === "ready"
    ? currentSourceDocument(loadedView.value, loadedView.revisionKey, sourceRequestKey, sourceBinding, snapshot.identity, view) : null;
  const active: LoadState<PiagentWebUISourceChangeViewV1> | undefined = loadedView?.state === "ready" && !currentViewDocument
    ? { state: "loading" } : loadedView;
  const viewFiles = currentViewDocument?.files ?? [];
  const selected = activeFileRef(viewFiles, selectedFileRef);
  const selectedFile = selected ? viewFiles.find((file) => file.fileRef === selected) ?? null : null;
  const detailCurrent = Boolean(currentViewDocument && selectedFile);
  const reviewCapability = snapshot.capabilities.capabilities.reviewActions;
  const reviewCapabilityKey = JSON.stringify(reviewCapability);
  const mutationAction = view === "working-tree" ? "source.stage" : view === "staged" ? "source.unstage" : null;
  const expectsReview = reviewCapability.status === "available" && reviewCapability.actions.reviewMark.available;
  const expectsMutation = mutationAction === "source.stage" ? reviewCapability.status === "available" && reviewCapability.actions.stage.available
    : mutationAction === "source.unstage" ? reviewCapability.status === "available" && reviewCapability.actions.unstage.available : false;
  const expectsRevert = view === "working-tree" && reviewCapability.status === "available" && reviewCapability.actions.revert.available;
  const detailRequestKey = detailCurrent ? [sessionRef ?? "default-session", view, selected, currentViewDocument!.viewRevision,
    selectedFile!.fileRevision, detailRevisions, refreshEpoch, reviewCapabilityKey].join("\u001e") : "no-detail-request";
  const diffMatches = Boolean(detailCurrent && diff.requestKey === detailRequestKey && diff.state === "ready"
    && sourceDiffMatchesSnapshot(diff.value, view, selected!,
    currentViewDocument!.viewRevision, selectedFile!.fileRevision, snapshot));
  const reviewMatches = Boolean(detailCurrent && review.requestKey === detailRequestKey && review.state === "ready"
    && sourceDetailProjectionMatchesSnapshot(review.value, view, selected!,
    currentViewDocument!.viewRevision, selectedFile!.fileRevision, snapshot, diffMatches ? diff.value : undefined));
  const mutationMatches = Boolean(detailCurrent && mutation.requestKey === detailRequestKey && mutation.state === "ready"
    && sourceDetailProjectionMatchesSnapshot(mutation.value, view, selected!,
    currentViewDocument!.viewRevision, selectedFile!.fileRevision, snapshot, diffMatches ? diff.value : undefined));
  const revertMatches = Boolean(detailCurrent && revert.requestKey === detailRequestKey && revert.state === "ready"
    && sourceDetailProjectionMatchesSnapshot(revert.value, view, selected!,
    currentViewDocument!.viewRevision, selectedFile!.fileRevision, snapshot, diffMatches ? diff.value : undefined));
  const diffMismatch = Boolean(detailCurrent && diff.requestKey === detailRequestKey && diff.state === "ready" && !diffMatches);
  const reviewMismatch = Boolean(detailCurrent && review.requestKey === detailRequestKey && review.state === "ready" && !reviewMatches);
  const mutationMismatch = Boolean(detailCurrent && mutation.requestKey === detailRequestKey && mutation.state === "ready" && !mutationMatches);
  const revertMismatch = Boolean(detailCurrent && revert.requestKey === detailRequestKey && revert.state === "ready" && !revertMatches);
  const diffLoadError = Boolean(detailCurrent && diff.requestKey === detailRequestKey && diff.state === "error");
  const reviewLoadError = Boolean(detailCurrent && expectsReview && review.requestKey === detailRequestKey && review.state === "error");
  const mutationLoadError = Boolean(detailCurrent && expectsMutation && mutation.requestKey === detailRequestKey && mutation.state === "error");
  const revertLoadError = Boolean(detailCurrent && expectsRevert && revert.requestKey === detailRequestKey && revert.state === "error");
  const detailMismatch = diffMismatch || reviewMismatch || mutationMismatch || revertMismatch;
  const detailLoadError = diffLoadError || reviewLoadError || mutationLoadError || revertLoadError;
  const detailRecoveryRequired = detailMismatch || detailLoadError;
  const detailReadsCurrent = Boolean(detailCurrent && diffMatches && (!expectsReview || reviewMatches)
    && (!expectsMutation || mutationMatches) && (!expectsRevert || revertMatches));
  const lastDetailSelectionRef = useRef<{ sourceScope: string; fileRef: string } | null>(null);
  if (selected) lastDetailSelectionRef.current = { sourceScope: sourceRecoveryScope, fileRef: selected };
  const recoveryFileRef = selected ?? (lastDetailSelectionRef.current?.sourceScope === sourceRecoveryScope
    ? lastDetailSelectionRef.current.fileRef : "no-file");
  const detailRecoveryScope = [sourceRecoveryScope, recoveryFileRef].join("\u001e");
  const detailRecoveryScopeRef = useRef(detailRecoveryScope); detailRecoveryScopeRef.current = detailRecoveryScope;
  const detailRecoveryAttemptsRef = useRef<Set<string>>(new Set());
  const detailRecoveryGenerationRef = useRef(0), previousDetailRecoveryScopeRef = useRef(detailRecoveryScope);
  if (previousDetailRecoveryScopeRef.current !== detailRecoveryScope) {
    previousDetailRecoveryScopeRef.current = detailRecoveryScope;
    detailRecoveryGenerationRef.current += 1;
  }
  const detailRecoveryGeneration = detailRecoveryGenerationRef.current;
  const [detailRecoveryPending, setDetailRecoveryPending] = useState<{
    scope: string; generation: number; requestKey: string;
  } | null>(null);
  const detailMismatchRecovering = Boolean(detailRecoveryRequired && refreshSnapshot
    && (!detailRecoveryAttemptsRef.current.has(detailRecoveryScope)
      || (detailRecoveryPending?.scope === detailRecoveryScope
        && detailRecoveryPending.generation === detailRecoveryGeneration
        && detailRecoveryPending.requestKey === detailRequestKey)));
  const presentedDiff: LoadState<PiagentWebUIBoundedFileDiffV1> = !detailCurrent ? { state: "idle" }
    : diff.requestKey !== detailRequestKey ? { state: "loading" }
    : (diffMismatch || diffLoadError) && detailMismatchRecovering ? { state: "loading" }
    : diffMismatch || diffLoadError ? { state: "error" } : diff;
  const presentedReview: LoadState<PiagentWebUIDigestBoundSelectedFileReviewStateV1> = !detailCurrent ? { state: "idle" }
    : !expectsReview ? { state: "idle" } : review.requestKey !== detailRequestKey ? { state: "loading" }
    : detailMismatchRecovering ? { state: "loading" }
    : reviewMismatch || reviewLoadError ? { state: "error" } : review;
  const presentedMutation: LoadState<PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1> = !detailCurrent ? { state: "idle" }
    : !expectsMutation ? { state: "idle" } : mutation.requestKey !== detailRequestKey ? { state: "loading" }
    : detailMismatchRecovering ? { state: "loading" }
    : mutationMismatch || mutationLoadError ? { state: "error" } : mutation;
  const presentedRevert: LoadState<PiagentWebUIConfirmedExactSourceRevertPreviewV1> = !detailCurrent ? { state: "idle" }
    : !expectsRevert ? { state: "idle" } : revert.requestKey !== detailRequestKey ? { state: "loading" }
    : detailMismatchRecovering ? { state: "loading" }
    : revertMismatch || revertLoadError ? { state: "error" } : revert;
  const actionAuthority = detailCurrent ? [sessionRef ?? "default-session", view, selected,
    currentViewDocument!.viewRevision, selectedFile!.fileRevision, detailRevisions].join("\u001e") : "no-source-authority";
  const actionAuthorityRef = useRef(actionAuthority); actionAuthorityRef.current = actionAuthority;
  const commandAuthority = [actionAuthority, snapshot.revision.runtimeRevision, snapshot.revision.controlRevision ?? "no-control-revision",
    snapshot.revision.approvalRevision ?? "no-approval-revision", snapshot.revision.sessionOptionRevision ?? "no-session-option-revision",
    snapshot.revision.queueRevision ?? "no-queue-revision"].join("\u001e");
  const commandAuthorityRef = useRef(commandAuthority); commandAuthorityRef.current = commandAuthority;
  const stagedAuthority = [sessionRef ?? "default-session", snapshot.identity.projectRef, snapshot.identity.runtimeInstanceId,
    snapshot.identity.sessionRef, snapshot.identity.taskId ?? "no-task", snapshot.identity.taskRunId ?? "no-run",
    snapshot.revision.taskRevision ?? "no-task-revision", snapshot.sourceChanges.staged.revision ?? "no-index-revision"].join("\u001e");
  const stagedAuthorityRef = useRef(stagedAuthority); stagedAuthorityRef.current = stagedAuthority;
  const reviewSelectionContextRef = useRef(""), reviewPreimageRef = useRef("");
  const reviewSelectionContext = [actionAuthority, reviewTargetKey(presentedReview.value)].join("\u001e");
  reviewSelectionContextRef.current = reviewSelectionContext;
  reviewPreimageRef.current = reviewPreimageKey(presentedReview.value);

  useEffect(() => { setCommitSummary({ state: "idle" }); setCommitStatus(null); setModelSummaryConfirmation(false); }, [stagedAuthority]);

  useEffect(() => {
    if (!hasTaskView && view === "task") { setView("working-tree"); setSelected(null); }
  }, [hasTaskView, view]);

  useEffect(() => { sourceResyncAttemptRef.current = null; setSourceActionWarning(null); },
    [sourceRecoveryScope, sourceRecoveryGeneration]);
  useEffect(() => {
    if (!detailReadsCurrent) return;
    detailRecoveryAttemptsRef.current.delete(detailRecoveryScope);
    setDetailRecoveryPending((current) => current?.scope === detailRecoveryScope ? null : current);
  }, [detailReadsCurrent, detailRecoveryScope]);

  useEffect(() => {
    const controller = new AbortController();
    const requestRevisionKey = sourceRequestKey;
    setDocuments((current) => ({ ...current, [view]: { state: "loading", revisionKey: requestRevisionKey } }));
    const request = sessionRef ? readSessionSourceChanges(sessionRef, view, controller.signal) : readSourceChanges(view, controller.signal);
    void request.then((value) => {
      if (!value) {
        if (!controller.signal.aborted) setDocuments((current) => ({ ...current, [view]: { state: "error", revisionKey: requestRevisionKey } }));
        return;
      }
      if (!sourceDocumentMatchesSnapshot(value, view, sourceBinding, snapshot.identity)) {
        if (controller.signal.aborted) return;
        if (!refreshSnapshot || sourceResyncAttemptRef.current === sourceRecoveryScope) {
          setDocuments((current) => ({ ...current, [view]: { state: "error", revisionKey: requestRevisionKey } }));
          return;
        }
        sourceResyncAttemptRef.current = sourceRecoveryScope;
        setDocuments((current) => ({ ...current, [view]: { state: "loading", revisionKey: requestRevisionKey } }));
        void refreshSnapshot().then((next) => {
          if (controller.signal.aborted) return;
          if (!next) {
            setDocuments((current) => ({ ...current, [view]: { state: "error", revisionKey: requestRevisionKey } }));
            return;
          }
          setRefreshEpoch((epoch) => epoch + 1);
        }).catch(() => {
          if (!controller.signal.aborted)
            setDocuments((current) => ({ ...current, [view]: { state: "error", revisionKey: requestRevisionKey } }));
        });
        return;
      }
      sourceResyncAttemptRef.current = null;
      if (!controller.signal.aborted) setDocuments((current) => ({ ...current, [view]: { state: "ready", value, revisionKey: requestRevisionKey } }));
    }).catch(() => { if (!controller.signal.aborted) setDocuments((current) => ({ ...current, [view]: { state: "error", revisionKey: requestRevisionKey } })); });
    return () => controller.abort();
  }, [view, sourceRequestKey, sessionRef]);

  const retrySourceList = useCallback(() => {
    const submittedScope = sourceRecoveryScope, submittedGeneration = sourceRecoveryGeneration,
      submittedRevisionKey = revisions;
    sourceResyncAttemptRef.current = null;
    setDocuments((current) => ({ ...current, [view]: { state: "loading", revisionKey: sourceRequestKey } }));
    void (async () => {
      let next: PiagentWebUICanonicalSnapshotV1 | undefined;
      try { next = await refreshSnapshot?.(); } catch { /* The explicit source retry still runs below. */ }
      if (sourceRecoveryScopeRef.current !== submittedScope
        || sourceRecoveryGenerationRef.current !== submittedGeneration) return;
      // The explicit click is the one recovery attempt for this scope. Mark it
      // before the source read starts so a still-stale response cannot cascade
      // into another hidden snapshot refresh.
      sourceResyncAttemptRef.current = submittedScope;
      const nextRevisionKey = next ? sourceSnapshotRevisionKey({
        sourceProjectionRevision: next.sourceChanges.projectionRevision ?? null,
        taskViewRevision: next.sourceChanges.task.revision,
        workspaceRevision: next.sourceChanges.workingTree.revision,
        indexRevision: next.sourceChanges.staged.revision
      }, next.identity) : submittedRevisionKey;
      if (!next || nextRevisionKey === submittedRevisionKey) setRefreshEpoch((epoch) => epoch + 1);
    })();
  }, [refreshSnapshot, revisions, sourceRecoveryGeneration, sourceRecoveryScope, sourceRequestKey, view]);

  useEffect(() => {
    if (!selected) {
      setDiff({ state: "idle" }); setReview({ state: "idle" }); setMutation({ state: "idle" }); setRevert({ state: "idle" });
      setReviewError(null); setMutationError(null); setRevertError(null); setRevertConfirmation(null); setOpenStatus(null);
      return;
    }
    const controller = new AbortController(), requestKey = detailRequestKey;
    setDiff({ state: "loading", requestKey }); setReviewError(null);
    setMutationError(null); setRevertError(null); setRevertConfirmation(null); setOpenStatus(null);
    setReview(expectsReview ? { state: "loading", requestKey } : { state: "idle" });
    setMutation(expectsMutation ? { state: "loading", requestKey } : { state: "idle" });
    setRevert(expectsRevert ? { state: "loading", requestKey } : { state: "idle" });
    const diffRequest = sessionRef ? readSessionFileDiff(sessionRef, view, selected, controller.signal) : readFileDiff(view, selected, controller.signal);
    void diffRequest.then((value) => { if (!controller.signal.aborted) setDiff({ state: "ready", value, requestKey }); })
      .catch(() => { if (!controller.signal.aborted) setDiff({ state: "error", requestKey }); });
    if (expectsReview) {
      const request = sessionRef ? readSessionReviewState(sessionRef, view, selected, controller.signal) : readReviewState(view, selected, controller.signal);
      void request.then((value) => { if (!controller.signal.aborted) setReview({ state: "ready", value, requestKey }); })
        .catch(() => { if (!controller.signal.aborted) setReview({ state: "error", requestKey }); });
    }
    if (expectsMutation && mutationAction) {
      const request = sessionRef ? readSessionSourceMutation(sessionRef, mutationAction, selected, controller.signal)
        : readSourceMutation(mutationAction, selected, controller.signal);
      void request.then((value) => { if (!controller.signal.aborted) setMutation({ state: "ready", value, requestKey }); })
        .catch(() => { if (!controller.signal.aborted) setMutation({ state: "error", requestKey }); });
    }
    if (expectsRevert) {
      const request = sessionRef ? readSessionSourceRevert(sessionRef, selected, null, controller.signal)
        : readSourceRevert(selected, null, controller.signal);
      void request.then((value) => { if (!controller.signal.aborted) setRevert({ state: "ready", value, requestKey }); })
        .catch(() => { if (!controller.signal.aborted) setRevert({ state: "error", requestKey }); });
    }
    return () => controller.abort();
  }, [selected, view, detailRevisions, refreshEpoch, sessionRef, reviewCapabilityKey, detailRequestKey]);

  const beginDetailRecovery = useCallback((explicit: boolean) => {
    if (!detailCurrent || !refreshSnapshot) return;
    const submittedScope = detailRecoveryScope, submittedGeneration = detailRecoveryGeneration,
      submittedRequestKey = detailRequestKey;
    if (!explicit && detailRecoveryAttemptsRef.current.has(submittedScope)) return;
    detailRecoveryAttemptsRef.current.add(submittedScope);
    setDetailRecoveryPending({ scope: submittedScope, generation: submittedGeneration, requestKey: submittedRequestKey });
    void refreshSnapshot().then((next) => {
      if (next && detailRecoveryScopeRef.current === submittedScope
        && detailRecoveryGenerationRef.current === submittedGeneration) setRefreshEpoch((epoch) => epoch + 1);
    }).catch(() => undefined).finally(() => {
      setDetailRecoveryPending((current) => current?.scope === submittedScope && current.generation === submittedGeneration
        && current.requestKey === submittedRequestKey ? null : current);
    });
  }, [detailCurrent, detailRecoveryGeneration, detailRecoveryScope, detailRequestKey, refreshSnapshot]);

  useEffect(() => {
    if (!detailCurrent || !detailRecoveryRequired || !refreshSnapshot
      || detailRecoveryAttemptsRef.current.has(detailRecoveryScope)) return;
    beginDetailRecovery(false);
  }, [beginDetailRecovery, detailCurrent, detailRecoveryRequired, detailRecoveryScope, refreshSnapshot]);

  const files = viewFiles;
  const fileGroups = useMemo(() => {
    const groups = new Map<string, FileChange[]>();
    for (const file of files) {
      const slash = file.path.lastIndexOf("/");
      const directory = slash < 0 ? localize(locale, "Gốc project", "Project root") : file.path.slice(0, slash);
      groups.set(directory, [...(groups.get(directory) ?? []), file]);
    }
    return [...groups.entries()];
  }, [files, locale]);
  const counts = useMemo(() => {
    const fallback: Record<View, number> = { task: snapshot.sourceChanges.task.counts.files,
      "working-tree": snapshot.sourceChanges.workingTree.counts.files, staged: snapshot.sourceChanges.staged.counts.files };
    const currentCount = (candidate: View): number => {
      const document = documents[candidate];
      const current = document?.state === "ready"
        ? currentSourceDocument(document.value, document.revisionKey, sourceRequestKey, sourceBinding, snapshot.identity, candidate) : null;
      return current?.page.total ?? fallback[candidate];
    };
    return { task: currentCount("task"), "working-tree": currentCount("working-tree"), staged: currentCount("staged") };
  }, [documents, sourceRequestKey, snapshot.sourceChanges.task.counts.files, snapshot.sourceChanges.workingTree.counts.files,
    snapshot.sourceChanges.staged.counts.files]);
  const selectView = (next: View) => { setSourceActionWarning(null); setView(next); setSelected(null); };
  const reviewEnabled = reviewCapability.status === "available" && reviewCapability.actions.reviewMark.available;
  const mutationEnabled = presentedMutation.value?.action === "source.stage" ? reviewCapability.status === "available" && reviewCapability.actions.stage.available
    : presentedMutation.value?.action === "source.unstage" ? reviewCapability.status === "available" && reviewCapability.actions.unstage.available : false;
  const revertEnabled = reviewCapability.status === "available" && reviewCapability.actions.revert.available;
  const openEnabled = view === "working-tree" && reviewCapability.status === "available" && reviewCapability.actions.openInVsCode.available
    && presentedDiff.state === "ready" && presentedDiff.value?.availability.state === "current" && presentedDiff.value.fallback.kind === "none";
  const stagedFilesPresent = view === "staged" && files.length > 0;
  const deterministicSummaryEnabled = stagedFilesPresent && reviewCapability.status === "available"
    && reviewCapability.actions.generateCommitSummaryDeterministic.available;
  const modelSummaryEnabled = stagedFilesPresent && reviewCapability.status === "available" && reviewCapability.actions.generateCommitSummaryModel.available;
  const commitSummaryIsCurrent = (value: PiagentWebUIDeterministicStagedCommitSummaryV1 | undefined): boolean => {
    if (!value || value.identity.projectRef !== snapshot.identity.projectRef
      || value.identity.runtimeInstanceId !== snapshot.identity.runtimeInstanceId || value.identity.sessionRef !== snapshot.identity.sessionRef
      || value.identity.taskId !== snapshot.identity.taskId || value.identity.taskRunId !== snapshot.identity.taskRunId) return false;
    if (!value.summary) return value.state === "unavailable";
    return value.summary.taskRevision === snapshot.revision.taskRevision
      && value.summary.indexRevision === snapshot.sourceChanges.staged.revision;
  };
  const markReview = async (next: "reviewed" | "unreviewed") => {
    if (!selected || !presentedReview.value || reviewBusy) return;
    const submittedReview = presentedReview.value, submittedPreimage = reviewPreimageKey(submittedReview),
      submittedSelectionContext = reviewSelectionContextRef.current, submittedCommandAuthority = commandAuthorityRef.current,
      submittedSourceScope = sourceRecoveryScope, submittedSourceGeneration = sourceRecoveryGeneration,
      submittedDetailScope = detailRecoveryScope, submittedDetailGeneration = detailRecoveryGeneration,
      submittedRevisionKey = revisions;
    let effectMayHaveStarted = false;
    setReviewBusy(true); setReviewError(null); setSourceActionWarning(null);
    try {
      const command = await createReviewCommand(snapshot, submittedReview, next);
      if (reviewSelectionContextRef.current !== submittedSelectionContext || reviewPreimageRef.current !== submittedPreimage
        || commandAuthorityRef.current !== submittedCommandAuthority) return;
      const idempotencyKeyDigest = await digestText(command.idempotencyKey);
      if (reviewSelectionContextRef.current !== submittedSelectionContext || reviewPreimageRef.current !== submittedPreimage
        || commandAuthorityRef.current !== submittedCommandAuthority) return;
      effectMayHaveStarted = true;
      const receipt = await sendReviewCommand(command);
      if (!validReviewSettlement(command, receipt, next, idempotencyKeyDigest)) {
        if (receipt.phase !== "rejected") {
          await reconcileUncertainSource(submittedSourceScope, submittedSourceGeneration, submittedDetailScope,
            submittedDetailGeneration, submittedRevisionKey, localize(locale,
              "Chưa xác nhận được receipt review. Piagent đã đọc lại trạng thái chính thức và sẽ không tự gửi lại lệnh.",
              "The review receipt is unconfirmed. Piagent reloaded canonical state and will not resend the command."));
          return;
        }
        if (reviewSelectionContextRef.current === submittedSelectionContext && reviewPreimageRef.current === submittedPreimage) setReviewError(receipt.error?.message
          ?? localize(locale, "Không xác nhận được trạng thái review chính xác; hãy tải lại diff.", "The exact review state could not be confirmed; reload the diff."));
        return;
      }
      if (reviewSelectionContextRef.current !== submittedSelectionContext || reviewPreimageRef.current !== submittedPreimage) return;
      setReview((current) => reviewSelectionContextRef.current === submittedSelectionContext && reviewPreimageKey(current.value) === submittedPreimage
        ? { state: "ready", requestKey: current.requestKey, value: {
          ...submittedReview, generatedAt: receipt.settledAt!, state: receipt.resultCode as "reviewed" | "unreviewed",
          recordedState: receipt.resultCode as "reviewed" | "unreviewed", recordedAt: receipt.settledAt!, evidenceRef: receipt.settlementEvidenceRef!,
          reasonCode: null, health: { state: "ok", reasonCode: null, message: null }
        } } : current);
      const refresh = sessionRef ? readSessionReviewState(sessionRef, view, selected) : readReviewState(view, selected);
      void refresh.then((value) => setReview((current) => reviewSelectionContextRef.current === submittedSelectionContext && current.state === "ready"
        && current.value?.evidenceRef === receipt.settlementEvidenceRef ? { state: "ready", value, requestKey: current.requestKey } : current)).catch(() => undefined);
    } catch {
      if (effectMayHaveStarted) await reconcileUncertainSource(submittedSourceScope, submittedSourceGeneration, submittedDetailScope,
        submittedDetailGeneration, submittedRevisionKey, localize(locale,
          "Mất kết nối khi đang ghi review. Piagent đã đọc lại trạng thái chính thức và sẽ không tự gửi lại lệnh.",
          "The connection was lost while saving review. Piagent reloaded canonical state and will not resend the command."));
      else if (reviewSelectionContextRef.current === submittedSelectionContext && reviewPreimageRef.current === submittedPreimage)
        setReviewError(localize(locale, "Không thể ghi trạng thái review. Nội dung source không bị thay đổi.",
          "Unable to save review state. Source content was not changed."));
    }
    finally { setReviewBusy(false); }
  };
  const reconcileUncertainSource = async (submittedSourceScope: string, submittedSourceGeneration: number,
    submittedDetailScope: string, submittedDetailGeneration: number, submittedRevisionKey: string, warning: string) => {
    if (detailRecoveryScopeRef.current === submittedDetailScope
      && detailRecoveryGenerationRef.current === submittedDetailGeneration) {
      setDiff({ state: "idle" }); setReview({ state: "idle" }); setMutation({ state: "idle" });
      setRevert({ state: "idle" }); setRevertConfirmation(null); setReviewError(null); setMutationError(null);
      setRevertError(null); setOpenStatus(null); setSourceActionWarning(null);
    }
    let next: PiagentWebUICanonicalSnapshotV1 | undefined;
    try { next = await refreshSnapshot?.(); } catch { /* A canonical detail reload still follows below. */ }
    if (sourceRecoveryScopeRef.current !== submittedSourceScope
      || sourceRecoveryGenerationRef.current !== submittedSourceGeneration) return;
    const nextRevisionKey = next ? sourceSnapshotRevisionKey({
      sourceProjectionRevision: next.sourceChanges.projectionRevision ?? null,
      taskViewRevision: next.sourceChanges.task.revision,
      workspaceRevision: next.sourceChanges.workingTree.revision,
      indexRevision: next.sourceChanges.staged.revision
    }, next.identity) : submittedRevisionKey;
    if (!next || nextRevisionKey === submittedRevisionKey) setRefreshEpoch((value) => value + 1);
    setSourceActionWarning({ scope: submittedSourceScope, generation: submittedSourceGeneration, message: warning });
  };
  const mutateSource = async (hunkRefs: string[] = []) => {
    if (!selected || !currentViewDocument || !presentedMutation.value || presentedMutation.value.state !== "ready" || mutationBusy) return;
    const submittedAuthority = actionAuthorityRef.current, submittedCommandAuthority = commandAuthorityRef.current,
      submittedMutation = presentedMutation.value, submittedSourceScope = sourceRecoveryScope,
      submittedSourceGeneration = sourceRecoveryGeneration, submittedDetailScope = detailRecoveryScope,
      submittedDetailGeneration = detailRecoveryGeneration, submittedRevisionKey = revisions;
    let effectMayHaveStarted = false;
    setMutationBusy(true); setMutationError(null); setSourceActionWarning(null);
    try {
      const command = await createSourceMutationCommand(snapshot, submittedMutation, hunkRefs);
      if (actionAuthorityRef.current !== submittedAuthority || commandAuthorityRef.current !== submittedCommandAuthority) return;
      effectMayHaveStarted = true;
      const receipt = await sendSourceMutationCommand(command);
      if (receipt.phase === "uncertain") {
        await reconcileUncertainSource(submittedSourceScope, submittedSourceGeneration, submittedDetailScope,
          submittedDetailGeneration, submittedRevisionKey, localize(locale,
          "Chưa xác nhận được trạng thái Git. Piagent đã tải lại Source Changes và sẽ không tự gửi lại lệnh.",
          "Git state is unconfirmed. Piagent refreshed Source Changes and will not resend the command."));
        return;
      }
      if (receipt.phase !== "settled" || !["staged", "unstaged"].includes(receipt.resultCode)) {
        if (actionAuthorityRef.current === submittedAuthority) setMutationError(receipt.error?.message
          ?? localize(locale, "File hoặc Git index đã thay đổi; hãy tải lại preview.", "The file or Git index changed; reload the preview."));
        return;
      }
      if (actionAuthorityRef.current === submittedAuthority) setSelected(null);
      await refreshSnapshot?.(); setRefreshEpoch((value) => value + 1);
    } catch {
      if (effectMayHaveStarted) await reconcileUncertainSource(submittedSourceScope, submittedSourceGeneration,
        submittedDetailScope, submittedDetailGeneration, submittedRevisionKey, localize(locale,
        "Mất kết nối khi đang cập nhật Git. Piagent đã tải lại Source Changes và sẽ không tự gửi lại lệnh.",
        "The connection was lost while updating Git. Piagent refreshed Source Changes and will not resend the command."));
      else if (actionAuthorityRef.current === submittedAuthority) setMutationError(localize(locale,
        "Không thể chuẩn bị lệnh cập nhật Git; source chưa bị thay đổi.", "Unable to prepare the Git update; source was not changed."));
    }
    finally { setMutationBusy(false); }
  };
  const requestRevert = async (hunkRef: string | null) => {
    if (!selected || !currentViewDocument || !revertEnabled || revertBusy) return;
    const submittedAuthority = actionAuthorityRef.current, submittedFileRef = selected;
    setRevertBusy(true); setRevertError(null); setSourceActionWarning(null);
    try {
      const preview = sessionRef ? await readSessionSourceRevert(sessionRef, submittedFileRef, hunkRef) : await readSourceRevert(submittedFileRef, hunkRef);
      if (actionAuthorityRef.current !== submittedAuthority) return;
      if (preview.state !== "ready" || !preview.target) {
        setRevertError(localize(locale, "Không thể hoàn tác an toàn: provenance hoặc diff hiện tại không còn đủ bằng chứng.", "Safe revert is unavailable because provenance or the current diff lacks evidence.")); return;
      }
      setRevertConfirmation(preview);
    } catch {
      if (actionAuthorityRef.current === submittedAuthority) setRevertError(localize(locale,
        "Không thể dựng preview hoàn tác. Source chưa bị thay đổi.", "Unable to build a revert preview. Source was not changed."));
    }
    finally { setRevertBusy(false); }
  };
  const confirmRevert = async () => {
    if (!revertConfirmation?.target || !selected || !currentViewDocument || !selectedFile || revertBusy
      || !sourceDetailTargetMatches(revertConfirmation.target, view, selected, currentViewDocument.viewRevision,
        selectedFile.fileRevision, snapshot)) return;
    const submittedAuthority = actionAuthorityRef.current, submittedCommandAuthority = commandAuthorityRef.current,
      submittedPreview = revertConfirmation, submittedSourceScope = sourceRecoveryScope,
      submittedSourceGeneration = sourceRecoveryGeneration, submittedDetailScope = detailRecoveryScope,
      submittedDetailGeneration = detailRecoveryGeneration, submittedRevisionKey = revisions;
    let effectMayHaveStarted = false;
    setRevertBusy(true); setRevertError(null); setSourceActionWarning(null);
    try {
      const command = await createSourceRevertCommand(snapshot, submittedPreview);
      if (actionAuthorityRef.current !== submittedAuthority || commandAuthorityRef.current !== submittedCommandAuthority) return;
      effectMayHaveStarted = true;
      const receipt = await sendSourceRevertCommand(command);
      if (receipt.phase === "uncertain") {
        await reconcileUncertainSource(submittedSourceScope, submittedSourceGeneration, submittedDetailScope,
          submittedDetailGeneration, submittedRevisionKey, localize(locale,
          "Chưa xác nhận được kết quả revert. Piagent đã tải lại Source Changes và sẽ không tự gửi lại lệnh.",
          "The revert result is unconfirmed. Piagent refreshed Source Changes and will not resend the command."));
        return;
      }
      if (receipt.phase !== "settled" || receipt.resultCode !== "reverted") {
        if (actionAuthorityRef.current === submittedAuthority) setRevertError(receipt.error?.message
          ?? localize(locale, "Preview đã cũ; hãy mở lại trước khi xác nhận.", "The preview is stale; reopen it before confirming."));
        return;
      }
      if (actionAuthorityRef.current === submittedAuthority) { setRevertConfirmation(null); setSelected(null); }
      await refreshSnapshot?.(); setRefreshEpoch((value) => value + 1);
    } catch {
      if (effectMayHaveStarted) await reconcileUncertainSource(submittedSourceScope, submittedSourceGeneration,
        submittedDetailScope, submittedDetailGeneration, submittedRevisionKey, localize(locale,
        "Mất kết nối khi đang revert. Piagent đã tải lại Source Changes và sẽ không tự gửi lại lệnh.",
        "The connection was lost during revert. Piagent refreshed Source Changes and will not resend the command."));
      else if (actionAuthorityRef.current === submittedAuthority) setRevertError(localize(locale,
        "Không thể chuẩn bị lệnh revert; source chưa bị thay đổi.", "Unable to prepare the revert command; source was not changed."));
    }
    finally { setRevertBusy(false); }
  };
  const openInVSCode = async () => {
    if (!selected || !openEnabled || openBusy) return;
    const submittedAuthority = actionAuthorityRef.current, submittedCommandAuthority = commandAuthorityRef.current,
      submittedFileRef = selected;
    setOpenBusy(true); setOpenStatus(null);
    try {
      const command = await createSourceOpenCommand(snapshot, submittedFileRef);
      if (actionAuthorityRef.current !== submittedAuthority || commandAuthorityRef.current !== submittedCommandAuthority) return;
      const receipt = await sendSourceOpenCommand(command);
      if (actionAuthorityRef.current !== submittedAuthority) return;
      if (receipt.phase === "settled" && receipt.resultCode === "opened") setOpenStatus(localize(locale, "VS Code đã nhận yêu cầu mở file.", "VS Code received the open-file request."));
      else setOpenStatus(receipt.phase === "uncertain" ? localize(locale, "Không xác nhận được VS Code đã nhận file. Piagent sẽ không tự mở lại.", "It is unknown whether VS Code received the file. Piagent will not retry automatically.")
        : receipt.error?.message ?? localize(locale, "File hoặc phiên làm việc đã thay đổi; hãy tải lại trước khi mở.", "The file or session changed; refresh before opening."));
    } catch {
      if (actionAuthorityRef.current === submittedAuthority) setOpenStatus(localize(locale,
        "Không thể mở file trong VS Code. Diff hiện tại vẫn được giữ nguyên.", "Unable to open the file in VS Code. The current diff remains available."));
    }
    finally { setOpenBusy(false); }
  };
  const generateCommitSummary = async () => {
    if (!deterministicSummaryEnabled || commitBusy) return;
    const submittedAuthority = stagedAuthorityRef.current;
    setCommitBusy(true); setCommitStatus(null); setCommitSummary({ state: "loading" });
    try {
      const value = sessionRef ? await readSessionCommitSummary(sessionRef) : await readCommitSummary();
      if (stagedAuthorityRef.current !== submittedAuthority) return;
      if (!commitSummaryIsCurrent(value)) {
        setCommitSummary({ state: "error" });
        setCommitStatus(localize(locale, "Staged Changes đã đổi trong lúc dựng summary; hãy tạo lại.",
          "Staged Changes changed while the summary was generated; generate it again."));
        return;
      }
      setCommitSummary({ state: "ready", value });
      if (value.state !== "ready") setCommitStatus(localize(locale, "Staged Changes đã thay đổi hoặc chưa có dữ liệu để tóm tắt.", "Staged Changes changed or has no data to summarize."));
    } catch {
      if (stagedAuthorityRef.current === submittedAuthority) {
        setCommitSummary({ state: "error" }); setCommitStatus(localize(locale,
          "Không thể dựng commit summary từ index hiện tại.", "Unable to generate a commit summary from the current index."));
      }
    }
    finally { setCommitBusy(false); }
  };
  const copyCommitSummary = async () => {
    const summary = commitSummary.value?.summary; if (!summary || !commitSummaryIsCurrent(commitSummary.value)) return;
    const submittedAuthority = stagedAuthorityRef.current;
    try {
      await navigator.clipboard.writeText([summary.title, "", ...summary.bodyLines].join("\n"));
      if (stagedAuthorityRef.current === submittedAuthority) setCommitStatus(localize(locale,
        "Đã copy summary. Chưa có commit nào được tạo.", "Summary copied. No commit was created."));
    } catch {
      if (stagedAuthorityRef.current === submittedAuthority) setCommitStatus(localize(locale,
        "Trình duyệt không cho phép copy tự động.", "The browser did not allow automatic copying."));
    }
  };
  const sendModelSummary = async () => {
    const summary = commitSummary.value?.summary;
    if (!summary || !commitSummaryIsCurrent(commitSummary.value) || !modelSummaryEnabled || commitBusy) return;
    const submittedAuthority = stagedAuthorityRef.current;
    setCommitBusy(true); setCommitStatus(null);
    try {
      const command = await createChatCommand(snapshot, summary.modelPrompt, "new-operation");
      if (stagedAuthorityRef.current !== submittedAuthority || !commitSummaryIsCurrent(commitSummary.value)) return;
      const receipt = await sendChatCommand(command);
      if (stagedAuthorityRef.current !== submittedAuthority) return;
      if (receipt.phase === "settled" && receipt.resultCode === "dispatch-observed")
        setCommitStatus(localize(locale, "Đã gửi yêu cầu sang Chat. Pi sẽ trả commit summary ở hội thoại; chưa commit hoặc push.", "Request sent to Chat. Pi will return the commit summary in the conversation; nothing was committed or pushed."));
      else setCommitStatus(receipt.phase === "uncertain" ? localize(locale, "Không xác nhận được yêu cầu đã tới Pi; hệ thống sẽ không tự gửi lại.", "It is unknown whether the request reached Pi; it will not be resent automatically.")
        : receipt.error?.message ?? localize(locale, "Không thể bắt đầu model work từ session hiện tại.", "Unable to start model work from the current session."));
    } catch {
      if (stagedAuthorityRef.current === submittedAuthority) setCommitStatus(localize(locale,
        "Không thể gửi yêu cầu sang Pi session hiện tại.", "Unable to send the request to the current Pi session."));
    }
    finally { setCommitBusy(false); setModelSummaryConfirmation(false); }
  };
  const visibleSourceActionWarning = sourceActionWarning?.scope === sourceRecoveryScope
    && sourceActionWarning.generation === sourceRecoveryGeneration ? sourceActionWarning.message : null;
  return (
    <Paper component="section" variant="outlined" className="source-workspace" aria-labelledby="source-title" sx={{ overflow: "hidden", minHeight: "calc(100vh - 120px)", display: "flex", flexDirection: "column" }}>
      <Box component="header" className="source-heading" sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: { xs: 2, sm: 2.5 }, py: 1.75, borderBottom: 1, borderColor: "divider" }}>
        <Box><Typography variant="overline" color="primary.main" sx={{ fontWeight: 800, letterSpacing: ".14em", lineHeight: 1 }}>Source changes</Typography><Typography variant="h2" id="source-title" sx={{ mt: .5 }}>{localize(locale, "Thay đổi trong project", "Project changes")}</Typography></Box>
        <Chip label="Git + task baseline" variant="outlined" size="small" />
      </Box>
      <Tabs className="source-tabs" value={view} onChange={(_, value: View) => selectView(value)} selectionFollowsFocus variant="scrollable" scrollButtons="auto"
        aria-label={localize(locale, "Nguồn thay đổi", "Change sources")} sx={{ borderBottom: 1, borderColor: "divider", minHeight: 48 }}>
        {availableTabs.map((tab) => <Tab key={tab.view} id={`source-tab-${tab.view}`} value={tab.view} aria-controls="source-tabpanel"
          disabled={tab.view === "task" && !hasTaskView} title={tab.view === "task" && !hasTaskView
            ? localize(locale, "Session này chưa có task baseline", "This session has no task baseline") : undefined}
          label={<Stack direction="row" spacing={1} sx={{ alignItems: "center" }}><span>{tab.label}</span>{counts[tab.view] > 0 && <Chip size="small"
            label={counts[tab.view]} sx={{ height: 20, minWidth: 24, "& .MuiChip-label": { px: .75 } }} />}</Stack>} />)}
      </Tabs>
      {view === "staged" && <CommitSummaryPanel state={commitSummary} busy={commitBusy} status={commitStatus} locale={locale}
        deterministicEnabled={deterministicSummaryEnabled} modelEnabled={modelSummaryEnabled}
        onGenerate={() => { void generateCommitSummary(); }} onCopy={() => { void copyCommitSummary(); }}
        onModel={() => setModelSummaryConfirmation(true)} />}
      <Box className="source-body" sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(286px, 330px) minmax(0, 1fr)" }, flex: 1, minHeight: 620 }}>
        <Box className="file-panel" id="source-tabpanel" role="tabpanel" aria-labelledby={`source-tab-${view}`} sx={{ minWidth: 0, borderRight: { md: 1 }, borderBottom: { xs: 1, md: 0 }, borderColor: "divider", bgcolor: "background.default" }}>
          <Box className="file-panel-meta" sx={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, px: 1.5, borderBottom: 1, borderColor: "divider" }}>
            <span aria-live="polite">{active?.state === "ready" && active.value ? sourceSummary(active.value, locale)
              : active?.state === "error" ? localize(locale, "Không thể tải danh sách file", "Unable to load files")
                : localize(locale, "Đang tải…", "Loading…")}</span>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              {active?.state === "error" && <button className="source-list-retry" type="button" onClick={retrySourceList}>
                {localize(locale, "Thử tải lại", "Retry")}
              </button>}
              <small>{availableTabs.find((tab) => tab.view === view)?.shortLabel}</small>
            </Stack>
          </Box>
          <Box className="file-list" sx={{ maxHeight: { xs: 300, md: "calc(100vh - 270px)" }, overflow: "auto", p: .75 }}>{fileGroups.map(([directory, group]) => <Box key={directory}>
            <Stack direction="row" className="file-group-label"><FolderOpenRounded /><Typography component="span" noWrap>{directory}</Typography></Stack>
            {group.map((file) => <FileRow key={file.fileRef} file={file} selected={file.fileRef === selected}
              onSelect={() => { setSourceActionWarning(null); setSelected(file.fileRef); }} locale={locale} />)}</Box>)}
            {active?.state === "ready" && files.length === 0 && <div className="files-empty">{localize(locale, "Không có thay đổi trong view này.", "No changes in this view.")}</div>}
          </Box>
        </Box>
        <DiffViewer state={presentedDiff} review={presentedReview} mutation={presentedMutation} revert={presentedRevert}
          reviewEnabled={reviewEnabled} reviewBusy={reviewBusy} reviewError={reviewError}
          mutationEnabled={mutationEnabled} mutationBusy={mutationBusy} mutationError={mutationError}
          revertEnabled={revertEnabled} revertBusy={revertBusy} openEnabled={openEnabled} openBusy={openBusy} openStatus={openStatus}
          detailError={detailRecoveryRequired && !detailMismatchRecovering}
          mode={mode} onMode={setMode} onReview={(value) => { void markReview(value); }}
          onMutation={(hunkRefs) => { void mutateSource(hunkRefs); }} onRevert={(hunkRef) => { void requestRevert(hunkRef); }}
          onOpen={() => { void openInVSCode(); }} onRetry={detailCurrent && refreshSnapshot
            ? () => beginDetailRecovery(true) : undefined} locale={locale} />
      </Box>
      {visibleSourceActionWarning && <div className="source-action-warning" role="status">{visibleSourceActionWarning}</div>}
      {revertError && <div className="source-revert-error" role="status">{revertError}</div>}
      {revertConfirmation?.target && selected && currentViewDocument && selectedFile
        && sourceDetailTargetMatches(revertConfirmation.target, view, selected, currentViewDocument.viewRevision,
          selectedFile.fileRevision, snapshot) && <div className="dialog-backdrop" role="presentation">
        <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="revert-dialog-title" aria-describedby="revert-dialog-description">
          <p className="section-kicker">{localize(locale, "Xác nhận hoàn tác", "Confirm revert")}</p>
          <h3 id="revert-dialog-title">Revert {revertConfirmation.target.hunkRefs.length ? "hunk" : "file"}?</h3>
          <p id="revert-dialog-description">{localize(locale, "Thao tác sẽ bỏ", "This will discard")} <strong>{revertConfirmation.target.summary.additionsDiscarded} {localize(locale, "dòng thêm", "added lines")}</strong> {localize(locale, "và khôi phục", "and restore")} <strong>{revertConfirmation.target.summary.deletionsRestored} {localize(locale, "dòng xóa", "deleted lines")}</strong> {localize(locale, "trong", "in")} <code>{revertConfirmation.target.path}</code>.</p>
          <div className="revert-diff" aria-label={localize(locale, "Các dòng chính xác sẽ được hoàn tác", "Exact lines to revert")}>
            {revertConfirmation.preview?.hunks.map((hunk) => <section key={hunk.hunkRef}>
              <div>{hunk.header}</div>
              {hunk.lines.map((line, index) => <code className={`revert-line revert-${line.kind}`} key={`${hunk.hunkRef}.${index}`}>
                <b>{line.marker}</b>{line.text}
              </code>)}
            </section>)}
          </div>
          <div className="revert-safety"><strong>{localize(locale, "Phần đã stage được giữ nguyên.", "Staged content is preserved.")}</strong><span>{localize(locale, "Không auto-commit. Khả năng khôi phục sau thao tác không được bảo đảm.", "No auto-commit. Recovery after this action is not guaranteed.")}</span></div>
          <div className="confirm-actions">
            <button type="button" disabled={revertBusy} onClick={() => setRevertConfirmation(null)}>{localize(locale, "Hủy", "Cancel")}</button>
            <button className="danger-action" type="button" disabled={revertBusy} onClick={() => { void confirmRevert(); }}>
              {revertBusy ? localize(locale, "Đang hoàn tác…", "Reverting…") : localize(locale, "Xác nhận revert", "Confirm revert")}
            </button>
          </div>
        </section>
      </div>}
      {modelSummaryConfirmation && commitSummaryIsCurrent(commitSummary.value) && <div className="dialog-backdrop" role="presentation">
        <section className="confirm-dialog model-summary-dialog" role="alertdialog" aria-modal="true"
          aria-labelledby="model-summary-dialog-title" aria-describedby="model-summary-dialog-description">
          <p className="section-kicker">{localize(locale, "Model work có tính phí", "Token-consuming model work")}</p>
          <h3 id="model-summary-dialog-title">{localize(locale, "Nhờ Pi viết lại commit summary?", "Ask Pi to rewrite the commit summary?")}</h3>
          <p id="model-summary-dialog-description">{localize(locale, "Thao tác này gửi một message vào đúng Pi session hiện tại, bắt đầu một Pi operation và tiêu token theo model/thinking đang chọn. Chỉ staged summary đã rút gọn được gửi; source text không được đính kèm.", "This sends a message to the exact current Pi session, starts a Pi operation, and consumes tokens using the selected model and thinking level. Only the bounded staged summary is sent; source text is not attached.")}</p>
          <div className="revert-safety"><strong>{localize(locale, "Không tự commit hoặc push.", "Does not commit or push.")}</strong><span>{localize(locale, "Kết quả sẽ xuất hiện trong Chat để anh review và copy.", "The result will appear in Chat for review and copying.")}</span></div>
          <div className="confirm-actions"><button type="button" disabled={commitBusy} onClick={() => setModelSummaryConfirmation(false)}>{localize(locale, "Hủy", "Cancel")}</button>
            <button type="button" disabled={commitBusy} onClick={() => { void sendModelSummary(); }}>{commitBusy ? localize(locale, "Đang gửi…", "Sending…") : localize(locale, "Xác nhận và gửi sang Pi", "Confirm and send to Pi")}</button></div>
        </section>
      </div>}
    </Paper>
  );
}
