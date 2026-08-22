import crypto from "node:crypto";

import { durableContextEvidenceEntries } from "../../extensions/context-evidence.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { readSolverShadowEvents } from "../solver/solver-shadow.ts";
import { readTrajectoryStore } from "../trajectory/trajectory-store.ts";
import type { TrajectoryPhase } from "../trajectory/trajectory-types.ts";

export const TASK_EFFICIENCY_METRICS_VERSION = "task-efficiency-v1" as const;

type ExactUsage = {
  tokens: number | null;
  cost: number | null;
  currency: string | null;
  source: "provider" | "pi-runtime";
};

function hash(value: string): string {
  return crypto.createHash("sha256").update(value || "unknown-session").digest("hex");
}

function duration(start: string, end: string): number | null {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function phaseDurations(task: TaskContract, trajectory: ReturnType<typeof readTrajectoryStore>): Array<{ phase: TrajectoryPhase; durationMs: number }> {
  if (trajectory.status !== "ok" || !trajectory.state) return [];
  if (trajectory.state.sequence > 0 && trajectory.events.length !== trajectory.state.sequence) return [];
  const totals = new Map<TrajectoryPhase, number>();
  let phase: TrajectoryPhase = "intake";
  let startedAt = trajectory.state.createdAt;
  for (const event of trajectory.events) {
    const elapsed = duration(startedAt, event.observedAt);
    if (elapsed !== null) totals.set(phase, (totals.get(phase) ?? 0) + elapsed);
    phase = event.to;
    startedAt = event.observedAt;
  }
  const elapsed = duration(startedAt, task.updatedAt);
  if (elapsed !== null) totals.set(phase, (totals.get(phase) ?? 0) + elapsed);
  return [...totals.entries()].map(([name, durationMs]) => ({ phase: name, durationMs }));
}

export function buildTaskEfficiencyMetrics(
  cwd: string,
  task: TaskContract,
  input: { activeToolGroups?: string[]; exactUsage?: ExactUsage } = {}
) {
  const sessionHash = hash(task.sessionId);
  const solverStore = readSolverShadowEvents(cwd);
  const solverEvent = [...solverStore.records].reverse().find((event) => event.sessionHash === sessionHash);
  const trajectory = readTrajectoryStore(cwd, task.taskRunId);
  const decision = solverEvent?.decision;
  const helperUsage = task.acceptanceReceipt?.helperUsage;
  const provenance = task.acceptanceReceipt?.provenance;
  const contextEvidence = durableContextEvidenceEntries(task);
  const relevantEvent = trajectory.events.find((event) => event.cause === "context-observed");
  const relevantFileMs = relevantEvent && contextEvidence.length > 0 ? duration(task.createdAt, relevantEvent.observedAt) : null;
  const recommendedTools = decision?.toolGroups ?? [];
  const activeTools = [...new Set(input.activeToolGroups ?? [])].sort();
  const exactUsage = input.exactUsage && (input.exactUsage.tokens !== null || input.exactUsage.cost !== null)
    ? input.exactUsage
    : { tokens: null, cost: null, currency: null, source: "unavailable" as const };

  return {
    schemaVersion: 1,
    version: TASK_EFFICIENCY_METRICS_VERSION,
    identity: { taskId: task.taskId, taskRunId: task.taskRunId, sessionHash },
    compatibility: {
      solver: solverStore.corruptions.length > 0 ? "corrupt" : solverEvent ? "ok" : "unavailable",
      trajectory: trajectory.status,
      oldSessionReadable: true
    },
    solver: decision ? {
      mode: decision.mode,
      route: decision.route,
      override: decision.override,
      routeRegret: decision.override.observed ? "route-overridden" : "unreviewed"
    } : { mode: "unknown", route: "unknown", override: null, routeRegret: "unavailable" },
    trajectory: {
      currentPhase: trajectory.state?.currentPhase ?? null,
      phaseDurations: phaseDurations(task, trajectory),
      recoveredEvents: trajectory.recoveredEvents,
      warnings: trajectory.warnings.slice(0, 4)
    },
    context: {
      requiredFiles: task.requiredContext.length,
      manifestedFiles: contextEvidence.length,
      memoryCitations: task.memoryCitations.length,
      recommendedBudget: decision?.context.budgetBand ?? "unknown",
      timeToRelevantFileMs: relevantFileMs,
      timeToRelevantFileSource: relevantFileMs === null ? "unavailable" : "persisted-context-transition"
    },
    tools: {
      recommendedGroups: recommendedTools,
      activeGroups: activeTools,
      activeRecommendedGroups: activeTools.filter((group) => recommendedTools.includes(group)),
      actualInvocationCounts: null
    },
    timing: {
      taskDurationMs: duration(task.createdAt, task.updatedAt),
      timeToFirstCorrectEditMs: null,
      timeToFirstCorrectEditReason: "no persisted edit-to-verifier causal marker"
    },
    verification: {
      attempts: task.verifyEvidence.length,
      passed: task.verifyEvidence.filter((item) => item.exitCode === 0).length,
      failed: task.verifyEvidence.filter((item) => item.exitCode !== 0).length,
      repairCount: provenance?.repairCount ?? 0,
      retryCount: provenance?.retryCount ?? 0
    },
    helpers: {
      mode: helperUsage?.mode ?? "unknown",
      used: helperUsage?.used ?? false,
      entries: (helperUsage?.helpers ?? []).map((item) => ({
        role: item.role,
        model: null,
        calls: item.calls,
        tokens: item.tokens,
        disposition: item.disposition,
        requestRef: item.requestRef,
        outputDigest: item.outputDigest
      }))
    },
    outcome: {
      task: task.trace.outcome,
      acceptance: task.acceptanceReceipt?.criteria.map((item) => ({ id: item.id, status: item.status })) ?? [],
      recoveryDisposition: provenance?.finalRecoveryDisposition ?? "unknown"
    },
    exactUsage
  };
}
