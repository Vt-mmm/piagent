import type { TaskContract } from "../../extensions/guard-types.js";
import {
  handoffIdentityMatchesTask,
  readHandoffProjection,
  taskAcceptanceDisposition,
  type HandoffProjection
} from "../recovery/handoff-projection.ts";

export const UNCERTAIN_SEND_RECEIPT_TYPE = "piagent-uncertain-send-continuation-v1";

function folded(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Identify the narrow uncertain-delivery recovery protocol. Generic requests
 * such as "continue" or "check the previous work" intentionally do not match:
 * they remain free to start a different task in the same session.
 */
export function isUncertainSendContinuation(value: unknown): boolean {
  const text = folded(value);
  if (!text) return false;
  const switchesWork = /\b(?:new|different|separate|unrelated)\s+(?:request|task|work)\b/.test(text)
    || /\b(?:task|yeu cau|cong viec|viec)\s+moi\b/.test(text);
  if (switchesWork) return false;
  const interrupted = /\b(?:connection|delivery|send|session)\b.{0,100}\b(?:interrupted|disconnected|dropped|lost|uncertain)\b/.test(text)
    || /\bket noi\b.{0,100}\b(?:gian doan|bi ngat|bi mat)\b/.test(text);
  const mayHaveArrived = /\b(?:previous|prior|last)\s+(?:send|message|request)\b.{0,100}\b(?:may|might|could)\s+have\s+been\s+(?:delivered|sent|received)\b/.test(text)
    || /\b(?:delivery|send|receipt)\b.{0,100}\b(?:unknown|uncertain|unconfirmed)\b/.test(text)
    || /\b(?:tin nhan|yeu cau|lan gui)\s+(?:truoc|vua roi)\b.{0,100}\bco the\b.{0,60}\b(?:da gui|da nhan|duoc gui)\b/.test(text);
  const sameRequest = /\bcontinue\b.{0,100}\b(?:same|original|previous|prior)\s+(?:request|task|work)\b/.test(text)
    || /\bdurable\s+session\s+state\b/.test(text)
    || /\bwithout\s+duplicating\b/.test(text)
    || /\btiep tuc\b.{0,100}\b(?:cung|yeu cau|task|cong viec)\b/.test(text)
    || /\bkhong\s+(?:lap lai|trung lap)\b/.test(text);
  return interrupted && mayHaveArrived && sameRequest;
}

function bounded(values: unknown, maximum = 8): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))]
    .slice(0, maximum);
}

export type TerminalUncertainSendReceipt = {
  customType: typeof UNCERTAIN_SEND_RECEIPT_TYPE;
  content: string;
  details: {
    schemaVersion: 1;
    version: typeof UNCERTAIN_SEND_RECEIPT_TYPE;
    state: "settled";
    taskId: string;
    taskRunId: string;
    outcome: TaskContract["trace"]["outcome"];
    gateDecision: "pass" | "fail";
    completionApproved: boolean;
    changedFiles: string[];
    missing: string[];
    nextSafeAction: string;
    replayed: false;
    modelTurnStarted: false;
  };
};

export type TerminalUncertainSendBinding = {
  task: TaskContract;
  text: string;
  receipt?: TerminalUncertainSendReceipt;
};

export type UncertainSendRuntimeIntake = {
  intake: {
    started: false;
    text: string;
    task?: TaskContract;
    plannedContext: [];
    plannedContextComplete: true;
    continuation: "terminal-uncertain-send";
  };
  trace: Record<string, unknown>;
  task?: TaskContract;
};

type HandoffReader = (cwd: string, taskRunId: string) => HandoffProjection | undefined;

/**
 * Project a privacy-safe terminal receipt from the immediately prior durable
 * task. Missing/corrupt/mismatched handoff state returns undefined so callers
 * can fail closed without claiming that delivery or completion was observed.
 */
