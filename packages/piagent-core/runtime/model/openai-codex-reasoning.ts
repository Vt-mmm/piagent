type ProviderPayload = Record<string, unknown>;

const GPT56_CODEX_MODEL = /^gpt-5\.6-(?:luna|sol|terra)$/;
const PROVIDER_EFFORT_BY_HOST_LEVEL: Readonly<Record<string, string>> = Object.freeze({
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
});

export type OpenAiCodexReasoningNormalization = {
  payload: unknown;
  applicable: boolean;
  changed: boolean;
  hostThinkingLevel: string;
  expectedProviderEffort: string | null;
  providerEffort: string | null;
  reasonCode: "not-applicable" | "observed" | "off-normalized-to-none" | "minimal-normalized-to-low" | "provider-effort-normalized";
};

function record(value: unknown): ProviderPayload | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ProviderPayload : null;
}

function effortFromPayload(payload: ProviderPayload): string | null {
  const reasoning = record(payload.reasoning);
  return typeof reasoning?.effort === "string" ? reasoning.effort : null;
}

/**
 * Compatibility bridge for the pinned Pi host's OpenAI Codex serializer.
 *
 * Pi names the provider's `none` effort `off`. Pi 0.84.1 currently drops
 * `off` before its request builder, which omits the reasoning object and lets
 * GPT-5.6 use its server default. Enforce the same-model/effort invariant for
 * every host level, while keeping the correction deliberately narrow to the
 * three authenticated GPT-5.6 Codex models whose capability map we audit.
 */
export function normalizeOpenAiCodexReasoningPayload(input: {
  payload: unknown;
  provider: unknown;
  modelId: unknown;
  hostThinkingLevel: unknown;
}): OpenAiCodexReasoningNormalization {
  const provider = String(input.provider ?? "");
  const modelId = String(input.modelId ?? "");
  const hostThinkingLevel = String(input.hostThinkingLevel ?? "");
  const payload = record(input.payload);
  const expectedProviderEffort = PROVIDER_EFFORT_BY_HOST_LEVEL[hostThinkingLevel] ?? null;
  const applicable = provider === "openai-codex" && GPT56_CODEX_MODEL.test(modelId)
    && payload !== null && payload.model === modelId && expectedProviderEffort !== null;
  if (!applicable || !payload) {
    return { payload: input.payload, applicable: false, changed: false, hostThinkingLevel,
      expectedProviderEffort, providerEffort: payload ? effortFromPayload(payload) : null, reasonCode: "not-applicable" };
  }

  const currentEffort = effortFromPayload(payload);
  if (currentEffort === expectedProviderEffort) {
    return { payload: input.payload, applicable: true, changed: false, hostThinkingLevel,
      expectedProviderEffort, providerEffort: currentEffort, reasonCode: "observed" };
  }

  const currentReasoning = record(payload.reasoning) ?? {};
  const normalizedReasoning = {
    ...currentReasoning,
    effort: expectedProviderEffort,
    ...(typeof currentReasoning.summary === "string" ? {} : { summary: "auto" })
  };
  return {
    payload: { ...payload, reasoning: normalizedReasoning },
    applicable: true,
    changed: true,
    hostThinkingLevel,
    expectedProviderEffort,
    providerEffort: expectedProviderEffort,
    reasonCode: hostThinkingLevel === "off" ? "off-normalized-to-none"
      : hostThinkingLevel === "minimal" ? "minimal-normalized-to-low"
        : "provider-effort-normalized"
  };
}
