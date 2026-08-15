import { createHash } from "node:crypto";

import { appendReviewEvidence, readReviewEvidence } from "../../piagent-core/runtime/inspection/review-state-store.ts";
import { canonicalReviewValue, type ReviewEvidenceRecord, type ReviewTarget, type ReviewView } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
import type { ReviewStateProjection } from "../../piagent-core/runtime/inspection/review-state-projection.ts";
import { controlActionDigest, type BridgeIdentity, type BridgeRevisions, type SameSessionPiBridge } from "./same-session-bridge.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/, PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/,
  REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/,
  IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;

type ReviewCommand = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "reviewActions"; action: "review.mark"; actionDigest: string;
  identity: BridgeIdentity; expectedRevisions: BridgeRevisions & { workspacePreimage: null; indexPreimage: null; patchPreimage: string };
  payload: { view: ReviewView; fileRef: string; diffRef: string; reviewState: "reviewed" | "unreviewed"; contentDigest: string };
};

export type ReviewReceipt = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string; idempotencyKeyDigest: string;
  action: "review.mark"; actionDigest: string; identity: BridgeIdentity; phase: "settled" | "rejected";
  resultCode: "reviewed" | "unreviewed" | "stale-revision" | "identity-mismatch" | "capability-unavailable" | "replay"
    | "idempotency-payload-mismatch" | "expired" | "invalid-command" | "resync-required";
  requestedAt: string; settledAt: string; observedRevisionsBefore: BridgeRevisions; observedRevisionsAfter: BridgeRevisions;
  deduplicated: boolean; auditRef: null; settlementEvidenceRef: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
};

function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return canonicalReviewValue(left) === canonicalReviewValue(right); }
function exactKeys(value: unknown, keys: string[]): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value)
  && same(Object.keys(value as object).sort(), [...keys].sort())); }
function timestamp(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function wireIdentity(value: BridgeIdentity): BridgeIdentity { return { projectRef: value.projectRef, runtimeInstanceId: value.runtimeInstanceId,
  sessionRef: value.sessionRef, taskId: value.taskId, taskRunId: value.taskRunId, agentOperationId: null, toolCallId: null }; }
function wireRevisions(value: BridgeRevisions): BridgeRevisions { return { runtimeRevision: value.runtimeRevision, taskRevision: value.taskRevision,
  controlRevision: value.controlRevision, workspaceRevision: value.workspaceRevision, indexRevision: value.indexRevision,
  approvalRevision: value.approvalRevision, sessionOptionRevision: value.sessionOptionRevision, queueRevision: value.queueRevision }; }

function receiptFromRecord(record: ReviewEvidenceRecord, deduplicated: boolean): ReviewReceipt {
  return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
    idempotencyKeyDigest: record.idempotencyKeyDigest, action: "review.mark", actionDigest: record.actionDigest,
    identity: { projectRef: record.projectRef, runtimeInstanceId: record.runtimeInstanceId, sessionRef: record.sessionRef,
      taskId: record.taskId, taskRunId: record.taskRunId,
      agentOperationId: null, toolCallId: null } as BridgeIdentity,
    phase: "settled", resultCode: record.reviewState, requestedAt: record.requestedAt, settledAt: record.recordedAt,
    observedRevisionsBefore: clone(record.observedRevisions) as BridgeRevisions,
    observedRevisionsAfter: clone(record.observedRevisions) as BridgeRevisions, deduplicated, auditRef: null,
    settlementEvidenceRef: record.evidenceRef, error: null };
}

