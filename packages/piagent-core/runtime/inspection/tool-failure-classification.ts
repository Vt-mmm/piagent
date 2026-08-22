export type ToolFailureReasonCode = "target-not-found" | "search-target-missing" | "tool-result-failed";

function boundedText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text")
      .map((item) => String((item as { text?: unknown }).text ?? "")).join("\n")
    : "";
  return text.slice(0, 8_192);
}

function commandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const direct = (input as { command?: unknown }).command;
  if (typeof direct === "string") return direct;
  const args = (input as { args?: unknown }).args;
  return args && typeof args === "object" && typeof (args as { command?: unknown }).command === "string"
    ? (args as { command: string }).command : "";
}

export function classifyToolFailure(toolName: string, isError: boolean, content: unknown, input?: unknown): ToolFailureReasonCode | null {
  if (!isError) return null;
  const text = boundedText(content);
  const readLike = /(?:^|[._-])(?:read|document[_-]?read)(?:$|[._-])/i.test(toolName);
  if (readLike && /\bENOENT\b|no such file or directory|file (?:does not exist|not found)|cannot find the (?:file|path)/i.test(text)) {
    return "target-not-found";
  }
  const shellLike = /^(?:bash|shell|exec|command)$/i.test(toolName);
  const searchCommand = /^\s*(?:rg|grep|git\s+grep)\b/.test(commandFromInput(input));
  const missingTarget = /no such file or directory|cannot find the (?:file|path)|\bos error 2\b/i.test(text);
  const usefulMatches = text.split(/\r?\n/).some((line) => !/^\s*(?:rg|grep):/i.test(line) && /^.+?:\d+:/.test(line));
  if (shellLike && searchCommand && missingTarget && usefulMatches) return "search-target-missing";
  return "tool-result-failed";
}

export function handledToolFailure(reasonCode: unknown): boolean {
  return reasonCode === "search-target-missing";
}
