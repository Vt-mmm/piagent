import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIBoundedFileDiffV1 } from "../../contracts/generated/diff-v1.ts";
import type { PiagentWebUIDigestBoundSelectedFileReviewStateV1 } from "../../contracts/generated/review-state-v1.ts";
import type { PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1 } from "../../contracts/generated/source-mutation-v1.ts";
import type { PiagentWebUIConfirmedExactSourceRevertPreviewV1 } from "../../contracts/generated/source-revert-v1.ts";
import type { PiagentWebUIDeterministicStagedCommitSummaryV1 } from "../../contracts/generated/commit-summary-v1.ts";
import type { Workflow } from "../../contracts/generated/session-command-v1.ts";
import type { Command as RuntimeCommand, Receipt as RuntimeReceipt } from "../../contracts/generated/runtime-command-v1.ts";
import type { PiagentWebUIAuthoritativeLocalTaskRunIndexV1 } from "../../contracts/generated/task-index-v1.ts";
import type { PiagentWebUIDurableTaskRecoveryTimelineV1 } from "../../contracts/generated/task-timeline-v1.ts";
import type { PiagentWebUIBoundedCompactionAndRecoveryHistoryV1 } from "../../contracts/generated/recovery-history-v1.ts";
import type { PiagentWebUIBoundedHandoffHistoryAndNextActionV1 } from "../../contracts/generated/handoff-history-v1.ts";
import type { PiagentWebUIBoundedSubagentOwnershipTreeV1 } from "../../contracts/generated/subagent-tree-v1.ts";
import type { PiagentWebUIBoundedBenchmarkAndReleaseMonitorV1 } from "../../contracts/generated/release-monitor-v1.ts";
import type { PiagentWebUISourceChangeViewV1, View } from "../../contracts/generated/source-change-v1.ts";
import type { PiagentWebUIBoundedTranscriptProjectionV1 } from "../../contracts/generated/transcript-v1.ts";
import type { PiagentWebUIHeldMessageQueueProjectionV1 } from "../../contracts/generated/queue-v1.ts";
import type { PiagentWebUIAuthenticatedModelCatalogV1 } from "../../contracts/generated/model-catalog-v1.ts";
import type { DiscardCommand, DiscardReceipt, StageCommand, StageReceipt } from "../../contracts/generated/attachment-v1.ts";
import type { Document as DocumentContent, Listing } from "../../contracts/generated/document-workspace-v1.ts";
import type { Command, Receipt } from "../../contracts/generated/control-command-v1.ts";
import type { ApprovalDecision, ApprovalReceipt, ApprovalRequest } from "../../contracts/generated/approval-v1.ts";
import type { Catalog } from "../../contracts/generated/session-catalog-v1.ts";
import type { PiagentWebUICanonicalVolatileSessionOperationStateV1 } from "../../contracts/generated/session-live-state-v1.ts";
import { browserCsrfToken } from "./bootstrap.ts";

export class WebUiRequestError extends Error {
  readonly status: number;
  constructor(status: number) { super(`webui-request-${status}`); this.status = status; }
}

export async function readSnapshot(signal?: AbortSignal): Promise<PiagentWebUICanonicalSnapshotV1> {
  const response = await fetch("/api/v1/snapshot", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal
  });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as PiagentWebUICanonicalSnapshotV1;
}

export function readSessionCatalog(signal?: AbortSignal): Promise<Catalog> {
  return readJson("/api/v1/session-catalog", signal);
}

export function readSessionLiveState(signal?: AbortSignal): Promise<PiagentWebUICanonicalVolatileSessionOperationStateV1> {
  return readJson("/api/v1/session-live-state", signal);
}

