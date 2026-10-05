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
  role: "user" | "assistant" | "tool-result" | "custom";
  recordedAt: string;
  agentOperationId: string | null;
  messageRequestId?: string | null;
  turnIndex: NullableCount;
  content: Content;
  /**
   * @maxItems 4
   */
  attachments?:
    | []
    | [AttachmentSummary]
    | [AttachmentSummary, AttachmentSummary]
    | [AttachmentSummary, AttachmentSummary, AttachmentSummary]
    | [AttachmentSummary, AttachmentSummary, AttachmentSummary, AttachmentSummary];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  model?: string;
  failure?: CompanyFailure;
  process?: HarnessProcess;
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
export interface AttachmentSummary {
  displayName: string;
  kind: "file" | "image" | "document";
  mimeType: string;
  truncated: boolean;
}
export interface CompanyFailure {
  role: "main" | "scout" | "research" | "verify" | "review";
  reasonCode: string;
  code: string;
  requestRef: string | null;
  local: boolean;
}
export interface HarnessProcess {
  phase: "plan" | "verify" | "review" | "final" | "objection" | "answer" | "claims" | "rejudge" | "dispute";
  outcome?:
    | "no_change"
    | "interrupted"
    | "disputed"
    | "blocking_open"
    | "unverified"
    | "review_unavailable"
    | "unreviewed"
    | "clean";
  role?: "scout" | "research" | "verify" | "review";
  by?: "main" | "harness";
  disputes?: number;
  unchanged?: true;
  /**
   * @maxItems 10
   */
  issues?:
    | []
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ]
    | [
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        },
        {
          kind: "wrong_premise" | "conflicts_with_request" | "ambiguous" | "out_of_scope";
          detail: string;
        }
      ];
  /**
   * @maxItems 10
   */
  claims?:
    | []
    | [
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ]
    | [
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        },
        {
          claim: string;
        }
      ];
  loop?: number;
  maxLoops?: number;
  verified?: boolean;
  reviewed?: boolean;
  blockingOpen?: number;
  planOpen?: number;
  planSkipped?: true;
  verifyPolicy?: "off" | "suggest" | "require";
  reviewPolicy?: "off" | "suggest" | "require";
  reviewUnavailable?: "too_large" | "not_git" | "limit" | "failed";
  /**
   * @maxItems 10
   */
  findings?:
    | []
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ]
    | [
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        },
        {
          severity: "blocking" | "major" | "minor";
          file: string;
          line: number | null;
          issue: string;
        }
      ];
}
export interface ToolCall {
  toolCallRef: string;
  toolName: string;
  state: "requested" | "completed" | "failed" | "unknown";
  summary?: {
    kind:
      | "read"
      | "write"
      | "edit"
      | "command"
      | "search"
      | "list"
      | "web-search"
      | "web-fetch"
      | "subagent"
      | "network"
      | "git"
      | "plan"
      | "other";
    target: string | null;
    detail: string | null;
  };
  change?: {
    added: number;
    removed: number;
    preview: string;
    truncated: boolean;
  };
  result?: {
    text: string;
    truncated: boolean;
    isError: boolean;
  };
  failure?: CompanyFailure;
}
