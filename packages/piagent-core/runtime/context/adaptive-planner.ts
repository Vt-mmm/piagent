import crypto from "node:crypto";

import { classifyContextTask } from "../../extensions/context-engine.js";
import type { TaskContract } from "../../extensions/guard-types.ts";
import type { RuntimeModelCapability } from "../model/capabilities.ts";
import { CONTEXT_PACK_MAX_TOKENS } from "../runtime-limits.ts";

type ContextUsage = {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
};

export type AdaptiveContextPlan = {
  schemaVersion: 1;
  phase: "utility" | "protected" | "intake" | "scout" | "execute" | "review" | "release";
  lane: "tiny" | "normal" | "high-risk";
  shouldInject: boolean;
  budgetTokens: number;
  limit: number;
  includeCode: boolean;
  currentSnapshot: boolean;
  includePatterns?: string[];
  minConfidence: "medium" | "high";
  receipt: string;
  reasons: string[];
  reranker: "off" | "local";
};

type PlannerInput = {
  prompt: string;
  activeTask?: TaskContract;
  runtimeIntake: boolean;
  protectedOnlyTarget?: boolean;
  contextUsage?: ContextUsage;
  modelCapability: RuntimeModelCapability;
};

const DEFAULT_INTAKE_PATTERNS = [
  "README.md",
  "package.json",
  "src/**",
  "app/**",
  "pages/**",
  "components/**",
  "tests/**",
  "__tests__/**"
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function contextPressure(usage?: ContextUsage): number {
  if (typeof usage?.percent === "number") return Math.max(0, Math.min(1, usage.percent / 100));
  if (typeof usage?.tokens === "number" && typeof usage?.contextWindow === "number" && usage.contextWindow > 0) {
    return Math.max(0, Math.min(1, usage.tokens / usage.contextWindow));
  }
  return 0;
}

function phaseFor(signal: ReturnType<typeof classifyContextTask>, input: PlannerInput): AdaptiveContextPlan["phase"] {
  if (input.protectedOnlyTarget) return "protected";
  if (signal.workflow === "usage") return "utility";
  if (signal.workflow === "review") return "review";
  if (signal.workflow === "scout" || signal.workflow === "onboard") return "scout";
  if (signal.workflow === "release") return "release";
  if (input.runtimeIntake) return "intake";
  return "execute";
}

function baseBudget(phase: AdaptiveContextPlan["phase"], lane: AdaptiveContextPlan["lane"], explicitPaths: number): number {
  if (phase === "protected" || phase === "utility") return 0;
  if (phase === "review") return lane === "high-risk" ? 720 : 520;
  if (phase === "release") return 620;
  if (phase === "scout") return lane === "high-risk" ? 820 : 640;
  if (phase === "intake") {
    if (explicitPaths > 0) return lane === "high-risk" ? 560 : 420;
    return lane === "high-risk" ? 780 : lane === "tiny" ? 360 : 540;
  }
  return lane === "high-risk" ? 680 : lane === "tiny" ? 320 : 460;
}

function contextLane(value: string): AdaptiveContextPlan["lane"] {
  return value === "high-risk" || value === "tiny" ? value : "normal";
}

function stableReceipt(input: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

export function planAdaptiveContext(input: PlannerInput): AdaptiveContextPlan {
  const signal = classifyContextTask(input.prompt);
  const lane = contextLane(signal.lane);
  const phase = phaseFor(signal, input);
  const reasons: string[] = [`phase:${phase}`, `lane:${lane}`];
  const pressure = contextPressure(input.contextUsage);
  const pressureScale = pressure >= 0.72 ? 0.55 : pressure >= 0.58 ? 0.72 : pressure >= 0.42 ? 0.86 : 1;
  if (pressureScale < 1) reasons.push(`context-pressure:${pressure.toFixed(2)}`);
  const activePendingTask = input.activeTask?.trace?.outcome === "pending";
  const explicitPathCount = signal.paths.length;
  const shouldInject = phase !== "protected"
    && phase !== "utility"
    && !activePendingTask
    && String(input.prompt ?? "").trim().length >= 20;
  if (activePendingTask) reasons.push("active-task:reuse-working-set");
  if (!shouldInject) {
    return {
      schemaVersion: 1,
      phase,
      lane,
      shouldInject: false,
      budgetTokens: 0,
      limit: 0,
      includeCode: false,
      currentSnapshot: false,
      minConfidence: "high",
      receipt: stableReceipt({ promptHash: signal.promptHash, phase, lane, shouldInject: false }),
      reasons,
      reranker: "off"
    };
  }
  const capabilityScale = Number.isFinite(input.modelCapability.phaseBudgetScale)
    ? Math.max(0.5, Math.min(1.25, input.modelCapability.phaseBudgetScale))
    : 1;
  const scaled = baseBudget(phase, lane, explicitPathCount)
    * capabilityScale
    * pressureScale;
  const budgetTokens = clamp(scaled, 240, lane === "high-risk" ? CONTEXT_PACK_MAX_TOKENS : 680);
  const limit = explicitPathCount > 0
    ? 4
    : lane === "high-risk" ? 8 : lane === "tiny" ? 4 : 6;
  const includeCode = phase === "intake" || phase === "review" || explicitPathCount > 0;
  const includePatterns = phase === "intake" ? DEFAULT_INTAKE_PATTERNS : undefined;
  const reranker = "off" as const;
  if (process.env.PIAGENT_LOCAL_RERANKER === "on") reasons.push("local-reranker:unavailable");
  const minConfidence = explicitPathCount > 0 || lane === "tiny"
    ? "medium"
    : phase === "review" || phase === "release" || lane === "high-risk"
      ? "high"
      : "medium";
  return {
    schemaVersion: 1,
    phase,
    lane,
    shouldInject: true,
    budgetTokens,
    limit,
    includeCode,
    currentSnapshot: phase === "intake",
    includePatterns,
    minConfidence,
    receipt: stableReceipt({
      promptHash: signal.promptHash,
      phase,
      lane,
      budgetTokens,
      limit,
      model: input.modelCapability.model,
      thinkingLevel: input.modelCapability.thinkingLevel,
      contextWindow: input.modelCapability.contextWindow
    }),
    reasons,
    reranker
  };
}

export function contextPlanAcceptsConfidence(plan: AdaptiveContextPlan, confidence: string): boolean {
  if (!plan.shouldInject) return false;
  if (plan.minConfidence === "high") return confidence === "high";
  return confidence === "medium" || confidence === "high";
}
