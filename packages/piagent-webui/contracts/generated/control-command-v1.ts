/* Generated from schemas/piagent-webui/control-command-v1.schema.json. Do not edit. */

export type PiagentWebUIControlCommandAndReceiptV1 = Command | Receipt;
export type Command = CommandActionBindings & {
  schemaVersion: 1;
  version: "piagent-webui-control-v1";
  messageType: "command";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  capabilityScope: CapabilityScope;
  action: Action;
  actionDigest: string;
  identity: Identity;
  expectedRevisions: ExpectedRevisions;
  payload: {
    [k: string]: any;
  };
};
export type CommandActionBindings = {
  [k: string]: any;
};
export type CapabilityScope =
  "control.chat" | "control.lifecycle" | "control.resumeAndContinue" | "control.sessionOptions" | "reviewActions";
export type Action =
  | "chat.send"
  | "queue.update"
  | "queue.delete"
  | "queue.dispatch"
  | "lifecycle.stop"
  | "lifecycle.pause"
  | "lifecycle.resume"
  | "lifecycle.resume-and-continue"
  | "session-options.set-model"
  | "session-options.set-thinking"
  | "review.mark"
  | "source.stage"
  | "source.unstage"
  | "source.revert"
  | "source.open-in-vscode"
  | "commit-summary.generate";
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
export type Receipt = ReceiptActionResultBinding &
  ReceiptPhaseResultBinding & {
    [k: string]: any;
  } & {
    schemaVersion: 1;
    version: "piagent-webui-control-v1";
    messageType: "receipt";
    commandId: string;
    idempotencyKeyDigest: string;
    action: Action;
    actionDigest: string;
    identity: Identity;
    phase: "rejected" | "requested" | "accepted" | "settled" | "uncertain";
    resultCode:
      | "already-idle"
      | "stop-requested"
      | "stopped"
      | "unsupported-operation-phase"
      | "settlement-unknown"
      | "emergency-stop"
      | "audit-unavailable"
      | "pause-requested"
      | "paused"
      | "already-pausing"
      | "already-paused"
      | "pause-unconfirmed"
      | "resumed"
      | "already-active"
      | "pause-cancelled"
      | "resume-rejected"
      | "resumed-not-dispatched"
      | "held"
      | "updated"
      | "deleted"
      | "dispatch-requested"
      | "dispatch-observed"
      | "dispatch-rejected"
      | "dispatch-unknown"
      | "changed"
      | "unchanged"
      | "effect-unknown"
      | "reviewed"
      | "unreviewed"
      | "staged"
      | "unstaged"
      | "reverted"
      | "opened"
      | "summary-generated"
      | "stale-revision"
      | "identity-mismatch"
      | "capability-unavailable"
      | "replay"
      | "idempotency-payload-mismatch"
      | "terminal-task"
      | "expired"
      | "invalid-command"
      | "resync-required";
    requestedAt: string;
    settledAt: string | null;
    observedRevisionsBefore: DomainRevision;
    observedRevisionsAfter: DomainRevision;
    deduplicated: boolean;
    auditRef: string | null;
    settlementEvidenceRef: string | null;
    error: ControlError | null;
  };
