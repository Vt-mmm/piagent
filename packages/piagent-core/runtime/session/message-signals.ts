import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export { looksLikeCompletionClaim, looksLikeIncompleteHandoff } from "./completion-signals.ts";

export function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))
    .map((item) => item.text)
    .join("\n");
}

export function assistantMessageHasToolCall(message: unknown): boolean {
  const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  return Array.isArray(content) && content.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "toolCall");
}

export function prependAssistantNotice<T extends { content?: unknown }>(message: T, notice: string) {
  const content = Array.isArray(message.content) ? [{ type: "text" as const, text: notice }, ...message.content]
    : [{ type: "text" as const, text: `${notice}${typeof message.content === "string" ? message.content : assistantMessageText(message)}` }];
  return { ...message, content };
}

export function modelLabel(ctx: ExtensionContext): string {
  const model = ctx.model as { provider?: string; id?: string; name?: string } | undefined;
  if (!model) return "none";
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.name ?? model.id ?? "unknown";
}

export function currentSessionName(ctx: ExtensionContext): string {
  try {
    return String(ctx.sessionManager.getSessionName() ?? "").trim();
  } catch {
    return "";
  }
}

export function hasOperatorSessionName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return Boolean(normalized && normalized !== "session");
}

export function cleanSessionNameInput(input: string): string {
  let name = input.trim();
  if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1).trim();
  }
  return name;
}
