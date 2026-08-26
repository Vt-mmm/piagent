import {
  WORKFLOW_IDS,
  WORKFLOW_OPTIONS,
  type WorkflowId,
  type WorkflowOption
} from "../../extensions/workflow-catalog.ts";

/**
 * Runtime/WebUI adapter over the surface-neutral workflow catalog.
 *
 * Keep aliases here rather than in an individual surface. A workflow selection
 * is a property of one message/operation; it never pins the rest of a session.
 */
export {
  WORKFLOW_ALIASES,
  WORKFLOW_IDS,
  WORKFLOW_OPTIONS,
  resolveWorkflowId,
  stripWorkflowCommand,
  workflowCommandNames,
  workflowCommandPattern,
  workflowHelpLines,
  workflowIdFromCommand,
  workflowOption
} from "../../extensions/workflow-catalog.ts";
export type { ContextWorkflow, WorkflowId, WorkflowOption } from "../../extensions/workflow-catalog.ts";

// Compatibility exports keep the public WebUI contract stable while its data
// now comes from the surface-neutral catalog above.
export const WEBUI_WORKFLOW_IDS = WORKFLOW_IDS;
export type WebUiWorkflowId = WorkflowId;

export type WebUiWorkflowOption = Pick<WorkflowOption,
  "id" | "label" | "changeMode" | "modelUse" | "recommendedFreshSession">;
export const WEBUI_WORKFLOW_OPTIONS: readonly WebUiWorkflowOption[] = WORKFLOW_OPTIONS.map((option) => ({
  id: option.id,
  label: option.label,
  changeMode: option.changeMode,
  modelUse: option.modelUse,
  recommendedFreshSession: option.recommendedFreshSession
}));

export function isWebUiWorkflowId(value: unknown): value is WebUiWorkflowId {
  return typeof value === "string" && (WORKFLOW_IDS as readonly string[]).includes(value);
}

/**
 * WebUI does not carry a second copy of workflow prompts. It sends the same
 * explicit command the terminal dispatcher accepts, and the Pi extension owns
 * task intake, policy, tool groups, and the eventual provider turn.
 */
export function buildWebUiWorkflowCommand(workflow: WebUiWorkflowId | null, request: string): string {
  const normalized = String(request ?? "").trim();
  if (!normalized) throw new Error("workflow-request-empty");
  if (normalized.includes("\0")) throw new Error("workflow-request-invalid");
  if (!workflow) return normalized;
  return `/workflow ${workflow} ${normalized}`;
}
