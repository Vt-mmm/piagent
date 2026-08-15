import { createHash } from "node:crypto";

import { appendSourceMutationEvidence, readSourceMutationEvidence, type SourceMutationEvidenceRecord } from "../../piagent-core/runtime/inspection/source-mutation-store.ts";
import { canonicalReviewValue, reviewDigest } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
import type { SourceMutationAction, SourceMutationAuthority, SourceMutationProjection, SourceMutationTarget } from "../../piagent-core/runtime/inspection/source-mutation-projection.ts";
import type { SourceIndexTransactionResult } from "../../piagent-core/runtime/policy/source-index-transaction.ts";
import { controlActionDigest, type BridgeIdentity, type BridgeRevisions, type SameSessionPiBridge } from "./same-session-bridge.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/, PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/,
  REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/,
  WORKSPACE = /^wt-content-v2:[a-f0-9]{64}$/, IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;
const REVISION_KEYS = ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"];

type MutationCommand = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "reviewActions"; action: SourceMutationAction; actionDigest: string;
  identity: BridgeIdentity; expectedRevisions: BridgeRevisions & { workspacePreimage: string; indexPreimage: string; patchPreimage: string };
  payload: { fileRef: string; hunkRefs: string[]; contentDigest: string };
};
export type SourceMutationReceipt = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string; idempotencyKeyDigest: string;
  action: SourceMutationAction; actionDigest: string; identity: BridgeIdentity; phase: "settled" | "rejected" | "uncertain";
  resultCode: "staged" | "unstaged" | "effect-unknown" | "stale-revision" | "identity-mismatch" | "capability-unavailable"
    | "idempotency-payload-mismatch" | "expired" | "invalid-command" | "resync-required" | "terminal-task";
  requestedAt: string; settledAt: string; observedRevisionsBefore: BridgeRevisions; observedRevisionsAfter: BridgeRevisions;
  deduplicated: boolean; auditRef: string | null; settlementEvidenceRef: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
};

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

function receiptFromRecord(record: SourceMutationEvidenceRecord, deduplicated: boolean): SourceMutationReceipt {
  if (record.action === "source.revert") throw new Error("source-mutation-evidence-action-mismatch");
  const action: SourceMutationAction = record.action;
  const identity = { projectRef: record.projectRef, runtimeInstanceId: record.runtimeInstanceId, sessionRef: record.sessionRef,
    taskId: record.taskId, taskRunId: record.taskRunId, agentOperationId: null, toolCallId: null } as BridgeIdentity;
  const before = wireRevisions(record.observedRevisionsBefore), after = wireRevisions(record.observedRevisionsAfter ?? record.observedRevisionsBefore);
  if (record.phase === "settled") return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
    idempotencyKeyDigest: record.idempotencyKeyDigest, action, actionDigest: record.actionDigest, identity, phase: "settled",
    resultCode: action === "source.stage" ? "staged" : "unstaged", requestedAt: record.requestedAt, settledAt: record.recordedAt,
    observedRevisionsBefore: before, observedRevisionsAfter: after, deduplicated, auditRef: record.evidenceRef,
    settlementEvidenceRef: record.evidenceRef, error: null };
  if (record.phase === "rejected") {
    const stale = record.failureCode === "mutation-preimage-stale" || record.failureCode === "mutation-guard-precondition-stale";
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
      idempotencyKeyDigest: record.idempotencyKeyDigest, action, actionDigest: record.actionDigest, identity, phase: "rejected",
      resultCode: stale ? "stale-revision" : "capability-unavailable", requestedAt: record.requestedAt, settledAt: record.recordedAt,
      observedRevisionsBefore: before, observedRevisionsAfter: after, deduplicated, auditRef: record.evidenceRef,
      settlementEvidenceRef: null, error: { code: record.failureCode ?? "source-mutation-rejected",
        message: "The Pi guard rejected the selected-file Git index action before commit.", retryable: true } };
  }
  return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
    idempotencyKeyDigest: record.idempotencyKeyDigest, action, actionDigest: record.actionDigest, identity, phase: "uncertain",
    resultCode: "effect-unknown", requestedAt: record.requestedAt, settledAt: record.recordedAt,
    observedRevisionsBefore: before, observedRevisionsAfter: after, deduplicated, auditRef: record.phase === "uncertain" ? record.evidenceRef : null,
    settlementEvidenceRef: null, error: { code: "source-mutation-effect-unknown", message: "The exact Git index effect could not be confirmed.", retryable: false } };
}

