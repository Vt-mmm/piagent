export type RuntimeStreamEvent = { eventCursor?: string; recordedAt?: string; kind?: string; messageRef?: string | null; toolCallId?: string | null;
  payload?: Record<string, unknown> };
export type LiveAssistant = { messageRef: string; text: string; thinking: boolean; truncated: boolean };
export type LiveTool = { toolCallId: string; activityRef: string; toolName: string; state: string };
export type TranscriptPageItem = { messageRef: string };

const MAX_LIVE_TEXT = 16_384;

export function mergeOlderTranscriptPage<T extends TranscriptPageItem>(current: T[], older: T[]): T[] {
  const values = new Map<string, T>();
  for (const item of [...older, ...current]) if (!values.has(item.messageRef)) values.set(item.messageRef, item);
  return [...values.values()].slice(0, 200);
}

export function liveChatState(events: RuntimeStreamEvent[]): { assistants: LiveAssistant[]; tools: LiveTool[] } {
  const assistants = new Map<string, LiveAssistant>(), tools = new Map<string, LiveTool>();
  for (const event of events.slice(-500)) {
    const kind = event.kind, payload = event.payload ?? {}, messageRef = event.messageRef;
    if (kind === "message.started" && payload.role === "assistant" && typeof messageRef === "string") {
      assistants.set(messageRef, { messageRef, text: "", thinking: false, truncated: false });
    } else if (kind === "message.text-delta" && typeof messageRef === "string" && typeof payload.delta === "string") {
      const current = assistants.get(messageRef); if (!current) continue;
      const combined = `${current.text}${payload.delta}`;
      assistants.set(messageRef, { ...current, text: combined.slice(0, MAX_LIVE_TEXT), truncated: current.truncated || combined.length > MAX_LIVE_TEXT });
    } else if (kind === "message.thinking-state" && typeof messageRef === "string") {
      const current = assistants.get(messageRef); if (!current) continue;
      assistants.set(messageRef, { ...current, thinking: payload.state !== "completed" });
    } else if (["message.completed", "message.failed"].includes(String(kind)) && typeof messageRef === "string") {
      assistants.delete(messageRef);
    }
    if (["activity.started", "activity.progress", "activity.finished", "activity.failed", "activity.blocked", "activity.aborted"].includes(String(kind))
      && typeof event.toolCallId === "string" && typeof payload.activityRef === "string" && typeof payload.toolName === "string") {
      tools.set(event.toolCallId, { toolCallId: event.toolCallId, activityRef: payload.activityRef, toolName: payload.toolName, state: String(payload.state ?? "unknown") });
    }
  }
  return { assistants: [...assistants.values()].slice(-2), tools: [...tools.values()].slice(-8) };
}
