export const WORKFLOW_IDS = [
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

export type WorkflowId = typeof WORKFLOW_IDS[number];
export type ContextWorkflow = "task" | "scout" | "discuss" | "plan" | "review" | "release" | "onboard"
  | "usage" | "permission" | "context";

export type WorkflowOption = {
  id: WorkflowId;
  aliases: readonly string[];
  label: string;
  description: string;
  argumentHint: string;
  requestRequired: boolean;
  contextWorkflow: ContextWorkflow;
  changeMode: "source-change" | "read-only" | "plan-only" | "clarification" | "git" | "onboarding" | "platform";
  modelUse: "required";
  recommendedFreshSession: boolean;
};

/** Surface-neutral workflow truth shared by context classification and runtime ingress. */
export const WORKFLOW_OPTIONS: readonly WorkflowOption[] = [
  { id: "task", aliases: ["task", "implement"], label: "Task", description: "Implement a bounded task", argumentHint: "<request>", requestRequired: true, contextWorkflow: "task", changeMode: "source-change", modelUse: "required", recommendedFreshSession: true },
  { id: "scout", aliases: ["scout", "audit"], label: "Scout", description: "Read-only audit or research", argumentHint: "<area/spec/risk>", requestRequired: true, contextWorkflow: "scout", changeMode: "read-only", modelUse: "required", recommendedFreshSession: true },
  { id: "be-to-fe", aliases: ["be-to-fe", "befe"], label: "BE → FE", description: "Implement frontend from a backend contract", argumentHint: "<BE spec/change + FE outcome>", requestRequired: true, contextWorkflow: "task", changeMode: "source-change", modelUse: "required", recommendedFreshSession: true },
  { id: "discuss", aliases: ["discuss", "clarify"], label: "Discuss", description: "Clarify before planning or editing", argumentHint: "<rough idea>", requestRequired: true, contextWorkflow: "discuss", changeMode: "clarification", modelUse: "required", recommendedFreshSession: false },
  { id: "plan", aliases: ["plan"], label: "Plan", description: "Create an implementation plan", argumentHint: "<goal>", requestRequired: true, contextWorkflow: "plan", changeMode: "plan-only", modelUse: "required", recommendedFreshSession: false },
  { id: "review", aliases: ["review"], label: "Review", description: "Review a diff or source read-only", argumentHint: "<target or diff>", requestRequired: true, contextWorkflow: "review", changeMode: "read-only", modelUse: "required", recommendedFreshSession: false },
  { id: "commit", aliases: ["commit"], label: "Commit", description: "Run the guarded local commit workflow", argumentHint: "[message]", requestRequired: false, contextWorkflow: "release", changeMode: "git", modelUse: "required", recommendedFreshSession: false },
  { id: "pr", aliases: ["pr"], label: "PR", description: "Prepare a guarded pull request", argumentHint: "[title]", requestRequired: false, contextWorkflow: "release", changeMode: "git", modelUse: "required", recommendedFreshSession: false },
  { id: "onboard", aliases: ["onboard", "onboard-project"], label: "Onboard", description: "Run first-read project onboarding", argumentHint: "[focus]", requestRequired: false, contextWorkflow: "onboard", changeMode: "onboarding", modelUse: "required", recommendedFreshSession: true },
  { id: "platform-improve", aliases: ["platform-improve", "platform"], label: "Platform improve", description: "Improve Pi Agent Platform itself", argumentHint: "<goal + affected area>", requestRequired: true, contextWorkflow: "task", changeMode: "platform", modelUse: "required", recommendedFreshSession: true }
] as const;

export const WORKFLOW_ALIASES: Readonly<Record<string, WorkflowId>> = Object.freeze(Object.fromEntries(
  WORKFLOW_OPTIONS.flatMap((option) => option.aliases.map((alias) => [alias, option.id] as const))
));

export function resolveWorkflowId(value: unknown): WorkflowId | null {
  if (typeof value !== "string") return null;
  return WORKFLOW_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function workflowOption(value: unknown): WorkflowOption | null {
  const id = resolveWorkflowId(value);
  return id ? WORKFLOW_OPTIONS.find((option) => option.id === id) ?? null : null;
}

export function workflowCommandNames(options: { aliases?: boolean } = {}): string[] {
  return options.aliases === false ? [...WORKFLOW_IDS] : Object.keys(WORKFLOW_ALIASES);
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex fragment derived from the catalog, for command/projection boundaries. */
export function workflowCommandPattern(options: { aliases?: boolean } = {}): string {
  return workflowCommandNames(options).sort((left, right) => right.length - left.length)
    .map(escapedPattern).join("|");
}

const NAMESPACED_WORKFLOW_COMMAND = new RegExp(
  `^/(?:piagent-workflow|workflow)\\s+(${workflowCommandPattern()})(?=\\s|$)\\s*`, "i"
);
const DIRECT_WORKFLOW_COMMAND = new RegExp(
  `^/(${workflowCommandPattern({ aliases: false })})(?=\\s|$)\\s*`, "i"
);

export function workflowIdFromCommand(input: unknown): WorkflowId | null {
  const normalized = String(input ?? "").trim();
  const match = NAMESPACED_WORKFLOW_COMMAND.exec(normalized) ?? DIRECT_WORKFLOW_COMMAND.exec(normalized);
  return resolveWorkflowId(match?.[1]);
}

export function stripWorkflowCommand(input: string): string {
  return String(input ?? "").replace(NAMESPACED_WORKFLOW_COMMAND, "").replace(DIRECT_WORKFLOW_COMMAND, "").trim();
}

export function workflowHelpLines(): string[] {
  const aliasLines = WORKFLOW_OPTIONS.flatMap((option) => option.aliases.filter((alias) => alias !== option.id)
    .map((alias) => `/workflow ${alias} → ${option.id}`));
  return [
    "namespace: /workflow",
    ...WORKFLOW_OPTIONS.map((option) => `${option.id}: /workflow ${option.id} ${option.argumentHint} — ${option.description}`),
    `aliases: ${aliasLines.join(" | ") || "none"}`
  ];
}
