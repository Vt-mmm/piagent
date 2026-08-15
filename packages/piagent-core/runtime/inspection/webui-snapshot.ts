import { createHash } from "node:crypto";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import { workingTreeEvidenceDigest, workingTreeSnapshotUsesCurrentAlgorithm } from "../../extensions/working-tree-digest.js";
import { inspectTaskContinuationBudget } from "../recovery/continuation-budget.ts";
import { readHandoffProjection } from "../recovery/handoff-projection.ts";
import type { ActivityInspectorEvent, CurrentActivity } from "../product/activity-inspector.ts";
import { projectCriteriaFileVerifier, type CriteriaLinkProjection } from "./criteria-links.ts";
import { collectSourceChangeViews, type SourceChangeDocument, type WebUiIdentity } from "./source-change-projection.ts";

export const WEBUI_SNAPSHOT_VERSION = "piagent-webui-snapshot-v1" as const;
export const WEBUI_RUNTIME_INSTANCE_REF = `runtime.${createHash("sha256").update(`${process.pid}\0${Date.now()}\0${process.cwd()}`).digest("hex")}`;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type WebUiRuntimeModel = {
  provider?: unknown; id?: unknown; name?: unknown; reasoning?: unknown; input?: unknown;
  thinkingLevelMap?: unknown; contextWindow?: unknown; maxTokens?: unknown;
};
export type WebUiInspectionProjection = {
  snapshot: Record<string, any>;
  sourceViews: CriteriaLinkProjection["sourceViews"];
  relations: CriteriaLinkProjection["relations"];
  verifierAttempts: CriteriaLinkProjection["verifierAttempts"];
  scopedEvents: ActivityInspectorEvent[];
};

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function token(prefix: string, value: unknown): string { return `${prefix}.${hash(JSON.stringify(value))}`; }
export function webUiProjectRef(cwd: string): string { return token("project", cwd); }
export function webUiSessionRef(sessionId: string): string { return token("session", sessionId); }
export function webUiModelRef(provider: string, modelId: string): string { return token("model", [provider, modelId]); }
export function webUiTaskRevision(task: Pick<TaskContract, "taskRunId" | "updatedAt" | "trace">): string {
  return token("task-rev", [task.taskRunId, task.updatedAt, task.trace.outcome]);
}
export function webUiControlRevision(taskRunId: string, controlState: "active" | "terminal"): string {
  return token("control-rev", [taskRunId, controlState]);
}
function timestamp(value: unknown, fallback = new Date().toISOString()): string {
  return typeof value === "string" && TIMESTAMP.test(value) ? value : fallback;
}
function strings(values: unknown[], maximum = 300): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))].slice(0, maximum);
}
function display(value: unknown, maximum = 500): string {
  return redactSensitiveText(String(value ?? "")).text
    .replace(/\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
}
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0; }
function cost(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  return value && typeof value === "object" ? number((value as Record<string, unknown>).total) : 0;
}
function usage(entries: unknown[]): { totals: UsageTotals; latest: UsageTotals | null; observed: boolean } {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latest: UsageTotals | null = null, observed = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as any).type === "message" ? (entry as any).message : undefined;
    const raw = message?.usage ?? (entry as any).usage;
    if (!raw || (message && !["assistant", "toolResult"].includes(message.role))) continue;
    const current = { input: number(raw.input), output: number(raw.output), cacheRead: number(raw.cacheRead), cacheWrite: number(raw.cacheWrite), cost: cost(raw.cost) };
    observed = true;
    for (const key of Object.keys(totals) as Array<keyof UsageTotals>) totals[key] += current[key];
    if (message?.role === "assistant") latest = current;
  }
  return { totals, latest, observed };
}

function scopedEvents(events: ActivityInspectorEvent[], sessionId: string, task?: TaskContract): ActivityInspectorEvent[] {
  const deduped = new Map<string, ActivityInspectorEvent>();
  for (const event of events) {
    if (String(event.sessionId ?? "") !== sessionId || (task ? event.taskRunId !== task.taskRunId : Boolean(event.taskRunId))) continue;
    const key = event.activityId ?? [event.event, event.toolCallId, event.recordedAt, event.toolName].join(":");
    deduped.set(key, event);
  }
  return [...deduped.values()].sort((left, right) => String(left.recordedAt).localeCompare(String(right.recordedAt))).slice(-2_000);
}

