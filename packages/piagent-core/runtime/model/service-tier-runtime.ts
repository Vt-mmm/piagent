import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PIAGENT_FAST_MODE_STATE_ENTRY_TYPE = "piagent-fast-mode-state";
export const PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE = "piagent-service-tier-receipt";
export const PIAGENT_FAST_SERVICE_TIER = "fast" as const;
export const PIAGENT_FAST_PROVIDER_SERVICE_TIER = "priority" as const;

type FastModeSource = "default" | "environment" | "session-command" | "session-state";

export type ServiceTierReceipt = {
  schemaVersion: 1;
  enabled: boolean;
  mode: "standard" | "fast";
  source: FastModeSource;
  requestedServiceTier: "fast" | null;
  observedRequestServiceTier: "priority" | null;
  providerResponseServiceTier: null;
  providerResponseEvidence: "unavailable-host-api";
  provider: string | null;
  modelId: string | null;
  applied: boolean;
  reasonCode: "fast-mode-disabled" | "provider-not-supported" | "fast-request-pending" | "fast-request-observed";
};

type SessionState = {
  enabled: boolean;
  source: FastModeSource;
  observedRequestServiceTier: "priority" | null;
  provider: string | null;
  modelId: string | null;
  observationPersisted: boolean;
};

type StateEntry = { type?: unknown; customType?: unknown; data?: unknown };

const SERVICE_TIER_RECEIPT_KEYS = [
  "schemaVersion", "enabled", "mode", "source", "requestedServiceTier", "observedRequestServiceTier",
  "providerResponseServiceTier", "providerResponseEvidence", "provider", "modelId", "applied", "reasonCode"
] as const;
const FAST_MODE_SOURCES = new Set<FastModeSource>(["default", "environment", "session-command", "session-state"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function environmentOverride(value: unknown): boolean | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "fast"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "standard", "default"].includes(normalized)) return false;
  return null;
}

function restoredState(ctx: ExtensionContext): boolean | null {
  let entries: StateEntry[] = [];
  try { entries = ctx.sessionManager.getBranch() as StateEntry[]; } catch { return null; }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index], data = record(entry.data);
    if (entry.type !== "custom" || entry.customType !== PIAGENT_FAST_MODE_STATE_ENTRY_TYPE || data?.schemaVersion !== 1) continue;
    if (typeof data.enabled === "boolean") return data.enabled;
  }
  return null;
}

function isOpenAiCodex(provider: unknown): boolean {
  return String(provider ?? "") === "openai-codex";
}

function boundedIdentity(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 512 && !value.includes("\0");
}

export function parseServiceTierReceipt(value: unknown): ServiceTierReceipt | null {
  const candidate = record(value);
  if (!candidate || Object.keys(candidate).length !== SERVICE_TIER_RECEIPT_KEYS.length
    || !SERVICE_TIER_RECEIPT_KEYS.every((key) => Object.hasOwn(candidate, key))) return null;
  if (candidate.schemaVersion !== 1 || typeof candidate.enabled !== "boolean"
    || !["standard", "fast"].includes(String(candidate.mode))
    || !FAST_MODE_SOURCES.has(candidate.source as FastModeSource)
    || ![null, PIAGENT_FAST_SERVICE_TIER].includes(candidate.requestedServiceTier as null | "fast")
    || ![null, PIAGENT_FAST_PROVIDER_SERVICE_TIER].includes(candidate.observedRequestServiceTier as null | "priority")
    || candidate.providerResponseServiceTier !== null || candidate.providerResponseEvidence !== "unavailable-host-api"
    || !boundedIdentity(candidate.provider) || !boundedIdentity(candidate.modelId)
    || typeof candidate.applied !== "boolean"
    || !["fast-mode-disabled", "provider-not-supported", "fast-request-pending", "fast-request-observed"].includes(String(candidate.reasonCode))) return null;

  const receipt = candidate as ServiceTierReceipt;
  const expectedMode = receipt.enabled ? "fast" : "standard";
  const expectedRequested = receipt.enabled ? PIAGENT_FAST_SERVICE_TIER : null;
  const supported = isOpenAiCodex(receipt.provider);
  const expectedReason = !receipt.enabled ? "fast-mode-disabled" : !supported ? "provider-not-supported"
    : receipt.observedRequestServiceTier === PIAGENT_FAST_PROVIDER_SERVICE_TIER ? "fast-request-observed" : "fast-request-pending";
  const expectedApplied = receipt.enabled && supported
    && receipt.observedRequestServiceTier === PIAGENT_FAST_PROVIDER_SERVICE_TIER;
  if (receipt.mode !== expectedMode || receipt.requestedServiceTier !== expectedRequested
    || receipt.reasonCode !== expectedReason || receipt.applied !== expectedApplied
    || (!receipt.enabled || !supported) && receipt.observedRequestServiceTier !== null) return null;
  return { ...receipt };
}