export type SessionCreationOptions = {
  schemaVersion: 1;
  version: "piagent-session-creation-options-v1";
  generatedAt: string;
  projects: Array<{ projectRef: string; placeRef: string; label: string }>;
  models: Array<{ modelRef: string; provider: string; modelId: string; displayName: string; reasoning: boolean; imageInput: boolean | null; thinkingLevels: string[] }>;
  defaultModelRef?: string | null;
  defaultThinkingLevel?: string | null;
  profiles?: Array<{ id: string; displayName: string; permissionMode: string | null }>;
  workflows?: Array<{ id: Workflow; changeMode: "source-change" | "read-only" | "plan-only" | "clarification" | "git" | "onboarding" | "platform";
    modelUse: "required"; recommendedFreshSession: boolean }>;
  runtimeActions?: Array<{ id: RuntimeCommand["action"]; category: "runtime" | "usage" | "onboarding" | "profile" | "context" | "memory" | "mcp";
    effect: "read-only" | "workspace-write" | "model-assisted"; argument: "none" | "optional-text" | "required-text" | "profile" | "connection";
    requiresConfirmation: boolean }>;
  webSearch?: { state: "configured" | "unavailable"; route: "codex-first" | "automatic" | null; provider: "openai-codex" | null;
    fallbackProvider: "exa" | null; integration: { name: "pi-web-access"; version: string } | null; reasonCode: string | null };
  projectImport?: { status: "available" | "unavailable"; reasonCode: string | null };
  reasonCode: string | null;
};

export function readSessionCreationOptions(signal?: AbortSignal): Promise<SessionCreationOptions> {
  return readJson("/api/v1/session-creation-options", signal);
}

export type ProviderAuthCatalog = { schemaVersion: 1; version: "piagent-provider-auth-catalog-v1"; generatedAt: string;
  state: "ready"; providers: Array<{ providerRef: string; name: string; method: "oauth"; state: "connected" | "not-connected" }>;
  reasonCode: string | null };
export type ProviderAuthJob = { schemaVersion: 1; version: "piagent-provider-auth-job-v1"; generatedAt: string; jobRef: string;
  providerRef: string; providerName: string; startedAt: string; expiresAt: string; state: "running" | "completed" | "failed" | "cancelled";
  events: Array<{ sequence: number; type: "info" | "auth-url" | "device-code" | "progress"; message: string | null;
    url: string | null; links: Array<{ url: string; label: string | null }>; userCode: string | null; expiresInSeconds: number | null }>;
  prompt: null | { promptRef: string; type: "text" | "select" | "manual_code"; message: string; placeholder: string | null;
    options: Array<{ id: string; label: string; description: string | null }> }; reasonCode: string | null };

export function readProviderAuthCatalog(signal?: AbortSignal): Promise<ProviderAuthCatalog> {
  return readJson("/api/v1/provider-auth", signal);
}

export function readProviderAuthJob(jobRef: string, signal?: AbortSignal): Promise<ProviderAuthJob> {
  return readJson(`/api/v1/provider-auth/jobs/${encodeURIComponent(jobRef)}`, signal);
}

async function providerAuthCommand(command: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderAuthJob> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/provider-auth", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as ProviderAuthJob;
}

export function startProviderAuth(providerRef: string, signal?: AbortSignal): Promise<ProviderAuthJob> {
  return providerAuthCommand({ action: "provider-auth.start", providerRef }, signal);
}

export function respondProviderAuth(jobRef: string, promptRef: string, value: string, signal?: AbortSignal): Promise<ProviderAuthJob> {
  return providerAuthCommand({ action: "provider-auth.respond", jobRef, promptRef, value }, signal);
}

export function cancelProviderAuth(jobRef: string, signal?: AbortSignal): Promise<ProviderAuthJob> {
  return providerAuthCommand({ action: "provider-auth.cancel", jobRef }, signal);
}

export async function importProjectFolder(signal?: AbortSignal): Promise<{ schemaVersion: 1; version: "piagent-project-import-result-v1";
  importedAt: string; project: SessionCreationOptions["projects"][number]; projects?: SessionCreationOptions["projects"] }> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/projects/import", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf },
    body: JSON.stringify({ action: "project.import" }) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json();
}

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as T;
}

