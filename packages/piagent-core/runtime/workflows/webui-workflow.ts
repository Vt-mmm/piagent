export const WEBUI_WORKFLOW_IDS = [
  "task",
  "scout",
  "be-to-fe",
  "discuss",
  "plan",
  "review",
  "commit",
  "pr",
  "onboard",
  "platform-improve"
] as const;

export type WebUiWorkflowId = typeof WEBUI_WORKFLOW_IDS[number];

export type WebUiWorkflowOption = {
  id: WebUiWorkflowId;
  changeMode: "source-change" | "read-only" | "plan-only" | "clarification" | "git" | "onboarding" | "platform";
  modelUse: "required";
  recommendedFreshSession: boolean;
};

export const WEBUI_WORKFLOW_OPTIONS: readonly WebUiWorkflowOption[] = [
  { id: "task", changeMode: "source-change", modelUse: "required", recommendedFreshSession: true },
  { id: "scout", changeMode: "read-only", modelUse: "required", recommendedFreshSession: true },
  { id: "be-to-fe", changeMode: "source-change", modelUse: "required", recommendedFreshSession: true },
  { id: "discuss", changeMode: "clarification", modelUse: "required", recommendedFreshSession: false },
  { id: "plan", changeMode: "plan-only", modelUse: "required", recommendedFreshSession: false },
  { id: "review", changeMode: "read-only", modelUse: "required", recommendedFreshSession: false },
  { id: "commit", changeMode: "git", modelUse: "required", recommendedFreshSession: false },
  { id: "pr", changeMode: "git", modelUse: "required", recommendedFreshSession: false },
  { id: "onboard", changeMode: "onboarding", modelUse: "required", recommendedFreshSession: true },
  { id: "platform-improve", changeMode: "platform", modelUse: "required", recommendedFreshSession: true }
] as const;

export function isWebUiWorkflowId(value: unknown): value is WebUiWorkflowId {
  return typeof value === "string" && (WEBUI_WORKFLOW_IDS as readonly string[]).includes(value);
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
