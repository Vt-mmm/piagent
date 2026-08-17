/* Generated from schemas/piagent-webui/snapshot-v1.schema.json. Do not edit. */

export type PiagentWebUICanonicalSnapshotV1 = {
  [k: string]: any;
} & (
  | {
      session?: {
        verificationState?: "not-run";
        [k: string]: any;
      };
      verification?: {
        state?: "not-run";
        [k: string]: any;
      };
      [k: string]: any;
    }
  | {
      session?: {
        verificationState?: "running";
        [k: string]: any;
      };
      verification?: {
        state?: "running";
        [k: string]: any;
      };
      [k: string]: any;
    }
  | {
      session?: {
        verificationState?: "current";
        [k: string]: any;
      };
      verification?: {
        state?: "current";
        [k: string]: any;
      };
      [k: string]: any;
    }
  | {
      session?: {
        verificationState?: "failed";
        [k: string]: any;
      };
      verification?: {
        state?: "failed";
        [k: string]: any;
      };
      [k: string]: any;
    }
  | {
      session?: {
        verificationState?: "stale";
        [k: string]: any;
      };
      verification?: {
        state?: "stale";
        [k: string]: any;
      };
      [k: string]: any;
    }
  | {
      session?: {
        verificationState?: "unavailable";
        [k: string]: any;
      };
      verification?: {
        state?: "unavailable";
        [k: string]: any;
      };
      [k: string]: any;
    }
) &
  (
    | {
        session?: {
          approvalState?: "none";
          [k: string]: any;
        };
        approvals?: {
          state?: "none";
          [k: string]: any;
        };
        [k: string]: any;
      }
    | {
        session?: {
          approvalState?: "waiting";
          [k: string]: any;
        };
        approvals?: {
          state?: "waiting";
          [k: string]: any;
        };
        [k: string]: any;
      }
    | {
        session?: {
          approvalState?: "resolved";
          [k: string]: any;
        };
        approvals?: {
          state?: "resolved";
          [k: string]: any;
        };
        [k: string]: any;
      }
    | {
        session?: {
          approvalState?: "expired";
          [k: string]: any;
        };
        approvals?: {
          state?: "expired";
          [k: string]: any;
        };
        [k: string]: any;
      }
    | {
        session?: {
          approvalState?: "unknown";
          [k: string]: any;
        };
        approvals?: {
          state?: "unknown";
          [k: string]: any;
        };
        [k: string]: any;
      }
  ) & {
    schemaVersion: 1;
    version: "piagent-webui-snapshot-v1";
    generatedAt: string;
    identity: Identity;
    revision: SnapshotRevision;
    capabilities: PiagentWebUICapabilityHandshakeV1;
    session: Session;
    task: Task | null;
    sourceChanges: SourceChanges;
    activity: ActivitySummary;
    approvals: ApprovalSummary;
    verification: Verification;
    usage: Usage;
    continuation: Continuation;
    handoff: Handoff | null;
    health: AggregateHealth;
  };
