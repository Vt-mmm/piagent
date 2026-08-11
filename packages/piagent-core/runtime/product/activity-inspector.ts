import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { TaskContract } from "../../extensions/guard-types.ts";
import { changedSnapshotFiles } from "../../extensions/task-contract-view.js";
import { workingTreeSnapshot } from "../../extensions/task-state.js";
import { inspectTaskResumeState } from "../recovery/resume-state.ts";
import { readTrajectoryStore } from "../trajectory/trajectory-store.ts";

export const ACTIVITY_INSPECTOR_VERSION = "activity-inspector-v1" as const;

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

type FileStatProjection = {
  path: string;
  additions: number | null;
  deletions: number | null;
  status: string;
  test: boolean;
};

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function strings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function isTestPath(file: string): boolean {
  return /(^|\/)(?:test|tests|spec|__tests__)(\/|$)|[._-](?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

function safeProjectPath(cwd: string, file: string): string | undefined {
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function lineCountIfText(file: string): number | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return null;
    const content = fs.readFileSync(file);
    if (content.includes(0)) return null;
    const text = content.toString("utf8");
    if (!text) return 0;
    return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return null;
  }
}

export function inspectChangedFileStats(cwd: string, files: string[]) {
  const requested = strings(files).slice(0, 300);
  const unavailable = (file: string): FileStatProjection => ({ path: file, additions: null, deletions: null, status: "unavailable", test: isTestPath(file) });
  const resolved = new Map<string, { relative: string; absolute: string; gitRoot: string; gitRelative: string }>();
  const knownRoots: string[] = [];
  try {
    knownRoots.push(fs.realpathSync.native(gitText(cwd, ["rev-parse", "--show-toplevel"]).trim()));
  } catch {
    // A workspace parent may contain several direct child repositories.
  }
  for (const file of requested) {
    const relative = safeProjectPath(cwd, file);
    if (!relative) continue;
    const absolute = path.resolve(cwd, relative);
    try {
      const canonicalAbsolute = fs.existsSync(absolute)
        ? fs.realpathSync.native(absolute)
        : path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
      let gitRoot = knownRoots.find((root) => {
        const candidate = path.relative(root, canonicalAbsolute);
        return candidate && candidate !== ".." && !candidate.startsWith(`..${path.sep}`) && !path.isAbsolute(candidate);
      });
      if (!gitRoot) {
        const searchFrom = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
        gitRoot = fs.realpathSync.native(gitText(searchFrom, ["rev-parse", "--show-toplevel"]).trim());
        knownRoots.push(gitRoot);
      }
      const gitRelative = path.relative(gitRoot, canonicalAbsolute).split(path.sep).join("/");
      if (!gitRelative || gitRelative === ".." || gitRelative.startsWith("../")) continue;
      resolved.set(file, { relative, absolute, gitRoot, gitRelative });
    } catch {
      // The per-file unavailable projection below is fail-closed.
    }
  }

  const projected = new Map<string, FileStatProjection>();
  for (const gitRoot of knownRoots) {
    const group = [...resolved.values()].filter((entry) => entry.gitRoot === gitRoot);
    if (group.length === 0) continue;
    const paths = group.map((entry) => entry.gitRelative);
    let hasHead = true;
    try {
      gitText(gitRoot, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      hasHead = false;
    }
    let diff = "";
    try {
      diff = gitText(gitRoot, ["diff", "--numstat", ...(hasHead ? ["HEAD"] : ["--cached"]), "--", ...paths]);
    } catch {
      diff = "";
    }
    const stats = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const line of diff.split(/\r?\n/).filter(Boolean)) {
      const [added, removed, ...nameParts] = line.split("\t");
      const name = nameParts.join("\t");
      if (!name || !paths.includes(name)) continue;
      stats.set(name, /^\d+$/.test(added ?? "") && /^\d+$/.test(removed ?? "")
        ? { additions: Number(added), deletions: Number(removed) }
        : { additions: null, deletions: null });
    }
    let tracked = new Set<string>();
    try {
      tracked = new Set(gitText(gitRoot, ["ls-files", "-z", "--", ...paths]).split("\0").filter(Boolean));
    } catch {
      tracked = new Set();
    }
    for (const entry of group) {
      const stat = stats.get(entry.gitRelative);
      if (stat) {
        projected.set(entry.relative, {
          path: entry.relative,
          additions: stat.additions,
          deletions: stat.deletions,
          status: stat.additions === null ? "binary" : fs.existsSync(entry.absolute) ? "modified" : "deleted",
          test: isTestPath(entry.relative)
        });
      } else if (tracked.has(entry.gitRelative)) {
        projected.set(entry.relative, { path: entry.relative, additions: 0, deletions: 0, status: "unchanged", test: isTestPath(entry.relative) });
      } else {
        const additions = lineCountIfText(entry.absolute);
        projected.set(entry.relative, { path: entry.relative, additions, deletions: additions === null ? null : 0, status: additions === null ? "binary" : "untracked", test: isTestPath(entry.relative) });
      }
    }
  }
  return requested.map((file) => {
    const relative = safeProjectPath(cwd, file);
    return relative ? projected.get(relative) ?? unavailable(relative) : unavailable(file);
  });
}

export function inspectWorkingTreeFiles(cwd: string): string[] {
  try {
    const fields = gitText(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
    const files: string[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const record = fields[index];
      const status = record.slice(0, 2);
      const candidate = record.slice(3);
      if (safeProjectPath(cwd, candidate)) files.push(candidate);
      if (/[RC]/.test(status) && fields[index + 1]) {
        const source = fields[++index];
        if (safeProjectPath(cwd, source)) files.push(source);
      }
    }
    return strings(files).sort();
  } catch {
    return Object.keys(workingTreeSnapshot(cwd) as Record<string, string>).sort();
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cost(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") return number((value as Record<string, unknown>).total);
  return 0;
}

function usageFromEntries(entries: unknown[]): { totals: UsageTotals; latest: UsageTotals } {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latest: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as any).type === "message" ? (entry as any).message : undefined;
    const usage = message?.usage ?? (entry as any).usage;
    if (!usage || (message && !["assistant", "toolResult"].includes(message.role))) continue;
    const current = {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
      cacheWrite: number(usage.cacheWrite),
      cost: cost(usage.cost)
    };
    for (const key of Object.keys(totals) as Array<keyof UsageTotals>) totals[key] += current[key];
    if (message?.role === "assistant") latest = current;
  }
  return { totals, latest };
}

function scopedEvents(events: ActivityInspectorEvent[], sessionId: string, task?: TaskContract): ActivityInspectorEvent[] {
  const selected = events.filter((event) => {
    if (String(event.sessionId ?? "") !== sessionId) return false;
    if (!task) return !event.taskRunId;
    return event.taskRunId === task.taskRunId;
  });
  const deduped = new Map<string, ActivityInspectorEvent>();
  for (const event of selected) {
    const key = event.activityId ?? [event.event, event.toolCallId, event.recordedAt, event.toolName].join(":");
    deduped.set(key, event);
  }
  return [...deduped.values()].sort((left, right) => String(left.recordedAt).localeCompare(String(right.recordedAt))).slice(-2_000);
}

function commandProjection(events: ActivityInspectorEvent[]) {
  const calls = events.filter((event) => event.event === "tool_call" && ["bash", "shell", "exec"].includes(String(event.toolName)));
  const results = new Map(events.filter((event) => event.event === "tool_result").map((event) => [event.toolCallId, event]));
  const decisions = new Map(events.filter((event) => event.event === "tool_decision").map((event) => [event.toolCallId, event]));
  const entries = calls.map((call) => {
    const decision = decisions.get(call.toolCallId);
    const result = results.get(call.toolCallId);
    const blocked = decision?.decision === "blocked";
    const failed = !blocked && Boolean(result && (result.isError === true || number(result.exitCode) !== 0));
    return {
      toolCallId: call.toolCallId ?? "unknown",
      command: call.command ?? "[redacted or unavailable]",
      status: blocked ? "blocked" : !result ? "running" : failed ? "failed" : "passed",
      exitCode: result?.exitCode ?? null,
      exitCodeExact: result?.exitCodeExact === true,
      reason: blocked ? decision?.reason ?? "blocked by policy" : null,
      recordedAt: call.recordedAt ?? null
    };
  });
  return {
    requested: entries.length,
    executed: entries.filter((entry) => entry.status !== "blocked").length,
    passed: entries.filter((entry) => entry.status === "passed").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    blocked: entries.filter((entry) => entry.status === "blocked").length,
    entries: entries.slice(-50).reverse()
  };
}

function failedToolResult(event: ActivityInspectorEvent): boolean {
  return event.isError === true || (typeof event.exitCode === "number" && event.exitCode !== 0);
}

function safetyProjection(events: ActivityInspectorEvent[], resumeWarnings: string[], trajectoryWarnings: string[]) {
  const entries = [
    ...events.filter((event) => event.event === "tool_decision" && event.decision === "blocked").map((event) => ({ kind: "policy-block", message: event.reason ?? `${event.toolName ?? "tool"} blocked`, recordedAt: event.recordedAt ?? null })),
    ...events.filter((event) => event.event === "security_warning").map((event) => ({ kind: event.warningKind ?? "warning", message: event.reason ?? "security warning", recordedAt: event.recordedAt ?? null })),
    ...events.filter((event) => event.event === "tool_result" && number(event.sensitiveValuesRedacted) > 0).map((event) => ({ kind: "secret-redaction", message: `${event.toolName ?? "tool"}: ${number(event.sensitiveValuesRedacted)} sensitive value(s) redacted`, recordedAt: event.recordedAt ?? null })),
    ...strings([...resumeWarnings, ...trajectoryWarnings]).map((message) => ({ kind: "runtime-integrity", message, recordedAt: null }))
  ];
  const unique = new Map(entries.map((entry) => [`${entry.kind}:${entry.message}`, entry]));
  const values = [...unique.values()];
  return {
    warnings: values.length,
    blocked: values.filter((entry) => entry.kind === "policy-block").length,
    redactions: values.filter((entry) => entry.kind === "secret-redaction").length,
    entries: values.slice(-50).reverse()
  };
}

export function buildActivityInspector(input: {
  cwd: string;
  sessionId: string;
  task?: TaskContract;
  events?: ActivityInspectorEvent[];
  sessionEntries?: unknown[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  current?: CurrentActivity[];
  fileEvidenceMode?: "exact" | "observed";
  workingTreeFiles?: string[];
}) {
  const task = input.task;
  const events = scopedEvents(input.events ?? [], input.sessionId, task);
  const fileEvidenceMode = input.fileEvidenceMode ?? "exact";
  const currentSnapshot = fileEvidenceMode === "exact" ? workingTreeSnapshot(input.cwd) as Record<string, string> : {};
  const treeFiles = fileEvidenceMode === "exact" ? Object.keys(currentSnapshot).sort() : strings(input.workingTreeFiles ?? inspectWorkingTreeFiles(input.cwd)).sort();
  const taskFiles = task ? fileEvidenceMode === "exact"
    ? changedSnapshotFiles(task.baselineFileDigests ?? {}, currentSnapshot)
    : strings([...(task.observedChangedFiles ?? []), ...(task.changedFiles ?? [])]).sort()
    : [];
  const inspectedFiles = task ? taskFiles : treeFiles;
  const fileEntries = inspectChangedFileStats(input.cwd, inspectedFiles);
  const additions = fileEntries.reduce((sum, entry) => sum + (entry.additions ?? 0), 0);
  const deletions = fileEntries.reduce((sum, entry) => sum + (entry.deletions ?? 0), 0);
  const unknownLineStats = fileEntries.filter((entry) => entry.additions === null || entry.deletions === null).length;
  const baselineOverlap = task ? taskFiles.filter((file) => (task.baselineChangedFiles ?? []).includes(file)) : [];
  const trajectory = task ? readTrajectoryStore(input.cwd, task.taskRunId) : undefined;
  const resume = task && fileEvidenceMode === "exact" ? inspectTaskResumeState(input.cwd, task, input.sessionId, currentSnapshot) : undefined;
  const calls = events.filter((event) => event.event === "tool_call");
  const results = events.filter((event) => event.event === "tool_result");
  const byName = Object.fromEntries([...new Set(calls.map((event) => event.toolName ?? "unknown"))].sort().map((name) => [name, calls.filter((event) => (event.toolName ?? "unknown") === name).length]));
  const usage = usageFromEntries(input.sessionEntries ?? []);
  const commands = commandProjection(events);
  const safety = safetyProjection(events, resume?.warnings ?? [], trajectory?.warnings ?? []);
  return {
    schemaVersion: 1,
    version: ACTIVITY_INSPECTOR_VERSION,
    state: {
      taskId: task?.taskId ?? null,
      taskRunId: task?.taskRunId ?? null,
      phase: trajectory?.state?.currentPhase ?? null,
      outcome: task?.trace.outcome ?? "idle",
      running: input.current?.filter((activity) => (activity.status ?? "running") === "running").length ?? 0,
      current: input.current ?? []
    },
    files: {
      taskChanged: taskFiles,
      workingTree: treeFiles,
      count: inspectedFiles.length,
      testFiles: inspectedFiles.filter(isTestPath),
      sourceFiles: inspectedFiles.filter((file) => !isTestPath(file)),
      additions,
      deletions,
      unknownLineStats,
      evidence: fileEvidenceMode === "exact" ? "exact-snapshot-delta" : task ? "observed-task-files" : "working-tree-status",
      lineStatsScope: baselineOverlap.length > 0 ? "mixed-working-tree" : task ? fileEvidenceMode === "exact" ? "task-clean-baseline" : "observed-task-files" : "working-tree",
      baselineOverlap,
      entries: fileEntries
    },
    tools: {
      calls: calls.length,
      results: results.length,
      failed: results.filter(failedToolResult).length,
      blocked: events.filter((event) => event.event === "tool_decision" && event.decision === "blocked").length,
      byName,
      perToolTokens: null,
      perToolTokensReason: "Pi reports model usage by response/turn; built-in tool calls do not carry attributable model-token totals."
    },
    commands,
    safety,
    verification: {
      attempts: task?.verifyEvidence.length ?? 0,
      passed: task?.verifyEvidence.filter((entry) => entry.exitCode === 0).length ?? 0,
      failed: task?.verifyEvidence.filter((entry) => entry.exitCode !== 0).length ?? 0,
      results: task?.verifyEvidence.slice(-20).reverse().map((entry) => ({ command: entry.command, exitCode: entry.exitCode, recordedAt: entry.recordedAt })) ?? []
    },
    context: {
      current: input.contextUsage ?? null,
      session: usage.totals,
      latestTurn: usage.latest,
      attribution: "session-and-turn-only"
    }
  };
}

function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "?";
  if (Math.abs(value) < 1_000) return String(Math.round(value));
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}

function clip(value: string, maximum = 120): string {
  const single = String(value ?? "")
    .replace(/\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return single.length <= maximum ? single : `${single.slice(0, maximum - 1)}…`;
}

export function formatActivityInspector(view: ReturnType<typeof buildActivityInspector>, action = "summary"): string {
  const context = view.context.current;
  const contextText = context ? `${compactNumber(context.tokens)}/${compactNumber(context.contextWindow)} (${context.percent === null ? "?" : `${context.percent.toFixed(1)}%`})` : "unavailable";
  if (action === "files") return [
    `files: ${view.files.count}; tests=${view.files.testFiles.length}; source=${view.files.sourceFiles.length}`,
    `lines: +${view.files.additions} -${view.files.deletions}; unknown=${view.files.unknownLineStats}; scope=${view.files.lineStatsScope}`,
    ...(view.files.baselineOverlap.length ? [`pre-existing overlap: ${view.files.baselineOverlap.join(", ")}`] : []),
    ...view.files.entries.map((entry) => `${entry.test ? "test" : "file"} ${entry.path}  +${entry.additions ?? "?"} -${entry.deletions ?? "?"}  ${entry.status}`)
  ].join("\n");
  if (action === "commands") return [
    `commands: requested=${view.commands.requested}; executed=${view.commands.executed}; passed=${view.commands.passed}; failed=${view.commands.failed}; blocked=${view.commands.blocked}`,
    `verification: attempts=${view.verification.attempts}; passed=${view.verification.passed}; failed=${view.verification.failed}`,
    ...view.commands.entries.map((entry) => `${entry.status === "passed" ? "✓" : entry.status === "failed" ? "✗" : entry.status === "blocked" ? "⊘" : "…"} ${clip(entry.command)}${entry.exitCode === null ? "" : `  exit=${entry.exitCode}${entry.exitCodeExact ? "" : " (derived)"}`}${entry.reason ? `  ${clip(entry.reason, 160)}` : ""}`)
  ].join("\n");
  if (action === "security") return [
    `safety: warnings=${view.safety.warnings}; blocked=${view.safety.blocked}; redactions=${view.safety.redactions}`,
    ...(view.safety.entries.length ? view.safety.entries.map((entry) => `⚠ ${entry.kind}: ${clip(entry.message, 180)}`) : ["No recorded safety warning for this task."])
  ].join("\n");
  if (action === "context") return [
    `context: ${contextText}`,
    `session: ↑${compactNumber(view.context.session.input)} ↓${compactNumber(view.context.session.output)} R${compactNumber(view.context.session.cacheRead)} W${compactNumber(view.context.session.cacheWrite)} cost=$${view.context.session.cost.toFixed(3)}`,
    `latestTurn: ↑${compactNumber(view.context.latestTurn.input)} ↓${compactNumber(view.context.latestTurn.output)} R${compactNumber(view.context.latestTurn.cacheRead)} W${compactNumber(view.context.latestTurn.cacheWrite)}`,
    `tools: ${Object.entries(view.tools.byName).map(([name, count]) => `${name}×${count}`).join(" · ") || "none"}`,
    "perToolTokens: unavailable — Pi exposes model usage by turn/session, not attributable tokens for each built-in tool call."
  ].join("\n");
  const activity = view.state.current.at(-1);
  return [
    `Piagent Inspector: ${view.state.phase ?? view.state.outcome}${view.state.running ? `; running=${view.state.running}` : ""}`,
    `activity: ${activity ? `${activity.label}${activity.target ? ` ${clip(activity.target, 100)}` : ""}` : "idle"}`,
    `files: ${view.files.count} (${view.files.testFiles.length} tests); +${view.files.additions} -${view.files.deletions}; scope=${view.files.lineStatsScope}`,
    `commands: ${view.commands.executed} executed; ${view.commands.failed} failed; ${view.commands.blocked} blocked`,
    `tools: ${view.tools.calls} calls; ${view.tools.failed} failed`,
    `safety: ${view.safety.warnings} warning(s); ${view.safety.redactions} redaction(s)`,
    `context: ${contextText}; latest ↑${compactNumber(view.context.latestTurn.input)} ↓${compactNumber(view.context.latestTurn.output)}`,
    `verify: ${view.verification.passed} passed; ${view.verification.failed} failed`,
    "details: /piagent-inspector files|commands|security|context"
  ].join("\n");
}