export class ReviewController {
  readonly #bridge: SameSessionPiBridge;
  readonly #projectRoot: string;
  readonly #resolve: (view: ReviewView, fileRef: string) => Promise<ReviewStateProjection>;
  readonly #now: () => Date;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: { bridge: SameSessionPiBridge; projectRoot: string;
    resolve(view: ReviewView, fileRef: string): Promise<ReviewStateProjection>; now?: () => Date }) {
    this.#bridge = options.bridge; this.#projectRoot = options.projectRoot; this.#resolve = options.resolve; this.#now = options.now ?? (() => new Date());
  }

  execute(value: unknown): Promise<ReviewReceipt> {
    const run = this.#serial.then(() => this.#execute(value), () => this.#execute(value));
    this.#serial = run.catch(() => undefined); return run;
  }

  async #execute(value: unknown): Promise<ReviewReceipt> {
    const command = value as ReviewCommand, snapshot = this.#bridge.snapshot(), structural = this.#validate(value);
    if (snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions) return this.#reject(command, "resync-required", "review-binding-unavailable", true);
    if (structural) return this.#reject(command, "invalid-command", structural, false);
    const identity = wireIdentity(snapshot.identity), revisions = wireRevisions(snapshot.revisions);
    if (!identity.taskId || !identity.taskRunId || !revisions.taskRevision)
      return this.#reject(command, "capability-unavailable", "active-task-required", false);
    const ledger = readReviewEvidence(this.#projectRoot, identity.taskRunId);
    if (ledger.corruptions.length) return this.#reject(command, "resync-required", "review-evidence-corrupt", false);
    const keyDigest = sha(command.idempotencyKey), old = ledger.records.find((record) => record.commandId === command.commandId
      || record.idempotencyKeyDigest === keyDigest);
    if (old) {
      if (old.commandId !== command.commandId || old.idempotencyKeyDigest !== keyDigest || old.actionDigest !== command.actionDigest)
        return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", false);
      if (old.runtimeInstanceId !== identity.runtimeInstanceId || old.sessionRef !== identity.sessionRef || old.taskId !== identity.taskId || old.taskRunId !== identity.taskRunId)
        return this.#reject(command, "identity-mismatch", "runtime-or-session-replaced", false);
      return receiptFromRecord(old, true);
    }
    const now = this.#now().getTime();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future", false);
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired", false);
    if (!same(command.identity, identity)) return this.#reject(command, "identity-mismatch", "identity-mismatch", false);
    if (command.expectedRevisions.runtimeRevision !== revisions.runtimeRevision || command.expectedRevisions.taskRevision !== revisions.taskRevision)
      return this.#reject(command, "stale-revision", "stale-source-revision", true);
    let projection: ReviewStateProjection;
    try { projection = await this.#resolve(command.payload.view, command.payload.fileRef); }
    catch { return this.#reject(command, "capability-unavailable", "review-target-unavailable", true); }
    const target = projection.target;
    if (!target || projection.state === "unavailable") return this.#reject(command, "capability-unavailable", projection.reasonCode ?? "review-target-unavailable", true);
    if (!this.#matchesTarget(command, target)) return this.#reject(command, "stale-revision", "review-target-changed", true);
    try {
      const observedRevisions = { ...revisions, workspaceRevision: target.workspaceRevision, indexRevision: target.indexRevision };
      const record = appendReviewEvidence({ projectRoot: this.#projectRoot, taskId: identity.taskId, taskRunId: identity.taskRunId,
        projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, commandId: command.commandId,
        idempotencyKeyDigest: keyDigest, actionDigest: command.actionDigest, reviewState: command.payload.reviewState,
        target, requestedAt: command.requestedAt, recordedAt: this.#now().toISOString(), observedRevisions });
      return receiptFromRecord(record, false);
    } catch { return this.#reject(command, "capability-unavailable", "review-evidence-unavailable", true); }
  }

  #matchesTarget(command: ReviewCommand, target: ReviewTarget): boolean {
    return command.payload.view === target.view && command.payload.fileRef === target.fileRef && command.payload.diffRef === target.diffRef
      && command.payload.contentDigest === target.contentDigest && command.expectedRevisions.taskRevision === target.taskRevision
      && command.expectedRevisions.workspaceRevision === target.workspaceRevision && command.expectedRevisions.indexRevision === target.indexRevision
      && command.expectedRevisions.patchPreimage === target.patchPreimage;
  }

  #validate(value: unknown): string | null {
    const command = value as ReviewCommand;
    if (!exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt",
      "capabilityScope", "action", "actionDigest", "identity", "expectedRevisions", "payload"]) || command.schemaVersion !== 1
      || command.version !== "piagent-webui-control-v1" || command.messageType !== "command" || command.capabilityScope !== "reviewActions"
      || command.action !== "review.mark" || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey)
      || !timestamp(command.requestedAt) || !timestamp(command.expiresAt) || Date.parse(command.requestedAt) > Date.parse(command.expiresAt)
      || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000) return "invalid-command-metadata";
    if (!exactKeys(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      || ![command.identity.projectRef, command.identity.runtimeInstanceId, command.identity.sessionRef].every((item) => REF.test(item))
      || ![command.identity.taskId, command.identity.taskRunId].every((item) => typeof item === "string" && PUBLIC_REF.test(item))
      || command.identity.agentOperationId !== null || command.identity.toolCallId !== null) return "invalid-command-identity";
    const revisionKeys = ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision",
      "sessionOptionRevision", "queueRevision", "workspacePreimage", "indexPreimage", "patchPreimage"];
    if (!exactKeys(command.expectedRevisions, revisionKeys) || !REVISION.test(command.expectedRevisions.runtimeRevision)
      || !REVISION.test(command.expectedRevisions.taskRevision ?? "") || !REVISION.test(command.expectedRevisions.workspaceRevision ?? "")
      || command.expectedRevisions.indexRevision !== null && !REVISION.test(command.expectedRevisions.indexRevision)
      || command.expectedRevisions.workspacePreimage !== null || command.expectedRevisions.indexPreimage !== null
      || !DIGEST.test(command.expectedRevisions.patchPreimage)) return "invalid-review-authority";
    if (!exactKeys(command.payload, ["view", "fileRef", "diffRef", "reviewState", "contentDigest"])
      || !["task", "working-tree", "staged"].includes(command.payload.view) || !REF.test(command.payload.fileRef) || !REF.test(command.payload.diffRef)
      || !["reviewed", "unreviewed"].includes(command.payload.reviewState) || !DIGEST.test(command.payload.contentDigest)) return "invalid-review-payload";
    if (!DIGEST.test(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    return null;
  }

  #reject(command: ReviewCommand, resultCode: ReviewReceipt["resultCode"], code: string, retryable: boolean): ReviewReceipt {
    const snapshot = this.#bridge.snapshot(), at = this.#now().toISOString();
    const observedIdentity = snapshot.identity ? wireIdentity(snapshot.identity) : null;
    const identity: BridgeIdentity = observedIdentity ? { ...observedIdentity, taskId: observedIdentity.taskId ?? "task.unavailable",
      taskRunId: observedIdentity.taskRunId ?? "task-run.unavailable" } : { projectRef: "project.unavailable", runtimeInstanceId: "runtime.unavailable",
      sessionRef: "session.unavailable", taskId: "task.unavailable", taskRunId: "task-run.unavailable", agentOperationId: null, toolCallId: null };
    const revisions = snapshot.revisions ? wireRevisions(snapshot.revisions) : { runtimeRevision: "runtime.unavailable", taskRevision: null,
      controlRevision: null, workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt",
      commandId: typeof command?.commandId === "string" && REF.test(command.commandId) ? command.commandId : `review-rejected.${sha(canonicalReviewValue(command ?? null)).slice(7)}`,
      idempotencyKeyDigest: sha(typeof command?.idempotencyKey === "string" ? command.idempotencyKey : canonicalReviewValue(command ?? null)),
      action: "review.mark", actionDigest: typeof command?.actionDigest === "string" && DIGEST.test(command.actionDigest) ? command.actionDigest : sha(code),
      identity, phase: "rejected", resultCode, requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : at, settledAt: at,
      observedRevisionsBefore: revisions, observedRevisionsAfter: revisions, deduplicated: false, auditRef: null, settlementEvidenceRef: null,
      error: { code, message: "The exact review request could not be recorded.", retryable } };
  }
}
