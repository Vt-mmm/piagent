import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

function normalizeLanguageSignal(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("đ", "d");
}

export function looksLikeIncompleteHandoff(text: string): boolean {
  const normalized = normalizeLanguageSignal(text);
  return /\b(?:not done|not complete|not finished|still working|blocked|cannot complete|unable to complete|need clarification|tests? (?:fail|failed|failing)|verification (?:fail|failed|failing)|chua xong|chua hoan tat|chua hoan thanh|dang lam|bi chan|can lam them|test (?:loi|fail))\b/.test(normalized);
}

export function looksLikeCompletionClaim(text: string): boolean {
  const normalized = normalizeLanguageSignal(text);
  if (!normalized.trim() || normalized.includes("[piagent completion gate:")) return false;
  if (looksLikeIncompleteHandoff(text)) return false;
  return /\b(?:done|completed|complete|finished|fixed|implemented|resolved|shipped|all tests pass(?:ed)?|tests? pass(?:ed)?|da xong|da sua|da fix|da hoan tat|da hoan thanh|da trien khai|test da pass|kiem tra da pass)\b/.test(normalized);
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
