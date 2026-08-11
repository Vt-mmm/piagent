import type { TrajectoryPhase } from "../trajectory/trajectory-types.ts";
import { PIAGENT_TOOL_NAMES, PIAGENT_TOOL_ORDER } from "./tool-groups.ts";

export const PHASE_TOOL_GROUPS = Object.freeze(["intake", "retrieval", "planning", "mutation", "verification", "review", "recovery", "handoff", "operator"] as const);
export type PhaseToolGroup = typeof PHASE_TOOL_GROUPS[number];

export const PIAGENT_PRIMARY_TOOL_GROUP = Object.freeze({
  piagent_tools: "operator",
  piagent_task_start: "intake",
  piagent_context: "intake",
  piagent_context_preflight: "intake",
  piagent_task_progress: "mutation",
  piagent_context_record: "recovery",
  piagent_verify_record: "verification",
  piagent_trace_record: "handoff",
  piagent_task_gate_check: "review",
  piagent_permission_status: "operator",
  piagent_exec_policy_check: "operator",
  piagent_tool_policy_check: "operator",
  piagent_context_engine: "retrieval",
  piagent_context_budget: "retrieval",
  piagent_context_index_status: "retrieval",
  piagent_context_index_search: "retrieval",
  piagent_memory_status: "retrieval",
  piagent_memory_search: "retrieval",
  piagent_memory_citation_record: "review",
  piagent_document_read: "retrieval",
  piagent_source_checkout: "retrieval",
  piagent_orchestration_policy: "planning",
  piagent_profile_options: "operator",
  piagent_profile_apply: "operator",
  piagent_profile_tech_options: "operator",
  piagent_profile_tech_apply: "operator",
  piagent_profile_tech_context_record: "operator",
  piagent_project_onboarding_record: "operator",
  piagent_context_index_record: "operator",
  piagent_memory_note: "operator",
  piagent_usage_snapshot: "operator"
} satisfies Record<string, PhaseToolGroup>);

export const PIAGENT_OPERATOR_TOOLS = new Set<string>(Object.entries(PIAGENT_PRIMARY_TOOL_GROUP)
  .filter(([, group]) => group === "operator").map(([tool]) => tool));
export const PIAGENT_DIAGNOSTIC_TOOLS = new Set<string>([
  "piagent_context_preflight", "piagent_permission_status", "piagent_exec_policy_check", "piagent_tool_policy_check",
  "piagent_context_budget", "piagent_context_index_status", "piagent_memory_status", "piagent_usage_snapshot"
]);
export const PIAGENT_MUTATION_CAPABLE_TOOLS = new Set<string>([
  "piagent_context_engine", "piagent_source_checkout", "piagent_profile_apply", "piagent_profile_tech_apply",
  "piagent_profile_tech_context_record", "piagent_project_onboarding_record", "piagent_context_index_record", "piagent_memory_note"
]);
export const PIAGENT_SEQUENTIAL_TOOLS = new Set<string>([
  ...PIAGENT_MUTATION_CAPABLE_TOOLS, "piagent_tools", "piagent_task_start", "piagent_task_progress", "piagent_context_record",
  "piagent_verify_record", "piagent_trace_record", "piagent_memory_citation_record"
]);

const PHASE_GROUP_POLICY: Record<TrajectoryPhase, PhaseToolGroup[]> = {
  intake: ["intake", "retrieval"],
  scout: ["retrieval", "mutation", "recovery"],
  plan: ["retrieval", "planning", "mutation", "recovery"],
  execute: ["retrieval", "mutation"],
  verify: ["retrieval", "verification", "recovery"],
  repair: ["retrieval", "mutation", "verification", "recovery"],
  review: ["retrieval", "mutation", "verification", "review"],
  handoff: ["verification", "review", "handoff"],
  terminal: []
};

