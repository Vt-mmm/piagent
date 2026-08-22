import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";

export type EffectiveSessionOptions = {
  state: "confirmed" | "mismatch" | "unknown";
  modelRef: string | null;
  thinkingLevel: string | null;
  reasonCode: string | null;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function effectiveModelRef(session: any): string | null {
  const model = session?.model;
  if (!model || typeof model !== "object") return null;
  const provider = String(model.provider ?? ""), id = String(model.id ?? model.modelId ?? "");
  return provider && id ? webUiModelRef(provider, id) : null;
}

export function effectiveThinkingLevel(session: any): string | null {
  let value: unknown;
  try { value = typeof session?.getThinkingLevel === "function" ? session.getThinkingLevel() : undefined; }
  catch { return null; }
  if (value === undefined || value === null || value === "") value = session?.thinkingLevel;
  const level = String(value ?? "");
  return THINKING_LEVELS.has(level) ? level : null;
}

export async function configureSessionOptions(session: any, modelRef: string | null,
  thinkingLevel: string): Promise<EffectiveSessionOptions> {
  if (modelRef) {
    const models = session.modelRuntime?.getAvailableSnapshot?.() ?? [];
    const model = models.find((value: any) => webUiModelRef(String(value.provider ?? ""),
      String(value.id ?? value.modelId ?? "")) === modelRef);
    try { if (model) await session.setModel(model); } catch { /* Canonical read-back below decides the effect. */ }
  }
  try { await session.setThinkingLevel(thinkingLevel); } catch { /* Canonical read-back below decides the effect. */ }
  const effectiveModel = effectiveModelRef(session), effectiveThinking = effectiveThinkingLevel(session);
  if (!effectiveModel) return { state: "unknown", modelRef: null,
    thinkingLevel: effectiveThinking, reasonCode: "session-model-effect-unknown" };
  if (!effectiveThinking) return { state: "unknown", modelRef: effectiveModel,
    thinkingLevel: null, reasonCode: "session-thinking-effect-unknown" };
  if (modelRef && effectiveModel !== modelRef) return { state: "mismatch", modelRef: effectiveModel,
    thinkingLevel: effectiveThinking, reasonCode: "session-model-mismatch" };
  if (effectiveThinking !== thinkingLevel) return { state: "mismatch", modelRef: effectiveModel,
    thinkingLevel: effectiveThinking, reasonCode: "session-thinking-mismatch" };
  return { state: "confirmed", modelRef: effectiveModel, thinkingLevel: effectiveThinking, reasonCode: null };
}
