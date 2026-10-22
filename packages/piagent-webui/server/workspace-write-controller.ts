import { createHash } from "node:crypto";
import { canonicalReviewValue } from "../../piagent-core/runtime/inspection/review-state-contract.ts";
import { WorkspaceWriteError } from "../../piagent-core/extensions/workspace-write.ts";
import type { Identity, WorkspaceWriteCommand, WorkspaceWritePayload, WorkspaceWriteReceipt, WorkspaceWriteState } from "../contracts/generated/workspace-write-v1.ts";

const VERSION = "piagent-webui-workspace-write-v1" as const;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = canonicalReviewValue;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const keys = (value: unknown, expected: string[]) => !!value && typeof value === "object" && !Array.isArray(value)
  && same(Object.keys(value).sort(), [...expected].sort());
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ref = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/.test(value);
export function workspaceWriteDigest(command: Pick<WorkspaceWriteCommand, "action" | "identity" | "expectedRevisions" | "payload">): string {
  return sha(canonical({ action: command.action, identity: command.identity, expectedRevisions: command.expectedRevisions, payload: command.payload }));
}
function parse(value: unknown): WorkspaceWriteCommand {
  const command = value as WorkspaceWriteCommand;
  if (!keys(value, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "action", "actionDigest", "identity", "expectedRevisions", "payload"])
    || command.schemaVersion !== 1 || command.version !== VERSION || command.messageType !== "command" || command.action !== "workspace.write"
    || !ref(command.commandId) || typeof command.idempotencyKey !== "string" || !/^[A-Za-z0-9._~-]{32,128}$/.test(command.idempotencyKey)
    || !timestamp(command.requestedAt) || !timestamp(command.expiresAt)
    || !keys(command.identity, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])
    || !keys(command.expectedRevisions, ["workspaceRevision"]) || typeof command.expectedRevisions.workspaceRevision !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/.test(command.expectedRevisions.workspaceRevision)
    || !keys(command.payload, ["path", "content", "expectedDigest"]) || typeof command.payload.path !== "string" || !command.payload.path || command.payload.path.length > 4096
    || typeof command.payload.content !== "string" || Buffer.byteLength(command.payload.content) > 1_048_576
    || typeof command.payload.expectedDigest !== "string" || !/^(absent|[a-f0-9]{64})$/.test(command.payload.expectedDigest)
    || command.actionDigest !== workspaceWriteDigest(command)) throw new Error("invalid-workspace-write-command");
  return command;
}
export type WorkspaceWriteFacts = { identity: Identity; writable: boolean; agentRunning: boolean };
export type WorkspaceWriteAdapterResult = { state: "saved"; digest: string } | { state: "rejected"; code: WorkspaceWriteError["code"]; currentDigest?: string | null };
type Options = {
  facts(): WorkspaceWriteFacts | Promise<WorkspaceWriteFacts>;
  // Gateway persistence owns receipts; successful saves mirror to the session.
  history(): WorkspaceWriteReceipt[];
  append(receipt: WorkspaceWriteReceipt): void | Promise<void>;
  write(payload: WorkspaceWritePayload): WorkspaceWriteAdapterResult | Promise<WorkspaceWriteAdapterResult>;
  now?(): Date;
};

