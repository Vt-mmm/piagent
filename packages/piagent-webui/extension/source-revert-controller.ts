import { createHash } from "node:crypto";

import { appendSourceMutationEvidence, readSourceMutationEvidence, type SourceMutationEvidenceRecord } from "../../piagent-core/runtime/inspection/source-mutation-store.ts";
import { canonicalReviewValue, reviewDigest } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
import type { SourceRevertAuthority, SourceRevertProjection, SourceRevertTarget } from "../../piagent-core/runtime/inspection/source-revert-projection.ts";
import type { SourceIndexTransactionResult } from "../../piagent-core/runtime/policy/source-index-transaction.ts";
import { controlActionDigest, type BridgeIdentity, type BridgeRevisions, type SameSessionPiBridge } from "./same-session-bridge.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/, PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/,
  REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/,
  WORKSPACE = /^wt-content-v2:[a-f0-9]{64}$/, IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;
const REVISION_KEYS = ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"];
type RevertCommand = { schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "reviewActions"; action: "source.revert"; actionDigest: string; identity: BridgeIdentity;
  expectedRevisions: BridgeRevisions & { workspacePreimage: string; indexPreimage: string; patchPreimage: string };
  payload: { fileRef: string; hunkRefs: string[]; previewRef: string; confirmedPreviewDigest: string; contentDigest: string } };
type RevertMutate = (input: { identity: { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string };
  action: "source.revert"; expectedTaskRevision: string; expectedControlRevision: string; expectedIndexPreimage: string;
  expectedWorkspacePreimage: string; previewRef: string; confirmedPreviewDigest: string;
  authority: SourceRevertAuthority }) => Promise<SourceIndexTransactionResult>;
export type SourceRevertReceipt = { schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string;
  idempotencyKeyDigest: string; action: "source.revert"; actionDigest: string; identity: BridgeIdentity; phase: "settled" | "rejected" | "uncertain";
  resultCode: "reverted" | "effect-unknown" | "stale-revision" | "identity-mismatch" | "capability-unavailable" | "idempotency-payload-mismatch"
    | "expired" | "invalid-command" | "resync-required" | "terminal-task"; requestedAt: string; settledAt: string;
  observedRevisionsBefore: BridgeRevisions; observedRevisionsAfter: BridgeRevisions; deduplicated: boolean; auditRef: string | null;
  settlementEvidenceRef: string | null; error: { code: string; message: string; retryable: boolean } | null };

function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function same(left: unknown, right: unknown): boolean { return canonicalReviewValue(left) === canonicalReviewValue(right); }
function exactKeys(value: unknown, keys: string[]): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value)
  && same(Object.keys(value as object).sort(), [...keys].sort())); }
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function wireIdentity(value: BridgeIdentity): BridgeIdentity { return { projectRef: value.projectRef, runtimeInstanceId: value.runtimeInstanceId,
  sessionRef: value.sessionRef, taskId: value.taskId, taskRunId: value.taskRunId, agentOperationId: null, toolCallId: null }; }
function wireRevisions(value: Record<string, any>): BridgeRevisions { return { runtimeRevision: value.runtimeRevision, taskRevision: value.taskRevision,
  controlRevision: value.controlRevision, workspaceRevision: value.workspaceRevision, indexRevision: value.indexRevision,
  approvalRevision: value.approvalRevision, sessionOptionRevision: value.sessionOptionRevision, queueRevision: value.queueRevision }; }