function sourceSummary(document: SourceChangeDocument | null, view: "task" | "working-tree" | "staged") {
  if (!document || document.availability.state === "unavailable") return {
    view, base: view === "task" ? "task-baseline" : "HEAD", state: "unavailable", revision: null,
    counts: { files: 0, added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, additions: null, deletions: null },
    health: { state: "unavailable", reasonCode: document?.availability.reasonCode ?? "no-active-task", message: document?.availability.message ?? "No active task baseline exists" }
  };
  const files = document.files as Array<Record<string, any>>;
  const truncated = document.page.truncated;
  const statsExact = !truncated && files.every((file) => file.stats?.state === "exact");
  const count = (status: string) => files.filter((file) => file.status === status).length;
  const additions = statsExact ? files.reduce((sum, file) => sum + number(file.stats.additions), 0) : null;
  const deletions = statsExact ? files.reduce((sum, file) => sum + number(file.stats.deletions), 0) : null;
  return {
    view, base: view === "task" ? "task-baseline" : "HEAD", state: document.availability.state === "stale" ? "stale" : "ready", revision: document.viewRevision,
    counts: { files: document.page.total, added: count("A"), modified: count("M"), deleted: count("D"), renamed: count("R"), untracked: count("U"), conflicted: count("C"),
      additions: additions !== null && additions <= 1_000_000_000 ? additions : null,
      deletions: deletions !== null && deletions <= 1_000_000_000 ? deletions : null },
    health: document.availability.state === "stale"
      ? { state: "degraded", reasonCode: document.availability.reasonCode ?? "source-view-stale", message: document.availability.message ?? "Source view is stale" }
      : truncated ? { state: "degraded", reasonCode: "source-view-truncated", message: "Source view totals exceed the bounded file list" }
      : { state: "ok", reasonCode: null, message: null }
  };
}

function activityProjection(events: ActivityInspectorEvent[], current: CurrentActivity[]) {
  const results = new Map(events.filter((event) => event.event === "tool_result").map((event) => [event.toolCallId, event]));
  const decisions = new Map(events.filter((event) => event.event === "tool_decision").map((event) => [event.toolCallId, event]));
  const calls = events.filter((event) => event.event === "tool_call").slice(-200);
  const projected = calls.map((call) => {
    const result = results.get(call.toolCallId), decision = decisions.get(call.toolCallId);
    const blocked = decision?.decision === "blocked";
    const failed = !blocked && Boolean(result && (result.isError === true || (typeof result.exitCode === "number" && result.exitCode !== 0)));
    const state = blocked ? "blocked" : !result ? "running" : failed ? "failed" : "passed";
    const toolName = display(call.toolName ?? "unknown", 80).replace(/[^A-Za-z0-9._:@~-]/g, "-") || "unknown";
    const rawId = String(call.toolCallId ?? call.activityId ?? `${call.recordedAt}:${toolName}`);
    const command = display(call.command ?? call.targetPath ?? toolName, 65_536);
    return {
      activityRef: token("activity", [rawId, call.recordedAt]), kind: ["bash", "shell", "exec"].includes(toolName) ? "command" : "tool", state,
      label: display(state === "running" ? `${toolName} running` : `${toolName} ${state}`, 500), preview: command,
      toolCallId: token("tool", rawId), toolName, commandDigest: call.command ? `sha256:${hash(call.command)}` : null,
      logRef: null, exitCode: typeof result?.exitCode === "number" ? result.exitCode : null, exitCodeExact: result?.exitCodeExact === true,
      startedAt: timestamp(call.recordedAt), finishedAt: result || blocked ? timestamp(result?.recordedAt ?? decision?.recordedAt, timestamp(call.recordedAt)) : null
    };
  });
  const callIds = new Set(calls.map((call) => String(call.toolCallId ?? "")));
  const extraRunning = current.filter((item) => (item.status ?? "running") === "running" && !callIds.has(String(item.toolCallId))).map((item) => ({
    activityRef: token("activity", [item.toolCallId, item.startedAt]), kind: ["bash", "shell", "exec"].includes(item.toolName) ? "command" : "tool", state: "running",
    label: display(item.label || `${item.toolName} running`, 500), preview: display(item.target ?? item.toolName, 65_536),
    toolCallId: token("tool", item.toolCallId), toolName: display(item.toolName, 80).replace(/[^A-Za-z0-9._:@~-]/g, "-") || "unknown",
    commandDigest: null, logRef: null, exitCode: null, exitCodeExact: false, startedAt: timestamp(item.startedAt), finishedAt: null
  }));
  const running = [...projected.filter((item) => item.state === "running"), ...extraRunning];
  const recent = projected.filter((item) => item.state !== "running").reverse();
  const returned = Math.min(running.length, 32) + Math.min(recent.length, 200);
  return { running: running.slice(-32), recent: recent.slice(0, 200), page: { cursor: null, nextCursor: null, total: projected.length + extraRunning.length, returned, truncated: projected.length + extraRunning.length > returned }, health: { state: "ok", reasonCode: null, message: null } };
}

