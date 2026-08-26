import { WORKFLOW_IDS, WORKFLOW_OPTIONS } from "../workflows/webui-workflow.ts";

export const WORKFLOW_COMMAND_EXCLUSIONS = Object.freeze([
  "implement",
  "audit",
  "clarify",
  "platform",
  "onboard-project"
]);

export const ONBOARDING_COMMAND_ACTIONS = Object.freeze([
  "status",
  "run",
  "profile",
  "setup",
  "tech",
  "help"
]);

export const FRESH_COMMAND_ACTIONS = Object.freeze([...WORKFLOW_IDS, "help"]);

export const FRESH_COMMAND_HELP = Object.freeze([
  "namespace: /fresh",
  ...WORKFLOW_OPTIONS.map((option) => `/fresh ${option.id} ${option.argumentHint}`)
]);