function receipt(record: SourceMutationEvidenceRecord, deduplicated: boolean): SourceRevertReceipt {
  const identity = { projectRef: record.projectRef, runtimeInstanceId: record.runtimeInstanceId, sessionRef: record.sessionRef,
    taskId: record.taskId, taskRunId: record.taskRunId, agentOperationId: null, toolCallId: null } as BridgeIdentity;
  const before = wireRevisions(record.observedRevisionsBefore), after = wireRevisions(record.observedRevisionsAfter ?? record.observedRevisionsBefore);
  if (record.phase === "settled") return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
    idempotencyKeyDigest: record.idempotencyKeyDigest, action: "source.revert", actionDigest: record.actionDigest, identity, phase: "settled", resultCode: "reverted",
    requestedAt: record.requestedAt, settledAt: record.recordedAt, observedRevisionsBefore: before, observedRevisionsAfter: after, deduplicated,
    auditRef: record.evidenceRef, settlementEvidenceRef: record.evidenceRef, error: null };
  if (record.phase === "rejected") {
    const stale = ["mutation-preimage-stale", "mutation-guard-precondition-stale"].includes(record.failureCode ?? "");
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
      idempotencyKeyDigest: record.idempotencyKeyDigest, action: "source.revert", actionDigest: record.actionDigest, identity, phase: "rejected",
      resultCode: stale ? "stale-revision" : "capability-unavailable", requestedAt: record.requestedAt, settledAt: record.recordedAt,
      observedRevisionsBefore: before, observedRevisionsAfter: after, deduplicated, auditRef: record.evidenceRef, settlementEvidenceRef: null,
      error: { code: record.failureCode ?? "source-revert-rejected", message: "The Pi guard rejected the confirmed source revert before commit.", retryable: true } };
  }
  return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
    idempotencyKeyDigest: record.idempotencyKeyDigest, action: "source.revert", actionDigest: record.actionDigest, identity, phase: "uncertain",
    resultCode: "effect-unknown", requestedAt: record.requestedAt, settledAt: record.recordedAt, observedRevisionsBefore: before,
    observedRevisionsAfter: after, deduplicated, auditRef: record.phase === "uncertain" ? record.evidenceRef : null,
    settlementEvidenceRef: null, error: { code: "source-revert-effect-unknown", message: "The worktree effect could not be confirmed. Inspect the source tabs.", retryable: false } };
}