export type ReceiptActionResultBinding =
  | {
      resultCode: GenericRejectedResultCode;
      [k: string]: any;
    }
  | (
      | {
          action: "chat.send";
          resultCode: "held" | "dispatch-requested" | "dispatch-observed" | "dispatch-rejected" | "dispatch-unknown";
          [k: string]: any;
        }
      | {
          action: "queue.update";
          resultCode: "updated";
          [k: string]: any;
        }
      | {
          action: "queue.delete";
          resultCode: "deleted";
          [k: string]: any;
        }
      | {
          action: "queue.dispatch";
          resultCode: "dispatch-requested" | "dispatch-observed" | "dispatch-rejected" | "dispatch-unknown";
          [k: string]: any;
        }
      | {
          action: "lifecycle.stop";
          resultCode:
            | "already-idle"
            | "stop-requested"
            | "stopped"
            | "unsupported-operation-phase"
            | "settlement-unknown"
            | "emergency-stop"
            | "audit-unavailable";
          [k: string]: any;
        }
      | {
          action: "lifecycle.pause";
          resultCode: "pause-requested" | "paused" | "already-pausing" | "already-paused" | "pause-unconfirmed";
          [k: string]: any;
        }
      | {
          action: "lifecycle.resume";
          resultCode: "resumed" | "already-active" | "pause-cancelled" | "resume-rejected";
          [k: string]: any;
        }
      | {
          action: "lifecycle.resume-and-continue";
          resultCode:
            | "dispatch-requested"
            | "dispatch-observed"
            | "dispatch-rejected"
            | "dispatch-unknown"
            | "resumed-not-dispatched";
          [k: string]: any;
        }
      | {
          action: "session-options.set-model" | "session-options.set-thinking";
          resultCode: "changed" | "unchanged" | "effect-unknown";
          [k: string]: any;
        }
      | {
          action: "review.mark";
          resultCode: "reviewed" | "unreviewed";
          [k: string]: any;
        }
      | {
          action: "source.stage";
          resultCode: "staged" | "effect-unknown";
          [k: string]: any;
        }
      | {
          action: "source.unstage";
          resultCode: "unstaged" | "effect-unknown";
          [k: string]: any;
        }
      | {
          action: "source.revert";
          resultCode: "reverted" | "effect-unknown";
          [k: string]: any;
        }
      | {
          action: "source.open-in-vscode";
          resultCode: "opened" | "effect-unknown";
          [k: string]: any;
        }
      | {
          action: "commit-summary.generate";
          resultCode: "summary-generated";
          [k: string]: any;
        }
    );
export type GenericRejectedResultCode =
  | "stale-revision"
  | "identity-mismatch"
  | "capability-unavailable"
  | "replay"
  | "idempotency-payload-mismatch"
  | "terminal-task"
  | "expired"
  | "invalid-command"
  | "resync-required";
export type ReceiptPhaseResultBinding =
  | {
      phase: "requested";
      resultCode: "stop-requested" | "pause-requested" | "dispatch-requested";
      settledAt: null;
      settlementEvidenceRef: null;
      error: null;
      [k: string]: any;
    }
  | {
      phase: "accepted";
      resultCode: "held" | "stop-requested" | "pause-requested" | "dispatch-requested";
      settledAt: null;
      settlementEvidenceRef: null;
      error: null;
      [k: string]: any;
    }
  | {
      phase: "settled";
      resultCode:
        | "already-idle"
        | "stopped"
        | "emergency-stop"
        | "paused"
        | "already-pausing"
        | "already-paused"
        | "resumed"
        | "already-active"
        | "pause-cancelled"
        | "updated"
        | "deleted"
        | "dispatch-observed"
        | "changed"
        | "unchanged"
        | "reviewed"
        | "unreviewed"
        | "staged"
        | "unstaged"
        | "reverted"
        | "opened"
        | "summary-generated";
      settledAt: string;
      settlementEvidenceRef: string;
      error: null;
      [k: string]: any;
    }
  | {
      phase: "rejected";
      resultCode: GenericRejectedResultCode | ("unsupported-operation-phase" | "resume-rejected" | "dispatch-rejected");
      settledAt: string;
      settlementEvidenceRef: null;
      error: ControlError;
      [k: string]: any;
    }
  | {
      phase: "uncertain";
      resultCode:
        | "settlement-unknown"
        | "audit-unavailable"
        | "pause-unconfirmed"
        | "dispatch-unknown"
        | "effect-unknown"
        | "resumed-not-dispatched";
      settledAt: string;
      settlementEvidenceRef: null;
      error: ControlError;
      [k: string]: any;
    };

export interface ExpectedRevisions {
  runtimeRevision: string;
  taskRevision: string | null;
  controlRevision: string | null;
  workspaceRevision: string | null;
  indexRevision: string | null;
  approvalRevision: string | null;
  sessionOptionRevision: string | null;
  queueRevision: string | null;
  workspacePreimage: string | null;
  indexPreimage: string | null;
  patchPreimage: string | null;
}
export interface ControlError {
  code: string;
  message: string;
  retryable: boolean;
}
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
