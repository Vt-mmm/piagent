import { createHash } from "node:crypto";

import { appendSourceHandoffEvidence, readSourceHandoffEvidence, type SourceHandoffRecord } from "../../piagent-core/runtime/inspection/source-handoff-store.ts";
import { canonicalReviewValue, reviewDigest } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
import type { SourceOpenAuthority } from "../../piagent-core/runtime/inspection/source-open-target.ts";
import { controlActionDigest, type BridgeIdentity, type BridgeRevisions, type SameSessionPiBridge } from "./same-session-bridge.ts";
import type { VSCodeHandoffResult } from "./vscode-handoff.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/, PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/,
  REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/, DIGEST = /^sha256:[a-f0-9]{64}$/, IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;
const REVISION_KEYS = ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision", "sessionOptionRevision", "queueRevision"];
type OpenCommand = { schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "reviewActions"; action: "source.open-in-vscode"; actionDigest: string; identity: BridgeIdentity;
  expectedRevisions: BridgeRevisions & { workspacePreimage: null; indexPreimage: null; patchPreimage: null };
  payload: { fileRef: string; line: number | null; column: number | null } };
export type SourceOpenReceipt = { schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string;
  idempotencyKeyDigest: string; action: "source.open-in-vscode"; actionDigest: string; identity: BridgeIdentity; phase: "settled" | "rejected" | "uncertain";
  resultCode: "opened" | "effect-unknown" | "stale-revision" | "identity-mismatch" | "capability-unavailable" | "idempotency-payload-mismatch"
    | "expired" | "invalid-command" | "resync-required"; requestedAt: string; settledAt: string; observedRevisionsBefore: BridgeRevisions;
  observedRevisionsAfter: BridgeRevisions; deduplicated: boolean; auditRef: string | null; settlementEvidenceRef: string | null;
  error: { code: string; message: string; retryable: boolean } | null };

function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function same(a: unknown, b: unknown): boolean { return canonicalReviewValue(a) === canonicalReviewValue(b); }
function exact(value: unknown, keys: string[]): boolean { return Boolean(value && typeof value === "object" && !Array.isArray(value)
  && same(Object.keys(value as object).sort(), [...keys].sort())); }