const REQUIRED_HOST_TOOLS: Record<TrajectoryPhase, string[]> = {
  intake: ["read", "grep", "find", "ls"],
  scout: ["read", "grep", "find", "ls"],
  plan: ["read", "grep", "find", "ls"],
  execute: ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash"],
  verify: ["read", "bash"],
  repair: ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash"],
  // Review needs a bounded read-only shell for git diff/status and similar
  // current-tree inspection. Mutation authorization remains carrier-aware in
  // PhaseToolRuntime.mutationDecision; exposing bash here does not authorize
  // project writes.
  review: ["read", "grep", "find", "ls", "bash"],
  handoff: ["read"],
  terminal: []
};

const PHASE_TOOL_ALLOW: Record<TrajectoryPhase, string[]> = {
  intake: [],
  scout: ["piagent_task_progress", "piagent_context_index_search", "piagent_document_read"],
  plan: ["piagent_task_progress", "piagent_orchestration_policy"],
  execute: ["piagent_task_progress"],
  // Runtime hooks own context, verifier, gate, and handoff evidence. Keeping
  // their record tools model-visible duplicates work and creates false manual
  // choreography in otherwise automatic tasks.
  verify: [],
  repair: ["piagent_task_progress", "piagent_context_index_search"],
  review: ["piagent_task_progress"],
  handoff: [],
  terminal: []
};

export type PhaseToolPolicy = {
  phase: TrajectoryPhase;
  changeMode: "source-change" | "read-only";
  primaryGroups: PhaseToolGroup[];
  modelVisiblePiagentTools: string[];
  requiredHostTools: string[];
  operatorTools: string[];
  diagnosticTools: string[];
};

export function phaseToolPolicy(phase: TrajectoryPhase, changeMode: PhaseToolPolicy["changeMode"]): PhaseToolPolicy {
  const primaryGroups = PHASE_GROUP_POLICY[phase];
  const readOnlySurface = changeMode === "read-only" || phase === "review";
  const modelVisiblePiagentTools = PIAGENT_TOOL_ORDER.filter((tool) => {
    const group = PIAGENT_PRIMARY_TOOL_GROUP[tool as keyof typeof PIAGENT_PRIMARY_TOOL_GROUP];
    return PHASE_TOOL_ALLOW[phase].includes(tool)
      && primaryGroups.includes(group)
      && !PIAGENT_OPERATOR_TOOLS.has(tool)
      && !PIAGENT_DIAGNOSTIC_TOOLS.has(tool)
      && (!readOnlySurface || !PIAGENT_MUTATION_CAPABLE_TOOLS.has(tool));
  });
  const requiredHostTools = REQUIRED_HOST_TOOLS[phase].filter((tool) => !(readOnlySurface && ["edit", "write", "apply_patch"].includes(tool)));
  return {
    phase,
    changeMode,
    primaryGroups: [...primaryGroups],
    modelVisiblePiagentTools,
    requiredHostTools,
    operatorTools: PIAGENT_TOOL_ORDER.filter((tool) => PIAGENT_OPERATOR_TOOLS.has(tool)),
    diagnosticTools: PIAGENT_TOOL_ORDER.filter((tool) => PIAGENT_DIAGNOSTIC_TOOLS.has(tool))
  };
}

export function phaseToolPolicyErrors(): string[] {
  const errors: string[] = [];
  const classified = Object.keys(PIAGENT_PRIMARY_TOOL_GROUP);
  for (const tool of PIAGENT_TOOL_ORDER) if (!(tool in PIAGENT_PRIMARY_TOOL_GROUP)) errors.push(`missing primary group: ${tool}`);
  for (const tool of classified) if (!PIAGENT_TOOL_NAMES.has(tool)) errors.push(`unknown classified tool: ${tool}`);
  if (new Set(classified).size !== classified.length) errors.push("primary tool classification contains duplicates");
  for (const group of PHASE_TOOL_GROUPS) if (!Object.values(PIAGENT_PRIMARY_TOOL_GROUP).includes(group)) errors.push(`primary group has no tool: ${group}`);
  return errors;
}