function unavailableCapability(code: string, message: string) {
  return { status: "unavailable", version: null, reason: { code, message } };
}
function capabilities(identity: WebUiIdentity, generatedAt: string, resyncRequired: boolean, replay?: { eventRetentionCount: number; eventRetentionSeconds: number }) {
  return {
    schemaVersion: 1, version: "piagent-webui-capabilities-v1", generatedAt, protocolMin: 1, protocolMax: 1,
    supportedSnapshotVersions: [1], supportedEventVersions: [2], mode: "inspect-only",
    compatibility: resyncRequired ? { state: "resync-required", reason: { code: "event-replay-gap", message: "A fresh canonical snapshot is required before event replay can continue" } } : { state: "compatible", reason: null }, identity,
    runtimeBuild: { state: "unavailable", buildId: null, version: null, reason: { code: "runtime-build-not-projected", message: "Runtime build identity is not projected" } },
    serverBuild: { state: "unavailable", buildId: null, version: null, reason: { code: "webui-server-not-started", message: "The WebUI server is not running" } },
    capabilities: {
      inspect: { status: "available", version: 1, reason: null, sourceViews: ["task", "working-tree", "staged"] },
      "control.chat": unavailableCapability("chat-control-not-enabled", "The same-session bridge exists, but transcript, queue, server control and browser UX are not enabled"),
      "control.lifecycle": unavailableCapability("lifecycle-contract-incomplete", "Pi 0.84.1 lacks semantic Pause and an acknowledged phase-complete Stop contract"),
      "control.resumeAndContinue": unavailableCapability("compound-control-unavailable", "Resume is unavailable until a durable acknowledged Pause contract exists"),
      "control.sessionOptions": unavailableCapability("effect-scope-not-productionized", "Model and thinking APIs exist but lifecycle and persistence scope enforcement is not enabled"),
      attachments: unavailableCapability("attachments-not-implemented", "Attachments are not implemented"),
      approve: unavailableCapability("approval-broker-not-implemented", "Approval broker is not implemented"),
      reviewActions: unavailableCapability("review-actions-not-implemented", "Review actions are not implemented")
    },
    replay: { eventRetentionCount: replay?.eventRetentionCount ?? 0, eventRetentionSeconds: replay?.eventRetentionSeconds ?? 0, resyncSupported: true },
    limits: { maxRequestBodyBytes: 1_048_576, maxEventPayloadBytes: 65_536, maxReplayEvents: 10_000, maxDiffBytes: 4_194_304,
      maxDiffLines: 5_000, maxDiffHunks: 256, maxLogPreviewBytes: 65_536, maxLogPreviewLines: 500, maxAttachmentCount: 16,
      maxAttachmentFileBytes: 10_485_760, maxAttachmentTotalBytes: 33_554_432, maxQueueItems: 100, maxMessageBytes: 65_536,
      maxSseClients: 8, maxGitProcesses: 4, requestTimeoutMs: 30_000 }
  };
}

