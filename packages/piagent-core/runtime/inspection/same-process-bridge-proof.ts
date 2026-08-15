import { createHash } from "node:crypto";

export const PINNED_BRIDGE_HOST_VERSION = "0.84.1" as const;
export const SAME_PROCESS_BRIDGE_PROOF_VERSION = "piagent-webui-same-process-bridge-v1" as const;

const HOST_EVENTS = Object.freeze([
  "session_start", "session_info_changed", "session_shutdown", "before_provider_request", "after_provider_response",
  "before_agent_start", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start",
  "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "model_select",
  "thinking_level_select", "tool_call", "tool_result", "input"
]);
type FeatureState = "proven" | "partial" | "unavailable";
type FeatureVerdict = { state: FeatureState; reasonCode: string; evidence: string[] };
export type SameProcessBridgeProof = {
  version: typeof SAME_PROCESS_BRIDGE_PROOF_VERSION;
  hostVersion: string;
  compatible: boolean;
  runtimeInstanceId: string;
  sessionRef: string | null;
  overall: "inspect-only" | "inspect-and-chat-feasible";
  productionControlAllowed: false;
  secondRuntimeAllowed: false;
  features: {
    sameProcessIdentity: FeatureVerdict;
    chatDispatch: FeatureVerdict;
    assistantStreaming: FeatureVerdict;
    toolStreaming: FeatureVerdict;
    providerObservation: FeatureVerdict;
    sessionOptions: FeatureVerdict;
    attachments: FeatureVerdict;
    stop: FeatureVerdict;
    pause: FeatureVerdict;
    resume: FeatureVerdict;
    queueObservation: FeatureVerdict;
    approvalBroker: FeatureVerdict;
    usageTotals: FeatureVerdict;
  };
};

type PiSurface = Record<string, unknown>;
type ContextSurface = Record<string, any> & { sessionManager?: Record<string, unknown> };
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
function callable(value: unknown): value is (...args: any[]) => unknown { return typeof value === "function"; }
function supportsEvents(required: string[]): boolean { return required.every((event) => HOST_EVENTS.includes(event)); }
function feature(state: FeatureState, reasonCode: string, evidence: string[]): FeatureVerdict { return { state, reasonCode, evidence }; }
function opaqueSession(value: string): string { return `session.${createHash("sha256").update(`piagent-webui-session\n${value}`).digest("hex")}`; }

export function probeSameProcessBridge(input: {
  hostVersion: string;
  runtimeInstanceId: string;
  pi: PiSurface;
  ctx: ContextSurface;
}): SameProcessBridgeProof {
  const compatible = input.hostVersion === PINNED_BRIDGE_HOST_VERSION;
  let sessionId: string | null = null;
  try {
    const getter = input.ctx.sessionManager?.getSessionId;
    const value = callable(getter) ? getter.call(input.ctx.sessionManager) : null;
    sessionId = typeof value === "string" && value.trim() ? value : null;
  } catch { sessionId = null; }
  const runtimeBound = REF.test(input.runtimeInstanceId), identity = compatible && runtimeBound && sessionId !== null;
  const sameProcessIdentity = identity
    ? feature("proven", "current-context-session-bound", ["ExtensionContext.sessionManager.getSessionId", "in-process runtime instance"])
    : feature("unavailable", !compatible ? "unsupported-host-version" : !runtimeBound ? "runtime-instance-unavailable" : "session-identity-unavailable", []);
  const send = identity && callable(input.pi.sendUserMessage), eventRegistration = callable(input.pi.on);
  const chatEvents = eventRegistration && supportsEvents(["input", "before_agent_start", "agent_start", "agent_settled", "message_start", "message_update", "message_end"]);
  const chatDispatch = send && chatEvents
    ? feature("proven", "same-process-dispatch-feasible", ["ExtensionAPI.sendUserMessage", "deliverAs steer/followUp", "input/agent/message events"])
    : feature("unavailable", !identity ? sameProcessIdentity.reasonCode : !send ? "send-user-message-unavailable" : "chat-events-unavailable", []);
  const assistantStreaming = identity && eventRegistration && supportsEvents(["message_start", "message_update", "message_end", "turn_start", "turn_end"])
    ? feature("proven", "assistant-events-available", ["message_start/update/end", "turn_start/end"])
    : feature("unavailable", "assistant-events-unavailable", []);
  const toolStreaming = identity && eventRegistration && supportsEvents(["tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_call", "tool_result"])
    ? feature("proven", "tool-events-available", ["tool_execution_start/update/end", "tool_call/result"])
    : feature("unavailable", "tool-events-unavailable", []);
  const providerObservation = identity && eventRegistration && supportsEvents(["before_provider_request", "after_provider_response"])
    ? feature("proven", "provider-events-available", ["before_provider_request", "after_provider_response"])
    : feature("unavailable", "provider-events-unavailable", []);
  const sessionOptions = identity && callable(input.pi.setModel) && callable(input.pi.setThinkingLevel)
    && Array.isArray(input.ctx.scopedModels) && Object.hasOwn(input.ctx, "thinkingLevel")
    ? feature("proven", "session-options-feasible", ["ExtensionAPI.setModel/setThinkingLevel", "ExtensionContext.scopedModels/thinkingLevel", "selection events"])
    : feature("unavailable", "session-option-surface-incomplete", []);
  const attachments = send
    ? feature("proven", "content-array-dispatch-feasible", ["ExtensionAPI.sendUserMessage TextContent/ImageContent[]"])
    : feature("unavailable", "attachment-dispatch-unavailable", []);
  const stop = identity && callable(input.ctx.abort) && eventRegistration && supportsEvents(["agent_settled"])
    ? feature("partial", "void-abort-without-operation-ack", ["ExtensionContext.abort(): void", "agent_settled", "TUI clears queued messages before agent.abort"])
    : feature("unavailable", "abort-surface-unavailable", []);
  const pause = feature("unavailable", "semantic-pause-api-unavailable", ["no durable pause barrier in ExtensionAPI/ExtensionContext"]);
  const resume = feature("unavailable", "semantic-resume-api-unavailable", ["resume depends on durable acknowledged pause"]);
  const queueObservation = identity && callable(input.ctx.hasPendingMessages)
    ? feature("partial", "queue-boolean-only", ["ExtensionContext.hasPendingMessages", "no extension queue_update/count/content/revision"])
    : feature("unavailable", "queue-observation-unavailable", []);
  const approvalBroker = feature("unavailable", "approval-injection-api-unavailable", ["ExtensionUI confirmation has no shared external decision hook"]);
  const usageTotals = identity && callable(input.ctx.getContextUsage) && callable(input.ctx.sessionManager?.getBranch) && providerObservation.state === "proven"
    ? feature("partial", "derived-session-usage-without-host-total-api", ["getContextUsage", "session branch assistant usage", "provider request events"])
    : feature("unavailable", "usage-observation-incomplete", []);
  const features = { sameProcessIdentity, chatDispatch, assistantStreaming, toolStreaming, providerObservation, sessionOptions, attachments,
    stop, pause, resume, queueObservation, approvalBroker, usageTotals };
  return { version: SAME_PROCESS_BRIDGE_PROOF_VERSION, hostVersion: input.hostVersion, compatible, runtimeInstanceId: input.runtimeInstanceId,
    sessionRef: sessionId ? opaqueSession(sessionId) : null, overall: chatDispatch.state === "proven" ? "inspect-and-chat-feasible" : "inspect-only",
    productionControlAllowed: false, secondRuntimeAllowed: false, features };
}
