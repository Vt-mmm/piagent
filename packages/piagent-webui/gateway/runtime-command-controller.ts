import { createHash } from "node:crypto";

import {
  WEBUI_RUNTIME_ACTIONS,
  buildWebUiRuntimeCommand,
  isWebUiRuntimeActionId
} from "../../piagent-core/runtime/workflows/webui-runtime-command.ts";
import {
  PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE,
  parseServiceTierReceipt
} from "../../piagent-core/runtime/model/service-tier-runtime.ts";
import type { Catalog } from "../contracts/generated/session-catalog-v1.ts";
import type { Action, Command, Output, Receipt } from "../contracts/generated/runtime-command-v1.ts";
import { GatewayEventStore } from "./gateway-events.ts";
import { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const MAX_REPLAYS = 200;

type Replay = { digest: string; receipt: Receipt };
type FastControlAssessment = Pick<Receipt, "state" | "resultCode" | "reasonCode">;

const FAST_ACTIONS = new Set<Action>(["runtime.fast-status", "runtime.fast-on", "runtime.fast-off"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCommand(value: unknown): Command | null {
  if (!record(value)) return null;
  const expected = ["schemaVersion", "version", "messageType", "requestId", "sessionRef", "expectedSessionRevision", "action", "argument", "confirmed"];
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !keys.every((key) => expected.includes(key))) return null;
  if (value.schemaVersion !== 1 || value.version !== "piagent-runtime-command-v1" || value.messageType !== "command"
    || typeof value.requestId !== "string" || !REF.test(value.requestId)
    || typeof value.sessionRef !== "string" || !REF.test(value.sessionRef)
    || typeof value.expectedSessionRevision !== "string" || !REVISION.test(value.expectedSessionRevision)
    || !isWebUiRuntimeActionId(value.action)
    || !(value.argument === null || typeof value.argument === "string" && value.argument.length <= 2_048 && !value.argument.includes("\0"))
    || typeof value.confirmed !== "boolean") return null;
  return value as unknown as Command;
}

function commandDigest(command: Command): string {
  return createHash("sha256").update(JSON.stringify({ sessionRef: command.sessionRef,
    expectedSessionRevision: command.expectedSessionRevision, action: command.action,
    argument: command.argument, confirmed: command.confirmed })).digest("hex");
}

function normalizedOutputs(value: unknown): Receipt["outputs"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    if (!record(item)) return item;
    const { details: _details, ...base } = item;
    if (item.customType !== PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE) return base;
    const details = parseServiceTierReceipt(item.details);
    return details ? { ...base, details } : base;
  }) as Receipt["outputs"];
}

function assessFastControl(action: Action, outputs: readonly Output[]): FastControlAssessment | null {
  if (!FAST_ACTIONS.has(action)) return null;
  const candidates = outputs.filter((output) => output.customType === PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE);
  if (candidates.length === 0) return { state: "uncertain", resultCode: "effect-unknown", reasonCode: "fast-service-tier-receipt-missing" };
  if (candidates.length !== 1) return { state: "uncertain", resultCode: "effect-unknown", reasonCode: "fast-service-tier-receipt-ambiguous" };
  const details = parseServiceTierReceipt(candidates[0]?.details);
  if (!details) return { state: "uncertain", resultCode: "effect-unknown", reasonCode: "fast-service-tier-receipt-invalid" };
  if (action === "runtime.fast-on" && !details.enabled || action === "runtime.fast-off" && details.enabled) {
    return { state: "uncertain", resultCode: "effect-unknown", reasonCode: "fast-service-tier-receipt-state-mismatch" };
  }
  if (details.reasonCode === "provider-not-supported") {
    return { state: "rejected", resultCode: "unavailable", reasonCode: "provider-not-supported" };
  }
  return { state: "settled", resultCode: "completed", reasonCode: null };
}

export class RuntimeCommandController {
  readonly #catalog: () => Promise<Catalog>;
  readonly #runtimes: SessionRuntimeSupervisor;
  readonly #events: GatewayEventStore;
  readonly #replays = new Map<string, Replay>();
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(options: { catalog(): Promise<Catalog>; runtimes: SessionRuntimeSupervisor; events: GatewayEventStore }) {
    this.#catalog = options.catalog;
    this.#runtimes = options.runtimes;
    this.#events = options.events;
  }

