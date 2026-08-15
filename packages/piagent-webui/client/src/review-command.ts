import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { Command } from "../../contracts/generated/control-command-v1.ts";
import type { PiagentWebUIDigestBoundSelectedFileReviewStateV1 } from "../../contracts/generated/review-state-v1.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createReviewCommand(snapshot: PiagentWebUICanonicalSnapshotV1,
  review: PiagentWebUIDigestBoundSelectedFileReviewStateV1, reviewState: "reviewed" | "unreviewed"): Promise<Command> {
  if (!review.target || review.state === "unavailable") throw new Error("review-target-unavailable");
  const requested = new Date(), expires = new Date(requested.getTime() + 5 * 60_000), target = review.target;
  const identity = { ...structuredClone(snapshot.identity), agentOperationId: null, toolCallId: null };
  const expectedRevisions = { runtimeRevision: snapshot.revision.runtimeRevision, taskRevision: target.taskRevision,
    controlRevision: snapshot.revision.controlRevision, workspaceRevision: target.workspaceRevision, indexRevision: target.indexRevision,
    approvalRevision: snapshot.revision.approvalRevision, sessionOptionRevision: snapshot.revision.sessionOptionRevision,
    queueRevision: snapshot.revision.queueRevision, workspacePreimage: null, indexPreimage: null, patchPreimage: target.patchPreimage };
  const payload = { view: target.view, fileRef: target.fileRef, diffRef: target.diffRef, reviewState, contentDigest: target.contentDigest };
  const command = { schemaVersion: 1 as const, version: "piagent-webui-control-v1" as const, messageType: "command" as const,
    commandId: `review-command.${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID(), requestedAt: requested.toISOString(),
    expiresAt: expires.toISOString(), capabilityScope: "reviewActions" as const, action: "review.mark" as const, actionDigest: "",
    identity, expectedRevisions, payload };
  command.actionDigest = await digest({ action: command.action, identity, expectedRevisions, payload });
  return command as Command;
}