function timestamp(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function nullableRevision(value: unknown): boolean { return value === null || typeof value === "string" && REVISION.test(value); }
function identity(value: BridgeIdentity): BridgeIdentity { return { projectRef: value.projectRef, runtimeInstanceId: value.runtimeInstanceId,
  sessionRef: value.sessionRef, taskId: value.taskId, taskRunId: value.taskRunId, agentOperationId: null, toolCallId: null }; }
function revisions(value: Record<string, any>, record?: SourceHandoffRecord): BridgeRevisions { return { runtimeRevision: value.runtimeRevision,
  taskRevision: record?.taskRevision ?? value.taskRevision, controlRevision: value.controlRevision,
  workspaceRevision: record?.workspaceRevision ?? value.workspaceRevision, indexRevision: value.indexRevision,
  approvalRevision: value.approvalRevision, sessionOptionRevision: value.sessionOptionRevision, queueRevision: value.queueRevision }; }

export class SourceOpenController {
  readonly #bridge: SameSessionPiBridge; readonly #root: string; readonly #resolve: (fileRef: string) => Promise<SourceOpenAuthority | null>;
  readonly #open: (absolutePath: string, line: number | null, column: number | null) => Promise<VSCodeHandoffResult>;
  readonly #now: () => Date; #serial: Promise<unknown> = Promise.resolve();
  constructor(options: { bridge: SameSessionPiBridge; projectRoot: string; resolve(fileRef: string): Promise<SourceOpenAuthority | null>;
    open(absolutePath: string, line: number | null, column: number | null): Promise<VSCodeHandoffResult>; now?: () => Date }) {
    this.#bridge = options.bridge; this.#root = options.projectRoot; this.#resolve = options.resolve; this.#open = options.open; this.#now = options.now ?? (() => new Date());
  }
  execute(value: unknown): Promise<SourceOpenReceipt> { const run = this.#serial.then(() => this.#execute(value), () => this.#execute(value));
    this.#serial = run.catch(() => undefined); return run; }
  async #execute(value: unknown): Promise<SourceOpenReceipt> {
    const command = value as OpenCommand, snapshot = this.#bridge.snapshot(), invalid = this.#validate(value);
    if (snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions) return this.#reject(command, "resync-required", "source-open-binding-unavailable", true);
    if (invalid) return this.#reject(command, "invalid-command", invalid, false);
    const currentIdentity = identity(snapshot.identity), currentRevisions = revisions(snapshot.revisions);
    if (!currentIdentity.taskId || !currentIdentity.taskRunId || !currentRevisions.taskRevision) return this.#reject(command, "capability-unavailable", "active-task-required", false);
    const ledger = readSourceHandoffEvidence(this.#root, currentIdentity.taskRunId); if (ledger.corruptions.length) return this.#reject(command, "resync-required", "source-handoff-evidence-corrupt", false);
    const keyDigest = sha(command.idempotencyKey), prior = ledger.records.filter((record) => record.commandId === command.commandId || record.idempotencyKeyDigest === keyDigest);
    if (prior.length) {
      if (prior.some((record) => record.commandId !== command.commandId || record.idempotencyKeyDigest !== keyDigest || record.actionDigest !== command.actionDigest))
        return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", false);
      if (prior.some((record) => record.runtimeInstanceId !== currentIdentity.runtimeInstanceId || record.sessionRef !== currentIdentity.sessionRef))
        return this.#reject(command, "identity-mismatch", "runtime-or-session-replaced", false);
      const last = prior.at(-1)!; if (last.phase !== "requested") return this.#receipt(last, currentRevisions, true);
      const uncertain = this.#append(command, currentIdentity, keyDigest, last, "uncertain", "effect-unknown", "source-open-outcome-unknown");
      return this.#receipt(uncertain, currentRevisions, true);
    }
    const now = this.#now().getTime(); if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future", false);
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired", false);
    if (!same(command.identity, currentIdentity)) return this.#reject(command, "identity-mismatch", "identity-mismatch", false);
    if (command.expectedRevisions.runtimeRevision !== currentRevisions.runtimeRevision || command.expectedRevisions.taskRevision !== currentRevisions.taskRevision)
      return this.#reject(command, "stale-revision", "stale-source-open-revision", true);
    let authority: SourceOpenAuthority | null; try { authority = await this.#resolve(command.payload.fileRef); } catch { authority = null; }
    if (!authority) return this.#reject(command, "capability-unavailable", "source-open-target-unavailable", true);
    if (authority.target.taskRevision !== command.expectedRevisions.taskRevision || authority.target.workspaceRevision !== command.expectedRevisions.workspaceRevision)
      return this.#reject(command, "stale-revision", "source-open-target-stale", true);
    let requested: SourceHandoffRecord; try { requested = this.#append(command, currentIdentity, keyDigest, authority.target, "requested", "handoff-requested", null); }
    catch { return this.#reject(command, "capability-unavailable", "source-handoff-evidence-unavailable", false); }
    let effect: VSCodeHandoffResult; try { effect = await this.#open(authority.absolutePath, command.payload.line, command.payload.column); }
    catch { effect = { state: "rejected", reasonCode: "vscode-launch-failed" }; }
    const resultCode = effect.state === "settled" ? "opened" : effect.state === "rejected" ? "handoff-rejected" : "effect-unknown";
    try { return this.#receipt(this.#append(command, currentIdentity, keyDigest, authority.target, effect.state, resultCode, effect.reasonCode), currentRevisions, false); }
    catch { return this.#receipt(requested, currentRevisions, false); }
  }
  #append(command: OpenCommand, current: BridgeIdentity, keyDigest: string, target: SourceOpenAuthority["target"] | SourceHandoffRecord,
    phase: SourceHandoffRecord["phase"], resultCode: SourceHandoffRecord["resultCode"], failureCode: string | null): SourceHandoffRecord {
    return appendSourceHandoffEvidence({ projectRoot: this.#root, projectRef: current.projectRef, runtimeInstanceId: current.runtimeInstanceId,
      sessionRef: current.sessionRef, taskId: current.taskId!, taskRunId: current.taskRunId!, commandId: command.commandId,
      idempotencyKeyDigest: keyDigest, actionDigest: command.actionDigest, fileRef: target.fileRef, line: command.payload.line,
      column: command.payload.column, taskRevision: target.taskRevision, workspaceRevision: target.workspaceRevision,
      contentDigest: target.contentDigest, phase, resultCode, failureCode, requestedAt: command.requestedAt, recordedAt: this.#now().toISOString() });
  }
  #receipt(record: SourceHandoffRecord, observed: BridgeRevisions, deduplicated: boolean): SourceOpenReceipt {
    const before = revisions(observed, record), settled = record.phase === "settled", uncertain = record.phase === "uncertain" || record.phase === "requested";
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: record.commandId,
      idempotencyKeyDigest: record.idempotencyKeyDigest, action: "source.open-in-vscode", actionDigest: record.actionDigest,
      identity: { projectRef: record.projectRef, runtimeInstanceId: record.runtimeInstanceId, sessionRef: record.sessionRef, taskId: record.taskId,
        taskRunId: record.taskRunId, agentOperationId: null, toolCallId: null }, phase: settled ? "settled" : uncertain ? "uncertain" : "rejected",
      resultCode: settled ? "opened" : uncertain ? "effect-unknown" : "capability-unavailable", requestedAt: record.requestedAt,
      settledAt: record.recordedAt, observedRevisionsBefore: before, observedRevisionsAfter: before, deduplicated,
      auditRef: record.evidenceRef, settlementEvidenceRef: settled ? record.evidenceRef : null,
      error: settled ? null : { code: record.failureCode ?? "source-open-effect-unknown", message: uncertain
        ? "VS Code may have received the request; Piagent cannot confirm it." : "VS Code did not accept the file handoff.", retryable: !uncertain } };
  }
  #validate(value: unknown): string | null {
    const command = value as OpenCommand;
    if (!exact(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope", "action", "actionDigest", "identity", "expectedRevisions", "payload"])
      || command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1" || command.messageType !== "command" || command.capabilityScope !== "reviewActions"
      || command.action !== "source.open-in-vscode" || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt)
      || !timestamp(command.expiresAt) || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000) return "invalid-command-metadata";
    if (!exact(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
      || ![command.identity.projectRef, command.identity.runtimeInstanceId, command.identity.sessionRef].every((item) => REF.test(item))
      || ![command.identity.taskId, command.identity.taskRunId].every((item) => typeof item === "string" && PUBLIC_REF.test(item))
      || command.identity.agentOperationId !== null || command.identity.toolCallId !== null) return "invalid-command-identity";
    if (!exact(command.expectedRevisions, [...REVISION_KEYS, "workspacePreimage", "indexPreimage", "patchPreimage"])
      || !REVISION.test(command.expectedRevisions.runtimeRevision) || !REVISION.test(command.expectedRevisions.taskRevision ?? "")
      || !REVISION.test(command.expectedRevisions.workspaceRevision ?? "") || command.expectedRevisions.workspacePreimage !== null
      || ![command.expectedRevisions.controlRevision, command.expectedRevisions.indexRevision, command.expectedRevisions.approvalRevision,
        command.expectedRevisions.sessionOptionRevision, command.expectedRevisions.queueRevision].every(nullableRevision)
      || command.expectedRevisions.indexPreimage !== null || command.expectedRevisions.patchPreimage !== null) return "invalid-source-open-authority";
    if (!exact(command.payload, ["fileRef", "line", "column"]) || !REF.test(command.payload.fileRef)
      || command.payload.line !== null && (!Number.isInteger(command.payload.line) || command.payload.line < 1 || command.payload.line > 100_000_000)
      || command.payload.column !== null && (!Number.isInteger(command.payload.column) || command.payload.column < 1 || command.payload.column > 1_000_000)
      || command.payload.column !== null && command.payload.line === null) return "invalid-source-open-payload";
    if (!DIGEST.test(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch"; return null;
  }
  #reject(command: OpenCommand, resultCode: SourceOpenReceipt["resultCode"], code: string, retryable: boolean): SourceOpenReceipt {
    const snapshot = this.#bridge.snapshot(), at = this.#now().toISOString(), current = snapshot.identity ? identity(snapshot.identity) : null;
    const safeIdentity = current ? { ...current, taskId: current.taskId ?? "task.unavailable", taskRunId: current.taskRunId ?? "task-run.unavailable" }
      : { projectRef: "project.unavailable", runtimeInstanceId: "runtime.unavailable", sessionRef: "session.unavailable", taskId: "task.unavailable", taskRunId: "task-run.unavailable", agentOperationId: null, toolCallId: null } as BridgeIdentity;
    const observed = snapshot.revisions ? revisions(snapshot.revisions) : { runtimeRevision: "runtime.unavailable", taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: typeof command?.commandId === "string" && REF.test(command.commandId)
      ? command.commandId : `source-open-rejected.${reviewDigest(command ?? null).slice(7)}`, idempotencyKeyDigest: sha(typeof command?.idempotencyKey === "string" ? command.idempotencyKey : canonicalReviewValue(command ?? null)),
      action: "source.open-in-vscode", actionDigest: typeof command?.actionDigest === "string" && DIGEST.test(command.actionDigest) ? command.actionDigest : sha(code), identity: safeIdentity,
      phase: "rejected", resultCode, requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : at, settledAt: at,
      observedRevisionsBefore: observed, observedRevisionsAfter: observed, deduplicated: false, auditRef: null, settlementEvidenceRef: null,
      error: { code, message: "The selected source file could not be opened in VS Code.", retryable } };
  }
}
