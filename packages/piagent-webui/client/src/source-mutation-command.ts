import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Command } from "../../contracts/generated/control-command-v1.ts";
import type { PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1 } from "../../contracts/generated/source-mutation-v1.ts";

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

export async function createSourceMutationCommand(snapshot: PiagentWebUICanonicalSnapshotV1,
  preview: PiagentWebUIGuardedSelectedFileSourceMutationPreviewV1, selectedHunkRefs: string[] = []): Promise<Command> {
  if (preview.state !== "ready" || !preview.target) throw new Error("source-mutation-preview-unavailable");
  const requested = new Date(), target = preview.target, identity = { ...structuredClone(snapshot.identity), agentOperationId: null, toolCallId: null };
  if (selectedHunkRefs.length > 128 || new Set(selectedHunkRefs).size !== selectedHunkRefs.length
    || selectedHunkRefs.some((hunkRef) => !target.hunkRefs.includes(hunkRef))
    || canonical(selectedHunkRefs) !== canonical(target.hunkRefs.filter((hunkRef) => selectedHunkRefs.includes(hunkRef))))
    throw new Error("source-mutation-hunk-unavailable");
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: target.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: target.workspaceRevision, indexRevision: target.indexRevision,
    approvalRevision: snapshot.revision.approvalRevision, sessionOptionRevision: snapshot.revision.sessionOptionRevision,
    queueRevision: snapshot.revision.queueRevision, workspacePreimage: target.workspacePreimage, indexPreimage: target.indexPreimage,
    patchPreimage: target.patchPreimage };
  const payload = { fileRef: target.fileRef, hunkRefs: [...selectedHunkRefs], contentDigest: target.contentDigest };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `source-mutation.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: new Date(requested.getTime() + 5 * 60_000).toISOString(), capabilityScope: "reviewActions" as const,
    action: preview.action, actionDigest: "", identity, expectedRevisions, payload };
  command.actionDigest = await digest({ action: command.action, identity, expectedRevisions, payload });
  return command as Command;
}
