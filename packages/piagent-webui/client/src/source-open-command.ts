import type { Command } from "../../contracts/generated/control-command-v1.ts";
import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";

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

export async function createSourceOpenCommand(snapshot: PiagentWebUICanonicalSnapshotV1, fileRef: string,
  line: number | null = null, column: number | null = null): Promise<Command> {
  if (!snapshot.identity.taskId || !snapshot.identity.taskRunId || !snapshot.revision.taskRevision || !snapshot.revision.workspaceRevision)
    throw new Error("source-open-task-authority-unavailable");
  if (column !== null && line === null) throw new Error("source-open-location-invalid");
  const requested = new Date(), identity = { ...structuredClone(snapshot.identity), agentOperationId: null, toolCallId: null };
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: snapshot.revision.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: snapshot.revision.workspaceRevision,
    indexRevision: snapshot.revision.indexRevision, approvalRevision: snapshot.revision.approvalRevision,
    sessionOptionRevision: snapshot.revision.sessionOptionRevision, queueRevision: snapshot.revision.queueRevision,
    workspacePreimage: null, indexPreimage: null, patchPreimage: null };
  const payload = { fileRef, line, column };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `source-open.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: new Date(requested.getTime() + 5 * 60_000).toISOString(), capabilityScope: "reviewActions" as const,
    action: "source.open-in-vscode" as const, actionDigest: "", identity, expectedRevisions, payload };
  command.actionDigest = await digest({ action: command.action, identity, expectedRevisions, payload });
  return command as Command;
}
