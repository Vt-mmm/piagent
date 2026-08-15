import { randomBytes } from "node:crypto";

import type { Catalog, SessionRow } from "../contracts/generated/session-catalog-v1.ts";
import type { Receipt } from "../contracts/generated/session-command-v1.ts";
import { GatewayEventStore } from "./gateway-events.ts";
import { SessionCommandStore, type SessionAction, type SessionCommandIdentity } from "./session-command-store.ts";
import { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";
import { SessionMetadataStore } from "./session-metadata-store.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{22,96}$/;
const ACTIONS: SessionAction[] = ["session.create", "session.send", "session.abort", "session.set-model", "session.set-thinking", "session.set-permission", "session.rename", "session.pin", "session.archive",
  "session.unarchive", "session.fork", "session.acquire", "session.release"];

type SessionCommand = SessionCommandIdentity & {
  schemaVersion: 1;
  version: "piagent-session-command-v1";
  messageType: "command";
  expiresAt: string;
  expectedCatalogRevision: string;
  expectedSessionRevision: string | null;
  payload: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const found = Object.keys(value); return found.length === keys.length && found.every((key) => keys.includes(key));
}
function exactTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function nullableRef(value: unknown): value is string | null { return value === null || typeof value === "string" && REF.test(value); }

function validPayload(action: SessionAction, payload: Record<string, unknown>): boolean {
  if (["session.archive", "session.unarchive", "session.acquire", "session.release"].includes(action)) return exactKeys(payload, []);
  if (action === "session.send") return exactKeys(payload, ["delivery", "message", "messageRequestId", "expectedOperationRef"])
    && ["new-operation", "follow-up", "steer"].includes(String(payload.delivery)) && typeof payload.message === "string"
    && payload.message.length >= 1 && payload.message.length <= 32_768 && !payload.message.includes("\0") && REF.test(String(payload.messageRequestId))
    && nullableRef(payload.expectedOperationRef) && (payload.delivery === "new-operation" ? payload.expectedOperationRef === null : payload.expectedOperationRef !== null);
  if (action === "session.abort") return exactKeys(payload, ["operationRef", "clearQueued"])
    && REF.test(String(payload.operationRef)) && typeof payload.clearQueued === "boolean";
  if (action === "session.set-model") return exactKeys(payload, ["modelRef"]) && REF.test(String(payload.modelRef));
  if (action === "session.set-thinking") return exactKeys(payload, ["thinkingLevel"])
    && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(payload.thinkingLevel));
  if (action === "session.set-permission") return exactKeys(payload, ["permissionMode"])
    && ["read-only", "workspace-write", "trusted-full-access"].includes(String(payload.permissionMode));
  if (action === "session.rename") return exactKeys(payload, ["title"]) && typeof payload.title === "string"
    && payload.title.length >= 1 && payload.title.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.title);
  if (action === "session.pin") return exactKeys(payload, ["pinned"]) && typeof payload.pinned === "boolean";
  if (action === "session.fork") return exactKeys(payload, ["entryRef", "title"]) && nullableRef(payload.entryRef)
    && (payload.title === null || typeof payload.title === "string" && payload.title.length >= 1 && payload.title.length <= 500
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.title));
  return exactKeys(payload, ["projectRef", "placeRef", "modelRef", "thinkingLevel", "message", "messageRequestId"])
    && REF.test(String(payload.projectRef)) && REF.test(String(payload.placeRef)) && nullableRef(payload.modelRef)
    && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(payload.thinkingLevel))
    && typeof payload.message === "string" && payload.message.length >= 1 && payload.message.length <= 32_768 && !payload.message.includes("\0")
    && REF.test(String(payload.messageRequestId));
}

