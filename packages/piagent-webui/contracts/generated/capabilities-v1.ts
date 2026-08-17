/* Generated from schemas/piagent-webui/capabilities-v1.schema.json. Do not edit. */

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
  runtimeBuild: BuildIdentity;
  serverBuild: BuildIdentity;
  capabilities: {
    inspect: InspectCapability;
    "control.chat": ChatCapability;
    "control.lifecycle": LifecycleCapability;
    "control.resumeAndContinue": ResumeAndContinueCapability;
    "control.sessionOptions": SessionOptionsCapability;
    attachments: AttachmentsCapability;
    approve: ApproveCapability;
    reviewActions: ReviewActionsCapability;
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
export type BuildIdentity = AvailableBuildIdentity | UnavailableBuildIdentity;
export type InspectCapability = AvailableInspectCapability | UnavailableCapability;
export type AvailableInspectCapability = AvailableCapabilityBase & {
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
    | ["task" | "working-tree" | "staged", "task" | "working-tree" | "staged", "task" | "working-tree" | "staged"];
};
export type ChatCapability = AvailableChatCapability | UnavailableCapability;
export type ActionAvailability =
  | {
      available: true;
      reasonCode: null;
    }
  | {
      available: false;
      reasonCode: string;
    };
export type LifecycleCapability = AvailableLifecycleCapability | UnavailableCapability;
export type OperationPhase =
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
export type PhaseStopSupport =
  | {
      stop: "supported";
      reasonCode: null;
    }
  | {
      stop: "unsupported" | "unknown";
      reasonCode: string;
    };
export type ResumeAndContinueCapability = AvailableResumeAndContinueCapability | UnavailableCapability;
export type SessionOptionsCapability = AvailableSessionOptionsCapability | UnavailableCapability;
export type AttachmentsCapability = AvailableAttachmentsCapability | UnavailableCapability;
export type ApproveCapability = AvailableApproveCapability | UnavailableCapability;
export type ReviewActionsCapability = AvailableReviewActionsCapability | UnavailableCapability;

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
    send: ActionAvailability;
    hold: ActionAvailability;
    editHeld: ActionAvailability;
    deleteHeld: ActionAvailability;
    dispatchHeld: ActionAvailability;
    interruptAndSend: ActionAvailability;
  };
}
export interface AvailableLifecycleCapability {
  status: "available";
  version: 1;
  reason: null;
  currentPhase: OperationPhase;
  actions: {
    pause: ActionAvailability;
    resume: ActionAvailability;
  };
  stopPhaseSupport: {
    idle: PhaseStopSupport;
    "input-preflight": PhaseStopSupport;
    model: PhaseStopSupport;
    "tool-preflight": PhaseStopSupport;
    "waiting-approval": PhaseStopSupport;
    tool: PhaseStopSupport;
    retry: PhaseStopSupport;
    compaction: PhaseStopSupport;
    "branch-summary": PhaseStopSupport;
    "direct-bash": PhaseStopSupport;
    settling: PhaseStopSupport;
    other: PhaseStopSupport;
    unknown: PhaseStopSupport;
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
    setModel: ActionAvailability;
    setThinking: ActionAvailability;
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
    reviewMark: ActionAvailability;
    stage: ActionAvailability;
    unstage: ActionAvailability;
    revert: ActionAvailability;
    openInVsCode: ActionAvailability;
    generateCommitSummaryDeterministic: ActionAvailability;
    generateCommitSummaryModel: ActionAvailability;
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
