import type { TaskContract } from "../../extensions/guard-types.ts";
import {
  buildWebUiInspectionProjection,
  type WebUiInspectionProjection
} from "../inspection/webui-snapshot.ts";

export const ACTIVITY_INSPECTOR_VERSION = "activity-inspector-v2" as const;

export type ActivityInspectorEvent = {
  activityId?: string;
  event?: string;
  recordedAt?: string;
  sessionId?: string;
  taskRunId?: string;
  toolCallId?: string;
  toolName?: string;
  targetPath?: string;
  command?: string;
  decision?: string;
  reason?: string;
  warningKind?: string;
  isError?: boolean;
  exitCode?: number;
  exitCodeExact?: boolean;
  additions?: number;
  deletions?: number;
  sensitiveValuesRedacted?: number;
};

export type CurrentActivity = {
  toolCallId: string;
  toolName: string;
  label: string;
  target?: string;
  startedAt: string;
  status?: "running" | "completed" | "failed" | "blocked";
};

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

function strings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function isTestPath(file: string): boolean { return /(^|\/)(?:test|tests|spec|__tests__)(\/|$)|[._-](?:test|spec)\.[cm]?[jt]sx?$/i.test(file); }
function failedToolResult(event: ActivityInspectorEvent): boolean { return event.isError === true || (typeof event.exitCode === "number" && event.exitCode !== 0); }

function commandProjection(events: ActivityInspectorEvent[]) {
  const calls = events.filter((event) => event.event === "tool_call" && ["bash", "shell", "exec"].includes(String(event.toolName)));
  const results = new Map(events.filter((event) => event.event === "tool_result").map((event) => [event.toolCallId, event]));
  const decisions = new Map(events.filter((event) => event.event === "tool_decision").map((event) => [event.toolCallId, event]));
  const entries = calls.map((call) => {
    const decision = decisions.get(call.toolCallId), result = results.get(call.toolCallId);
    const blocked = decision?.decision === "blocked";
    const failed = !blocked && Boolean(result && failedToolResult(result));
    return { toolCallId: call.toolCallId ?? "unknown", command: call.command ?? "[redacted or unavailable]",
      status: blocked ? "blocked" : !result ? "running" : failed ? "failed" : "passed",
      exitCode: result?.exitCode ?? null, exitCodeExact: result?.exitCodeExact === true,
      reason: blocked ? decision?.reason ?? "blocked by policy" : null, recordedAt: call.recordedAt ?? null };
  });
  return { requested: entries.length, executed: entries.filter((entry) => entry.status !== "blocked").length,
    passed: entries.filter((entry) => entry.status === "passed").length, failed: entries.filter((entry) => entry.status === "failed").length,
    blocked: entries.filter((entry) => entry.status === "blocked").length, entries: entries.slice(-50).reverse() };
}

function safetyProjection(events: ActivityInspectorEvent[]) {
  const entries = [
    ...events.filter((event) => event.event === "tool_decision" && event.decision === "blocked").map((event) => ({ kind: "policy-block", message: event.reason ?? `${event.toolName ?? "tool"} blocked`, recordedAt: event.recordedAt ?? null })),
    ...events.filter((event) => event.event === "security_warning").map((event) => ({ kind: event.warningKind ?? "warning", message: event.reason ?? "security warning", recordedAt: event.recordedAt ?? null })),
    ...events.filter((event) => event.event === "tool_result" && number(event.sensitiveValuesRedacted) > 0).map((event) => ({ kind: "secret-redaction", message: `${event.toolName ?? "tool"}: ${number(event.sensitiveValuesRedacted)} sensitive value(s) redacted`, recordedAt: event.recordedAt ?? null }))
  ];
  const values = [...new Map(entries.map((entry) => [`${entry.kind}:${entry.message}`, entry])).values()];
  return { warnings: values.length, blocked: values.filter((entry) => entry.kind === "policy-block").length,
    redactions: values.filter((entry) => entry.kind === "secret-redaction").length, entries: values.slice(-50).reverse() };
}

function usageCounter(value: Record<string, any>): UsageTotals {
  return { input: number(value.input), output: number(value.output), cacheRead: number(value.cacheRead), cacheWrite: number(value.cacheWrite), cost: number(value.cost) };
}