function parseCommand(value: unknown): SessionCommand | null {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "action",
    "requestedAt", "expiresAt", "sessionRef", "expectedCatalogRevision", "expectedSessionRevision", "payload"])) return null;
  const action = value.action as SessionAction;
  if (value.schemaVersion !== 1 || value.version !== "piagent-session-command-v1" || value.messageType !== "command"
    || typeof value.commandId !== "string" || !REF.test(value.commandId) || typeof value.idempotencyKey !== "string" || !IDEMPOTENCY.test(value.idempotencyKey)
    || !ACTIONS.includes(action) || !exactTimestamp(value.requestedAt) || !exactTimestamp(value.expiresAt)
    || Date.parse(value.requestedAt) > Date.parse(value.expiresAt) || Date.parse(value.expiresAt) - Date.parse(value.requestedAt) > 300_000
    || !nullableRef(value.sessionRef) || typeof value.expectedCatalogRevision !== "string" || !REVISION.test(value.expectedCatalogRevision)
    || !(value.expectedSessionRevision === null || typeof value.expectedSessionRevision === "string" && REVISION.test(value.expectedSessionRevision))
    || !record(value.payload) || !validPayload(action, value.payload)) return null;
  if (action === "session.create") {
    if (value.sessionRef !== null || value.expectedSessionRevision !== null) return null;
  } else if (value.sessionRef === null || value.expectedSessionRevision === null) return null;
  return value as SessionCommand;
}

function error(code: string, message: string) { return { code, message }; }