export function terminalUncertainSendReceipt(
  cwd: string,
  task: TaskContract | undefined,
  readHandoff: HandoffReader = readHandoffProjection
): TerminalUncertainSendReceipt | undefined {
  if (!task || task.trace.outcome === "pending") return undefined;
  let handoff;
  try {
    handoff = readHandoff(cwd, task.taskRunId);
  } catch {
    return undefined;
  }
  if (!handoff
    || !handoffIdentityMatchesTask(handoff.identity, task)
    || handoff.state.taskOutcome !== task.trace.outcome) return undefined;
  if (handoff.state.completionApproved === true) {
    const authoritativeAcceptance = taskAcceptanceDisposition(task);
    if (handoff.acceptance.required !== authoritativeAcceptance.required
      || handoff.acceptance.satisfied !== authoritativeAcceptance.satisfied
      || handoff.acceptance.criteriaCount !== authoritativeAcceptance.criteriaCount
      || handoff.acceptance.dispositionDigest !== authoritativeAcceptance.dispositionDigest) return undefined;
  }
  const changedFiles = bounded(handoff.changedFiles.current, 12);
  const missing = bounded(handoff.state.missing, 12);
  const approved = handoff.state.completionApproved === true;
  const lines = [
    "[Piagent delivery receipt]",
    `The immediately preceding task already settled as ${handoff.state.taskOutcome}; its durable contract was reused and no command, mutation, message, or model turn was replayed.`,
    `Completion approved: ${approved ? "yes" : "no"}. Gate: ${handoff.state.gateDecision}.`,
    ...(changedFiles.length > 0 ? [`Changed files: ${changedFiles.join(", ")}.`] : []),
    ...(missing.length > 0 ? [`Still missing: ${missing.join("; ")}.`] : []),
    `Next safe action: ${handoff.nextSafeAction.action}.`
  ];
  return {
    customType: UNCERTAIN_SEND_RECEIPT_TYPE,
    content: lines.join("\n"),
    details: {
      schemaVersion: 1,
      version: UNCERTAIN_SEND_RECEIPT_TYPE,
      state: "settled",
      taskId: task.taskId,
      taskRunId: task.taskRunId,
      outcome: task.trace.outcome,
      gateDecision: handoff.state.gateDecision,
      completionApproved: approved,
      changedFiles,
      missing,
      nextSafeAction: handoff.nextSafeAction.action,
      replayed: false,
      modelTurnStarted: false
    }
  };
}

export function unavailableUncertainSendContext(task?: TaskContract): string {
  const identity = task
    ? `durable task ${task.taskId} (${task.taskRunId})`
    : "the immediately preceding durable task";
  return [
    "[Piagent uncertain-send continuation]",
    `Reuse ${identity}; do not create a replacement task or repeat prior mutations/messages.`,
    "Its terminal handoff receipt is missing, corrupt, or identity-mismatched, so completion must not be inferred.",
    "Report that the durable receipt is unavailable and require state inspection or an explicit new request before any further mutation."
  ].join("\n");
}

/**
 * Bind a synthetic reconnect continuation to the terminal task already bound
 * to this durable session. This decision is intentionally separate from
 * generic task intake so a receipt recovery cannot become a new read-only
 * task merely because the previous operation settled before the client saw it.
 */
export function terminalUncertainSendBinding(
  cwd: string,
  task: TaskContract | undefined,
  prompt: unknown,
  readHandoff: HandoffReader = readHandoffProjection
): TerminalUncertainSendBinding | undefined {
  if (!task || task.trace.outcome === "pending" || !isUncertainSendContinuation(prompt)) return undefined;
  const receipt = terminalUncertainSendReceipt(cwd, task, readHandoff);
  return {
    task,
    text: receipt
      ? `${receipt.content}\nRecovery-turn rule: return only this durable receipt; do not call tools, repeat work, or start another task.`
      : unavailableUncertainSendContext(task),
    receipt
  };
}

export function uncertainSendRuntimeIntake(
  cwd: string,
  task: TaskContract | undefined,
  prompt: unknown,
  sessionId: string
): UncertainSendRuntimeIntake | undefined {
  if (!isUncertainSendContinuation(prompt) || task?.trace.outcome === "pending") return undefined;
  const binding = terminalUncertainSendBinding(cwd, task, prompt);
  return {
    intake: {
      started: false,
      task: binding?.task,
      text: binding?.text ?? unavailableUncertainSendContext(),
      plannedContext: [],
      plannedContextComplete: true,
      continuation: "terminal-uncertain-send"
    },
    trace: {
      event: binding ? "uncertain_send_terminal_task_bound" : "uncertain_send_task_binding_unavailable",
      taskId: binding?.task.taskId,
      taskRunId: binding?.task.taskRunId,
      sessionId,
      receiptAvailable: Boolean(binding?.receipt),
      replacementTaskStarted: false,
      replayed: false,
      modelTurnStarted: true
    },
    task: binding?.task
  };
}
