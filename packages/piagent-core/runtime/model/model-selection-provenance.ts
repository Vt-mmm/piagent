import type { ModelSelectionSource } from "./model-route-types.ts";
import { MODEL_SELECTION_SOURCES } from "./model-route-types.ts";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on", "pinned"].includes(String(value ?? "").trim().toLowerCase());
}

function hasModelArgument(argv: readonly string[]): boolean {
  return argv.some((arg, index) => arg === "--model" || arg === "-m" || arg.startsWith("--model=")
    || ((arg === "--provider" || arg === "--thinking") && Boolean(argv[index + 1])));
}

export function modelSelectionSourceFromInvocation(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): ModelSelectionSource {
  const declared = String(env.PIAGENT_MODEL_SELECTION_SOURCE ?? "").trim().toLowerCase();
  if (MODEL_SELECTION_SOURCES.includes(declared as ModelSelectionSource)) return declared as ModelSelectionSource;
  if (truthy(env.PIAGENT_MODEL_PINNED) || hasModelArgument(argv) || Boolean(env.PI_MODEL?.trim())) return "explicit-user-pin";
  return "unknown";
}

export class ModelSelectionProvenanceTracker {
  readonly #initial: ModelSelectionSource;
  readonly #bySession = new Map<string, ModelSelectionSource>();

  constructor(initial = modelSelectionSourceFromInvocation()) {
    this.#initial = initial;
  }

  source(sessionId: string): ModelSelectionSource {
    return this.#bySession.get(sessionId) ?? this.#initial;
  }

  observeModelSelection(sessionId: string, source: "set" | "cycle" | "restore" | string): void {
    this.#bySession.set(sessionId, source === "set" || source === "cycle" || source === "restore" ? "explicit-user-pin" : "unknown");
  }

  observeThinkingSelection(sessionId: string): void {
    this.#bySession.set(sessionId, "explicit-user-pin");
  }

  markRouterSelected(sessionId: string): void {
    this.#bySession.set(sessionId, "router-selected");
  }

  clear(sessionId?: string): void {
    if (sessionId) this.#bySession.delete(sessionId);
    else this.#bySession.clear();
  }
}
