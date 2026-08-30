import type { WorkflowId } from "../../extensions/workflow-catalog.ts";

export function buildOnboardingWorkflowPrompt(focus: string): string {
  return [
    "Run the Pi Agent Platform first-read onboarding workflow for this repository.",
    "",
    `Optional focus: ${focus.trim() || "whole repository"}`,
    "",
    "Preconditions:",
    "- The operator has logged in and selected the intended model/thinking level.",
    "- Stay read-only except writing Piagent onboarding state through piagent tools.",
    "",
    "Mandatory flow:",
    "1. Call piagent_context with detail=full.",
    "2. If the project is unprofiled, call piagent_profile_options, do a lightweight root scout, recommend a profile, and use piagent_profile_apply only after the operator choice is clear.",
    "3. Prefer /profile setup or piagent_profile_tech_options + piagent_profile_tech_apply for tech stack selection.",
    "4. Re-call piagent_context after profile/tech changes.",
    "5. Call piagent_memory_status and treat memory as advisory.",
    "6. Read AGENTS.md, README/package/build config, required context, docs/architecture files, source map, and verify command definitions. Do not ingest the whole repo.",
    "7. Identify project purpose, stack/runtime, ownership boundaries, high-risk areas, protected paths, verify commands, MCP/tool capabilities, selected tech stack, memory policy, and conventions.",
    "8. Write a concise .pi/project-context.md snapshot and record it with piagent_project_onboarding_record so .pi/context-index.json is generated.",
    "9. Call piagent_context_index_status and report pending/stale warnings.",
    "",
    "Final output: profile, tech stack, context files read, verification matrix, high-risk areas, context-index status, memory status, and any missing operator decisions."
  ].join("\n");
}

/** Exact /workflow namespace follow-up; keep request whitespace and workflow intent. */
export function buildWorkflowFollowUp(workflow: WorkflowId, request: string): string {
  return workflow === "onboard"
    ? buildOnboardingWorkflowPrompt(request)
    : [`/${workflow}`, request].filter(Boolean).join(" ");
}
