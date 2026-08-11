const PERFORMANCE_REVIEW_RESULT_MAX_CHARS = 2 * 1024 * 1024;

/** Preserve a complete bounded review result before generic UI compaction. */
export function boundedPerformanceReviewResultText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length <= PERFORMANCE_REVIEW_RESULT_MAX_CHARS ? content : undefined;
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") continue;
    const value = String((block as { text?: unknown }).text ?? "");
    chars += value.length + (parts.length > 0 ? 1 : 0);
    if (chars > PERFORMANCE_REVIEW_RESULT_MAX_CHARS) return undefined;
    parts.push(value);
  }
  return parts.join("\n");
}