function sourceFiles(projection: WebUiInspectionProjection, task?: TaskContract) {
  const taskFiles = projection.sourceViews.task?.files ?? [];
  const workingFiles = projection.sourceViews.workingTree.files ?? [];
  const selected = task ? taskFiles : workingFiles;
  const entries = selected.map((file: Record<string, any>) => ({ path: String(file.path), additions: file.stats?.state === "exact" ? number(file.stats.additions) : null,
    deletions: file.stats?.state === "exact" ? number(file.stats.deletions) : null, status: String(file.status), test: isTestPath(String(file.path)),
    criterionIds: file.criterionIds ?? [], verifierAttemptIds: file.verifierAttemptIds ?? [], provenance: file.provenance }));
  const taskChanged = strings(taskFiles.map((file) => file.path)).sort(), workingTree = strings(workingFiles.map((file) => file.path)).sort();
  const inspected = strings(selected.map((file) => file.path)).sort();
  return { taskChanged, workingTree, count: inspected.length, testFiles: inspected.filter(isTestPath), sourceFiles: inspected.filter((file) => !isTestPath(file)),
    additions: entries.reduce((sum, entry) => sum + (entry.additions ?? 0), 0), deletions: entries.reduce((sum, entry) => sum + (entry.deletions ?? 0), 0),
    unknownLineStats: entries.filter((entry) => entry.additions === null || entry.deletions === null).length,
    evidence: task ? projection.sourceViews.task?.availability.state === "current" ? "exact-task-baseline" : "task-baseline-unavailable" : "canonical-working-tree",
    lineStatsScope: task ? projection.sourceViews.task?.availability.state === "current" ? "task-baseline" : "unavailable" : "working-tree",
    baselineOverlap: task ? taskChanged.filter((file) => task.baselineChangedFiles.includes(file)) : [], entries };
}

export async function buildActivityInspector(input: {
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
}) {
  const projection = await buildWebUiInspectionProjection(input);
  const events = projection.scopedEvents, snapshot = projection.snapshot;
  const calls = events.filter((event) => event.event === "tool_call"), results = events.filter((event) => event.event === "tool_result");
  const byName = Object.fromEntries([...new Set(calls.map((event) => event.toolName ?? "unknown"))].sort().map((name) => [name, calls.filter((event) => (event.toolName ?? "unknown") === name).length]));
  const commands = commandProjection(events), files = sourceFiles(projection, input.task), safety = safetyProjection(events);
  return {
    schemaVersion: 2, version: ACTIVITY_INSPECTOR_VERSION, snapshot,
    state: { taskId: snapshot.identity.taskId, taskRunId: snapshot.identity.taskRunId,
      phase: snapshot.session.operation.hostPhase.state === "known" && snapshot.session.operation.hostPhase.value !== "idle" ? snapshot.session.operation.hostPhase.value : null,
      outcome: snapshot.task?.outcome ?? "idle", running: snapshot.activity.running.length, current: input.current ?? [] },
    criteria: snapshot.task?.criteria ?? [], sourceChanges: snapshot.sourceChanges, files,
    tools: { calls: calls.length, results: results.length, failed: results.filter(failedToolResult).length,
      blocked: events.filter((event) => event.event === "tool_decision" && event.decision === "blocked").length, byName,
      perToolTokens: null, perToolTokensReason: "Pi reports model usage by response/turn; built-in tool calls do not carry attributable model-token totals." },
    commands, safety,
    verification: { state: snapshot.verification.state, attempts: projection.verifierAttempts.length,
      passed: projection.verifierAttempts.filter((entry) => entry.state === "passed").length,
      failed: projection.verifierAttempts.filter((entry) => entry.state === "failed").length,
      stale: projection.verifierAttempts.filter((entry) => entry.state === "stale").length,
      latest: snapshot.verification.latest,
      results: projection.verifierAttempts.slice(-20).reverse().map((entry) => ({ command: entry.command, exitCode: entry.exitCode, recordedAt: entry.finishedAt, state: entry.state, staleByPaths: entry.staleByPaths })) },
    context: { current: snapshot.usage.context.state === "known" ? { tokens: snapshot.usage.context.tokens, contextWindow: snapshot.usage.context.contextWindow, percent: snapshot.usage.context.percent } : null,
      session: usageCounter(snapshot.usage.sessionTotal), latestTurn: usageCounter(snapshot.usage.latestTurn), attribution: "session-and-turn-only" }
  };
}