  execute(input: unknown): Promise<Receipt> {
    const command = parseCommand(input);
    if (!command) return Promise.reject(new Error("runtime-command-invalid"));
    const prior = this.#chains.get(command.sessionRef) ?? Promise.resolve();
    const run = prior.then(() => this.#execute(command), () => this.#execute(command));
    const tail = run.catch(() => undefined);
    this.#chains.set(command.sessionRef, tail);
    return run.finally(() => { if (this.#chains.get(command.sessionRef) === tail) this.#chains.delete(command.sessionRef); });
  }

  async #execute(command: Command): Promise<Receipt> {
    const digest = commandDigest(command), replay = this.#replays.get(command.requestId);
    if (replay) {
      if (replay.digest !== digest) return this.#receipt(command, "rejected", "invalid-command", "idempotency-payload-mismatch");
      return replay.receipt;
    }
    const catalog = await this.#readyCatalog();
    const row = catalog.sessions.find((session) => session.sessionRef === command.sessionRef);
    if (!row || row.archived) return this.#settle(command, digest,
      this.#receipt(command, "rejected", "unavailable", row ? "session-archived" : "session-not-found"));
    if (row.sessionRevision !== command.expectedSessionRevision) return this.#settle(command, digest,
      this.#receipt(command, "rejected", "stale-revision", "session-revision-stale", row.sessionRevision));

    let built: ReturnType<typeof buildWebUiRuntimeCommand>;
    try { built = buildWebUiRuntimeCommand({ action: command.action, argument: command.argument, confirmed: command.confirmed }); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "runtime-command-invalid";
      return this.#settle(command, digest, this.#receipt(command, "rejected",
        reason === "runtime-command-confirmation-required" ? "confirmation-required" : "invalid-command", reason, row.sessionRevision));
    }

    try {
      const result = await this.#runtimes.runRuntimeCommand(command.sessionRef, built.command);
      const after = await this.#readyCatalog();
      const afterRow = after.sessions.find((session) => session.sessionRef === command.sessionRef);
      const outputs = normalizedOutputs(result.outputs);
      const fastControl = assessFastControl(command.action, outputs);
      const zeroTurnExpected = built.spec.effect === "read-only" || built.spec.effect === "session-setting";
      const zeroTurnViolation = zeroTurnExpected && result.modelCallObserved;
      const zeroTurnReason = built.spec.effect === "session-setting"
        ? "session-setting-command-started-model-call"
        : "read-only-command-started-model-call";
      const receipt = this.#receipt(command, zeroTurnViolation ? "uncertain" : fastControl?.state ?? "settled",
        zeroTurnViolation ? "effect-unknown" : fastControl?.resultCode ?? "completed",
        zeroTurnViolation ? zeroTurnReason : fastControl?.reasonCode ?? null,
        afterRow?.sessionRevision ?? null, result.modelCallObserved, outputs);
      this.#events.publish("session.changed", { catalogRevision: after.catalogRevision, session: afterRow ?? row });
      return this.#settle(command, digest, receipt);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "runtime-command-unavailable";
      const resultCode = reason.includes("busy") ? "runtime-busy" : "unavailable";
      return this.#settle(command, digest,
        this.#receipt(command, "rejected", resultCode, reason, row.sessionRevision));
    }
  }

  async #readyCatalog(): Promise<Catalog> {
    const catalog = await this.#catalog();
    if (catalog.state !== "ready" || !catalog.catalogRevision) throw new Error(catalog.reasonCode ?? "catalog-unavailable");
    return catalog;
  }

  #receipt(command: Command, state: Receipt["state"], resultCode: Receipt["resultCode"], reasonCode: string | null,
    sessionRevisionAfter: string | null = null, modelCallObserved = false, outputs: Receipt["outputs"] = []): Receipt {
    const spec = WEBUI_RUNTIME_ACTIONS.find((item) => item.id === command.action)!;
    return { schemaVersion: 1, version: "piagent-runtime-receipt-v1", messageType: "receipt",
      requestId: command.requestId, sessionRef: command.sessionRef, action: command.action as Action,
      state, resultCode, effect: spec.effect, modelCallObserved, outputs, sessionRevisionAfter, reasonCode };
  }

  #settle(command: Command, digest: string, receipt: Receipt): Receipt {
    this.#replays.set(command.requestId, { digest, receipt });
    while (this.#replays.size > MAX_REPLAYS) this.#replays.delete(this.#replays.keys().next().value as string);
    return receipt;
  }
}
