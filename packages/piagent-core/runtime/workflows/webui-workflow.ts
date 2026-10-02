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

/** Legacy clients may still send a workflow field. It must never rewrite their message. */
export function buildWebUiWorkflowCommand(_workflow: WebUiWorkflowId | null, request: string): string {
  const text = String(request ?? "");
  if (!text.trim()) throw new Error("workflow-request-empty");
  if (text.includes("\0")) throw new Error("workflow-request-invalid");
  return text;
}