export class ServiceTierRuntime {
  readonly #environmentValue: string | undefined;
  readonly #states = new Map<string, SessionState>();

  constructor(options: { environmentValue?: string } = {}) {
    this.#environmentValue = options.environmentValue;
  }

  restore(ctx: ExtensionContext): ServiceTierReceipt {
    const environment = environmentOverride(this.#environmentValue);
    const restored = environment === null ? restoredState(ctx) : null;
    const enabled = environment ?? restored ?? false;
    const source: FastModeSource = environment !== null ? "environment" : restored !== null ? "session-state" : "default";
    this.#states.set(sessionId(ctx), {
      enabled, source, observedRequestServiceTier: null, provider: null, modelId: null, observationPersisted: false
    });
    return this.receipt(ctx);
  }

  forget(ctx: ExtensionContext): void {
    this.#states.delete(sessionId(ctx));
  }

  set(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): ServiceTierReceipt {
    const state: SessionState = {
      enabled, source: "session-command", observedRequestServiceTier: null, provider: null, modelId: null, observationPersisted: false
    };
    this.#states.set(sessionId(ctx), state);
    pi.appendEntry(PIAGENT_FAST_MODE_STATE_ENTRY_TYPE, {
      schemaVersion: 1,
      enabled,
      requestedServiceTier: enabled ? PIAGENT_FAST_SERVICE_TIER : null,
      source: state.source
    });
    return this.receipt(ctx);
  }

  receipt(ctx: ExtensionContext): ServiceTierReceipt {
    const state = this.#state(ctx);
    const provider = typeof ctx.model?.provider === "string" ? ctx.model.provider : null;
    const modelId = typeof ctx.model?.id === "string" ? ctx.model.id : null;
    const supported = isOpenAiCodex(provider);
    const observationMatchesCurrentModel = state.observedRequestServiceTier === PIAGENT_FAST_PROVIDER_SERVICE_TIER
      && state.provider === provider && state.modelId === modelId;
    const observed = observationMatchesCurrentModel ? PIAGENT_FAST_PROVIDER_SERVICE_TIER : null;
    return {
      schemaVersion: 1,
      enabled: state.enabled,
      mode: state.enabled ? "fast" : "standard",
      source: state.source,
      requestedServiceTier: state.enabled ? PIAGENT_FAST_SERVICE_TIER : null,
      observedRequestServiceTier: observed,
      providerResponseServiceTier: null,
      providerResponseEvidence: "unavailable-host-api",
      provider,
      modelId,
      applied: state.enabled && supported && observed === PIAGENT_FAST_PROVIDER_SERVICE_TIER,
      reasonCode: !state.enabled ? "fast-mode-disabled" : !supported ? "provider-not-supported"
        : observed === PIAGENT_FAST_PROVIDER_SERVICE_TIER ? "fast-request-observed" : "fast-request-pending"
    };
  }

  applyProviderRequest(pi: ExtensionAPI, ctx: ExtensionContext, payloadValue: unknown): {
    payload: unknown;
    changed: boolean;
    receipt: ServiceTierReceipt;
    observationChanged: boolean;
  } {
    const state = this.#state(ctx), payload = record(payloadValue);
    if (!state.enabled || !isOpenAiCodex(ctx.model?.provider) || !payload) {
      return { payload: payloadValue, changed: false, receipt: this.receipt(ctx), observationChanged: false };
    }
    const next = payload.service_tier === PIAGENT_FAST_PROVIDER_SERVICE_TIER
      ? payloadValue
      : { ...payload, service_tier: PIAGENT_FAST_PROVIDER_SERVICE_TIER };
    const observationChanged = state.observedRequestServiceTier !== PIAGENT_FAST_PROVIDER_SERVICE_TIER
      || state.provider !== String(ctx.model?.provider ?? "") || state.modelId !== String(ctx.model?.id ?? "");
    state.observedRequestServiceTier = PIAGENT_FAST_PROVIDER_SERVICE_TIER;
    state.provider = String(ctx.model?.provider ?? "") || null;
    state.modelId = String(ctx.model?.id ?? "") || null;
    const receipt = this.receipt(ctx);
    if (observationChanged && !state.observationPersisted) {
      pi.appendEntry(PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE, receipt);
      state.observationPersisted = true;
    }
    return { payload: next, changed: next !== payloadValue, receipt, observationChanged };
  }

  #state(ctx: ExtensionContext): SessionState {
    const id = sessionId(ctx), found = this.#states.get(id);
    if (found) return found;
    this.restore(ctx);
    return this.#states.get(id)!;
  }
}

