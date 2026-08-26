import { appendToolResultText, isPlainRecord } from "./tool-result-value-helpers.ts";

function handledNavigationText(reasonCode: string): string {
  const guidance = reasonCode === "target-is-directory"
    ? "List the directory once and choose a child"
    : "Discover from one confirmed parent";
  return `[Piagent navigation: ${reasonCode} — handled negative evidence, not a runtime failure. ${guidance}; do not retry this call.]`;
}

export function handledNavigationToolResult(input: {
  toolName: string;
  reasonCode: string;
  targetPath?: string;
  content: unknown;
  details: unknown;
  redactText: (value: string) => string;
}): { content: unknown; details: unknown } {
  const targetPath = input.targetPath
    ? input.redactText(input.targetPath).replace(/\s+/g, " ").trim().slice(0, 1_024) || undefined
    : undefined;
  const navigation = {
    schemaVersion: 1,
    handled: true,
    reasonCode: input.reasonCode,
    targetPath,
    retryExactCall: false
  };
  const text = handledNavigationText(input.reasonCode);
  const content = ["read", "grep", "find", "ls"].includes(input.toolName)
    ? [{ type: "text", text }]
    : appendToolResultText(input.content, text);
  const details = isPlainRecord(input.details)
    ? { ...input.details, piagentNavigation: navigation }
    : { ...(input.details === undefined ? {} : { value: input.details }), piagentNavigation: navigation };
  return { content, details };
}
