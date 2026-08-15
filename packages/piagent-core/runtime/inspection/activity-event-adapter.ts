import { createHash } from "node:crypto";

import { redactSensitiveText } from "../../extensions/redaction-core.js";
import type { ActivityInspectorEvent } from "../product/activity-inspector.ts";
import type { RuntimeEventDraft, RuntimeEventRevision } from "./runtime-event-store.ts";

export type RuntimeEventIdentity = {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId?: string | null;
};
export type ActivityEventAdapterInput = {
  event: ActivityInspectorEvent & Record<string, unknown>;
  identity: RuntimeEventIdentity;
  revision: RuntimeEventRevision;
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function opaque(prefix: string, value: unknown): string { return `${prefix}.${hash(String(value ?? "unknown"))}`; }
function digest(value: unknown): string | null {
  const candidate = String(value ?? "");
  return /^[a-f0-9]{64}$/.test(candidate) ? `sha256:${candidate}` : /^sha256:[a-f0-9]{64}$/.test(candidate) ? candidate : null;
}
function safeText(value: unknown, maximum = 4000): { text: string; redacted: number } {
  const source = String(value ?? "");
  const redaction = redactSensitiveText(source);
  const text = redaction.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  return { text, redacted: redaction.redacted ? 1 : 0 };
}
function correlation() {
  return { commandId: null, messageRequestId: null, replacementId: null, approvalRequestId: null, causationEventId: null, idempotencyKeyDigest: null };
}
function base(identity: RuntimeEventIdentity, revision: RuntimeEventRevision, sourceObservedAt: string): Omit<RuntimeEventDraft, "kind" | "payload" | "evidence" | "redaction"> {
  return { sourceObservedAt, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef,
    taskId: identity.taskId, taskRunId: identity.taskRunId, agentOperationId: null, turnIndex: null, messageRef: null, toolCallId: null,
    revision, correlation: correlation() };
}

export function adaptActivityTelemetryEvent(input: ActivityEventAdapterInput): RuntimeEventDraft | null {
  const event = input.event, observedAt = String(event.recordedAt ?? "");
  if (!TIMESTAMP.test(observedAt)) return null;
  const eventName = String(event.event ?? "");
  if (!["tool_call", "tool_result", "tool_decision"].includes(eventName)) return null;
  if (eventName === "tool_decision" && event.decision !== "blocked") return null;
  const toolName = safeText(event.toolName ?? "unknown", 80).text.replace(/[^A-Za-z0-9._:@~-]/g, "-") || "unknown";
  const rawToolCall = String(event.toolCallId ?? event.activityId ?? `${observedAt}:${toolName}`);
  const hasOperation = typeof input.identity.agentOperationId === "string" && input.identity.agentOperationId.length > 0;
  const operationRef = hasOperation ? opaque("operation", input.identity.agentOperationId) : null;
  const toolCallRef = hasOperation ? opaque("tool", rawToolCall) : null;
  const activityType = hasOperation ? "tool" : ["bash", "shell", "exec"].includes(toolName) ? "command" : "other";
  const failed = eventName === "tool_result" && (event.isError === true || typeof event.exitCode === "number" && event.exitCode !== 0);
  const blocked = eventName === "tool_decision";
  const state = eventName === "tool_call" ? "started" : blocked ? "blocked" : failed ? "failed" : "finished";
  const kind = `activity.${state}`;
  const previewValue = blocked ? event.reason : event.command ?? event.targetPath ?? event.toolName;
  const preview = safeText(previewValue, 4000);
  const storedRedactions = typeof event.sensitiveValuesRedacted === "number" && Number.isInteger(event.sensitiveValuesRedacted)
    ? Math.max(0, Math.min(10_000, event.sensitiveValuesRedacted)) : 0;
  const reasonCode = blocked ? "policy-blocked" : failed ? "tool-result-failed" : null;
  return {
    ...base(input.identity, input.revision, observedAt), agentOperationId: operationRef, toolCallId: toolCallRef,
    kind, evidence: "derived",
    payload: {
      state, activityType, activityRef: opaque("activity", `${input.identity.runtimeInstanceId}\0${input.identity.sessionRef}\0${rawToolCall}`),
      toolName, inputDigest: digest((event as any).inputHash), outputDigest: digest((event as any).outputHash),
      preview: preview.text || null, previewKind: preview.text ? "summary" : "none",
      outputBytes: Number.isInteger((event as any).outputBytes) && (event as any).outputBytes >= 0 ? Math.min(1_000_000_000, (event as any).outputBytes) : null,
      outputLines: Number.isInteger((event as any).outputLines) && (event as any).outputLines >= 0 ? Math.min(1_000_000_000, (event as any).outputLines) : null,
      exitCode: typeof event.exitCode === "number" && Number.isInteger(event.exitCode) ? event.exitCode : null,
      isError: eventName === "tool_result" ? failed : null,
      affectedFileRefs: [], criterionIds: [], verifierAttemptIds: [], reasonCode
    },
    redaction: { applied: preview.redacted + storedRedactions > 0, valuesRemoved: Math.min(10_000, preview.redacted + storedRedactions), truncated: String(previewValue ?? "").length > 4000 }
  };
}

export function runtimeStartedEventDraft(input: {
  identity: Pick<RuntimeEventIdentity, "projectRef" | "runtimeInstanceId" | "sessionRef">;
  revision: RuntimeEventRevision;
  sourceObservedAt: string;
  buildRef: string;
  capabilitySnapshotRef: string;
}): RuntimeEventDraft {
  return {
    ...base({ ...input.identity, taskId: null, taskRunId: null }, input.revision, input.sourceObservedAt),
    kind: "runtime.started", evidence: "observed",
    payload: { connectionState: "connected", operationState: "idle", buildRef: input.buildRef, capabilitySnapshotRef: input.capabilitySnapshotRef, reasonCode: null },
    redaction: { applied: false, valuesRemoved: 0, truncated: false }
  };
}
