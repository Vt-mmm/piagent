import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RuntimeAvailability } from "./runtime-snapshot.ts";

export const AUTHENTICATED_MODEL_CATALOG_SCHEMA_VERSION = 1 as const;

export type AuthenticatedModelCatalogEntry = {
  provider: string;
  modelId: string;
  contextWindow: number | null;
  reasoning: boolean | null;
  imageInput: boolean | null;
  supportedThinkingLevels: string[] | null;
};

export type AuthenticatedModelCatalog = {
  schemaVersion: typeof AUTHENTICATED_MODEL_CATALOG_SCHEMA_VERSION;
  capturedAt: string;
  source: "authenticated-catalog";
  availability: RuntimeAvailability;
  models: AuthenticatedModelCatalogEntry[];
  warnings: string[];
};

type ModelLike = {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  reasoning?: unknown;
  input?: unknown;
  thinkingLevelMap?: unknown;
};

export type ModelRegistryView = {
  getAvailable?: () => readonly ModelLike[] | Promise<readonly ModelLike[]>;
  getAll?: () => readonly ModelLike[] | Promise<readonly ModelLike[]>;
};

export type CatalogCaptureOptions = {
  capturedAt?: string;
  offline?: boolean;
};

function text(value: unknown): string {
  return String(value ?? "").trim().slice(0, 160);
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 10_000_000 ? Number(value) : null;
}

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevels(value: ModelLike): string[] | null {
  if (typeof value.reasoning !== "boolean") return null;
  if (!value.reasoning) return ["off"];
  const mapping = value.thinkingLevelMap && typeof value.thinkingLevelMap === "object" && !Array.isArray(value.thinkingLevelMap)
    ? value.thinkingLevelMap as Record<string, unknown>
    : {};
  // Match Pi's getSupportedThinkingLevels semantics. Reasoning models support
  // the standard host levels through `high` unless a model explicitly marks a
  // level null. `xhigh` and `max` are opt-in capabilities.
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = mapping[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

function boundedModel(value: ModelLike): AuthenticatedModelCatalogEntry | undefined {
  const provider = text(value.provider);
  const modelId = text(value.id ?? value.name);
  if (!provider || !modelId) return undefined;
  const input = Array.isArray(value.input) ? value.input.map(text) : undefined;
  return {
    provider,
    modelId,
    contextWindow: positiveInteger(value.contextWindow),
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : null,
    imageInput: input ? input.includes("image") : null,
    supportedThinkingLevels: thinkingLevels(value)
  };
}

function deterministicModels(values: readonly ModelLike[]): AuthenticatedModelCatalogEntry[] {
  const models = new Map<string, AuthenticatedModelCatalogEntry>();
  for (const value of values) {
    const model = boundedModel(value);
    if (!model) continue;
    const key = `${model.provider}\u0000${model.modelId}`;
    if (!models.has(key)) models.set(key, model);
  }
  return [...models.values()].sort((left, right) => (
    `${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`)
  ));
}

export async function captureAuthenticatedModelCatalog(
  registry: ModelRegistryView | undefined,
  options: CatalogCaptureOptions = {}
): Promise<AuthenticatedModelCatalog> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  if (options.offline) {
    return { schemaVersion: 1, capturedAt, source: "authenticated-catalog", availability: "offline", models: [], warnings: ["Authenticated model catalog was not queried in offline mode."] };
  }
  if (!registry?.getAvailable) {
    return { schemaVersion: 1, capturedAt, source: "authenticated-catalog", availability: "unknown", models: [], warnings: ["Pi ModelRegistry is unavailable in this runtime."] };
  }
  try {
    const available = deterministicModels(await registry.getAvailable());
    const all = registry.getAll ? deterministicModels(await registry.getAll()) : [];
    const availability: RuntimeAvailability = available.length > 0
      ? "authenticated"
      : all.length > 0
        ? "logged-out"
        : "unavailable";
    const warnings = availability === "logged-out"
      ? ["Models exist in the Pi catalog, but none are available through current authentication."]
      : availability === "unavailable"
        ? ["Pi returned no authenticated models."]
        : [];
    return { schemaVersion: 1, capturedAt, source: "authenticated-catalog", availability, models: available, warnings };
  } catch {
    return { schemaVersion: 1, capturedAt, source: "authenticated-catalog", availability: "unavailable", models: [], warnings: ["Authenticated model catalog capture failed; unrelated runtime behavior is unchanged."] };
  }
}

export async function captureAuthenticatedModelCatalogFromContext(
  ctx: ExtensionContext,
  options: CatalogCaptureOptions = {}
): Promise<AuthenticatedModelCatalog> {
  const registry = (ctx as ExtensionContext & { modelRegistry?: ModelRegistryView }).modelRegistry;
  return captureAuthenticatedModelCatalog(registry, options);
}
