import type { ToolCall, TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import { hasVisibleText } from "../../shared/text-visibility.ts";

export type ActivityKind = "read" | "image" | "command" | "edit" | "search" | "context" | "verify" | "generic";
export type ActivityState = ToolCall["state"] | "running" | "recovered";
export type CompletionGateState = "continuing" | "not-approved";

export function toolActivityKind(toolName: string): ActivityKind {
  const value = toolName.toLowerCase();
  if (/(?:view[_-]?image|image[_-]?(?:read|view))/.test(value)) return "image";
  if (/(?:apply[_-]?patch|edit|write|create[_-]?file|replace)/.test(value)) return "edit";
  if (/(?:bash|exec|shell|terminal|command)/.test(value)) return "command";
  if (/(?:web|search|browser|fetch)/.test(value)) return "search";
  if (/(?:compact|context|memory)/.test(value)) return "context";
  if (/(?:test|verify|check|lint)/.test(value)) return "verify";
  if (/(?:read|grep|find|list|glob|document)/.test(value)) return "read";
  return "generic";
}

export function assistantTextPresentation(text: string): { text: string; completionGate: CompletionGateState | null } {
  const match = /^\[Piagent completion gate: (CONTINUING|NOT APPROVED)\][\t ]*/i.exec(text);
  if (!match) return { text, completionGate: null };
  const state = match[1]?.toUpperCase() === "CONTINUING" ? "continuing" : "not-approved";
  const separator = text.indexOf("\n\n", match[0].length);
  return { text: separator < 0 ? "" : text.slice(separator + 2).trimStart(), completionGate: state };
}

export function successfulAssistantText(text: string): string | null {
  const presentation = assistantTextPresentation(text);
  return presentation.completionGate === null && hasVisibleText(presentation.text) ? presentation.text : null;
}

export function conversationTranscriptItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const visible: TranscriptItem[] = [];
  const assistantIndexes = new Map<string, number>();
  for (const item of items) {
    if (item.role === "user") {
      assistantIndexes.clear(); visible.push(item); continue;
    }
    if (item.role !== "assistant") continue;
    // Assistant prose attached to a tool request is progress, not a terminal
    // response. Its command/result belongs in Activity.
    if (item.toolCalls.length > 0) continue;
    const text = successfulAssistantText(item.content.text ?? "");
    if (!text) continue;
    const previous = assistantIndexes.get(text.trim());
    if (previous === undefined) {
      assistantIndexes.set(text.trim(), visible.length); visible.push(item);
    } else visible[previous] = item;
  }
  return visible;
}

export function finalTranscriptToolStates(items: readonly TranscriptItem[]): ReadonlyMap<string, ToolCall["state"]> {
  const values = new Map<string, ToolCall["state"]>();
  for (const item of items) for (const tool of item.toolCalls) values.set(tool.toolCallRef, tool.state);
  return values;
}

export function recoveredActivityRefs(
  activities: readonly { toolCallRef: string; toolName: string; state: ActivityState }[]
): ReadonlySet<string> {
  const successfulKinds = new Set<ActivityKind>(), recovered = new Set<string>();
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    const kind = toolActivityKind(activity.toolName);
    if (activity.state === "completed" || activity.state === "recovered") successfulKinds.add(kind);
    else if (activity.state === "failed" && successfulKinds.has(kind)) recovered.add(activity.toolCallRef);
  }
  return recovered;
}

export function recoveredTranscriptToolRefs(
  items: readonly TranscriptItem[], finalStates: ReadonlyMap<string, ToolCall["state"]>
): ReadonlySet<string> {
  const recovered = new Set<string>();
  let turnActivities: Array<{ toolCallRef: string; toolName: string; state: ActivityState }> = [];
  const flush = () => {
    for (const toolCallRef of recoveredActivityRefs(turnActivities)) recovered.add(toolCallRef);
    turnActivities = [];
  };
  for (const item of items) {
    if (item.role === "user") flush();
    else for (const tool of item.toolCalls) turnActivities.push({
      toolCallRef: tool.toolCallRef,
      toolName: tool.toolName,
      state: finalStates.get(tool.toolCallRef) ?? tool.state
    });
  }
  flush();
  return recovered;
}

export function settledTranscriptToolRefs(
  items: readonly TranscriptItem[], finalStates: ReadonlyMap<string, ToolCall["state"]>
): ReadonlySet<string> {
  const settled = new Set(recoveredTranscriptToolRefs(items, finalStates));
  let activities: Array<{ toolCallRef: string; state: ActivityState; order: number }> = [], latestResponseOrder = -1, order = 0;
  const flush = () => {
    for (const activity of activities) if (activity.state === "failed" && activity.order < latestResponseOrder) settled.add(activity.toolCallRef);
    activities = []; latestResponseOrder = -1;
  };
  for (const item of items) {
    order += 1;
    if (item.role === "user") flush();
    else {
      for (const tool of item.toolCalls) activities.push({
        toolCallRef: tool.toolCallRef,
        state: finalStates.get(tool.toolCallRef) ?? tool.state,
        order
      });
      if (item.role === "assistant" && hasVisibleText(item.content.text ?? "")) latestResponseOrder = order;
    }
  }
  flush();
  return settled;
}
