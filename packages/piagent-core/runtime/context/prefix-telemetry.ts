import crypto from "node:crypto";

type ProviderToolMetadata = {
  name: string;
  description?: unknown;
  parameters?: unknown;
};

function canonicalValue(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}

export function deepCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildPrefixTelemetry(systemPrompt: string, tools: ProviderToolMetadata[]): {
  systemPromptHash: string;
  toolSchemaHash: string;
  prefixSurfaceHash: string;
  canonicalToolSurface: string;
} {
  const providerSurface = tools
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const canonicalToolSurface = deepCanonicalJson(providerSurface);
  const systemPromptHash = hash(systemPrompt);
  const toolSchemaHash = hash(canonicalToolSurface);
  return {
    systemPromptHash,
    toolSchemaHash,
    prefixSurfaceHash: hash(`${systemPromptHash}\0${toolSchemaHash}`),
    canonicalToolSurface
  };
}
