import type { Command } from "../../contracts/generated/control-command-v1.ts";
import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIConfirmedExactSourceRevertPreviewV1 } from "../../contracts/generated/source-revert-v1.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function digest(value: unknown): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return `sha256:${[...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createSourceRevertCommand(snapshot: PiagentWebUICanonicalSnapshotV1,
  preview: PiagentWebUIConfirmedExactSourceRevertPreviewV1): Promise<Command> {
  if (preview.state !== "ready" || !preview.target) throw new Error("source-revert-preview-unavailable");
  const requested = new Date(), target = preview.target;
  if (Date.parse(target.expiresAt) <= requested.getTime()) throw new Error("source-revert-preview-expired");
  const identity = { ...structuredClone(snapshot.identity), agentOperationId: null, toolCallId: null };
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: target.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: target.workspaceRevision, indexRevision: target.indexRevision,
    approvalRevision: snapshot.revision.approvalRevision, sessionOptionRevision: snapshot.revision.sessionOptionRevision,
    queueRevision: snapshot.revision.queueRevision, workspacePreimage: target.workspacePreimage, indexPreimage: target.indexPreimage,
    patchPreimage: target.patchPreimage };
  const payload = { fileRef: target.fileRef, hunkRefs: [...target.hunkRefs], previewRef: target.previewRef,
    confirmedPreviewDigest: target.confirmedPreviewDigest, contentDigest: target.contentDigest };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `source-revert.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: target.expiresAt, capabilityScope: "reviewActions" as const, action: "source.revert" as const, actionDigest: "",
    identity, expectedRevisions, payload };
  command.actionDigest = await digest({ action: command.action, identity, expectedRevisions, payload });
  return command as Command;
}
