import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type RuntimeModelCapability = {
  provider: string;
  model: string;
  family: "codex" | "claude" | "generic";
  thinkingLevel: string;
  contextWindow?: number;
  phaseBudgetScale: number;
  supportsLargeContext: boolean;
  source: "pi-runtime";
};

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function modelString(ctx: ExtensionContext): { provider: string; model: string } {
  const model = (ctx as unknown as { model?: { provider?: unknown; id?: unknown; name?: unknown } }).model;
  const provider = normalize(model?.provider);
  const id = normalize(model?.id ?? model?.name);
  const joined = [provider, id].filter(Boolean).join("/");
  return {
    provider: provider || "unknown",
    model: joined || id || "unknown"
  };
}

function familyForModel(value: string): RuntimeModelCapability["family"] {
  const lower = value.toLowerCase();
  if (lower.includes("codex") || lower.includes("gpt-5")) return "codex";
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  return "generic";
}

function thinkingScale(thinkingLevel: string): number {
  const normalized = thinkingLevel.toLowerCase();
  if (["xhigh", "extra-high", "max"].includes(normalized)) return 0.82;
  if (["high"].includes(normalized)) return 0.9;
  if (["medium", "med"].includes(normalized)) return 1;
  if (["low", "minimal", "none"].includes(normalized)) return 1.08;
  return 1;
}

export function modelCapabilityFromContext(
  ctx: ExtensionContext,
  thinkingLevel: string
): RuntimeModelCapability {
  const model = modelString(ctx);
  const contextUsage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
  const contextWindow = typeof contextUsage?.contextWindow === "number" ? contextUsage.contextWindow : undefined;
  const family = familyForModel(`${model.provider}/${model.model}`);
  const supportsLargeContext = typeof contextWindow === "number" ? contextWindow >= 120_000 : family === "codex";
  return {
    provider: model.provider,
    model: model.model,
    family,
    thinkingLevel: normalize(thinkingLevel) || "unknown",
    contextWindow,
    phaseBudgetScale: thinkingScale(thinkingLevel) * (supportsLargeContext ? 1 : 0.86),
    supportsLargeContext,
    source: "pi-runtime"
  };
}