export type Identity = {
  [k: string]: any;
} & {
  projectRef: string;
  runtimeInstanceId: string;
  sessionRef: string;
  taskId: string | null;
  taskRunId: string | null;
  agentOperationId: string | null;
  toolCallId: string | null;
};
export type PiagentWebUICapabilityHandshakeV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-webui-capabilities-v1";
  generatedAt: string;
  protocolMin: 1;
  protocolMax: 1;
  /**
   * @minItems 1
   * @maxItems 16
   */
  supportedSnapshotVersions:
    | [number]
    | [number, number]
    | [number, number, number]
    | [number, number, number, number]
    | [number, number, number, number, number]
    | [number, number, number, number, number, number]
    | [number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number, number, number, number]
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ];
  /**
   * @minItems 1
   * @maxItems 16
   */
  supportedEventVersions:
    | [number]
    | [number, number]
    | [number, number, number]
    | [number, number, number, number]
    | [number, number, number, number, number]
    | [number, number, number, number, number, number]
    | [number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number, number, number]
    | [number, number, number, number, number, number, number, number, number, number, number, number, number, number]
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ];
  mode: "unavailable" | "inspect-only" | "control-enabled";
  compatibility: Compatibility;
  identity: Identity;
  runtimeBuild: AvailableBuildIdentity | UnavailableBuildIdentity;
  serverBuild: AvailableBuildIdentity | UnavailableBuildIdentity;
  capabilities: {
    inspect:
      | (AvailableCapabilityBase & {
          status: "available";
          version: 1;
          reason: null;
          /**
           * @minItems 1
           * @maxItems 3
           */
          sourceViews:
            | ["task" | "working-tree" | "staged"]
            | ["task" | "working-tree" | "staged", "task" | "working-tree" | "staged"]
            | [
                "task" | "working-tree" | "staged",
                "task" | "working-tree" | "staged",
                "task" | "working-tree" | "staged"
              ];
        })
      | UnavailableCapability;
    "control.chat": AvailableChatCapability | UnavailableCapability;
    "control.lifecycle": AvailableLifecycleCapability | UnavailableCapability;
    "control.resumeAndContinue": AvailableResumeAndContinueCapability | UnavailableCapability;
    "control.sessionOptions": AvailableSessionOptionsCapability | UnavailableCapability;
    attachments: AvailableAttachmentsCapability | UnavailableCapability;
    approve: AvailableApproveCapability | UnavailableCapability;
    reviewActions: AvailableReviewActionsCapability | UnavailableCapability;
  };
  replay: Replay;
  limits: ResourceLimits;
};
export type Compatibility = {
  [k: string]: any;
} & {
  state: "compatible" | "degraded" | "incompatible" | "resync-required";
  reason: StateReason | null;
};
export type HostPhaseFact = {
  [k: string]: any;
} & {
  state: KnownFactState;
  value:
    | (
        | "idle"
        | "input-preflight"
        | "model"
        | "tool-preflight"
        | "waiting-approval"
        | "tool"
        | "retry"
        | "compaction"
        | "branch-summary"
        | "direct-bash"
        | "settling"
        | "other"
        | "unknown"
      )
    | null;
  evidence: "observed" | "derived" | null;
  reasonCode: string | null;
};
export type KnownFactState = "known" | "unknown" | "unavailable" | "disconnected" | "resync-required";
export type ModelFact = {
  [k: string]: any;
} & {
  state: KnownFactState;
  value: Model | null;
  evidence: "observed" | "derived" | null;
  reasonCode: string | null;
};
export type ThinkingFact = {
  [k: string]: any;
} & {
  state: KnownFactState;
  value: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  evidence: "observed" | "derived" | null;
  reasonCode: string | null;
};
export type Queue = {
  [k: string]: any;
} & {
  state: "known" | "unknown" | "unavailable" | "disconnected" | "resync-required";
  hasPending: boolean | null;
  heldCount: number | null;
  revision: string | null;
  reasonCode: string | null;
};
export type ContextUsage = {
  [k: string]: any;
} & {
  state: "known" | "unknown" | "unavailable" | "disconnected";
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  capturedAt: string | null;
  reasonCode: string | null;
};
export type SourceViewSummary = {
  [k: string]: any;
} & {
  view: "task" | "working-tree" | "staged";
  base: "task-baseline" | "HEAD" | "index";
  state: "ready" | "loading" | "stale" | "unavailable" | "unknown";
  revision: string | null;
  counts: {
    files: number;
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    untracked: number;
    conflicted: number;
    additions: number | null;
    deletions: number | null;
  };
  health: Health;
};
export type Health = {
  [k: string]: any;
} & {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  reasonCode: string | null;
  message: string | null;
};
export type ApprovalSummary = {
  [k: string]: any;
} & {
  state: "none" | "waiting" | "resolved" | "expired" | "unknown";
  /**
   * @maxItems 32
   */
  pending: ApprovalSummaryItem[];
  /**
   * @maxItems 64
   */
  recent: ApprovalSummaryItem[];
  health: Health;
};
export type ApprovalSummaryItem = {
  [k: string]: any;
} & {
  approvalRef: string;
  state: "waiting" | "resolved" | "expired" | "unknown";
  resolution: "allow" | "deny" | "cancelled" | "expired" | null;
  actionSummary: string;
  toolCallId: string | null;
  expiresAt: string | null;
  reasonCode: string | null;
};
export type Verification = {
  [k: string]: any;
} & {
  state: "not-run" | "running" | "current" | "failed" | "stale" | "unavailable";
  latest: VerifierAttempt | null;
  /**
   * @maxItems 64
   */
  requiredCommands: string[];
  reasonCode: string | null;
  health: Health;
};
export type UsageCounter = {
  [k: string]: any;
} & {
  state: "known" | "unknown" | "unavailable";
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cost: number | null;
  currency: "USD" | null;
  reasonCode: string | null;
};
export type Continuation = {
  [k: string]: any;
} & {
  state: "available" | "reserved" | "exhausted" | "not-applicable" | "unknown";
  consumed: number | null;
  maximum: number | null;
  remaining: number | null;
  reservationRef: string | null;
  reasonCode: string | null;
};

