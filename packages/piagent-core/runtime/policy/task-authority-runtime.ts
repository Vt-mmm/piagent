import {
  createTaskAuthoritySnapshot,
  taskAuthoritySnapshotValidationErrors,
  type AuthorityProfileId,
  type NormalizedAuthority,
  type TaskAuthorityEntry,
  type TaskAuthoritySnapshot
} from "../../capabilities/authority-manifest.ts";
import { parentRoutingModeFromEnvironment } from "../model/model-route-policy.ts";
import { helpersMode } from "../orchestration/helper-lifecycle.ts";
import { solverModeFromEnvironment } from "../solver/solver-shadow.ts";
import { phaseToolModeFromEnvironment } from "../tools/phase-tool-runtime.ts";

export type AuthorityAction = "observe" | "advise" | "block" | "mutate" | "model-turn" | "dispatch";
export type TaskAuthorityCarrier = {
  taskId: string;
  taskRunId: string;
  createdAt: string;
  authoritySnapshot?: TaskAuthoritySnapshot;
};
export type TaskAuthorityDecision = {
  allowed: boolean;
  capabilityId: string;
  action: AuthorityAction;
  authority: NormalizedAuthority | "legacy-unbound";
  mode: string;
  reason: "allowed" | "authority-too-low" | "budget-not-declared" | "missing-task-snapshot" | "invalid-task-snapshot" | "task-identity-mismatch";
  entry?: TaskAuthorityEntry;
};

const LEGACY_HARD_INVARIANTS = new Set(["CAP-01", "CAP-02", "CAP-03", "CAP-04"]);

function snapshotDisposition(task: TaskAuthorityCarrier): { snapshot?: TaskAuthoritySnapshot; reason?: TaskAuthorityDecision["reason"] } {
  if (!task.authoritySnapshot) return { reason: "missing-task-snapshot" };
  if (taskAuthoritySnapshotValidationErrors(task.authoritySnapshot).length > 0) return { reason: "invalid-task-snapshot" };
  if (task.authoritySnapshot.taskId !== task.taskId || task.authoritySnapshot.taskRunId !== task.taskRunId || task.authoritySnapshot.capturedAt !== task.createdAt) {
    return { reason: "task-identity-mismatch" };
  }
  return { snapshot: task.authoritySnapshot };
}

function actionAllowed(entry: TaskAuthorityEntry, action: AuthorityAction): boolean {
  if (entry.authority === "off") return false;
  if (action === "observe") return true;
  if (action === "advise") return entry.authority === "advise" || entry.authority === "enforce" || entry.authority === "orchestrate";
  if (action === "block" || action === "mutate") return entry.authority === "enforce" || entry.authority === "orchestrate";
  if (action === "dispatch") return entry.authority === "orchestrate" && entry.budgets.automaticDispatches > 0;
  return (entry.authority === "enforce" || entry.authority === "orchestrate")
    && (entry.budgets.systemContinuations > 0 || entry.budgets.reviewRounds > 0 || entry.budgets.automaticDispatches > 0);
}

export function taskAuthorityDecision(task: TaskAuthorityCarrier, capabilityId: string, action: AuthorityAction): TaskAuthorityDecision {
  const disposition = snapshotDisposition(task);
  if (!disposition.snapshot) {
    const legacyHardInvariant = LEGACY_HARD_INVARIANTS.has(capabilityId) && ["observe", "advise", "block", "mutate"].includes(action);
    return { allowed: legacyHardInvariant, capabilityId, action, authority: "legacy-unbound", mode: "legacy-unbound", reason: legacyHardInvariant ? "allowed" : disposition.reason as TaskAuthorityDecision["reason"] };
  }
  const entry = disposition.snapshot.capabilities.find((candidate) => candidate.id === capabilityId);
  if (!entry) return { allowed: false, capabilityId, action, authority: "legacy-unbound", mode: "invalid", reason: "invalid-task-snapshot" };
  const allowed = actionAllowed(entry, action);
  const budgetMissing = (action === "model-turn" || action === "dispatch") && ["enforce", "orchestrate"].includes(entry.authority) && !allowed;
  return { allowed, capabilityId, action, authority: entry.authority, mode: entry.mode, reason: allowed ? "allowed" : budgetMissing ? "budget-not-declared" : "authority-too-low", entry };
}

