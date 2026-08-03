import { classifyContextTask } from "../../extensions/context-engine.js";
import { runtimeLifecycleMode } from "../../extensions/task-lifecycle.js";
import type { TaskContract } from "../../extensions/guard-types.js";

export const PIAGENT_TOOL_GROUPS = {
  loader: ["piagent_tools"],
  intake: ["piagent_task_start"],
  governance: [
    "piagent_context",
    "piagent_context_preflight"
  ],
  task: ["piagent_task_progress"],
  recovery: [
    "piagent_context_record",
    "piagent_verify_record",
    "piagent_trace_record",
    "piagent_task_gate_check"
  ],
  policy: [
    "piagent_permission_status",
    "piagent_exec_policy_check",
    "piagent_tool_policy_check"
  ],
  retrieval: [
    "piagent_context_engine",
    "piagent_context_budget",
    "piagent_context_index_status",
    "piagent_context_index_search"
  ],
  knowledge: [
    "piagent_memory_status",
    "piagent_memory_search",
    "piagent_memory_citation_record",
    "piagent_document_read",
    "piagent_source_checkout",
    "piagent_orchestration_policy"
  ],
  onboarding: [
    "piagent_profile_options",
    "piagent_profile_apply",
    "piagent_profile_tech_options",
    "piagent_profile_tech_apply",
    "piagent_profile_tech_context_record",
    "piagent_project_onboarding_record",
    "piagent_context_index_record",
    "piagent_memory_note"
  ],
  usage: ["piagent_usage_snapshot"]
} as const;

export type PiagentToolGroup = keyof typeof PIAGENT_TOOL_GROUPS;

export const PIAGENT_TOOL_ORDER = Object.values(PIAGENT_TOOL_GROUPS).flat();
export const PIAGENT_TOOL_NAMES = new Set<string>(PIAGENT_TOOL_ORDER);

export function toolGroupsForPrompt(prompt: string): PiagentToolGroup[] {
  const signal = classifyContextTask(prompt);
  const lower = prompt.toLowerCase();
  const groups = new Set<PiagentToolGroup>();

  if (signal.workflow === "usage") return ["usage"];
  if (signal.workflow === "onboard") {
    return ["governance", "policy", "retrieval", "knowledge", "onboarding"];
  }

  groups.add("intake");
  if (signal.lane !== "tiny") groups.add("task");
  if (/\b(context (?:engine|index|search|diagnostic)|source checkout|vendor checkout)\b/.test(lower)) {
    groups.add("retrieval");
  }
  if (/\b(document intake|project memory|orchestration policy|source checkout|subagent policy|vendor checkout)\b/.test(lower)) {
    groups.add("knowledge");
  }
  if (/\b(permission|capability|exec policy|tool policy)\b/.test(lower)) groups.add("policy");
  if (/\b(profile|tech stack|onboard|project context)\b/.test(lower)) groups.add("onboarding");
  if (/\b(token|usage|cost)\b/.test(lower)) groups.add("usage");
  if (/\b(?:piagent tool loader|load piagent tools?|piagent tool groups?)\b/.test(lower)) groups.add("loader");
  return [...groups];
}

export function activeTaskToolGroups(task: TaskContract): PiagentToolGroup[] {
  const mode = runtimeLifecycleMode(task);
  if (mode.startsWith("automatic")) return [];
  if (mode.startsWith("assisted")) return ["task"];
  return ["task", "recovery"];
}