export class SessionCommandController {
  readonly #catalog: () => Promise<Catalog>;
  readonly #runtimes: SessionRuntimeSupervisor;
  readonly #store: SessionCommandStore;
  readonly #events: GatewayEventStore;
  readonly #metadata: SessionMetadataStore | null;
  readonly #now: () => Date;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(options: { catalog(): Promise<Catalog>; runtimes: SessionRuntimeSupervisor; store: SessionCommandStore; events: GatewayEventStore;
    metadata?: SessionMetadataStore;
    now?: () => Date }) {
    this.#catalog = options.catalog; this.#runtimes = options.runtimes; this.#store = options.store; this.#events = options.events;
    this.#metadata = options.metadata ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  execute(input: unknown): Promise<Receipt> {
    const command = parseCommand(input);
    if (!command) return Promise.reject(new Error("invalid-session-command"));
    const key = command.sessionRef ?? "session-create";
    const prior = this.#chains.get(key) ?? Promise.resolve();
    const run = prior.then(() => this.#execute(command), () => this.#execute(command));
    const tail = run.catch(() => undefined);
    this.#chains.set(key, tail);
    return run.finally(() => { if (this.#chains.get(key) === tail) this.#chains.delete(key); });
  }

  async #execute(command: SessionCommand): Promise<Receipt> {
    const current = await this.#readyCatalog(), row = command.sessionRef ? current.sessions.find((item) => item.sessionRef === command.sessionRef) : null;
    const replay = this.#store.lookup(command);
    if (replay.state === "settled") return { ...replay.receipt!, deduplicated: true };
    if (replay.state === "conflict") return this.#rejected(command, current, row, "invalid-command", "idempotency-payload-mismatch");
    if (replay.state === "unavailable") return this.#rejected(command, current, row, "unavailable", "session-command-journal-unavailable");
    if (replay.state === "pending") {
      const uncertain = this.#uncertain(command, current, row, "session-command-effect-unknown");
      try { this.#store.settle(command, uncertain, this.#now()); } catch { /* returning uncertainty is still safer than replay */ }
      return uncertain;
    }
    const now = this.#now().getTime();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#rejected(command, current, row, "invalid-command", "requested-at-in-future");
    if (now > Date.parse(command.expiresAt)) return this.#rejected(command, current, row, "expired", "session-command-expired");
    const stale = command.expectedCatalogRevision !== current.catalogRevision || (command.action === "session.create"
      ? command.expectedSessionRevision !== null : !row || command.expectedSessionRevision !== row.sessionRevision);
    if (stale) {
      return this.#rejected(command, current, row, "stale-revision", "session-revision-stale");
    }
    if (row?.archived && command.action !== "session.unarchive") return this.#rejected(command, current, row, "unavailable", "session-archived");
    try { this.#store.admit(command, this.#now()); }
    catch { return this.#rejected(command, current, row, "unavailable", "session-command-admission-failed"); }
    let targetSessionRef = command.sessionRef;
    try {
      let resultCode: "acquired" | "released" | "started" | "queued" | "steered" | "aborted" | "model-changed" | "thinking-changed" | "permission-changed"
        | "renamed" | "pinned" | "unpinned" | "archived" | "unarchived" | "forked" | "no-change",
        operationRef: string | null = null;
      if (command.action === "session.create") {
        targetSessionRef = await this.#runtimes.create(String(command.payload.projectRef), String(command.payload.placeRef),
          command.payload.modelRef === null ? null : String(command.payload.modelRef), String(command.payload.thinkingLevel));
        const created = await this.#readyCatalog(), createdRow = created.sessions.find((item) => item.sessionRef === targetSessionRef);
        if (!createdRow) throw new Error("session-catalog-refresh-failed");
        const sent = await this.#runtimes.send(targetSessionRef, { delivery: "new-operation", message: String(command.payload.message),
          expectedOperationRef: null }, createdRow.sessionRevision);
        resultCode = sent.resultCode === "started" ? "started" : sent.resultCode; operationRef = sent.operationRef;
      } else if (command.action === "session.acquire") { await this.#runtimes.acquire(command.sessionRef!); resultCode = "acquired"; }
      else if (command.action === "session.release") { await this.#runtimes.release(command.sessionRef!); resultCode = "released"; }
      else if (command.action === "session.send") {
        await this.#runtimes.acquire(command.sessionRef!);
        const acquired = await this.#readyCatalog(), acquiredRow = acquired.sessions.find((item) => item.sessionRef === command.sessionRef);
        if (!acquiredRow) throw new Error("session-catalog-refresh-failed");
        const sent = await this.#runtimes.send(command.sessionRef!, command.payload as {
          delivery: "new-operation" | "follow-up" | "steer"; message: string; expectedOperationRef: string | null
        }, acquiredRow.sessionRevision);
        resultCode = sent.resultCode; operationRef = sent.operationRef;
      } else if (command.action === "session.abort") {
        operationRef = String(command.payload.operationRef);
        await this.#runtimes.abort(command.sessionRef!, operationRef, command.payload.clearQueued === true);
        resultCode = "aborted";
      } else if (command.action === "session.set-model") {
        resultCode = await this.#runtimes.setModel(command.sessionRef!, String(command.payload.modelRef));
      } else if (command.action === "session.set-thinking") {
        resultCode = await this.#runtimes.setThinking(command.sessionRef!, String(command.payload.thinkingLevel));
      } else if (command.action === "session.set-permission") {
        resultCode = await this.#runtimes.setPermission(command.sessionRef!, String(command.payload.permissionMode) as
          "read-only" | "workspace-write" | "trusted-full-access");
      } else if (command.action === "session.rename") {
        resultCode = await this.#runtimes.rename(command.sessionRef!, String(command.payload.title).trim());
      } else if (command.action === "session.fork") {
        targetSessionRef = await this.#runtimes.fork(command.sessionRef!, command.payload.entryRef === null ? null : String(command.payload.entryRef),
          command.payload.title === null ? null : String(command.payload.title).trim());
        resultCode = "forked";
      } else {
        if (!this.#metadata) throw new Error("session-metadata-unavailable");
        if (command.action === "session.archive") await this.#runtimes.release(command.sessionRef!);
        const snapshot = this.#metadata.read();
        if (snapshot.state !== "ready") throw new Error(snapshot.reasonCode ?? "session-metadata-unavailable");
        const prior = snapshot.sessions.get(command.sessionRef!), expected = prior?.revision ?? null;
        if (command.action === "session.pin") {
          const pinned = command.payload.pinned === true;
          if ((prior?.pinned ?? false) === pinned) resultCode = "no-change";
          else { this.#metadata.update(command.sessionRef!, expected, { pinned }, this.#now()); resultCode = pinned ? "pinned" : "unpinned"; }
        } else if (command.action === "session.archive") {
          if (prior?.archived) resultCode = "no-change";
          else { this.#metadata.update(command.sessionRef!, expected, { archived: true }, this.#now()); resultCode = "archived"; }
        } else {
          if (!prior?.archived) resultCode = "no-change";
          else { this.#metadata.update(command.sessionRef!, expected, { archived: false }, this.#now()); resultCode = "unarchived"; }
        }
      }
      const after = await this.#readyCatalog(), afterRow = after.sessions.find((item) => item.sessionRef === targetSessionRef);
      if (!afterRow) throw new Error("session-catalog-refresh-failed");
      const receipt = this.#settled(command, after, afterRow, resultCode, operationRef);
      try { this.#store.settle(command, receipt, this.#now()); }
      catch { return this.#uncertain(command, after, afterRow, "session-command-settlement-not-durable"); }
      this.#events.publish("session.changed", { catalogRevision: after.catalogRevision, session: afterRow });
      return receipt;
    } catch (cause) {
      const after = await this.#readyCatalog(), afterRow = after.sessions.find((item) => item.sessionRef === targetSessionRef) ?? row;
      const code = cause instanceof Error && /recovery/.test(cause.message) ? "recovery-required"
        : cause instanceof Error && /(owner-conflict|operation-conflict|runtime-busy)/.test(cause.message) ? "owner-conflict" : "effect-unknown";
      const receipt = code === "effect-unknown" ? this.#uncertain(command, after, afterRow, "session-command-effect-unknown")
        : this.#rejected(command, after, afterRow, code, cause instanceof Error ? cause.message : "session-command-failed");
      try { this.#store.settle(command, receipt, this.#now()); } catch { /* intent remains uncertain */ }
      return receipt;
    }
  }

  async #readyCatalog(): Promise<Catalog> {
    const catalog = await this.#catalog();
    if (catalog.state !== "ready" || !catalog.catalogRevision) throw new Error(catalog.reasonCode ?? "catalog-unavailable");
    return catalog;
  }

  #base(command: SessionCommand, catalog: Catalog, row: SessionRow | null) {
    return { schemaVersion: 1 as const, version: "piagent-session-receipt-v1" as const, messageType: "receipt" as const,
      commandId: command.commandId, idempotencyKeyDigest: this.#store.idempotencyDigest(command.idempotencyKey), action: command.action,
      requestedAt: command.requestedAt, sessionRef: command.action === "session.create" || command.action === "session.fork"
        ? row?.sessionRef ?? null : command.sessionRef,
      operationRef: null, catalogRevisionAfter: catalog.catalogRevision!,
      sessionRevisionAfter: row?.sessionRevision ?? null, deduplicated: false };
  }
  #settled(command: SessionCommand, catalog: Catalog, row: SessionRow,
    resultCode: "acquired" | "released" | "started" | "queued" | "steered" | "aborted" | "model-changed" | "thinking-changed" | "permission-changed"
      | "renamed" | "pinned" | "unpinned" | "archived" | "unarchived" | "forked" | "no-change",
    operationRef: string | null): Receipt {
    return { ...this.#base(command, catalog, row), operationRef, phase: "settled", resultCode, settledAt: this.#now().toISOString(),
      evidenceRef: `evidence_${randomBytes(24).toString("base64url")}`, error: null };
  }
  #uncertain(command: SessionCommand, catalog: Catalog, row: SessionRow | null, code: string): Receipt {
    return { ...this.#base(command, catalog, row), phase: "uncertain", resultCode: "effect-unknown", settledAt: this.#now().toISOString(),
      evidenceRef: null, error: error(code, "The command effect cannot be proven. It will not be replayed automatically.") };
  }
  #rejected(command: SessionCommand, catalog: Catalog, row: SessionRow | null,
    resultCode: "stale-revision" | "owner-conflict" | "recovery-required" | "invalid-command" | "expired" | "unavailable", code: string): Receipt {
    return { ...this.#base(command, catalog, row), phase: "rejected", resultCode, settledAt: this.#now().toISOString(), evidenceRef: null,
      error: error(code.replace(/[^a-z0-9.-]/g, "-").slice(0, 96) || "session-command-rejected", "The session command was rejected.") };
  }
}
