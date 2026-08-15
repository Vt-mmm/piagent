import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";
import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { controlActionDigest, type BridgeIdentity, type BridgeRevisions, type SameSessionPiBridge,
  type SessionOptionMutationPermit } from "./same-session-bridge.ts";

export const WEBUI_SESSION_OPTION_ENTRY_TYPE = "piagent-webui-session-option-v1";
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const PUBLIC_REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{32,128}$/;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING[number];
type SessionOptionAction = "session-options.set-model" | "session-options.set-thinking";
type ModelLike = { provider?: unknown; id?: unknown; name?: unknown; reasoning?: unknown; input?: unknown; thinkingLevelMap?: unknown;
  contextWindow?: unknown; maxTokens?: unknown };
type Command = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "command"; commandId: string; idempotencyKey: string;
  requestedAt: string; expiresAt: string; capabilityScope: "control.sessionOptions"; action: SessionOptionAction; actionDigest: string;
  identity: BridgeIdentity; expectedRevisions: BridgeRevisions & { workspacePreimage: null; indexPreimage: null; patchPreimage: null };
  payload: { effectScopeAcknowledged: "session-and-user-default"; modelRef?: string; thinkingLevel?: ThinkingLevel };
};
export type SessionOptionReceipt = {
  schemaVersion: 1; version: "piagent-webui-control-v1"; messageType: "receipt"; commandId: string; idempotencyKeyDigest: string;
  action: SessionOptionAction; actionDigest: string; identity: BridgeIdentity; phase: "settled" | "rejected" | "uncertain";
  resultCode: "changed" | "unchanged" | "effect-unknown" | "stale-revision" | "identity-mismatch" | "capability-unavailable"
    | "replay" | "idempotency-payload-mismatch" | "expired" | "invalid-command" | "resync-required";
  requestedAt: string; settledAt: string; observedRevisionsBefore: BridgeRevisions; observedRevisionsAfter: BridgeRevisions;
  deduplicated: boolean; auditRef: null; settlementEvidenceRef: string | null;
  error: { code: string; message: string; retryable: false } | null;
};
type CatalogModel = { modelRef: string; provider: string; modelId: string; displayName: string; reasoning: boolean;
  inputCapabilities: Array<"text" | "image">; supportedThinkingLevels: ThinkingLevel[]; contextWindow: number; maxOutputTokens: number };

function sha(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function exactKeys(value: unknown, keys: string[]): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && same(Object.keys(value as object).sort(), [...keys].sort()));
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function copy<T>(value: T): T { return structuredClone(value); }
function validIdentity(value: unknown): value is BridgeIdentity {
  if (!exactKeys(value, ["projectRef", "runtimeInstanceId", "sessionRef", "taskId", "taskRunId", "agentOperationId", "toolCallId"])) return false;
  const identity = value as BridgeIdentity;
  return [identity.projectRef, identity.runtimeInstanceId, identity.sessionRef].every((item) => typeof item === "string" && REF.test(item))
    && [identity.taskId, identity.taskRunId].every((item) => item === null || PUBLIC_REF.test(item))
    && (identity.taskRunId === null || identity.taskId !== null) && (identity.agentOperationId === null || REF.test(identity.agentOperationId))
    && identity.toolCallId === null;
}
function validRevisions(value: unknown): value is Command["expectedRevisions"] {
  if (!exactKeys(value, ["runtimeRevision", "taskRevision", "controlRevision", "workspaceRevision", "indexRevision", "approvalRevision",
    "sessionOptionRevision", "queueRevision", "workspacePreimage", "indexPreimage", "patchPreimage"])) return false;
  const revisions = value as Command["expectedRevisions"];
  return REVISION.test(revisions.runtimeRevision) && [revisions.taskRevision, revisions.controlRevision, revisions.workspaceRevision,
    revisions.indexRevision, revisions.approvalRevision, revisions.sessionOptionRevision, revisions.queueRevision]
    .every((item) => item === null || REVISION.test(item)) && revisions.workspacePreimage === null && revisions.indexPreimage === null
    && revisions.patchPreimage === null;
}
function safeName(value: unknown, fallback: string): string {
  return redactSensitiveText(String(value ?? fallback)).text.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || fallback;
}
function safePublicId(value: unknown): string | null {
  if (typeof value !== "string" || !PUBLIC_REF.test(value)) return null;
  return redactSensitiveText(value).redacted ? null : value;
}
function positive(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100_000_000 ? Number(value) : null;
}
function thinkingLevels(model: ModelLike): ThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  const mapping = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap as Record<string, unknown> : {};
  const levels = THINKING.filter((level) => mapping[level] !== null && !(["xhigh", "max"].includes(level) && mapping[level] === undefined));
  return levels.length ? [...levels] : ["off"];
}
function catalogModel(value: ModelLike): CatalogModel | null {
  const provider = safePublicId(value.provider), modelId = safePublicId(value.id);
  const contextWindow = positive(value.contextWindow), maxOutputTokens = positive(value.maxTokens);
  if (!provider || !modelId || typeof value.reasoning !== "boolean" || !contextWindow || !maxOutputTokens) return null;
  const inputCapabilities = Array.isArray(value.input) ? [...new Set(value.input.filter((item): item is "text" | "image" => item === "text" || item === "image"))] : [];
  return { modelRef: webUiModelRef(provider, modelId), provider, modelId, displayName: safeName(value.name, modelId), reasoning: value.reasoning,
    inputCapabilities, supportedThinkingLevels: thinkingLevels(value), contextWindow, maxOutputTokens };
}