function taskProjection(task: TaskContract, criteria: CriteriaLinkProjection["criteria"], controlState: "active" | "terminal") {
  const safeCriteria = criteria.map((criterion) => ({ ...criterion, obligation: display(criterion.obligation, 500) || "Criterion unavailable" }));
  const completed = safeCriteria.filter((criterion) => criterion.state === "satisfied").length;
  const total = safeCriteria.length;
  const blocker = task.trace.outcome === "blocked" || task.trace.outcome === "partial" || task.trace.outcome === "failed"
    ? display(task.failureReason ?? task.trace.friction ?? "Task cannot complete", 500) : null;
  return {
    taskId: task.taskId, taskRunId: task.taskRunId, summary: display(task.summary, 500), changeMode: task.changeMode,
    riskLane: task.riskLane === "high-risk" ? "high-risk" : "low-risk", outcome: task.trace.outcome, controlState,
    criteria: safeCriteria, workPlan: task.workPlan.slice(0, 64).map((step) => ({ stepId: step.id, summary: display(step.title, 500) || "Work step", status: step.status, criterionIds: [] })),
    scope: strings(task.scope.map((item) => display(item, 500)), 256), outOfScope: strings(task.outOfScope.map((item) => display(item, 500)), 256), progress: { completed, total, percent: total ? completed / total * 100 : 0 },
    blocker, reasonCode: blocker ? "task-blocked-or-incomplete" : null
  };
}

function usageCounter(value: UsageTotals | null, reasonCode: string) {
  const valid = value && [value.input, value.output, value.cacheRead, value.cacheWrite].every((item) => Number.isInteger(item) && item >= 0 && item <= 1_000_000_000_000)
    && Number.isFinite(value.cost) && value.cost >= 0 && value.cost <= 1_000_000_000;
  return valid ? { state: "known", ...value, currency: "USD", reasonCode: null }
    : { state: "unknown", input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, currency: null, reasonCode };
}

function contextProjection(value: { tokens: number | null; contextWindow: number; percent: number | null } | undefined, generatedAt: string) {
  return value && Number.isInteger(value.tokens) && value.tokens! >= 0 && value.tokens! <= 1_000_000_000
    && Number.isInteger(value.contextWindow) && value.contextWindow > 0 && value.contextWindow <= 1_000_000_000
    && typeof value.percent === "number" && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100
    ? { state: "known", tokens: value.tokens, contextWindow: value.contextWindow, percent: value.percent, capturedAt: generatedAt, reasonCode: null }
    : { state: "unavailable", tokens: null, contextWindow: null, percent: null, capturedAt: null, reasonCode: "host-context-usage-unavailable" };
}

function modelFact(value: WebUiRuntimeModel | undefined) {
  const publicId = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
  const provider = typeof value?.provider === "string" ? value.provider : "";
  const modelId = typeof value?.id === "string" ? value.id : "";
  const contextWindow = typeof value?.contextWindow === "number" ? value.contextWindow : 0;
  const maxOutputTokens = typeof value?.maxTokens === "number" ? value.maxTokens : 0;
  if (!publicId.test(provider) || !publicId.test(modelId) || !Number.isInteger(contextWindow) || contextWindow < 1 || contextWindow > 100_000_000
    || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 100_000_000 || typeof value?.reasoning !== "boolean") {
    return { state: "unavailable", value: null, evidence: null, reasonCode: "model-snapshot-not-projectable" };
  }
  const mapping = value.thinkingLevelMap && typeof value.thinkingLevelMap === "object" ? value.thinkingLevelMap as Record<string, unknown> : {};
  const supportedThinkingLevels = value.reasoning
    ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"].filter((level) => mapping[level] !== null && !(["xhigh", "max"].includes(level) && mapping[level] === undefined))
    : ["off"];
  const inputCapabilities = Array.isArray(value.input)
    ? [...new Set(value.input.filter((item): item is "text" | "image" => item === "text" || item === "image"))]
    : [];
  return { state: "known", value: { modelRef: webUiModelRef(provider, modelId), provider, modelId,
    displayName: display(value.name ?? modelId, 500) || modelId, reasoning: value.reasoning, inputCapabilities,
    supportedThinkingLevels, contextWindow, maxOutputTokens }, evidence: "observed", reasonCode: null };
}

function thinkingFact(value: unknown) {
  const level = typeof value === "string" ? value : "";
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)
    ? { state: "known", value: level, evidence: "observed", reasonCode: null }
    : { state: "unavailable", value: null, evidence: null, reasonCode: "thinking-level-not-projected" };
}