function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "?";
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}
function clip(value: string, maximum = 120): string {
  const single = String(value ?? "").replace(/\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return single.length <= maximum ? single : `${single.slice(0, maximum - 1)}…`;
}

export function formatActivityInspector(view: Awaited<ReturnType<typeof buildActivityInspector>>, action = "summary"): string {
  const context = view.context.current;
  const contextText = context ? `${compactNumber(context.tokens)}/${compactNumber(context.contextWindow)} (${context.percent === null ? "?" : `${context.percent.toFixed(1)}%`})` : "unavailable";
  if (action === "files") return [
    `files: ${view.files.count}; tests=${view.files.testFiles.length}; source=${view.files.sourceFiles.length}`,
    `lines: +${view.files.additions} -${view.files.deletions}; unknown=${view.files.unknownLineStats}; scope=${view.files.lineStatsScope}`,
    ...(view.files.baselineOverlap.length ? [`pre-existing overlap: ${view.files.baselineOverlap.join(", ")}`] : []),
    ...view.files.entries.map((entry) => `${entry.test ? "test" : "file"} ${entry.path}  +${entry.additions ?? "?"} -${entry.deletions ?? "?"}  ${entry.status}${entry.criterionIds.length ? `  criteria=${entry.criterionIds.join(",")}` : ""}${entry.verifierAttemptIds.length ? `  verifier=${entry.verifierAttemptIds.join(",")}` : ""}`)
  ].join("\n");
  if (action === "commands") return [
    `commands: requested=${view.commands.requested}; executed=${view.commands.executed}; passed=${view.commands.passed}; failed=${view.commands.failed}; blocked=${view.commands.blocked}`,
    `verification: state=${view.verification.state}; attempts=${view.verification.attempts}; passed=${view.verification.passed}; failed=${view.verification.failed}; stale=${view.verification.stale}`,
    ...(view.verification.latest?.staleByPaths?.length ? [`stale files: ${view.verification.latest.staleByPaths.join(", ")}`] : []),
    ...view.commands.entries.map((entry) => `${entry.status === "passed" ? "✓" : entry.status === "failed" ? "✗" : entry.status === "blocked" ? "⊘" : "…"} ${clip(entry.command)}${entry.exitCode === null ? "" : `  exit=${entry.exitCode}${entry.exitCodeExact ? "" : " (derived)"}`}${entry.reason ? `  ${clip(entry.reason, 160)}` : ""}`)
  ].join("\n");
  if (action === "security") return [`safety: warnings=${view.safety.warnings}; blocked=${view.safety.blocked}; redactions=${view.safety.redactions}`,
    ...(view.safety.entries.length ? view.safety.entries.map((entry) => `⚠ ${entry.kind}: ${clip(entry.message, 180)}`) : ["No recorded safety warning for this task."])].join("\n");
  if (action === "context") return [`context: ${contextText}`,
    `session: ↑${compactNumber(view.context.session.input)} ↓${compactNumber(view.context.session.output)} R${compactNumber(view.context.session.cacheRead)} W${compactNumber(view.context.session.cacheWrite)} cost=$${view.context.session.cost.toFixed(3)}`,
    `latestTurn: ↑${compactNumber(view.context.latestTurn.input)} ↓${compactNumber(view.context.latestTurn.output)} R${compactNumber(view.context.latestTurn.cacheRead)} W${compactNumber(view.context.latestTurn.cacheWrite)}`,
    `tools: ${Object.entries(view.tools.byName).map(([name, count]) => `${name}×${count}`).join(" · ") || "none"}`,
    "perToolTokens: unavailable — Pi exposes model usage by turn/session, not attributable tokens for each built-in tool call."].join("\n");
  const activity = view.state.current.at(-1);
  return [`Piagent Inspector: ${view.state.phase ?? view.state.outcome}${view.state.running ? `; running=${view.state.running}` : ""}`,
    `activity: ${activity ? `${activity.label}${activity.target ? ` ${clip(activity.target, 100)}` : ""}` : "idle"}`,
    `files: ${view.files.count} (${view.files.testFiles.length} tests); +${view.files.additions} -${view.files.deletions}; scope=${view.files.lineStatsScope}`,
    `criteria: ${view.criteria.filter((item) => item.state === "satisfied").length}/${view.criteria.length} satisfied`,
    `commands: ${view.commands.executed} executed; ${view.commands.failed} failed; ${view.commands.blocked} blocked`,
    `tools: ${view.tools.calls} calls; ${view.tools.failed} failed`, `safety: ${view.safety.warnings} warning(s); ${view.safety.redactions} redaction(s)`,
    `context: ${contextText}; latest ↑${compactNumber(view.context.latestTurn.input)} ↓${compactNumber(view.context.latestTurn.output)}`,
    `verify: ${view.verification.state}; ${view.verification.passed} passed; ${view.verification.failed} failed`,
    "details: /piagent-inspector files|commands|security|context"].join("\n");
}