function sessionInspectionPath(sessionRef: string, readPath: string): string {
  if (!readPath.startsWith("/api/v1/")) throw new Error("invalid-inspection-path");
  return `/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection/${readPath.slice("/api/v1/".length)}`;
}

export function readSessionInspectionSnapshot(sessionRef: string, signal?: AbortSignal): Promise<PiagentWebUICanonicalSnapshotV1> {
  return readJson(sessionInspectionPath(sessionRef, "/api/v1/snapshot"), signal);
}

export function readSessionTranscript(sessionRef: string, beforeCursor: string | null = null, limit = 50,
  signal?: AbortSignal): Promise<PiagentWebUIBoundedTranscriptProjectionV1> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeCursor) query.set("before", beforeCursor);
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/transcript?${query}`), signal);
}

export function readSessionApproval(sessionRef: string, approvalRef: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/approvals/${encodeURIComponent(approvalRef)}`), signal);
}

export function readSessionSourceChanges(sessionRef: string, view: View, signal?: AbortSignal): Promise<PiagentWebUISourceChangeViewV1 | null> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/source-changes?view=${encodeURIComponent(view)}`), signal);
}

export function readSessionFileDiff(sessionRef: string, view: View, fileRef: string, signal?: AbortSignal): Promise<PiagentWebUIBoundedFileDiffV1> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/diffs/${encodeURIComponent(fileRef)}?view=${encodeURIComponent(view)}`), signal);
}

export function readSessionReviewState(sessionRef: string, view: View, fileRef: string, signal?: AbortSignal): Promise<PiagentWebUIDigestBoundSelectedFileReviewStateV1> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/reviews/${encodeURIComponent(fileRef)}?view=${encodeURIComponent(view)}`), signal);
}

export function readSessionSourceMutation(sessionRef: string, action: "source.stage" | "source.unstage", fileRef: string, signal?: AbortSignal): Promise<PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/source-mutations/${encodeURIComponent(fileRef)}?action=${encodeURIComponent(action)}`), signal);
}