function continuation(cwd: string, task?: TaskContract) {
  if (!task) return { state: "not-applicable", consumed: null, maximum: null, remaining: null, reservationRef: null, reasonCode: "no-active-task" };
  const budget = inspectTaskContinuationBudget(cwd, task);
  if (!budget.enforcementSafe) return { state: "unknown", consumed: null, maximum: null, remaining: null, reservationRef: null, reasonCode: "continuation-journal-unavailable" };
  const remaining = Math.max(0, budget.maximum - budget.consumed);
  return { state: remaining === 0 ? "exhausted" : "available", consumed: budget.consumed, maximum: budget.maximum, remaining, reservationRef: null, reasonCode: null };
}

function handoff(cwd: string, task: TaskContract | undefined, currentDigest: string | null) {
  if (!task) return null;
  let value;
  try { value = readHandoffProjection(cwd, task.taskRunId); } catch { return null; }
  if (!value) return null;
  const stale = Boolean(currentDigest && value.tree.currentDigest && currentDigest !== value.tree.currentDigest);
  return { handoffRef: token("handoff", task.taskRunId), state: stale ? "stale" : "ready", summary: display(value.goal.summary, 500),
    blocker: value.failure.warnings[0] ? display(value.failure.warnings[0], 500) : null,
    nextSafeAction: display(value.nextSafeAction.action, 500) || null,
    evidenceRefs: strings([value.references.taskContract, value.references.journal, value.references.trajectory].map((item) => token("evidence", item)), 64),
    generatedAt: timestamp(value.generatedAt), reasonCode: stale ? "handoff-tree-stale" : null };
}

