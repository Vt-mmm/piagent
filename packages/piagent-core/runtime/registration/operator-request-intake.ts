import { OPERATOR_REQUEST_MAX_CHARS } from "../../extensions/task-state.js";

type SessionContext = {
  sessionManager: {
    getBranch?: () => unknown;
    getEntries?: () => unknown;
  };
};

function userMessageText(message: unknown): string {
  if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "user") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // The host stores the exact operator prose in the first text block. Later
  // text blocks may contain extracted attachment bodies and must not be copied
  // into private task truth as if the operator typed them.
  const first = content.find((block) => block && typeof block === "object"
    && (block as Record<string, unknown>).type === "text"
    && typeof (block as Record<string, unknown>).text === "string") as Record<string, unknown> | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

export function latestOperatorRequest(ctx: SessionContext): string | undefined {
  let entries: unknown[] = [];
  try {
    const branch = ctx.sessionManager.getBranch?.();
    entries = Array.isArray(branch) ? branch : [];
    if (entries.length === 0) {
      const all = ctx.sessionManager.getEntries?.();
      entries = Array.isArray(all) ? all : [];
    }
  } catch {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as Record<string, any> | undefined;
    if (entry?.type !== "message") continue;
    const text = userMessageText(entry.message);
    if (text.trim()) return text;
  }
  return undefined;
}

export function boundedOperatorRequest(value: unknown, redactText: (value: string) => string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const redacted = redactText(value);
  return Array.from(redacted).length <= OPERATOR_REQUEST_MAX_CHARS ? redacted : undefined;
}
