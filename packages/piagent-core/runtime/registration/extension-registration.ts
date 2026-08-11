import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PIAGENT_SEQUENTIAL_TOOLS } from "../tools/phase-tools.ts";

type RuntimeCommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
type RuntimeToolDefinition = Record<string, any> & { name: string };

function legacyToolErrorText(result: Record<string, any>, name: string): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || `${name} failed`;
}

function hostCompatibleTool(definition: RuntimeToolDefinition): RuntimeToolDefinition {
  if (typeof definition.execute !== "function") return definition;
  const execute = definition.execute;
  return {
    ...definition,
    async execute(...args: any[]) {
      const result = await execute.apply(definition, args);
      // Pi 0.82 treats thrown execute errors as tool failures. A legacy
      // `isError` return field is ignored and reaches the model as success,
      // which made refused intake/progress calls look actionable.
      if (result && typeof result === "object" && result.isError === true) {
        const error = new Error(legacyToolErrorText(result, definition.name));
        Object.assign(error, { details: result.details, piagentToolResult: result });
        throw error;
      }
      return result;
    }
  };
}

export function registerRuntimeCommand(
  pi: ExtensionAPI,
  name: string,
  definition: RuntimeCommandDefinition
): void {
  pi.registerCommand(name, definition);
}

export function piagentToolExecutionMode(name: string): "sequential" | "parallel" {
  return PIAGENT_SEQUENTIAL_TOOLS.has(name) ? "sequential" : "parallel";
}

export function piagentToolBatchMode(names: string[]): "sequential" | "parallel" {
  return names.some((name) => piagentToolExecutionMode(name) === "sequential") ? "sequential" : "parallel";
}

export function registerPiagentTool(pi: ExtensionAPI, definition: RuntimeToolDefinition): void {
  pi.registerTool({ ...hostCompatibleTool(definition), executionMode: piagentToolExecutionMode(definition.name) });
}

export function registerRuntimeTool(pi: ExtensionAPI, definition: RuntimeToolDefinition): void {
  registerPiagentTool(pi, definition);
}

export function prefixCompletions(values: readonly string[], prefix: string): Array<{ value: string; label: string }> {
  const typed = String(prefix ?? "").trim().toLowerCase();
  return values
    .filter((value) => value.startsWith(typed))
    .map((value) => ({ value, label: value }));
}