export function taskAuthorityMode(task: TaskAuthorityCarrier, capabilityId: string): string {
  const disposition = snapshotDisposition(task);
  return disposition.snapshot?.capabilities.find((candidate) => candidate.id === capabilityId)?.mode ?? "off";
}

export function createBoundTaskAuthority(input: { taskId: string; taskRunId: string; createdAt: string; profile?: AuthorityProfileId }): TaskAuthoritySnapshot {
  return createTaskAuthoritySnapshot({ taskId: input.taskId, taskRunId: input.taskRunId, capturedAt: input.createdAt, profile: input.profile ?? "broad-default" });
}

export function taskAuthorityProfileFromEnvironment(value = process.env.PIAGENT_AUTHORITY_PROFILE): AuthorityProfileId {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "mechanical-only" || normalized === "strict-high-risk" ? normalized : "broad-default";
}

function featureMode(value: string | undefined): "off" | "on" | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase()) ? "off" : "on";
}

function explicitOff(value: string | undefined): "off" | undefined {
  return value !== undefined && ["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase()) ? "off" : undefined;
}

export function createEnvironmentBoundTaskAuthority(
  input: { taskId: string; taskRunId: string; createdAt: string; profile?: AuthorityProfileId },
  environment: NodeJS.ProcessEnv = process.env
): TaskAuthoritySnapshot {
  const profile = input.profile ?? taskAuthorityProfileFromEnvironment(environment.PIAGENT_AUTHORITY_PROFILE);
  const overrides: Record<string, string> = {};
  const autoContext = featureMode(environment.PIAGENT_AUTO_CONTEXT), dynamicTools = featureMode(environment.PIAGENT_DYNAMIC_TOOLS);
  const recovery = featureMode(environment.PIAGENT_AUTO_RECOVERY), telemetry = featureMode(environment.PIAGENT_CONTEXT_TELEMETRY);
  const assurance = explicitOff(environment.PIAGENT_ACCEPTANCE_ASSURANCE), semanticRepair = explicitOff(environment.PIAGENT_SEMANTIC_REPAIR);
  if (autoContext) overrides["CAP-05"] = autoContext;
  if (dynamicTools) overrides["CAP-06"] = dynamicTools;
  if (environment.PIAGENT_SOLVER_MODE !== undefined) overrides["CAP-08"] = solverModeFromEnvironment(environment.PIAGENT_SOLVER_MODE);
  if (environment.PIAGENT_PHASE_TOOLS !== undefined) overrides["CAP-09"] = phaseToolModeFromEnvironment(environment.PIAGENT_PHASE_TOOLS);
  if (recovery) overrides["CAP-12"] = recovery;
  if (environment.PIAGENT_HELPERS_MODE !== undefined) overrides["CAP-14"] = helpersMode(environment.PIAGENT_HELPERS_MODE);
  if (environment.PIAGENT_PARENT_ROUTING !== undefined) overrides["CAP-15"] = parentRoutingModeFromEnvironment(environment.PIAGENT_PARENT_ROUTING);
  if (telemetry) overrides["CAP-17"] = telemetry;
  if (assurance) overrides["CAP-11"] = assurance;
  if (semanticRepair) overrides["CAP-13"] = semanticRepair;
  if (profile === "mechanical-only") {
    for (const [capabilityId, mode] of Object.entries(overrides)) if (mode !== "off") delete overrides[capabilityId];
  }
  if (overrides["CAP-05"] === "off") Object.assign(overrides, { "CAP-07": "off", "CAP-08": "off", "CAP-14": "off", "CAP-15": "off" });
  if (overrides["CAP-08"] === "off") Object.assign(overrides, { "CAP-14": "off", "CAP-15": "off" });
  if (overrides["CAP-14"] === "off") overrides["CAP-15"] = "off";
  if (overrides["CAP-09"] === "off" || overrides["CAP-11"] === "off" || overrides["CAP-12"] === "off") overrides["CAP-13"] = "off";
  return createTaskAuthoritySnapshot({ taskId: input.taskId, taskRunId: input.taskRunId, capturedAt: input.createdAt, profile, modeOverrides: overrides, resolutionSource: Object.keys(overrides).length > 0 ? "explicit-overrides" : "profile" });
}
