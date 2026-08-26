import { redactSensitiveText } from "../../extensions/redaction-core.js";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function numericExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

export function successfulToolResult(event: { isError?: boolean; details?: unknown }): boolean {
  if (event.isError === true) return false;
  const details = isPlainRecord(event.details) ? event.details : {};
  const exitCode = numericExitCode(details.exitCode ?? details.status);
  return exitCode === undefined || exitCode === 0;
}

export function boundedToolResultText(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
          .map((block) => String((block as { text?: unknown }).text ?? ""))
          .join("\n")
      : "";
  return text.slice(-20_000);
}

export function countChangedStringLeaves(before: unknown, after: unknown): number {
  if (typeof before === "string" && typeof after === "string") return before === after ? 0 : 1;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.reduce((total, item, index) => total + countChangedStringLeaves(item, after[index]), 0);
  }
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return 0;
  return Object.entries(before as Record<string, unknown>).reduce(
    (total, [key, value]) => total + countChangedStringLeaves(value, (after as Record<string, unknown>)[key]),
    0
  );
}

export function redactToolResultTextContent(content: unknown): { content: unknown; redacted: number } {
  if (!Array.isArray(content)) return { content, redacted: 0 };
  let redacted = 0;
  const safeContent = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") return block;
    const safeText = redactSensitiveText(typed.text);
    if (!safeText.redacted) return block;
    redacted += 1;
    return { ...block, text: safeText.text };
  });
  return { content: safeContent, redacted };
}

export function appendToolResultText(content: unknown, text: string): unknown[] {
  const block = { type: "text", text };
  if (Array.isArray(content)) return [...content, block];
  if (typeof content === "string" && content) return [{ type: "text", text: content }, block];
  return [block];
}
