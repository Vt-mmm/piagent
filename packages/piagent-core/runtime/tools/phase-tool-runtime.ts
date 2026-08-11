import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import type { TrajectoryState } from "../trajectory/trajectory-types.ts";
import { PIAGENT_TOOL_NAMES } from "./tool-groups.ts";
import { PIAGENT_DIAGNOSTIC_TOOLS, PIAGENT_OPERATOR_TOOLS, phaseToolPolicy } from "./phase-tools.ts";

export type PhaseToolMode = "off" | "shadow" | "on";
export type PhaseMutationInput = {
  projectMutation: boolean;
  exactSourceVerifier?: boolean;
  verificationCarrier?: boolean;
};

const MANAGED_HOST_TOOL_ORDER = Object.freeze(["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash", "shell", "exec"]);

function phaseHostToolName(toolName: string): string {
  return toolName === "shell" || toolName === "exec" ? "bash" : toolName;
}

export function phaseToolModeFromEnvironment(input: string | undefined): PhaseToolMode {
  const normalized = input?.trim().toLowerCase();
  return normalized === "off" || normalized === "on" || normalized === "shadow" ? normalized : "shadow";
}

export function intendedPhaseTools(current: string[], available: string[], state: TrajectoryState): string[] {
  const policy = phaseToolPolicy(state.currentPhase, state.changeMode);
  const availableSet = new Set([...available, ...current]);
  const preserved = current.filter((tool) => !PIAGENT_TOOL_NAMES.has(tool) && !MANAGED_HOST_TOOL_ORDER.includes(tool));
  const host = MANAGED_HOST_TOOL_ORDER.filter((tool) => availableSet.has(tool) && policy.requiredHostTools.includes(phaseHostToolName(tool)));
  const piagent = policy.modelVisiblePiagentTools.filter((tool) => availableSet.has(tool));
  return [...new Set([...preserved, ...host, ...piagent])];
}

type PhaseToolHost = Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">;
type Telemetry = (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
type DigestMigrationStatus = (ctx: ExtensionContext) => string | undefined;
type AuthorityMode = (ctx: ExtensionContext) => PhaseToolMode | undefined;

export class PhaseToolRuntime {
  private readonly states = new Map<string, TrajectoryState>();
  private readonly observations = new Map<string, string>();
  private readonly pi: PhaseToolHost;
  private readonly telemetry: Telemetry;
  private readonly digestMigrationStatus: DigestMigrationStatus;
  private readonly authorityMode: AuthorityMode;
  readonly mode: PhaseToolMode;

  constructor(pi: PhaseToolHost, mode: PhaseToolMode, telemetry: Telemetry, digestMigrationStatus: DigestMigrationStatus = () => undefined, authorityMode: AuthorityMode = () => undefined) {
    this.pi = pi;
    this.mode = mode;
    this.telemetry = telemetry;
    this.digestMigrationStatus = digestMigrationStatus;
    this.authorityMode = authorityMode;
  }

  private effectiveMode(ctx: ExtensionContext): PhaseToolMode { return this.authorityMode(ctx) ?? this.mode; }

  private key(ctx: ExtensionContext): string {
    return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
  }

  private activate(ctx: ExtensionContext, state: TrajectoryState): void {
    const mode = this.effectiveMode(ctx); if (mode === "off") return;
    const current = this.pi.getActiveTools();
    const available = this.pi.getAllTools().map((tool) => tool.name);
    const intended = intendedPhaseTools(current, available, state);
    const changed = current.length !== intended.length || intended.some((tool, index) => tool !== current[index]);
    const added = intended.filter((tool) => !current.includes(tool));
    const removed = current.filter((tool) => !intended.includes(tool));
    const observation = JSON.stringify([state.taskRunId, state.sequence, state.currentPhase, current, intended]);
    if (changed && this.observations.get(this.key(ctx)) !== observation) {
      this.observations.set(this.key(ctx), observation);
      this.telemetry(ctx, { event: "phase_tool_activation", mode, taskId: state.taskId, taskRunId: state.taskRunId, phase: state.currentPhase, sequence: state.sequence, currentCount: current.length, intendedCount: intended.length, added, removed, applied: mode === "on", enforcement: mode === "on" ? "tool-call-guard" : "shadow" });
    }
    // Keep the provider-visible tool schema cache-stable for the whole task.
    // On mode enforces phase policy at tool-call time via `toolDecision` rather
    // than replacing schemas after each trajectory transition.
  }

  toolDecision(ctx: ExtensionContext, toolName: string): { block: true; reason: string } | undefined {
    if (this.effectiveMode(ctx) !== "on") return undefined;
    if (toolName === "piagent_task_start" && this.digestMigrationStatus(ctx) === "new-attempt-required") return undefined;
    const state = this.states.get(this.key(ctx));
    if (!state) return undefined;
    const policy = phaseToolPolicy(state.currentPhase, state.changeMode);
    if (MANAGED_HOST_TOOL_ORDER.includes(toolName) && !policy.requiredHostTools.includes(phaseHostToolName(toolName))) {
      return { block: true, reason: `Phase ${state.currentPhase} does not allow host tool ${toolName}; allowed host tools: ${policy.requiredHostTools.join(", ") || "none"}.` };
    }
    if (
      PIAGENT_TOOL_NAMES.has(toolName)
      && !PIAGENT_OPERATOR_TOOLS.has(toolName)
      && !PIAGENT_DIAGNOSTIC_TOOLS.has(toolName)
      && !policy.modelVisiblePiagentTools.includes(toolName)
    ) {
      return { block: true, reason: `Phase ${state.currentPhase} does not allow ${toolName}; allowed Piagent tools: ${policy.modelVisiblePiagentTools.join(", ") || "none"}.` };
    }
    return undefined;
  }

  mutationDecision(ctx: ExtensionContext, input: PhaseMutationInput): { block: true; reason: string } | undefined {
    if (this.effectiveMode(ctx) !== "on") return undefined;
    if (this.digestMigrationStatus(ctx) === "verification-refresh-required" && (input.projectMutation || input.verificationCarrier)) return input.exactSourceVerifier ? undefined : { block: true, reason: "Digest migration permits only the exact configured verifier under a pre/post tree invariant until current-tree evidence is refreshed." };
    const state = this.states.get(this.key(ctx));
    if (!state || (!input.projectMutation && !input.exactSourceVerifier)) return undefined;
    if (state.changeMode === "read-only") {
      return { block: true, reason: `Task ${state.taskId} is read-only; project mutation and source verification are not authorized.` };
    }
    if (input.exactSourceVerifier) {
      if (["execute", "verify", "repair"].includes(state.currentPhase)) return undefined;
      return { block: true, reason: `Phase ${state.currentPhase} does not authorize the exact source verifier; verification is allowed only in execute, verify, or repair.` };
    }
    if (input.projectMutation) {
      if (state.currentPhase === "execute" || state.currentPhase === "repair") return undefined;
      return { block: true, reason: `Phase ${state.currentPhase} does not authorize project mutation; mutation is allowed only in execute or repair.` };
    }
    return undefined;
  }

  apply<T extends TrajectorySyncResult | undefined>(ctx: ExtensionContext, result: T): T {
    if (this.effectiveMode(ctx) === "off" || !result?.enforcementSafe || !result.state) return result;
    this.states.set(this.key(ctx), result.state);
    while (this.states.size > 128) this.states.delete(this.states.keys().next().value as string);
    while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value as string);
    this.activate(ctx, result.state);
    return result;
  }

  reapply(ctx: ExtensionContext): void {
    const state = this.states.get(this.key(ctx));
    if (state) this.activate(ctx, state);
  }
}
