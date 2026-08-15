/* Generated from schemas/piagent-webui/transcript-v1.schema.json. Do not edit. */

export type PiagentWebUIBoundedTranscriptProjectionV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-transcript-v1";
  generatedAt: string;
  identity: Identity;
  revision: DomainRevision;
  eventCursor: string;
  state: "ready" | "unavailable";
  /**
   * @maxItems 200
   */
  items: TranscriptItem[];
  page: Page;
  reasonCode: string | null;
};
export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: null;
  toolCallId: null;
};
export type TranscriptItem = {
  [k: string]: any;
} & {
  messageRef: string;
  parentMessageRef: string | null;
  role: "user" | "assistant" | "tool-result";
  recordedAt: string;
  agentOperationId: string | null;
  turnIndex: NullableCount;
  content: Content;
  /**
   * @maxItems 64
   */
  toolCalls: ToolCall[];
};
export type NullableCount = number | null;
export type Content = {
  [k: string]: any;
} & {
  state: "available" | "redacted" | "unavailable";
  text: NullableSafeTranscriptText;
  textChars: NullableCount;
  digest: string | null;
  truncated: boolean;
  redacted: boolean;
  imageCount: number;
  reasonCode: string | null;
};
export type NullableSafeTranscriptText = SafeTranscriptText | null;
export type SafeTranscriptText = string;
export type Page = {
  [k: string]: any;
} & {
  beforeCursor: string | null;
  nextBeforeCursor: string | null;
  hasOlder: boolean;
  limit: number;
  truncated: boolean;
};

export interface DomainRevision {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
}
export interface ToolCall {
  toolCallRef: string;
  toolName: string;
  state: "requested" | "completed" | "failed" | "unknown";
}