function receiptText(receipt: ServiceTierReceipt): string {
  return [
    `fastMode: ${receipt.mode}`,
    `provider/model: ${receipt.provider && receipt.modelId ? `${receipt.provider}/${receipt.modelId}` : "unknown"}`,
    `requestedServiceTier: ${receipt.requestedServiceTier ?? "no Piagent override (host/provider configuration applies)"}`,
    `observedRequestServiceTier: ${receipt.observedRequestServiceTier ?? "not-observed"}`,
    `providerMapping: Fast mode uses OpenAI service_tier=priority`,
    `providerResponseServiceTier: unavailable (Pi host API does not expose response.service_tier)`,
    `state: ${receipt.reasonCode}`,
    "modelThinkingParity: unchanged",
    "note: Fast service can consume provider quota or cost differently; Fast mode never changes model or thinking"
  ].join("\n");
}

export function registerFastModeCommand(pi: ExtensionAPI, runtime: ServiceTierRuntime): void {
  pi.registerCommand("fast", {
    description: "Show or switch OpenAI Codex Fast service tier without changing model/thinking",
    getArgumentCompletions: (prefix: string) => ["status", "on", "off"]
      .filter((value) => value.startsWith(String(prefix ?? "").trim().toLowerCase()))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = String(args ?? "").trim().toLowerCase() || "status";
      if (!["status", "on", "off"].includes(action)) {
        ctx.ui.notify("Usage: /fast status|on|off", "warning");
        return;
      }
      let receipt = action === "status" ? runtime.receipt(ctx) : runtime.set(pi, ctx, action === "on");
      if (action === "on" && receipt.reasonCode === "provider-not-supported") {
        ctx.ui.notify("Fast mode is enabled for the session, but the active provider is not OpenAI Codex.", "warning");
      } else {
        ctx.ui.notify(`Piagent Fast override: ${receipt.enabled ? "on" : "off"}`, receipt.enabled ? "info" : "warning");
      }
      receipt = runtime.receipt(ctx);
      pi.sendMessage({
        customType: "piagent-service-tier-receipt",
        content: receiptText(receipt),
        display: true,
        details: receipt
      }, { triggerTurn: false });
    }
  });
}