export async function buildWebUiInspectionProjection(input: {
  cwd: string;
  sessionId: string;
  task?: TaskContract;
  events?: ActivityInspectorEvent[];
  sessionEntries?: unknown[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  current?: CurrentActivity[];
  protectedPaths?: string[];
  generatedAt?: string;
  runtimeInstanceId?: string;
  eventCursor?: string;
  resyncRequired?: boolean;
  eventReplay?: { eventRetentionCount: number; eventRetentionSeconds: number };
  model?: WebUiRuntimeModel;
  thinkingLevel?: unknown;
}): Promise<WebUiInspectionProjection> {
  const generatedAt = timestamp(input.generatedAt);
  const identity: WebUiIdentity = { projectRef: webUiProjectRef(input.cwd), runtimeInstanceId: input.runtimeInstanceId ?? WEBUI_RUNTIME_INSTANCE_REF,
    sessionRef: webUiSessionRef(input.sessionId), taskId: input.task?.taskId ?? null, taskRunId: input.task?.taskRunId ?? null, agentOperationId: null, toolCallId: null };
  const effectiveProtectedPaths = input.protectedPaths ?? input.task?.protectedPaths ?? [];
  const currentSnapshot = workingTreeSnapshot(input.cwd, {
    isProtectedProjectPath: (projectPath: string) => Boolean(matchesProtectedPath(projectPath, effectiveProtectedPaths))
  }) as Record<string, string>;
  const taskRevision = input.task ? webUiTaskRevision(input.task) : null;
  const views = await collectSourceChangeViews({ cwd: input.cwd, identity, generatedAt, taskRevision,
    isProtectedPath: (_root, repoPath) => Boolean(matchesProtectedPath(repoPath, effectiveProtectedPaths)) });
  const events = scopedEvents(input.events ?? [], input.sessionId, input.task);
  const linked = projectCriteriaFileVerifier({ cwd: input.cwd, task: input.task, sourceViews: views, currentSnapshot,
    protectedPaths: input.protectedPaths, events, at: new Date(generatedAt) });
  const sourceChanges = { task: sourceSummary(linked.sourceViews.task, "task"), workingTree: sourceSummary(linked.sourceViews.workingTree, "working-tree"), staged: sourceSummary(linked.sourceViews.staged, "staged") };
  const currentDigest = workingTreeSnapshotUsesCurrentAlgorithm(currentSnapshot) ? workingTreeEvidenceDigest(currentSnapshot) : null;
  const current = input.current ?? [], controlState = input.task?.trace.outcome === "pending" ? "active" as const : "terminal" as const;
  const context = contextProjection(input.contextUsage, generatedAt), usageFacts = usage(input.sessionEntries ?? []);
  const eventCursor = input.eventCursor ?? token("event-cursor", events.map((event) => event.activityId ?? [event.event, event.toolCallId, event.recordedAt]));
  const runtimeRevision = token("runtime-rev", [taskRevision, sourceChanges.workingTree.revision, sourceChanges.staged.revision, eventCursor, current]);
  const approvals = { state: "unknown", pending: [], recent: [], health: { state: "unavailable", reasonCode: "approval-projection-unavailable", message: "Current host approval state is not exposed to the read-only projector" } };
  const task = input.task ? taskProjection(input.task, linked.criteria, controlState) : null;
  const issues = [
    { code: "approval-projection-unavailable", message: "Approval state is unavailable until the same-process bridge is proved" },
    ...(linked.verification.health.state === "ok" ? [] : [{ code: linked.verification.health.reasonCode ?? "verification-projection-degraded", message: linked.verification.health.message ?? "Verification projection is degraded" }]),
    ...([sourceChanges.task, sourceChanges.workingTree, sourceChanges.staged].filter((item) => item.state === "unavailable").map((item) => ({ code: item.health.reasonCode ?? "source-view-unavailable", message: item.health.message ?? `${item.view} source view unavailable` }))),
    ...(input.resyncRequired ? [{ code: "event-replay-gap", message: "Event replay has a gap; refresh from this snapshot" }] : [])
  ].slice(0, 128).map((issue, index) => ({ issueRef: token("issue", [runtimeRevision, index, issue.code]), severity: "warning", code: issue.code, message: display(issue.message, 500), relatedRefs: [] }));
  const snapshot = {
    schemaVersion: 1, version: WEBUI_SNAPSHOT_VERSION, generatedAt, identity,
    revision: { runtimeRevision, taskRevision, controlRevision: input.task ? webUiControlRevision(input.task.taskRunId, controlState) : null,
      workspaceRevision: linked.sourceViews.workingTree.viewRevision, indexRevision: linked.sourceViews.staged.viewRevision,
      approvalRevision: null, sessionOptionRevision: token("session-option-rev", input.sessionId), queueRevision: null, journalHead: null,
      eventCursor },
    capabilities: capabilities(identity, generatedAt, input.resyncRequired === true, input.eventReplay),
    session: {
      connectionState: input.resyncRequired ? "resync-required" : "connected", connectionReason: input.resyncRequired ? "event-replay-gap" : null, displayName: input.task?.sessionName ?? null,
      operation: current.some((item) => (item.status ?? "running") === "running")
        ? { liveness: "running", operationRef: null, hostPhase: { state: "known", value: "tool", evidence: "derived", reasonCode: null }, startedAt: timestamp(current[0]?.startedAt, generatedAt), settledAt: null, reasonCode: null }
        : { liveness: "idle", operationRef: null, hostPhase: { state: "known", value: "idle", evidence: "derived", reasonCode: null }, startedAt: null, settledAt: null, reasonCode: null },
      controlState: input.task ? controlState : "active", taskOutcome: input.task?.trace.outcome ?? null, approvalState: approvals.state,
      verificationState: linked.verification.state, permissionProfile: { state: "unavailable", value: null, evidence: null, reasonCode: "permission-profile-not-projected" },
      model: modelFact(input.model),
      thinking: thinkingFact(input.thinkingLevel),
      queue: { state: "unavailable", hasPending: null, heldCount: null, revision: null, reasonCode: "host-queue-api-unavailable" }, context
    },
    task, sourceChanges, activity: activityProjection(events, current), approvals, verification: linked.verification,
    usage: { context, latestTurn: usageCounter(usageFacts.latest, "no-assistant-turn"), sessionTotal: usageCounter(usageFacts.observed ? usageFacts.totals : null, "host-total-usage-unavailable"),
      taskTotal: usageCounter(null, input.task ? "task-usage-boundary-unavailable" : "no-active-task"), capturedAt: generatedAt,
      health: { state: "degraded", reasonCode: "partial-usage-only", message: "Task-attributed usage is not available" } },
    continuation: continuation(input.cwd, input.task), handoff: handoff(input.cwd, input.task, currentDigest),
    health: { state: issues.length ? "degraded" : "ok", issues, resyncRequired: input.resyncRequired === true, generatedFromRevision: runtimeRevision }
  };
  return { snapshot, sourceViews: linked.sourceViews, relations: linked.relations, verifierAttempts: linked.verifierAttempts, scopedEvents: events };
}