export class WorkspaceWriteController {
  readonly #options: Options;
  #serial: Promise<unknown> = Promise.resolve();
  constructor(options: Options) { this.#options = options; }
  #revision(facts: WorkspaceWriteFacts, history: WorkspaceWriteReceipt[]): string {
    const last = [...history].reverse().find(receipt => receipt.phase === "settled" && receipt.resultCode === "saved"
      && receipt.identity.projectRef === facts.identity.projectRef && receipt.identity.sessionRef === facts.identity.sessionRef);
    return last?.observedRevisionsAfter.workspaceRevision ?? `workspace:${sha(canonical(facts.identity)).slice(7)}`;
  }
  async state(): Promise<WorkspaceWriteState> {
    const facts = await this.#options.facts();
    return { schemaVersion: 1, version: VERSION, messageType: "state", ...facts,
      revisions: { workspaceRevision: this.#revision(facts, this.#options.history()) } };
  }
  execute(value: unknown): Promise<WorkspaceWriteReceipt> {
    const command = parse(value);
    const run = this.#serial.then(() => this.#execute(command));
    this.#serial = run.catch(() => undefined); return run;
  }
  async #execute(command: WorkspaceWriteCommand): Promise<WorkspaceWriteReceipt> {
    const facts = await this.#options.facts(), history = this.#options.history();
    const key = sha(command.idempotencyKey), previous = [...history].reverse().find(receipt => receipt.idempotencyKeyDigest === key);
    const revisions = { workspaceRevision: this.#revision(facts, history) };
    const now = this.#options.now?.() ?? new Date();
    const receipt: WorkspaceWriteReceipt = { schemaVersion: 1, version: VERSION, messageType: "receipt", commandId: command.commandId,
      idempotencyKeyDigest: key, action: command.action, actionDigest: command.actionDigest, identity: facts.identity,
      phase: "rejected", resultCode: "write-failed", requestedAt: command.requestedAt, settledAt: now.toISOString(),
      observedRevisionsBefore: revisions, observedRevisionsAfter: revisions, path: command.payload.path, digest: null, currentDigest: null, deduplicated: false };
    const reject = (resultCode: WorkspaceWriteReceipt["resultCode"]) => ({ ...receipt, resultCode });
    if (previous && same(command.identity, previous.identity)
      && command.identity.projectRef === facts.identity.projectRef && command.identity.sessionRef === facts.identity.sessionRef) {
      if (previous.actionDigest !== command.actionDigest) return reject("idempotency-payload-mismatch");
      return { ...previous, deduplicated: true };
    }
    if (!same(command.identity, facts.identity)) return reject("identity-mismatch");
    if (previous) return reject("idempotency-payload-mismatch");
    const refuse = async (code: WorkspaceWriteReceipt["resultCode"]) => { const value = reject(code); await this.#options.append(value); return value; };
    if (Date.parse(command.expiresAt) < now.getTime() || Date.parse(command.requestedAt) > now.getTime() + 5000
      || Date.parse(command.expiresAt) <= Date.parse(command.requestedAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 120_000) return refuse("expired");
    if (!facts.writable) return refuse("read-only");
    if (!same(command.expectedRevisions, revisions)) return refuse("stale-revision");
    // Persist an uncertain receipt before dispatch. A crash must never replay a
    // possibly completed write, even when its completion was not recorded.
    const pending = { ...receipt, phase: "uncertain" as const, resultCode: "effect-unknown" as const };
    await this.#options.append(pending);
    let settled: WorkspaceWriteReceipt;
    try {
      const current = await this.#options.facts();
      if (!same(current.identity, facts.identity)) settled = reject("identity-mismatch");
      else if (!current.writable) settled = reject("read-only");
      else if (Date.parse(command.expiresAt) < (this.#options.now?.() ?? new Date()).getTime()) settled = reject("expired");
      else {
        const result = await this.#options.write(command.payload);
        settled = result.state === "saved" ? { ...receipt, phase: "settled", resultCode: "saved", digest: result.digest,
          observedRevisionsAfter: { workspaceRevision: `workspace:${key.slice(7)}` } }
          : { ...receipt, resultCode: result.code, currentDigest: result.currentDigest ?? null };
      }
    } catch (error) {
      // The live personal guard may be loaded by Pi's TS loader, with a
      // different Error constructor than native ESM. Validate its bounded code.
      const failure = error as WorkspaceWriteError | undefined;
      settled = (error instanceof WorkspaceWriteError || failure?.name === "WorkspaceWriteError")
        && ["invalid-write", "path-protected", "read-only", "stale-content", "unsafe-path"].includes(failure!.code)
        ? { ...receipt, resultCode: failure!.code, currentDigest: failure!.currentDigest ?? null } : pending;
    }
    settled.settledAt = (this.#options.now?.() ?? new Date()).toISOString();
    try { await this.#options.append(settled); } catch { return pending; }
    return settled;
  }
}
