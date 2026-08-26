export type ToolFailureReasonCode =
  | "target-not-found"
  | "search-target-missing"
  | "edit-anchor-not-unique"
  | "edit-anchor-stale"
  | "helper-dispatch-rejected"
  | "helper-insufficient-evidence"
  | "tool-result-failed";

function boundedText(content: unknown, depth = 0): string {
  if (depth > 2) return "";
  const nested = content && typeof content === "object" && !Array.isArray(content)
    ? (content as { content?: unknown }).content
    : undefined;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text")
      .map((item) => String((item as { text?: unknown }).text ?? "")).join("\n")
    : nested !== undefined ? boundedText(nested, depth + 1) : "";
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
  const text = boundedText(content);
  const subagent = /(?:^|[._-])subagents?(?:$|[._-])/i.test(toolName);
  // Some subagent providers return a successful tool envelope even though no
  // child was launched, or a zero-exit child explicitly reports that it could
  // inspect no evidence. Canonical replay must not turn either outcome into a
  // green "passed" Activity row merely because `isError` is false.
  if (subagent && /spawn limit reached|no children were started|declared run cannot fit/i.test(text)) {
    return "helper-dispatch-rejected";
  }
  if (subagent && /scope inspected:[^\n]{0,16}\bnone\b|insufficient-evidence rule|no source (?:content|evidence)[^\n]{0,80}(?:accessible|collected)/i.test(text)) {
    return "helper-insufficient-evidence";
  }
  if (!isError) return null;
  // Only the registered, policy-governed `edit` tool may receive an automatic
  // current-file recovery snapshot. A similarly named third-party `replace`
  // tool is not necessarily covered by Piagent's mutation guard.
  if (/^edit$/i.test(toolName)) {
    if (/\b(?:oldtext|old text)\b[^\n]{0,240}\b(?:unique|occurrences?)\b|\bfound\s+\d+\s+occurrences?\b/i.test(text)) {
      return "edit-anchor-not-unique";
    }
    if (/could not find (?:the )?exact text|\b(?:oldtext|old text)\b[^\n]{0,240}\b(?:match|mismatch|stale|changed|find)\b|\b(?:generation|content) drift\b/i.test(text)) {
      return "edit-anchor-stale";
    }
  }
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