export class SessionOptionsController {
  readonly #pi: ExtensionAPI;
  readonly #bridge: SameSessionPiBridge;
  readonly #now: () => Date;
  #ctx: ExtensionContext | null = null;
  #models = new Map<string, ModelLike>();
  #receiptsByKey = new Map<string, SessionOptionReceipt>();
  #receiptsByCommand = new Map<string, SessionOptionReceipt>();
  #serial: Promise<unknown> = Promise.resolve();
  readonly #hostMutation = new AsyncLocalStorage<symbol>();
  #activeHostMutation: symbol | null = null;

  constructor(options: { pi: ExtensionAPI; bridge: SameSessionPiBridge; now?: () => Date }) {
    this.#pi = options.pi; this.#bridge = options.bridge; this.#now = options.now ?? (() => new Date());
  }
  bind(ctx: ExtensionContext): void { this.#ctx = ctx; this.#models.clear(); this.#receiptsByKey.clear(); this.#receiptsByCommand.clear(); }
  refresh(ctx: ExtensionContext): void { if (this.#bridge.refresh(ctx)) this.#ctx = ctx; }
  observeHostOptionChange(ctx: ExtensionContext): void {
    const causal = this.#activeHostMutation !== null && this.#hostMutation.getStore() === this.#activeHostMutation;
    this.#bridge.observeSessionOptionChange(ctx, causal); this.refresh(ctx);
  }
  reset(): void { this.#ctx = null; this.#models.clear(); this.#receiptsByKey.clear(); this.#receiptsByCommand.clear(); }

  catalog(): Record<string, unknown> {
    const snapshot = this.#bridge.snapshot();
    if (!this.#ctx || snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions) throw new Error("webui-session-options-binding-unavailable");
    const values = this.#availableModels(this.#ctx), projected: CatalogModel[] = []; this.#models.clear();
    for (const value of values.slice(0, 300)) {
      const model = catalogModel(value); if (!model || this.#models.has(model.modelRef)) continue;
      this.#models.set(model.modelRef, value); projected.push(model);
    }
    projected.sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`));
    const active = catalogModel(this.#ctx.model as ModelLike), thinking = this.#currentThinking();
    const ready = Boolean(active && this.#models.has(active.modelRef) && THINKING.includes(thinking as ThinkingLevel) && projected.length);
    return { schemaVersion: 1, version: "piagent-webui-model-catalog-v1", generatedAt: this.#now().toISOString(), identity: snapshot.identity,
      revision: snapshot.revisions, state: ready ? "ready" : "unavailable",
      catalogScope: ready ? (this.#ctx.scopedModels.length ? "session-scoped" : "authenticated-all") : "unavailable",
      effectScope: "session-and-user-default", activeModelRef: ready ? active!.modelRef : null, activeThinkingLevel: ready ? thinking : null,
      models: ready ? projected : [], reasonCode: ready ? null : "authenticated-model-catalog-unavailable" };
  }

  execute(input: unknown): Promise<SessionOptionReceipt> {
    const run = this.#serial.then(() => this.#execute(input), () => this.#execute(input)); this.#serial = run.catch(() => undefined); return run;
  }

  async #execute(input: unknown): Promise<SessionOptionReceipt> {
    const command = input as Command, snapshot = this.#bridge.snapshot(), structural = this.#validate(command);
    if (!this.#ctx || snapshot.state !== "ready" || !snapshot.identity || !snapshot.revisions)
      return this.#reject(command, "resync-required", "session-options-binding-not-ready", "The current Pi session option binding is unavailable.");
    if (structural) return this.#reject(command, "invalid-command", structural, "The session option command is invalid.");
    const keyDigest = sha(command.idempotencyKey), old = this.#receiptsByKey.get(keyDigest) ?? this.#receiptsByCommand.get(command.commandId);
    if (old) {
      if (old.commandId !== command.commandId || old.actionDigest !== command.actionDigest || old.idempotencyKeyDigest !== keyDigest)
        return this.#reject(command, "idempotency-payload-mismatch", "idempotency-payload-mismatch", "The command key is bound to another option change.");
      return { ...copy(old), deduplicated: true };
    }
    const now = this.#now().getTime();
    if (Date.parse(command.requestedAt) > now + 30_000) return this.#reject(command, "invalid-command", "requested-at-in-future", "The command timestamp is not yet valid.");
    if (now > Date.parse(command.expiresAt)) return this.#reject(command, "expired", "command-expired", "The command expired before execution.");
    if (!same(command.identity, snapshot.identity)) return this.#reject(command, "identity-mismatch", "identity-mismatch", "The command targets another Pi session.");
    if (!["runtimeRevision", "taskRevision", "controlRevision", "sessionOptionRevision"].every((key) =>
      (command.expectedRevisions as any)[key] === (snapshot.revisions as any)[key]))
      return this.#reject(command, "stale-revision", "stale-revision", "The Pi session option state changed before execution.");
    if (snapshot.liveness !== "idle" || !this.#ctx.isIdle() || snapshot.identity.agentOperationId)
      return this.#reject(command, "capability-unavailable", "agent-not-idle", "Model and thinking can change only while Pi is idle.");
    this.catalog();
    const permit = this.#bridge.beginSessionOptionMutation(), ctx = this.#ctx;
    if (!permit) return this.#reject(command, "capability-unavailable", "session-option-linearization-unavailable", "Pi is no longer at an idle option-change boundary.");
    try { return command.action === "session-options.set-model" ? await this.#setModel(command, ctx, permit) : this.#setThinking(command, ctx, permit); }
    finally { permit.release(); }
  }

  async #setModel(command: Command, ctx: ExtensionContext, permit: SessionOptionMutationPermit): Promise<SessionOptionReceipt> {
    const model = this.#models.get(command.payload.modelRef!);
    if (!model) return this.#reject(command, "capability-unavailable", "model-not-selectable", "The selected model is not in the authenticated Pi catalog.");
    const beforeRef = catalogModel(ctx.model as ModelLike)?.modelRef ?? null;
    let result: "changed" | "unchanged" | "effect-unknown" = beforeRef === command.payload.modelRef ? "unchanged" : "changed";
    if (result === "changed") {
      const token = Symbol("webui-session-option"); this.#activeHostMutation = token;
      try {
        const accepted = await this.#hostMutation.run(token, () => this.#pi.setModel(model as any));
        const actual = catalogModel(ctx.model as ModelLike)?.modelRef ?? null;
        if (!accepted || actual !== command.payload.modelRef) result = "effect-unknown";
      } catch { result = "effect-unknown"; } finally { this.#activeHostMutation = null; }
    }
    return this.#settle(command, result, permit);
  }

  #setThinking(command: Command, ctx: ExtensionContext, permit: SessionOptionMutationPermit): SessionOptionReceipt {
    const target = command.payload.thinkingLevel!, active = catalogModel(ctx.model as ModelLike);
    if (!active?.supportedThinkingLevels.includes(target))
      return this.#reject(command, "capability-unavailable", "thinking-level-not-supported", "The active model does not support this thinking level.");
    const before = this.#thinkingFor(ctx); let result: "changed" | "unchanged" | "effect-unknown" = before === target ? "unchanged" : "changed";
    if (result === "changed") {
      const token = Symbol("webui-session-option"); this.#activeHostMutation = token;
      try { this.#hostMutation.run(token, () => this.#pi.setThinkingLevel(target as any)); if (this.#thinkingFor(ctx) !== target) result = "effect-unknown"; }
      catch { result = "effect-unknown"; } finally { this.#activeHostMutation = null; }
    }
    return this.#settle(command, result, permit);
  }

  #settle(command: Command, result: "changed" | "unchanged" | "effect-unknown", permit: SessionOptionMutationPermit): SessionOptionReceipt {
    const evidenceRef = `session-option-evidence.${randomBytes(24).toString("hex")}`; let receipt: SessionOptionReceipt | null = null;
    const observation = permit.commitObservation((before, after) => {
      receipt = this.#receipt(command, before, after, result === "effect-unknown" ? "uncertain" : "settled", result,
        result === "effect-unknown" ? { code: "session-option-effect-unconfirmed", message: "Pi did not expose the requested active setting after the change.", retryable: false } : null,
        result === "effect-unknown" ? null : evidenceRef);
      this.#pi.appendEntry(WEBUI_SESSION_OPTION_ENTRY_TYPE, { schemaVersion: 1, evidenceRef, action: command.action,
        targetRef: command.action === "session-options.set-model" ? command.payload.modelRef : command.payload.thinkingLevel,
        resultCode: result, sessionOptionRevision: after.sessionOptionRevision });
    });
    if (!observation) {
      const before = this.#domainRevisions(command.expectedRevisions), after = this.#bridge.snapshot().revisions ?? before;
      return this.#receipt(command, before, after, "uncertain", "effect-unknown",
        { code: "session-option-binding-lost", message: "The session binding changed while the setting was being applied.", retryable: false }, null);
    }
    if (!receipt) return this.#receipt(command, observation.before, observation.after, "uncertain", "effect-unknown",
      { code: "session-option-concurrent-selection", message: "A native Pi selection raced this WebUI setting change.", retryable: false }, null);
    if (!observation.recorded) receipt = this.#receipt(command, observation.before, observation.after, "uncertain", "effect-unknown",
      { code: "session-option-evidence-unavailable", message: "The setting may have changed, but its local evidence could not be recorded.", retryable: false }, null);
    return this.#remember(receipt);
  }

  #validate(command: Command): string | null {
    if (!command || typeof command !== "object" || command.schemaVersion !== 1 || command.version !== "piagent-webui-control-v1"
      || command.messageType !== "command" || command.capabilityScope !== "control.sessionOptions"
      || !["session-options.set-model", "session-options.set-thinking"].includes(command.action)) return "unsupported-command-shape";
    if (!exactKeys(command, ["schemaVersion", "version", "messageType", "commandId", "idempotencyKey", "requestedAt", "expiresAt", "capabilityScope",
      "action", "actionDigest", "identity", "expectedRevisions", "payload"]) || !validIdentity(command.identity) || !validRevisions(command.expectedRevisions)
      || !REF.test(command.commandId) || !IDEMPOTENCY.test(command.idempotencyKey) || !timestamp(command.requestedAt) || !timestamp(command.expiresAt)
      || !REVISION.test(command.expectedRevisions.sessionOptionRevision ?? "")
      || Date.parse(command.requestedAt) > Date.parse(command.expiresAt) || Date.parse(command.expiresAt) - Date.parse(command.requestedAt) > 300_000)
      return "invalid-command-metadata";
    const expectedPayload = command.action === "session-options.set-model" ? ["modelRef", "effectScopeAcknowledged"] : ["thinkingLevel", "effectScopeAcknowledged"];
    if (!exactKeys(command.payload, expectedPayload) || command.payload.effectScopeAcknowledged !== "session-and-user-default") return "effect-scope-not-acknowledged";
    if (command.action === "session-options.set-model" && (typeof command.payload.modelRef !== "string" || !REF.test(command.payload.modelRef))) return "invalid-model-ref";
    if (command.action === "session-options.set-thinking" && !THINKING.includes(command.payload.thinkingLevel as ThinkingLevel)) return "invalid-thinking-level";
    if (!DIGEST.test(command.actionDigest) || command.actionDigest !== controlActionDigest(command)) return "action-digest-mismatch";
    return null;
  }

  #receipt(command: Command, before: BridgeRevisions, after: BridgeRevisions, phase: "settled" | "uncertain",
    resultCode: "changed" | "unchanged" | "effect-unknown", error: SessionOptionReceipt["error"], evidence: string | null): SessionOptionReceipt {
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: command.commandId,
      idempotencyKeyDigest: sha(command.idempotencyKey), action: command.action, actionDigest: command.actionDigest, identity: copy(command.identity),
      phase, resultCode, requestedAt: command.requestedAt, settledAt: this.#now().toISOString(), observedRevisionsBefore: copy(before),
      observedRevisionsAfter: copy(after), deduplicated: false, auditRef: null, settlementEvidenceRef: evidence, error };
  }
  #reject(command: Command, resultCode: SessionOptionReceipt["resultCode"], code: string, message: string): SessionOptionReceipt {
    const snapshot = this.#bridge.snapshot(), identity = validIdentity(command?.identity) ? command.identity : snapshot.identity ?? {
      projectRef: "project.unavailable", runtimeInstanceId: "runtime.unavailable", sessionRef: "session.unavailable", taskId: null, taskRunId: null,
      agentOperationId: null, toolCallId: null };
    const revisions = snapshot.revisions ?? { runtimeRevision: "runtime-rev.unavailable", taskRevision: null, controlRevision: null,
      workspaceRevision: null, indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
    const action = ["session-options.set-model", "session-options.set-thinking"].includes(command?.action) ? command.action : "session-options.set-model";
    return { schemaVersion: 1, version: "piagent-webui-control-v1", messageType: "receipt", commandId: REF.test(command?.commandId ?? "") ? command.commandId : "command.invalid",
      idempotencyKeyDigest: IDEMPOTENCY.test(command?.idempotencyKey ?? "") ? sha(command.idempotencyKey) : sha("invalid-idempotency"), action,
      actionDigest: DIGEST.test(command?.actionDigest ?? "") ? command.actionDigest : sha(code), identity: copy(identity), phase: "rejected", resultCode,
      requestedAt: timestamp(command?.requestedAt) ? command.requestedAt : this.#now().toISOString(), settledAt: this.#now().toISOString(),
      observedRevisionsBefore: copy(revisions), observedRevisionsAfter: copy(revisions), deduplicated: resultCode === "replay", auditRef: null,
      settlementEvidenceRef: null, error: { code, message, retryable: false } };
  }
  #remember(receipt: SessionOptionReceipt): SessionOptionReceipt {
    this.#receiptsByKey.set(receipt.idempotencyKeyDigest, copy(receipt)); this.#receiptsByCommand.set(receipt.commandId, copy(receipt)); return receipt;
  }
  #domainRevisions(value: BridgeRevisions): BridgeRevisions {
    return { runtimeRevision: value.runtimeRevision, taskRevision: value.taskRevision, controlRevision: value.controlRevision,
      workspaceRevision: value.workspaceRevision, indexRevision: value.indexRevision, approvalRevision: value.approvalRevision,
      sessionOptionRevision: value.sessionOptionRevision, queueRevision: value.queueRevision };
  }
  #currentThinking(): ThinkingLevel | null {
    return this.#ctx ? this.#thinkingFor(this.#ctx) : null;
  }
  #thinkingFor(ctx: ExtensionContext): ThinkingLevel | null {
    const value = ctx.thinkingLevel ?? this.#pi.getThinkingLevel(); return THINKING.includes(value as ThinkingLevel) ? value as ThinkingLevel : null;
  }
  #availableModels(ctx: ExtensionContext): ModelLike[] {
    const available = ctx.modelRegistry.getAvailable() as ModelLike[];
    if (!ctx.scopedModels.length) return available;
    const scope = new Set(ctx.scopedModels.map((item: any) => `${item.model?.provider}\0${item.model?.id}`));
    return available.filter((item) => scope.has(`${item.provider}\0${item.id}`));
  }
}
