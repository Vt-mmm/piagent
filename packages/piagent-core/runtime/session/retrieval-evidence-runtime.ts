import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RETRIEVAL_EVIDENCE_VERSION = "retrieval-evidence-v1" as const;
export const RETRIEVAL_EVIDENCE_TOOLS = new Set(["read", "grep", "find", "ls"]);

export type RetrievalEvidenceObservation = {
  toolName: string;
  callFingerprint: string;
  outputHash: string;
  target?: string;
  deterministicMiss?: boolean;
  nonEvidenceFailure?: boolean;
};

export type RetrievalEvidenceCheckpoint = {
  version: typeof RETRIEVAL_EVIDENCE_VERSION;
  reason: "evidence-checkpoint" | "evidence-saturated";
  calls: number;
  uniqueCalls: number;
  repeatedCalls: number;
  uniqueTargets: number;
  deterministicMisses: number;
  noNovelEvidenceStreak: number;
  generation: number;
  generationCalls: number;
  text: string;
};

type RetrievalTurnState = {
  turnId?: string;
  calls: number;
  repeatedCalls: number;
  deterministicMisses: number;
  noNovelEvidenceStreak: number;
  generation: number;
  generationCalls: number;
  adviceCount: number;
  lastAdviceAt: number;
  // Operation-wide sets keep the accounting truthful across a mutation. The
  // generation-local sets below decide whether a result is fresh for the
  // current tree revision.
  callFingerprints: Set<string>;
  generationCallFingerprints: Set<string>;
  outputHashes: Set<string>;
  targets: Set<string>;
  generationTargets: Set<string>;
};

function newState(generation = 0, turnId?: string): RetrievalTurnState {
  return {
    turnId,
    calls: 0,
    repeatedCalls: 0,
    deterministicMisses: 0,
    noNovelEvidenceStreak: 0,
    generation,
    generationCalls: 0,
    adviceCount: 0,
    lastAdviceAt: 0,
    callFingerprints: new Set(),
    generationCallFingerprints: new Set(),
    outputHashes: new Set(),
    targets: new Set(),
    generationTargets: new Set()
  };
}

function sessionKey(ctx: ExtensionContext): string {
  return `${ctx.cwd}\u0000${ctx.sessionManager.getSessionId()}`;
}

function boundedTarget(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 512
    ? normalized
    : `${normalized.slice(0, 255)}…${normalized.slice(-256)}`;
}

function checkpointText(checkpoint: Omit<RetrievalEvidenceCheckpoint, "text">): string {
  const prefix = checkpoint.reason === "evidence-saturated"
    ? "Piagent retrieval saturation"
    : "Piagent retrieval checkpoint";
  return `[${prefix}: ${checkpoint.calls} calls; ${checkpoint.uniqueCalls} unique; ${checkpoint.repeatedCalls} repeated; ${checkpoint.deterministicMisses} deterministic misses; ${checkpoint.uniqueTargets} targets. `
    + "If the acceptance criteria are covered, stop broad scouting and synthesize now. Continue only for a named unresolved criterion, a concrete contradiction, or a required focused test. Do not repeat an exact call, revisit a known-missing target, or batch patterns against an unconfirmed target.]";
}

/**
 * Tracks evidence novelty for one operator operation. It never blocks a new
 * source path: the model keeps its full reasoning/retrieval capability. The
 * runtime only emits bounded checkpoints when search becomes long or stops
 * producing new evidence.
 */
export class RetrievalEvidenceRuntime {
  readonly #states = new Map<string, RetrievalTurnState>();

  beginTurn(ctx: ExtensionContext, turnId?: string): void {
    const key = sessionKey(ctx);
    this.#states.set(key, newState(0, turnId));
    while (this.#states.size > 100) this.#states.delete(this.#states.keys().next().value as string);
  }

  invalidateAfterMutation(ctx: ExtensionContext, turnId?: string): void {
    const key = sessionKey(ctx);
    const current = this.#states.get(key);
    const prior = current && (!turnId || !current.turnId || current.turnId === turnId)
      ? current
      : newState(0, turnId);
    if (turnId && !prior.turnId) prior.turnId = turnId;
    // Keep the operation totals so a mutation cannot erase token accounting,
    // but clear novelty/negative evidence because the working tree changed.
    prior.generation += 1;
    prior.generationCalls = 0;
    prior.noNovelEvidenceStreak = 0;
    prior.adviceCount = 0;
    prior.lastAdviceAt = 0;
    prior.generationCallFingerprints.clear();
    prior.outputHashes.clear();
    prior.generationTargets.clear();
    this.#states.set(key, prior);
  }

  clearSession(ctx: ExtensionContext): void {
    this.#states.delete(sessionKey(ctx));
  }

  observe(
    ctx: ExtensionContext,
    observation: RetrievalEvidenceObservation,
    turnId?: string
  ): RetrievalEvidenceCheckpoint | undefined {
    const toolName = String(observation.toolName ?? "").toLowerCase();
    if (!RETRIEVAL_EVIDENCE_TOOLS.has(toolName)) return undefined;
    const key = sessionKey(ctx);
    const current = this.#states.get(key);
    const state = current && (!turnId || !current.turnId || current.turnId === turnId)
      ? current
      : newState(0, turnId);
    if (turnId && !state.turnId) state.turnId = turnId;
    this.#states.set(key, state);

    state.calls += 1;
    state.generationCalls += 1;
    const target = boundedTarget(observation.target);
    const repeatedAcrossOperation = state.callFingerprints.has(observation.callFingerprint);
    const repeatedCall = state.generationCallFingerprints.has(observation.callFingerprint);
    const repeatedOutput = Boolean(observation.outputHash) && state.outputHashes.has(observation.outputHash);
    const knownTarget = target ? state.generationTargets.has(target) : false;
    if (repeatedAcrossOperation) state.repeatedCalls += 1;
    if (observation.deterministicMiss) state.deterministicMisses += 1;

    const novel = !observation.nonEvidenceFailure
      && !repeatedCall
      && !observation.deterministicMiss
      && (!repeatedOutput || !knownTarget);
    state.noNovelEvidenceStreak = novel ? 0 : state.noNovelEvidenceStreak + 1;
    state.callFingerprints.add(observation.callFingerprint);
    state.generationCallFingerprints.add(observation.callFingerprint);
    if (observation.outputHash) state.outputHashes.add(observation.outputHash);
    if (target) {
      state.targets.add(target);
      state.generationTargets.add(target);
    }

    const saturated = state.noNovelEvidenceStreak >= 4;
    const periodic = state.generationCalls >= 32 && state.generationCalls % 32 === 0;
    const enoughDistance = state.adviceCount === 0
      ? state.generationCalls >= 4
      : state.generationCalls - state.lastAdviceAt >= 8;
    if (state.adviceCount >= 4 || !enoughDistance || (!saturated && !periodic)) return undefined;

    state.adviceCount += 1;
    state.lastAdviceAt = state.generationCalls;
    const checkpoint = {
      version: RETRIEVAL_EVIDENCE_VERSION,
      reason: saturated ? "evidence-saturated" as const : "evidence-checkpoint" as const,
      calls: state.calls,
      uniqueCalls: state.callFingerprints.size,
      repeatedCalls: state.repeatedCalls,
      uniqueTargets: state.targets.size,
      deterministicMisses: state.deterministicMisses,
      noNovelEvidenceStreak: state.noNovelEvidenceStreak,
      generation: state.generation,
      generationCalls: state.generationCalls
    };
    return { ...checkpoint, text: checkpointText(checkpoint) };
  }
}
