export const WEBUI_RUNTIME_ACTION_IDS = [
  "runtime.status", "runtime.inspector", "runtime.commands", "orchestration.status",
  "usage.live", "usage.history", "usage.logs", "usage.efficiency", "usage.preflight",
  "onboarding.status", "onboarding.profile", "onboarding.tech",
  "profile.status", "profile.options", "profile.tech-options", "profile.apply", "profile.auto",
  "context.status", "context.rebuild", "context.search", "context.pack", "context.impact", "context.efficiency", "context.preflight", "context.compact",
  "memory.status",
  "mcp.status", "mcp.doctor", "mcp.detail", "mcp.approve", "mcp.reject", "mcp.reset"
] as const;

export type WebUiRuntimeActionId = typeof WEBUI_RUNTIME_ACTION_IDS[number];
export type WebUiRuntimeEffect = "read-only" | "workspace-write" | "model-assisted";
export type WebUiRuntimeArgument = "none" | "optional-text" | "required-text" | "profile" | "connection";

export type WebUiRuntimeAction = {
  id: WebUiRuntimeActionId;
  category: "runtime" | "usage" | "onboarding" | "profile" | "context" | "memory" | "mcp";
  effect: WebUiRuntimeEffect;
  argument: WebUiRuntimeArgument;
  requiresConfirmation: boolean;
};

const action = (id: WebUiRuntimeActionId, category: WebUiRuntimeAction["category"], effect: WebUiRuntimeEffect = "read-only",
  argument: WebUiRuntimeArgument = "none"): WebUiRuntimeAction => ({
  id, category, effect, argument, requiresConfirmation: effect !== "read-only"
});

export const WEBUI_RUNTIME_ACTIONS: readonly WebUiRuntimeAction[] = [
  action("runtime.status", "runtime"), action("runtime.inspector", "runtime"), action("runtime.commands", "runtime"),
  action("orchestration.status", "runtime"),
  action("usage.live", "usage"), action("usage.history", "usage"), action("usage.logs", "usage"),
  action("usage.efficiency", "usage"), action("usage.preflight", "usage", "read-only", "optional-text"),
  action("onboarding.status", "onboarding"), action("onboarding.profile", "onboarding"), action("onboarding.tech", "onboarding"),
  action("profile.status", "profile"), action("profile.options", "profile"),
  action("profile.tech-options", "profile", "read-only", "optional-text"),
  action("profile.apply", "profile", "workspace-write", "profile"), action("profile.auto", "profile", "workspace-write"),
  action("context.status", "context"), action("context.rebuild", "context", "workspace-write"),
  action("context.search", "context", "read-only", "required-text"), action("context.pack", "context", "read-only", "required-text"),
  action("context.impact", "context", "read-only", "optional-text"), action("context.efficiency", "context"),
  action("context.preflight", "context", "read-only", "optional-text"), action("context.compact", "context", "model-assisted", "optional-text"),
  action("memory.status", "memory"),
  action("mcp.status", "mcp"), action("mcp.doctor", "mcp"), action("mcp.detail", "mcp", "read-only", "connection"),
  action("mcp.approve", "mcp", "workspace-write", "connection"), action("mcp.reject", "mcp", "workspace-write", "connection"),
  action("mcp.reset", "mcp", "workspace-write", "connection")
] as const;

const BY_ID = new Map<WebUiRuntimeActionId, WebUiRuntimeAction>(WEBUI_RUNTIME_ACTIONS.map((item) => [item.id, item]));
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function isWebUiRuntimeActionId(value: unknown): value is WebUiRuntimeActionId {
  return typeof value === "string" && (WEBUI_RUNTIME_ACTION_IDS as readonly string[]).includes(value);
}

function normalizedArgument(spec: WebUiRuntimeAction, value: unknown): string {
  const argument = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (argument.length > 2_048) throw new Error("runtime-command-argument-too-long");
  if (["required-text", "profile", "connection"].includes(spec.argument) && !argument) throw new Error("runtime-command-argument-required");
  if (["profile", "connection"].includes(spec.argument) && !TOKEN.test(argument)) throw new Error("runtime-command-argument-invalid");
  return argument;
}

export function buildWebUiRuntimeCommand(input: {
  action: WebUiRuntimeActionId;
  argument?: string | null;
  confirmed?: boolean;
}): { command: string; spec: WebUiRuntimeAction; argument: string } {
  const spec = BY_ID.get(input.action);
  if (!spec) throw new Error("runtime-command-action-invalid");
  if (spec.requiresConfirmation && input.confirmed !== true) throw new Error("runtime-command-confirmation-required");
  const argument = normalizedArgument(spec, input.argument);
  const suffix = argument ? ` ${argument}` : "";
  const commands: Record<WebUiRuntimeActionId, string> = {
    "runtime.status": "/piagent-status", "runtime.inspector": "/piagent-inspector", "runtime.commands": "/commands",
    "orchestration.status": "/piagent-orchestration",
    "usage.live": "/usage live", "usage.history": "/usage history", "usage.logs": "/usage logs",
    "usage.efficiency": "/usage efficiency", "usage.preflight": `/usage preflight${suffix}`,
    "onboarding.status": "/onboard status", "onboarding.profile": "/onboard profile", "onboarding.tech": "/onboard tech",
    "profile.status": "/profile", "profile.options": "/profile list", "profile.tech-options": `/profile tech options${suffix}`,
    "profile.apply": `/profile ${argument}`, "profile.auto": "/profile auto",
    "context.status": "/context index", "context.rebuild": "/context rebuild", "context.search": `/context search${suffix}`,
    "context.pack": `/context pack${suffix}`, "context.impact": `/context impact${suffix}`, "context.efficiency": "/context efficiency",
    "context.preflight": `/context preflight${suffix}`, "context.compact": `/context compact${suffix}`,
    "memory.status": "/memory",
    "mcp.status": "/piagent-mcp status", "mcp.doctor": "/piagent-mcp doctor", "mcp.detail": `/piagent-mcp get ${argument}`,
    "mcp.approve": `/piagent-mcp approve ${argument}`, "mcp.reject": `/piagent-mcp reject ${argument}`,
    "mcp.reset": `/piagent-mcp reset ${argument}`
  };
  return { command: commands[input.action], spec, argument };
}