export class SourceMutationController {
  readonly #bridge: SameSessionPiBridge;
  readonly #projectRoot: string;
  readonly #resolve: (action: SourceMutationAction, fileRef: string) => Promise<{ projection: SourceMutationProjection; authority: SourceMutationAuthority | null }>;
  readonly #revisions: () => Promise<Record<string, string | null>>;
  readonly #mutate: (input: { identity: { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string };
    action: SourceMutationAction; expectedTaskRevision: string; expectedControlRevision: string; expectedIndexPreimage: string;
    expectedWorkspacePreimage: string; selectedHunkRefs: string[]; authority: SourceMutationAuthority }) => Promise<SourceIndexTransactionResult>;
  readonly #now: () => Date;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: { bridge: SameSessionPiBridge; projectRoot: string;
    resolve(action: SourceMutationAction, fileRef: string): Promise<{ projection: SourceMutationProjection; authority: SourceMutationAuthority | null }>;
    revisions(): Promise<Record<string, string | null>>;
    mutate(input: { identity: { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string };
      action: SourceMutationAction; expectedTaskRevision: string; expectedControlRevision: string; expectedIndexPreimage: string;
      expectedWorkspacePreimage: string; selectedHunkRefs: string[]; authority: SourceMutationAuthority }): Promise<SourceIndexTransactionResult>;
    now?: () => Date }) {
    this.#bridge = options.bridge; this.#projectRoot = options.projectRoot; this.#resolve = options.resolve;
    this.#revisions = options.revisions; this.#mutate = options.mutate; this.#now = options.now ?? (() => new Date());
  }

  execute(value: unknown): Promise<SourceMutationReceipt> {
    const run = this.#serial.then(() => this.#execute(value), () => this.#execute(value)); this.#serial = run.catch(() => undefined); return run;
  }

  async #execute(value: unknown): Promise<SourceMutationReceipt> {
    const command = value as MutationCommand, snapshot = this.#bridge.snapshot(), invalid = this.#validate(value);
    if (snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions) return this.#reject(command, "resync-required", "mutation-binding-unavailable", true);
    if (invalid) return this.#reject(command, "invalid-command", invalid, false);
    const identity = wireIdentity(snapshot.identity), bridgeRevisions = wireRevisions(snapshot.revisions);
    if (!identity.taskId || !identity.taskRunId || !bridgeRevisions.taskRevision) return this.#reject(command, "capability-unavailable", "active-task-required", false);
    if (snapshot.taskState === "terminal") return this.#reject(command, "terminal-task", "task-terminal", false);
    if (snapshot.liveness !== "idle") return this.#reject(command, "capability-unavailable", "agent-not-idle", true);
    const evidence = readSourceMutationEvidence(this.#projectRoot, identity.taskRunId);
    if (evidence.corruptions.length) return this.#reject(command, "resync-required", "mutation-evidence-corrupt", false);
    const keyDigest = sha(command.idempotencyKey), prior = evidence.records.filter((record) => record.commandId === command.commandId
      || record.idempotencyKeyDigest === keyDigest);
    if (prior.length) {
      if (prior.some((record) => record.commandId !== command.commandId || record.idempotencyKeyDigest !== keyDigest || record.actionDigest !== command.actionDigest
        || record.action !== command.action)) return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", false);
      if (prior.some((record) => record.runtimeInstanceId !== identity.runtimeInstanceId || record.sessionRef !== identity.sessionRef))
        return this.#reject(command, "identity-mismatch", "runtime-or-session-replaced", false);
      return receiptFromRecord(prior.at(-1)!, true);
    }
    const now = this.#now().getTime();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future", false);
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired", false);
    if (!same(command.identity, identity)) return this.#reject(command, "identity-mismatch", "identity-mismatch", false);
    if (command.expectedRevisions.runtimeRevision !== bridgeRevisions.runtimeRevision || command.expectedRevisions.taskRevision !== bridgeRevisions.taskRevision
      || command.expectedRevisions.controlRevision !== bridgeRevisions.controlRevision) return this.#reject(command, "stale-revision", "stale-task-control-revision", true);
    let resolved: { projection: SourceMutationProjection; authority: SourceMutationAuthority | null };
    try { resolved = await this.#resolve(command.action, command.payload.fileRef); }
    catch { return this.#reject(command, "capability-unavailable", "mutation-preview-unavailable", true); }
    if (!resolved.authority || resolved.projection.state !== "ready" || !resolved.projection.target)
      return this.#reject(command, "capability-unavailable", resolved.projection.reasonCode ?? "mutation-preview-unavailable", true);
    const target = resolved.projection.target;
    if (!this.#matches(command, target)) return this.#reject(command, "stale-revision", "mutation-preview-stale", true);
    const before = { ...bridgeRevisions, workspaceRevision: target.workspaceRevision, indexRevision: target.indexRevision };
    let requested: SourceMutationEvidenceRecord;
    try { requested = appendSourceMutationEvidence({ projectRoot: this.#projectRoot, projectRef: identity.projectRef,
      runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId,
      commandId: command.commandId, idempotencyKeyDigest: keyDigest, actionDigest: command.actionDigest, action: command.action, target,
      selectedHunkRefs: [...command.payload.hunkRefs], phase: "requested", resultCode: "mutation-requested", failureCode: null,
      requestedAt: command.requestedAt, recordedAt: this.#now().toISOString(),
      beforeIndexPreimage: target.indexPreimage, afterIndexPreimage: null, beforeWorkspacePreimage: target.workspacePreimage,
      afterWorkspacePreimage: null, observedRevisionsBefore: before, observedRevisionsAfter: null }); }
    catch { return this.#reject(command, "capability-unavailable", "mutation-evidence-unavailable", false); }
    let effect: SourceIndexTransactionResult;
    try { effect = await this.#mutate({ identity: { projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
      sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId }, action: command.action,
      expectedTaskRevision: target.taskRevision, expectedControlRevision: bridgeRevisions.controlRevision!,
      expectedIndexPreimage: target.indexPreimage, expectedWorkspacePreimage: target.workspacePreimage,
      selectedHunkRefs: [...command.payload.hunkRefs], authority: resolved.authority }); }
    catch { effect = { state: "rejected", reasonCode: "mutation-guard-unavailable", beforeIndexPreimage: target.indexPreimage,
      afterIndexPreimage: null, beforeWorkspacePreimage: target.workspacePreimage, afterWorkspacePreimage: null,
      executor: "pi-guard", directExecution: false }; }
    if (effect.executor !== "pi-guard" || effect.directExecution !== false) effect = { ...effect, state: "uncertain",
      reasonCode: "mutation-executor-untrusted", afterIndexPreimage: null, afterWorkspacePreimage: null,
      executor: "pi-guard", directExecution: false };
    let after: BridgeRevisions;
    try { after = wireRevisions(await this.#revisions()); } catch { after = before; }
    const phase = effect.state, resultCode = effect.state === "settled" ? command.action === "source.stage" ? "staged" : "unstaged"
      : effect.state === "rejected" ? "mutation-rejected" : "effect-unknown";
    try {
      const terminal = appendSourceMutationEvidence({ projectRoot: this.#projectRoot, projectRef: identity.projectRef,
        runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef, taskId: identity.taskId, taskRunId: identity.taskRunId,
        commandId: command.commandId, idempotencyKeyDigest: keyDigest, actionDigest: command.actionDigest, action: command.action, target,
        selectedHunkRefs: [...command.payload.hunkRefs], phase, resultCode, failureCode: effect.reasonCode,
        requestedAt: command.requestedAt, recordedAt: this.#now().toISOString(), beforeIndexPreimage: target.indexPreimage,
        afterIndexPreimage: effect.afterIndexPreimage, beforeWorkspacePreimage: target.workspacePreimage,
        afterWorkspacePreimage: effect.afterWorkspacePreimage, observedRevisionsBefore: before, observedRevisionsAfter: after });
      return receiptFromRecord(terminal, false);
    } catch { return receiptFromRecord(requested, false); }
  }

  #matches(command: MutationCommand, target: SourceMutationTarget): boolean {
    return command.payload.fileRef === target.fileRef && command.payload.contentDigest === target.contentDigest
      && same(command.payload.hunkRefs, target.hunkRefs.filter((hunkRef) => command.payload.hunkRefs.includes(hunkRef)))
      && command.expectedRevisions.taskRevision === target.taskRevision && command.expectedRevisions.workspaceRevision === target.workspaceRevision
      && command.expectedRevisions.indexRevision === target.indexRevision && command.expectedRevisions.workspacePreimage === target.workspacePreimage
      && command.expectedRevisions.indexPreimage === target.indexPreimage && command.expectedRevisions.patchPreimage === target.patchPreimage;
  }

  #validate(value: unknown): string | null {
    const command = value as MutationCommand;
    if (!exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope", "action", "actionDigest", "identity", "expectedRevisions", "payload"])
      || command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1" || command.messageType !== "command" || command.capabilityScope !== "reviewActions"
      || !["source.stage", "source.unstage"].includes(command.action) || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey)
      || !timestamp(command.requestedAt) || !timestamp(command.expiresAt) || Date.parse(command.requestedAt) > Date.parse(command.expiresAt)
      || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000) return "invalid-command-metadata";
    if (!exactKeys(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      || ![command.identity.projectRef, command.identity.runtimeInstanceId, command.identity.sessionRef].every((item) => REF.test(item))
      || ![command.identity.taskId, command.identity.taskRunId].every((item) => typeof item === "string" && PUBLIC_REF.test(item))
      || command.identity.agentOperationId !== null || command.identity.toolCallId !== null) return "invalid-command-identity";
    const preimageKeys = [...REVISION_KEYS, "workspacePreimage", "indexPreimage", "patchPreimage"];
    if (!exactKeys(command.expectedRevisions, preimageKeys) || !REVISION.test(command.expectedRevisions.runtimeRevision)
      || !REVISION.test(command.expectedRevisions.taskRevision ?? "") || !REVISION.test(command.expectedRevisions.workspaceRevision ?? "")
      || !REVISION.test(command.expectedRevisions.indexRevision ?? "") || !WORKSPACE.test(command.expectedRevisions.workspacePreimage)
      || !DIGEST.test(command.expectedRevisions.indexPreimage) || !DIGEST.test(command.expectedRevisions.patchPreimage)) return "invalid-mutation-authority";
    if (!exactKeys(command.payload, ["fileRef", "hunkRefs", "contentDigest"]) || !REF.test(command.payload.fileRef)
      || !Array.isArray(command.payload.hunkRefs) || command.payload.hunkRefs.length > 128
      || new Set(command.payload.hunkRefs).size !== command.payload.hunkRefs.length || command.payload.hunkRefs.some((item) => !REF.test(item))
      || !DIGEST.test(command.payload.contentDigest)) return "invalid-mutation-payload";
    if (!DIGEST.test(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    return null;
  }

  #reject(command: MutationCommand, resultCode: SourceMutationReceipt["resultCode"], code: string, retryable: boolean): SourceMutationReceipt {
    const snapshot = this.#bridge.snapshot(), at = this.#now().toISOString(), observed = snapshot.identity ? wireIdentity(snapshot.identity) : null;
    const identity = observed ? { ...observed, taskId: observed.taskId ?? "task.unavailable", taskRunId: observed.taskRunId ?? "task-run.unavailable" }
      : { projectRef: "project.unavailable", runtimeInstanceId: "runtime.unavailable", sessionRef: "session.unavailable", taskId: "task.unavailable",
        taskRunId: "task-run.unavailable", agentOperationId: null, toolCallId: null } as BridgeIdentity;
    const revisions = snapshot.revisions ? wireRevisions(snapshot.revisions) : { runtimeRevision: "runtime.unavailable", taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    const action: SourceMutationAction = command?.action === "source.unstage" ? "source.unstage" : "source.stage";
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt",
      commandId: typeof command?.commandId === "string" && REF.test(command.commandId) ? command.commandId : `mutation-rejected.${reviewDigest(command ?? null).slice(7)}`,
      idempotencyKeyDigest: sha(typeof command?.idempotencyKey === "string" ? command.idempotencyKey : canonicalReviewValue(command ?? null)), action,
      actionDigest: typeof command?.actionDigest === "string" && DIGEST.test(command.actionDigest) ? command.actionDigest : sha(code), identity,
      phase: "rejected", resultCode, requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : at, settledAt: at,
      observedRevisionsBefore: revisions, observedRevisionsAfter: revisions, deduplicated: false, auditRef: null, settlementEvidenceRef: null,
      error: { code, message: "The exact selected-file Git index action could not be completed.", retryable } };
  }
}
