import crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildContextPack, ensureContextIndexV2 } from "../../extensions/context-engine.js";
import { durableContextEvidenceEntries } from "../../extensions/context-evidence.js";
import type { TaskContract } from "../../extensions/guard-types.js";

export type ContextDeltaShadowMode = "off" | "sample" | "on";

type ShadowInput = {
  ctx: ExtensionContext;
  query: string;
  turnId: string;
  task: TaskContract;
  mode: ContextDeltaShadowMode;
  protectedTarget: boolean;
  excludePatterns: string[];
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

function sampled(taskRunId: string, query: string): boolean {
  const byte = crypto.createHash("sha256").update(`${taskRunId}\0${query}`).digest()[0];
  return byte < 64;
}

export async function measureContextDeltaShadow(input: ShadowInput): Promise<void> {
  if (input.mode === "off" || input.protectedTarget || (input.mode === "sample" && !sampled(input.task.taskRunId, input.query))) return;
  const usage = input.ctx.getContextUsage();
  if (usage && Number(usage.percent ?? 0) >= 80) return;
  try {
    const { status } = await ensureContextIndexV2(input.ctx.cwd, { excludePatterns: input.excludePatterns, rebuildMissing: false });
    if (!status.exists || status.stale) return;
    const pack = await buildContextPack(input.ctx.cwd, input.query, {
      budgetTokens: 1_200,
      includeCode: false,
      limit: 10,
      excludePatterns: input.excludePatterns
    });
    const manifested = new Set(durableContextEvidenceEntries(input.task).map((entry) => entry.path));
    const duplicateItems = pack.selected.filter((item) => manifested.has(item.path));
    input.telemetry(input.ctx, {
      event: "context_delta_shadow",
      turnId: input.turnId,
      queryHash: pack.queryHash,
      candidatePaths: pack.selected.map((item) => item.path),
      pathsAlreadyManifested: duplicateItems.map((item) => item.path),
      candidateTokens: pack.selected.reduce((sum, item) => sum + item.estimatedTokens, 0),
      duplicateCandidateTokens: duplicateItems.reduce((sum, item) => sum + item.estimatedTokens, 0)
    });
  } catch (error) {
    input.telemetry(input.ctx, { event: "context_delta_shadow", turnId: input.turnId, skipped: "error", error: error instanceof Error ? error.message : String(error) });
  }
}