export function readSessionSourceRevert(sessionRef: string, fileRef: string, hunkRef: string | null = null, signal?: AbortSignal): Promise<PiagentWebUIConfirmedExactSourceRevertPreviewV1> {
  const query = hunkRef ? `?hunkRef=${encodeURIComponent(hunkRef)}` : "";
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/source-reverts/${encodeURIComponent(fileRef)}${query}`), signal);
}

export function readSessionCommitSummary(sessionRef: string, signal?: AbortSignal): Promise<PiagentWebUIDeterministicStagedCommitSummaryV1> {
  return readJson(sessionInspectionPath(sessionRef, "/api/v1/commit-summary"), signal);
}

export function readSessionLogPreview(sessionRef: string, activityRef: string, signal?: AbortSignal): Promise<LogPreview> {
  return readJson(sessionInspectionPath(sessionRef, `/api/v1/log-previews/${encodeURIComponent(activityRef)}`), signal);
}

export type SessionConnections = {
  schemaVersion: 1;
  version: "piagent-session-connections-v1";
  generatedAt: string;
  sessionRef: string;
  state: "ready" | "degraded";
  summary: { configured: number; connected: number | null; approvalRequired: number };
  connections: Array<{ connectionRef: string; name: string; kind: "mcp"; scope: string; origin: string;
    transport: "http" | "stdio" | "unknown"; state: "configured" | "connected" | "disabled"; requiresApproval: boolean;
    oauthSupported: boolean; authState: "connected" | "expired" | "not-connected" | "unavailable"; toggleSupported: boolean }>;
  truncated: boolean;
  reasonCode: string | null;
};

export function readSessionConnections(sessionRef: string, signal?: AbortSignal): Promise<SessionConnections> {
  return readJson(sessionInspectionPath(sessionRef, "/api/v1/connections"), signal);
}

export type McpAuthJob = { schemaVersion: 1; version: "piagent-mcp-auth-job-v1"; generatedAt: string; jobRef: string;
  sessionRef: string; connectionRef: string; name: string; createdAt: string; expiresAt: string;
  state: "running" | "completed" | "failed" | "cancelled"; authorizationUrl: string | null; reasonCode: string | null };

export async function executeSessionConnection(command: { action: "mcp.enable" | "mcp.disable" | "mcp.oauth"; sessionRef: string; connectionRef: string },
  signal?: AbortSignal): Promise<SessionConnections | McpAuthJob> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/session-connections", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json();
}

export function readMcpAuthJob(jobRef: string, signal?: AbortSignal): Promise<McpAuthJob> {
  return readJson(`/api/v1/mcp-auth/jobs/${encodeURIComponent(jobRef)}`, signal);
}

export async function executeRuntimeCommand(command: RuntimeCommand, signal?: AbortSignal): Promise<RuntimeReceipt> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/runtime-commands", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as RuntimeReceipt;
}

export async function cancelMcpAuthJob(jobRef: string, signal?: AbortSignal): Promise<McpAuthJob> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch(`/api/v1/mcp-auth/jobs/${encodeURIComponent(jobRef)}/cancel`, { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "X-Piagent-CSRF": csrf } });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json();
}

export function readSourceChanges(view: View, signal?: AbortSignal): Promise<PiagentWebUISourceChangeViewV1 | null> {
  return readJson(`/api/v1/source-changes?view=${encodeURIComponent(view)}`, signal);
}

export function readFileDiff(view: View, fileRef: string, signal?: AbortSignal): Promise<PiagentWebUIBoundedFileDiffV1> {
  return readJson(`/api/v1/diffs/${encodeURIComponent(fileRef)}?view=${encodeURIComponent(view)}`, signal);
}

export function readReviewState(view: View, fileRef: string, signal?: AbortSignal): Promise<PiagentWebUIDigestBoundSelectedFileReviewStateV1> {
  return readJson(`/api/v1/reviews/${encodeURIComponent(fileRef)}?view=${encodeURIComponent(view)}`, signal);
}

export function readSourceMutation(action: "source.stage" | "source.unstage", fileRef: string, signal?: AbortSignal): Promise<PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1> {
  return readJson(`/api/v1/source-mutations/${encodeURIComponent(fileRef)}?action=${encodeURIComponent(action)}`, signal);
}

export function readSourceRevert(fileRef: string, hunkRef: string | null = null, signal?: AbortSignal): Promise<PiagentWebUIConfirmedExactSourceRevertPreviewV1> {
  const query = hunkRef ? `?hunkRef=${encodeURIComponent(hunkRef)}` : "";
  return readJson(`/api/v1/source-reverts/${encodeURIComponent(fileRef)}${query}`, signal);
}

export function readCommitSummary(signal?: AbortSignal): Promise<PiagentWebUIDeterministicStagedCommitSummaryV1> {
  return readJson("/api/v1/commit-summary", signal);
}

export function readTaskIndex(signal?: AbortSignal): Promise<PiagentWebUIAuthoritativeLocalTaskRunIndexV1> {
  return readJson("/api/v1/tasks", signal);
}

export function readTaskTimeline(runRef: string, signal?: AbortSignal): Promise<PiagentWebUIDurableTaskRecoveryTimelineV1> {
  return readJson(`/api/v1/tasks/${encodeURIComponent(runRef)}/timeline`, signal);
}

export function readRecoveryHistory(runRef: string, signal?: AbortSignal): Promise<PiagentWebUIBoundedCompactionAndRecoveryHistoryV1> {
  return readJson(`/api/v1/tasks/${encodeURIComponent(runRef)}/recovery-history`, signal);
}

export function readHandoffHistory(runRef: string, signal?: AbortSignal): Promise<PiagentWebUIBoundedHandoffHistoryAndNextActionV1> {
  return readJson(`/api/v1/tasks/${encodeURIComponent(runRef)}/handoff-history`, signal);
}

export function readSubagentTree(runRef: string, signal?: AbortSignal): Promise<PiagentWebUIBoundedSubagentOwnershipTreeV1> {
  return readJson(`/api/v1/tasks/${encodeURIComponent(runRef)}/subagent-tree`, signal);
}

export function readReleaseMonitor(signal?: AbortSignal): Promise<PiagentWebUIBoundedBenchmarkAndReleaseMonitorV1> {
  return readJson("/api/v1/monitoring/release", signal);
}

export type LogPreview = { activityRef: string; state: "available" | "unavailable"; preview: string | null; truncated: boolean; reasonCode: string | null };

export function readLogPreview(activityRef: string, signal?: AbortSignal): Promise<LogPreview> {
  return readJson(`/api/v1/log-previews/${encodeURIComponent(activityRef)}`, signal);
}

export function readTranscript(beforeCursor: string | null = null, limit = 50, signal?: AbortSignal): Promise<PiagentWebUIBoundedTranscriptProjectionV1> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeCursor) query.set("before", beforeCursor);
  return readJson(`/api/v1/transcript?${query}`, signal);
}

export function readHeldQueue(signal?: AbortSignal): Promise<PiagentWebUIHeldMessageQueueProjectionV1> {
  return readJson("/api/v1/chat/queue", signal);
}

export function readModelCatalog(signal?: AbortSignal): Promise<PiagentWebUIAuthenticatedModelCatalogV1> {
  return readJson("/api/v1/session-options/models", signal);
}

export function readApproval(approvalRef: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  return readJson(`/api/v1/approvals/${encodeURIComponent(approvalRef)}`, signal);
}

export async function decideApproval(decision: ApprovalDecision, signal?: AbortSignal): Promise<ApprovalReceipt> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch(`/api/v1/approvals/${encodeURIComponent(decision.approvalRef)}/decision`, { method: "POST",
    credentials: "same-origin", signal, headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf },
    body: JSON.stringify(decision) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as ApprovalReceipt;
}

export async function sendChatCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/chat/messages", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendSessionOptionCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/session-options", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendLifecycleCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/lifecycle", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendResumeAndContinueCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/control/resume-and-continue", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendReviewCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/reviews", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendSourceMutationCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/source-mutations", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendSourceRevertCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/source-mutations", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

export async function sendSourceOpenCommand(command: Command, signal?: AbortSignal): Promise<Receipt> {
  const csrf = browserCsrfToken(); if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/source-handoffs", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as Receipt;
}

// The Gateway drives many sessions, so its attachment endpoint names the one the
// bytes belong to. Same bounded command, same receipts as the single-session route.
export async function stageSessionAttachment(sessionRef: string, command: StageCommand | DiscardCommand,
  signal?: AbortSignal): Promise<StageReceipt | DiscardReceipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionRef)}/attachments`, { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as StageReceipt | DiscardReceipt;
}

export function readDocumentIndex(sessionRef: string | null, signal?: AbortSignal): Promise<Listing> {
  return readJson(sessionRef ? sessionInspectionPath(sessionRef, "/api/v1/documents") : "/api/v1/documents", signal);
}

export function readDocument(sessionRef: string | null, documentRef: string, signal?: AbortSignal): Promise<DocumentContent> {
  const readPath = `/api/v1/documents/${encodeURIComponent(documentRef)}`;
  return readJson(sessionRef ? sessionInspectionPath(sessionRef, readPath) : readPath, signal);
}

export async function stageAttachment(command: StageCommand | DiscardCommand, signal?: AbortSignal): Promise<StageReceipt | DiscardReceipt> {
  const csrf = browserCsrfToken();
  if (!csrf) throw new WebUiRequestError(403);
  const response = await fetch("/api/v1/attachments", { method: "POST", credentials: "same-origin", signal,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Piagent-CSRF": csrf }, body: JSON.stringify(command) });
  if (!response.ok) throw new WebUiRequestError(response.status);
  return await response.json() as StageReceipt | DiscardReceipt;
}
