import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Command } from "../../contracts/generated/control-command-v1.ts";
import type { DiscardCommand, StageCommand } from "../../contracts/generated/attachment-v1.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonical(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createChatCommand(snapshot: PiagentWebUICanonicalSnapshotV1, text: string,
  delivery: "new-operation" | "follow-up" | "steer" | "hold",
  attachment?: { messageRequestId: string; attachmentRefs: string[] }): Promise<Command> {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000), attachmentRefs = attachment?.attachmentRefs ?? [];
  const payload = { messageRequestId: attachment?.messageRequestId ?? `message-request.${crypto.randomUUID()}`,
    capabilityAction: delivery === "steer" ? "interruptAndSend" as const : delivery === "hold" ? "hold" as const : "send" as const,
    delivery, text, attachmentRefs, contentDigest: await digest({ attachmentRefs, text }) };
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
    indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
    sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision,
    workspacePreimage: null, indexPreimage: null, patchPreimage: null };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), capabilityScope: "control.chat" as const, action: "chat.send" as const, actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions, payload };
  command.actionDigest = await digest({ action: command.action, identity: command.identity, expectedRevisions, payload });
  return command as Command;
}

export async function createAttachmentCommand(snapshot: PiagentWebUICanonicalSnapshotV1, messageRequestId: string,
  file: { displayName: string; declaredMimeType: StageCommand["file"]["declaredMimeType"]; dataBase64: string }): Promise<StageCommand> {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000);
  return { schemaVersion: 1, version: "piagent-webui-attachment-v1", messageType: "stage-command",
    commandId: `attachment-command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), identity: { ...structuredClone(snapshot.identity), toolCallId: null }, expectedRuntimeRevision: snapshot.revision.runtimeRevision,
    messageRequestId, file };
}

export function createAttachmentDiscardCommand(snapshot: PiagentWebUICanonicalSnapshotV1, messageRequestId: string,
  attachmentRef: string): DiscardCommand {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000);
  return { schemaVersion: 1, version: "piagent-webui-attachment-v1", messageType: "discard-command",
    commandId: `attachment-command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), identity: { ...structuredClone(snapshot.identity), toolCallId: null },
    expectedRuntimeRevision: snapshot.revision.runtimeRevision, messageRequestId, attachmentRef };
}

export async function createQueueCommand(snapshot: PiagentWebUICanonicalSnapshotV1,
  action: "queue.update" | "queue.delete" | "queue.dispatch", payload: Record<string, unknown>): Promise<Command> {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000);
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
    indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
    sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision,
    workspacePreimage: null, indexPreimage: null, patchPreimage: null };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), capabilityScope: "control.chat" as const, action, actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions, payload };
  command.actionDigest = await digest({ action, identity: command.identity, expectedRevisions, payload });
  return command as Command;
}

export async function queueUpdatePayload(queueItemRef: string, text: string): Promise<Record<string, unknown>> {
  const attachmentRefs: string[] = [];
  return { queueItemRef, text, attachmentRefs, contentDigest: await digest({ attachmentRefs, text }) };
}

export async function createSessionOptionCommand(snapshot: PiagentWebUICanonicalSnapshotV1,
  action: "session-options.set-model" | "session-options.set-thinking", target: string): Promise<Command> {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000);
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
    indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
    sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision,
    workspacePreimage: null, indexPreimage: null, patchPreimage: null };
  const payload = action === "session-options.set-model"
    ? { modelRef: target, effectScopeAcknowledged: "session-and-user-default" as const }
    : { thinkingLevel: target as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
      effectScopeAcknowledged: "session-and-user-default" as const };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), capabilityScope: "control.sessionOptions" as const, action, actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions, payload };
  command.actionDigest = await digest({ action, identity: command.identity, expectedRevisions, payload });
  return command as Command;
}

export async function createLifecycleCommand(snapshot: PiagentWebUICanonicalSnapshotV1,
  action: "lifecycle.stop" | "lifecycle.pause" | "lifecycle.resume"): Promise<Command> {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000);
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
    indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
    sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision,
    workspacePreimage: null, indexPreimage: null, patchPreimage: null };
  const payload = action === "lifecycle.stop" ? { requestedScope: "current-agent-operation" as const }
    : action === "lifecycle.pause" ? { safePointPolicy: "after-current-atomic-unit" as const } : {};
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), capabilityScope: "control.lifecycle" as const, action, actionDigest: "",
    identity: structuredClone(snapshot.identity), expectedRevisions, payload };
  command.actionDigest = await digest({ action, identity: command.identity, expectedRevisions, payload });
  return command as Command;
}

export async function createResumeAndContinueCommand(snapshot: PiagentWebUICanonicalSnapshotV1, text: string,
  attachment?: { messageRequestId: string; attachmentRefs: string[] }): Promise<Command> {
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000), attachmentRefs = attachment?.attachmentRefs ?? [];
  const payload = { messageRequestId: attachment?.messageRequestId ?? `message-request.${crypto.randomUUID()}`,
    capabilityAction: "send" as const, delivery: "new-operation" as const, text, attachmentRefs,
    contentDigest: await digest({ attachmentRefs, text }) };
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
    indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
    sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision,
    workspacePreimage: null, indexPreimage: null, patchPreimage: null };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), capabilityScope: "control.resumeAndContinue" as const,
    action: "lifecycle.resume-and-continue" as const, actionDigest: "", identity: structuredClone(snapshot.identity), expectedRevisions, payload };
  command.actionDigest = await digest({ action: command.action, identity: command.identity, expectedRevisions, payload });
  return command as Command;
}