export class SourceRevertController {
  readonly #bridge: SameSessionPiBridge; readonly #projectRoot: string;
  readonly #resolve: (fileRef: string, hunkRefs: string[]) => Promise<{ projection: SourceRevertProjection; authority: SourceRevertAuthority | null }>;
  readonly #revisions: () => Promise<Record<string, string | null>>;
  readonly #mutate: RevertMutate;
  readonly #now: () => Date; #serial: Promise<unknown> = Promise.resolve();
  constructor(options: { bridge: SameSessionPiBridge; projectRoot: string;
    resolve(fileRef: string, hunkRefs: string[]): Promise<{ projection: SourceRevertProjection; authority: SourceRevertAuthority | null }>;
    revisions(): Promise<Record<string, string | null>>; mutate: RevertMutate; now?: () => Date }) {
    this.#bridge = options.bridge; this.#projectRoot = options.projectRoot; this.#resolve = options.resolve;
    this.#revisions = options.revisions; this.#mutate = options.mutate; this.#now = options.now ?? (() => new Date());
  }
  execute(value: unknown): Promise<SourceRevertReceipt> {
    const run = this.#serial.then(() => this.#execute(value), () => this.#execute(value)); this.#serial = run.catch(() => undefined); return run;
  }
  async #execute(value: unknown): Promise<SourceRevertReceipt> {
    const command = value as RevertCommand, snapshot = this.#bridge.snapshot(), invalid = this.#validate(value);
    if (snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions) return this.#reject(command, "resync-required", "revert-binding-unavailable", true);
    if (invalid) return this.#reject(command, "invalid-command", invalid, false);
    const identity = wireIdentity(snapshot.identity), bridgeRevisions = wireRevisions(snapshot.revisions);
    if (!identity.taskId || !identity.taskRunId || !bridgeRevisions.taskRevision) return this.#reject(command, "capability-unavailable", "active-task-required", false);
    if (snapshot.taskState === "terminal") return this.#reject(command, "terminal-task", "task-terminal", false);
    if (snapshot.liveness !== "idle") return this.#reject(command, "capability-unavailable", "agent-not-idle", true);
    const evidence = readSourceMutationEvidence(this.#projectRoot, identity.taskRunId);
    if (evidence.corruptions.length) return this.#reject(command, "resync-required", "mutation-evidence-corrupt", false);
    const keyDigest = sha(command.idempotencyKey), prior = evidence.records.filter((record) => record.commandId === command.commandId || record.idempotencyKeyDigest === keyDigest);
    if (prior.length) {
      if (prior.some((record) => record.commandId !== command.commandId || record.idempotencyKeyDigest !== keyDigest || record.actionDigest !== command.actionDigest
        || record.action !== command.action)) return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", false);
      if (prior.some((record) => record.runtimeInstanceId !== identity.runtimeInstanceId || record.sessionRef !== identity.sessionRef))
        return this.#reject(command, "identity-mismatch", "runtime-or-session-replaced", false);
      return receipt(prior.at(-1)!, true);
    }
    const now = this.#now().getTime();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future", false);
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired", false);
    if (!same(command.identity, identity)) return this.#reject(command, "identity-mismatch", "identity-mismatch", false);
    if (command.expectedRevisions.runtimeRevision !== bridgeRevisions.runtimeRevision || command.expectedRevisions.taskRevision !== bridgeRevisions.taskRevision
      || command.expectedRevisions.controlRevision !== bridgeRevisions.controlRevision) return this.#reject(command, "stale-revision", "stale-task-control-revision", true);
    let resolved: { projection: SourceRevertProjection; authority: SourceRevertAuthority | null };
    try { resolved = await this.#resolve(command.payload.fileRef, command.payload.hunkRefs); }
    catch { return this.#reject(command, "capability-unavailable", "revert-preview-unavailable", true); }
    if (!resolved.authority || resolved.projection.state !== "ready" || !resolved.projection.target)
      return this.#reject(command, "capability-unavailable", resolved.projection.reasonCode ?? "revert-preview-unavailable", true);
    const target = resolved.projection.target;
    if (!this.#matches(command, target) || now > Date.parse(target.expiresAt)) return this.#reject(command, "stale-revision", "revert-preview-stale", true);
    const before = { ...bridgeRevisions, workspaceRevision: target.workspaceRevision, indexRevision: target.indexRevision };
    let requested: SourceMutationEvidenceRecord;
    try { requested = appendSourceMutationEvidence({ projectRoot: this.#projectRoot, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
      sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId, commandId: command.commandId, idempotencyKeyDigest: keyDigest,
      actionDigest: command.actionDigest, action: "source.revert", target, selectedHunkRefs: [...command.payload.hunkRefs], phase: "requested",
      resultCode: "mutation-requested", failureCode: null, requestedAt: command.requestedAt, recordedAt: this.#now().toISOString(),
      beforeIndexPreimage: target.indexPreimage, afterIndexPreimage: null, beforeWorkspacePreimage: target.workspacePreimage,
      afterWorkspacePreimage: null, observedRevisionsBefore: before, observedRevisionsAfter: null }); }
    catch { return this.#reject(command, "capability-unavailable", "mutation-evidence-unavailable", false); }
    let effect: SourceIndexTransactionResult;
    try { effect = await this.#mutate({ identity: { projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
      sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId }, action: "source.revert",
      expectedTaskRevision: target.taskRevision, expectedControlRevision: bridgeRevisions.controlRevision!, expectedIndexPreimage: target.indexPreimage,
      expectedWorkspacePreimage: target.workspacePreimage, previewRef: target.previewRef, confirmedPreviewDigest: target.confirmedPreviewDigest,
      authority: resolved.authority }); }
    catch { effect = { state: "rejected", reasonCode: "mutation-guard-unavailable", beforeIndexPreimage: target.indexPreimage,
      afterIndexPreimage: null, beforeWorkspacePreimage: target.workspacePreimage, afterWorkspacePreimage: null, executor: "pi-guard", directExecution: false }; }
    if (effect.executor !== "pi-guard" || effect.directExecution !== false) effect = { ...effect, state: "uncertain", reasonCode: "mutation-executor-untrusted",
      afterIndexPreimage: null, afterWorkspacePreimage: null, executor: "pi-guard", directExecution: false };
    let after: BridgeRevisions; try { after = wireRevisions(await this.#revisions()); } catch { after = before; }
    const phase = effect.state, resultCode = effect.state === "settled" ? "reverted" : effect.state === "rejected" ? "mutation-rejected" : "effect-unknown";
    try { const terminal = appendSourceMutationEvidence({ projectRoot: this.#projectRoot, projectRef: identity.projectRef,
      runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId,
      commandId: command.commandId, idempotencyKeyDigest: keyDigest, actionDigest: command.actionDigest, action: "source.revert", target,
      selectedHunkRefs: [...command.payload.hunkRefs], phase, resultCode, failureCode: effect.reasonCode, requestedAt: command.requestedAt,
      recordedAt: this.#now().toISOString(), beforeIndexPreimage: target.indexPreimage, afterIndexPreimage: effect.afterIndexPreimage,
      beforeWorkspacePreimage: target.workspacePreimage, afterWorkspacePreimage: effect.afterWorkspacePreimage,
      observedRevisionsBefore: before, observedRevisionsAfter: after }); return receipt(terminal, false); }
    catch { return receipt(requested, false); }
  }
  #matches(command: RevertCommand, target: SourceRevertTarget): boolean {
    return command.payload.fileRef === target.fileRef && same(command.payload.hunkRefs, target.hunkRefs) && command.payload.previewRef === target.previewRef
      && command.payload.confirmedPreviewDigest === target.confirmedPreviewDigest && command.payload.contentDigest === target.contentDigest
      && command.expectedRevisions.taskRevision === target.taskRevision && command.expectedRevisions.workspaceRevision === target.workspaceRevision
      && command.expectedRevisions.indexRevision === target.indexRevision && command.expectedRevisions.workspacePreimage === target.workspacePreimage
      && command.expectedRevisions.indexPreimage === target.indexPreimage && command.expectedRevisions.patchPreimage === target.patchPreimage;
  }
  #validate(value: unknown): string | null {
    const command = value as RevertCommand;
    if (!exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope", "action", "actionDigest", "identity", "expectedRevisions", "payload"])
      || command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1" || command.messageType !== "command" || command.capabilityScope !== "reviewActions"
      || command.action !== "source.revert" || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt)
      || !timestamp(command.expiresAt) || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000)
      return "invalid-command-metadata";
    if (!exactKeys(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      || ![command.identity.projectRef, command.identity.runtimeInstanceId, command.identity.sessionRef].every((item) => REF.test(item))
      || ![command.identity.taskId, command.identity.taskRunId].every((item) => typeof item === "string" && PUBLIC_REF.test(item))
      || command.identity.agentOperationId !== null || command.identity.toolCallId !== null) return "invalid-command-identity";
    if (!exactKeys(command.expectedRevisions, [...REVISION_KEYS, "workspacePreimage", "indexPreimage", "patchPreimage"])
      || !REVISION.test(command.expectedRevisions.runtimeRevision) || !REVISION.test(command.expectedRevisions.taskRevision ?? "")
      || !REVISION.test(command.expectedRevisions.controlRevision ?? "")
      || !REVISION.test(command.expectedRevisions.workspaceRevision ?? "") || !REVISION.test(command.expectedRevisions.indexRevision ?? "")
      || [command.expectedRevisions.approvalRevision, command.expectedRevisions.sessionOptionRevision, command.expectedRevisions.queueRevision]
        .some((item) => item !== null && !REVISION.test(String(item)))
      || !WORKSPACE.test(command.expectedRevisions.workspacePreimage) || !DIGEST.test(command.expectedRevisions.indexPreimage)
      || !DIGEST.test(command.expectedRevisions.patchPreimage)) return "invalid-revert-authority";
    if (!exactKeys(command.payload, ["fileRef", "hunkRefs", "previewRef", "confirmedPreviewDigest", "contentDigest"])
      || !REF.test(command.payload.fileRef) || !REF.test(command.payload.previewRef) || !Array.isArray(command.payload.hunkRefs)
      || command.payload.hunkRefs.length > 1 || new Set(command.payload.hunkRefs).size !== command.payload.hunkRefs.length
      || command.payload.hunkRefs.some((item) => !REF.test(item)) || !DIGEST.test(command.payload.confirmedPreviewDigest)
      || !DIGEST.test(command.payload.contentDigest)) return "invalid-revert-payload";
    if (!DIGEST.test(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    return null;
  }
  #reject(command: RevertCommand, resultCode: SourceRevertReceipt["resultCode"], code: string, retryable: boolean): SourceRevertReceipt {
    const snapshot = this.#bridge.snapshot(), at = this.#now().toISOString(), observed = snapshot.identity ? wireIdentity(snapshot.identity) : null;
    const identity = observed ? { ...observed, taskId: observed.taskId ?? "task.unavailable", taskRunId: observed.taskRunId ?? "task-run.unavailable" }
      : { projectRef: "project.unavailable", runtimeInstanceId: "runtime.unavailable", sessionRef: "session.unavailable", taskId: "task.unavailable",
        taskRunId: "task-run.unavailable", agentOperationId: null, toolCallId: null } as BridgeIdentity;
    const revisions = snapshot.revisions ? wireRevisions(snapshot.revisions) : { runtimeRevision: "runtime.unavailable", taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt",
      commandId: typeof command?.commandId === "string" && REF.test(command.commandId) ? command.commandId : `revert-rejected.${reviewDigest(command ?? null).slice(7)}`,
      idempotencyKeyDigest: sha(typeof command?.idempotencyKey === "string" ? command.idempotencyKey : canonicalReviewValue(command ?? null)), action: "source.revert",
      actionDigest: typeof command?.actionDigest === "string" && DIGEST.test(command.actionDigest) ? command.actionDigest : sha(code), identity,
      phase: "rejected", resultCode, requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : at, settledAt: at,
      observedRevisionsBefore: revisions, observedRevisionsAfter: revisions, deduplicated: false, auditRef: null, settlementEvidenceRef: null,
      error: { code, message: "The confirmed exact source revert could not be completed.", retryable } };
  }
}