export interface SnapshotRevision {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
  journalHead: string | null;
  eventCursor: string;
}
export interface StateReason {
  code: string;
  message: string;
}
export interface AvailableBuildIdentity {
  state: "available";
  buildId: string;
  version: string;
  reason: null;
}
export interface UnavailableBuildIdentity {
  state: "unavailable";
  buildId: null;
  version: null;
  reason: StateReason;
}
export interface AvailableCapabilityBase {
  status: "available";
  version: 1;
  reason: null;
  [k: string]: any;
}
export interface UnavailableCapability {
  status: "unavailable";
  version: null;
  reason: StateReason;
}
export interface AvailableChatCapability {
  status: "available";
  version: 1;
  reason: null;
  queuePersistence: "runtime-lifetime" | "runtime-restart-revalidation";
  actions: {
    send:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    hold:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    editHeld:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    deleteHeld:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    dispatchHeld:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    interruptAndSend:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
  };
}
export interface AvailableLifecycleCapability {
  status: "available";
  version: 1;
  reason: null;
  currentPhase:
    | "idle"
    | "input-preflight"
    | "model"
    | "tool-preflight"
    | "waiting-approval"
    | "tool"
    | "retry"
    | "compaction"
    | "branch-summary"
    | "direct-bash"
    | "settling"
    | "other"
    | "unknown";
  actions: {
    pause:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    resume:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
  };
  stopPhaseSupport: {
    idle:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    "input-preflight":
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    model:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    "tool-preflight":
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    "waiting-approval":
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    tool:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    retry:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    compaction:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    "branch-summary":
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    "direct-bash":
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    settling:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    other:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
    unknown:
      | {
          stop: "supported";
          reasonCode: null;
        }
      | {
          stop: "unsupported" | "unknown";
          reasonCode: string;
        };
  };
}
export interface AvailableResumeAndContinueCapability {
  status: "available";
  version: 1;
  reason: null;
  delivery: "new-operation";
  /**
   * @minItems 2
   * @maxItems 2
   */
  requires: never[];
}
export interface AvailableSessionOptionsCapability {
  status: "available";
  version: 1;
  reason: null;
  effectScope: "session" | "session-and-user-default";
  /**
   * @minItems 1
   * @maxItems 2
   */
  allowedLifecyclePoints: ["idle" | "pre-fresh-task"] | ["idle" | "pre-fresh-task", "idle" | "pre-fresh-task"];
  actions: {
    setModel:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    setThinking:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
  };
}
export interface AvailableAttachmentsCapability {
  status: "available";
  version: 1;
  reason: null;
  /**
   * @minItems 1
   * @maxItems 3
   */
  kinds:
    | ["file" | "image" | "document"]
    | ["file" | "image" | "document", "file" | "image" | "document"]
    | ["file" | "image" | "document", "file" | "image" | "document", "file" | "image" | "document"];
  /**
   * @minItems 1
   * @maxItems 64
   */
  mimeTypes: [string, ...string[]];
}
export interface AvailableApproveCapability {
  status: "available";
  version: 1;
  reason: null;
  /**
   * @minItems 2
   * @maxItems 2
   */
  decisions: ["allow" | "deny", "allow" | "deny"];
  arbitration: "first-valid-cas";
}
export interface AvailableReviewActionsCapability {
  status: "available";
  version: 1;
  reason: null;
  actions: {
    reviewMark:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    stage:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    unstage:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    revert:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    openInVsCode:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    generateCommitSummaryDeterministic:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
    generateCommitSummaryModel:
      | {
          available: true;
          reasonCode: null;
        }
      | {
          available: false;
          reasonCode: string;
        };
  };
}
export interface Replay {
  eventRetentionCount: number;
  eventRetentionSeconds: number;
  resyncSupported: true;
}
export interface ResourceLimits {
  maxRequestBodyBytes: number;
  maxEventPayloadBytes: number;
  maxReplayEvents: number;
  maxDiffBytes: number;
  maxDiffLines: number;
  maxDiffHunks: number;
  maxLogPreviewBytes: number;
  maxLogPreviewLines: number;
  maxAttachmentCount: number;
  maxAttachmentFileBytes: number;
  maxAttachmentTotalBytes: number;
  maxQueueItems: number;
  maxMessageBytes: number;
  maxSseClients: number;
  maxGitProcesses: number;
  requestTimeoutMs: number;
}
export interface Session {
  connectionState: "connected" | "disconnected" | "reconnecting" | "resync-required" | "unknown";
  connectionReason: string | null;
  displayName: string | null;
  operation: Operation;
  controlState: "active" | "pause-requested" | "paused" | "terminal" | "unknown";
  taskOutcome: "pending" | "completed" | "blocked" | "partial" | "failed" | null;
  approvalState: "none" | "waiting" | "resolved" | "expired" | "unknown";
  verificationState: "not-run" | "running" | "current" | "failed" | "stale" | "unavailable";
  permissionProfile: {
    [k: string]: any;
  };
  model: ModelFact;
  thinking: ThinkingFact;
  queue: Queue;
  context: ContextUsage;
}
export interface Operation {
  liveness: "idle" | "running" | "stopping" | "settled" | "unknown";
  operationRef: string | null;
  hostPhase: HostPhaseFact;
  startedAt: string | null;
  settledAt: string | null;
  reasonCode: string | null;
}
export interface Model {
  modelRef: string;
  provider: string;
  modelId: string;
  displayName: string;
  reasoning: boolean;
  /**
   * @maxItems 8
   */
  inputCapabilities:
    | []
    | ["text" | "image" | "audio" | "document"]
    | ["text" | "image" | "audio" | "document", "text" | "image" | "audio" | "document"]
    | [
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document"
      ]
    | [
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document"
      ]
    | [
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document"
      ]
    | [
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document"
      ]
    | [
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document"
      ]
    | [
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document",
        "text" | "image" | "audio" | "document"
      ];
  /**
   * @maxItems 7
   */
  supportedThinkingLevels:
    | []
    | ["off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"]
    | [
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
      ]
    | [
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
      ]
    | [
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
      ]
    | [
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
      ]
    | [
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
      ]
    | [
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
      ];
  contextWindow: number;
  maxOutputTokens: number;
}
export interface Task {
  taskId: string;
  taskRunId: string;
  summary: string;
  changeMode: "source-change" | "read-only";
  riskLane: "low-risk" | "high-risk";
  outcome: "pending" | "completed" | "blocked" | "partial" | "failed";
  controlState: "active" | "pause-requested" | "paused" | "terminal" | "unknown";
  /**
   * @maxItems 64
   */
  criteria: Criterion[];
  /**
   * @maxItems 64
   */
  workPlan: WorkPlanStep[];
  /**
   * @maxItems 256
   */
  scope: string[];
  /**
   * @maxItems 256
   */
  outOfScope: string[];
  progress: {
    completed: number;
    total: number;
    percent: number;
  };
  blocker: string | null;
  reasonCode: string | null;
}
export interface Criterion {
  criterionId: string;
  obligation: string;
  priority: "normal" | "critical";
  state: "pending" | "satisfied" | "blocked" | "unknown";
  evidence: "observed" | "derived" | "unavailable";
  /**
   * @maxItems 300
   */
  relatedFileRefs: string[];
  /**
   * @maxItems 64
   */
  verifierAttemptRefs: string[];
  reasonCode: string | null;
}
export interface WorkPlanStep {
  stepId: string;
  summary: string;
  status: "pending" | "in-progress" | "done" | "skipped" | "failed";
  /**
   * @maxItems 12
   */
  criterionIds:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string];
}
export interface SourceChanges {
  task: SourceViewSummary & {
    view?: "task";
    [k: string]: any;
  };
  workingTree: SourceViewSummary & {
    view?: "working-tree";
    [k: string]: any;
  };
  staged: SourceViewSummary & {
    view?: "staged";
    [k: string]: any;
  };
}
export interface ActivitySummary {
  /**
   * @maxItems 32
   */
  running: Activity[];
  /**
   * @maxItems 200
   */
  recent: Activity[];
  page: Page;
  health: Health;
}
export interface Activity {
  activityRef: string;
  kind: "tool" | "command" | "verifier" | "approval" | "system";
  state: "requested" | "running" | "passed" | "failed" | "blocked" | "aborted" | "unknown";
  label: string;
  preview: string;
  toolCallId: string | null;
  toolName: string | null;
  commandDigest: string | null;
  logRef: string | null;
  exitCode: number | null;
  exitCodeExact: boolean;
  startedAt: string;
  finishedAt: string | null;
}
export interface Page {
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  returned: number;
  truncated: boolean;
}
export interface VerifierAttempt {
  attemptRef: string;
  command: string;
  commandDigest: string;
  exact: boolean;
  state: "running" | "passed" | "failed" | "blocked" | "aborted" | "stale" | "unknown";
  exitCode: number | null;
  exitCodeExact: boolean;
  treeDigest: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * @maxItems 300
   */
  staleByFileRefs: string[];
  /**
   * @maxItems 300
   */
  staleByPaths: string[];
  staleFilesKnown: boolean;
}
export interface Usage {
  context: ContextUsage;
  latestTurn: UsageCounter;
  sessionTotal: UsageCounter;
  taskTotal: UsageCounter;
  capturedAt: string;
  health: Health;
}
export interface Handoff {
  handoffRef: string;
  state: "ready" | "stale" | "unavailable" | "unknown";
  summary: string;
  blocker: string | null;
  nextSafeAction: string | null;
  /**
   * @maxItems 64
   */
  evidenceRefs: string[];
  generatedAt: string;
  reasonCode: string | null;
}
export interface AggregateHealth {
  state: "ok" | "degraded" | "error" | "unavailable" | "unknown";
  /**
   * @maxItems 128
   */
  issues: Issue[];
  resyncRequired: boolean;
  generatedFromRevision: string;
}
export interface Issue {
  issueRef: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  /**
   * @maxItems 32
   */
  relatedRefs: string[];
}
