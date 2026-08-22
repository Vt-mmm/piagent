/* Generated from schemas/piagent-webui/gateway-protocol-v1.schema.json. Do not edit. */

export type PiagentGatewayProtocolEnvelopeV1 = Connect | Hello | Request | SuccessResponse | ErrorResponse | Event;
export type StateVersion = number;
export type PiagentGatewayCapabilityHandshakeV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-gateway-capabilities-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  protocol: {
    minimum: 1;
    maximum: 1;
    selected: number | null;
    compatibility: "ready" | "incompatible" | "resync-required";
  };
  mode: "full" | "read-only" | "unavailable";
  capabilities: {
    catalog: Capability;
    events: Capability;
    terminalAdapter: Capability;
    sessionRuntime: Capability;
    sessionActions: {
      create: Capability;
      send: Capability;
      abort: Capability;
      setModel: Capability;
      setThinking: Capability;
      setPermission: Capability;
      rename: Capability;
      pin: Capability;
      archive: Capability;
      unarchive: Capability;
      fork: Capability;
      acquire: Capability;
      release: Capability;
    };
  };
  reasonCode: string | null;
};
export type Capability = {
  [k: string]: any;
} & {
  status: "available" | "unavailable";
  version: number | null;
  reasonCode: string | null;
};
export type Request = HealthRequest | ListRequest | GetRequest | CommandRequest;
export type HealthRequest = RequestBase & {
  method?: "gateway.health";
  params?: {};
  [k: string]: any;
};
export type RequestId = string;
export type Method = "gateway.health" | "sessions.list" | "sessions.get" | "sessions.command";
export type ListRequest = RequestBase & {
  method?: "sessions.list";
  params?: {
    cursor: string | null;
    limit: number;
    filter: "active" | "archived" | "all";
    query: string | null;
    projectRef: string | null;
  };
  [k: string]: any;
};
export type GetRequest = RequestBase & {
  method?: "sessions.get";
  params?: {
    sessionRef: string;
  };
  [k: string]: any;
};
export type CommandRequest = RequestBase & {
  method?: "sessions.command";
  params?: {
    command:
      | (BaseCommandProperties & {
          action?: "session.create";
          sessionRef?: null;
          expectedSessionRevision?: null;
          payload?: {
            projectRef: string;
            placeRef: string;
            modelRef: string | null;
            thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
            permissionMode?: "read-only" | "workspace-write" | "trusted-full-access";
            workflow?:
              | "task"
              | "scout"
              | "be-to-fe"
              | "discuss"
              | "plan"
              | "review"
              | "commit"
              | "pr"
              | "onboard"
              | "platform-improve";
            message: string;
            messageRequestId: string;
            /**
             * Create the durable session without dispatching the first turn so the client can stage selected attachments against the new session before sending it.
             */
            deferInitialMessage?: boolean;
          };
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          action?: "session.send";
          sessionRef?: string;
          expectedSessionRevision?: string;
          payload?: {
            [k: string]: any;
          };
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          action?: "session.abort";
          sessionRef?: string;
          expectedSessionRevision?: string;
          payload?: {
            operationRef: string;
            clearQueued: boolean;
          };
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          action?: "session.rename";
          sessionRef?: string;
          expectedSessionRevision?: string;
          payload?: {
            title: string;
          };
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          action?: "session.pin";
          sessionRef?: string;
          expectedSessionRevision?: string;
          payload?: {
            pinned: boolean;
          };
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          action?: "session.archive" | "session.unarchive" | "session.acquire" | "session.release";
          sessionRef?: string;
          expectedSessionRevision?: string;
          payload?: {};
          [k: string]: any;
        })
      | (BaseCommandProperties & {
          action?: "session.fork";
          sessionRef?: string;
          expectedSessionRevision?: string;
          payload?: {
            entryRef: string | null;
            title: string | null;
          };
          [k: string]: any;
        });
  };
  [k: string]: any;
};
export type SuccessResponse = HealthResponse | ListResponse | GetResponse | CommandResponse;
export type HealthResponse = ResponseBase & {
  method?: "gateway.health";
  ok?: true;
  result?: PiagentGatewayCapabilityHandshakeV1;
  error?: null;
  [k: string]: any;
};
export type ListResponse = ResponseBase & {
  method?: "sessions.list";
  ok?: true;
  result?: Catalog;
  error?: null;
  [k: string]: any;
};
export type Catalog = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-session-catalog-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  state: "ready" | "unavailable";
  catalogRevision: string | null;
  /**
   * @maxItems 200
   */
  sessions: SessionRow[];
  page: Page;
  reasonCode: string | null;
};
export type SessionRow = {
  [k: string]: any;
} & {
  sessionRef: string;
  projectRef: string;
  title: string;
  projectLabel: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  state:
    | "offline"
    | "gateway-starting"
    | "gateway-owned"
    | "terminal-owned"
    | "handoff-pending"
    | "recovery-required"
    | "archived";
  liveState: "offline" | "idle" | "running" | "paused" | "waiting-approval" | "uncertain";
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  composerAvailable: boolean;
  needsAttention: boolean;
  modelLabel: string | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "unknown";
  contextUsage: ContextUsage;
  task: null | {
    taskRef: string;
    summary: string;
    outcome: "pending" | "completed" | "blocked" | "partial" | "failed" | "unknown";
    progressCompleted: number;
    progressTotal: number;
  };
  owner:
    | {
        kind: "none";
        ownerEpoch: null;
        gatewayInstanceRef: null;
        runtimeInstanceRef: null;
        continuity: "released" | "unknown";
      }
    | {
        kind: "gateway";
        ownerEpoch: string;
        gatewayInstanceRef: string;
        runtimeInstanceRef: string;
        continuity: "exact" | "uncertain";
      }
    | {
        kind: "terminal";
        ownerEpoch: string;
        gatewayInstanceRef: string;
        runtimeInstanceRef: string;
        continuity: "exact" | "uncertain";
      };
  sessionRevision: string;
  reasonCode: string | null;
};
export type ContextUsage = {
  [k: string]: any;
} & {
  usedTokens: number | null;
  contextWindow: number | null;
  ratio: number | null;
  state: "known" | "unknown";
};
export type GetResponse = ResponseBase & {
  method?: "sessions.get";
  ok?: true;
  result?: SessionDetail;
  error?: null;
  [k: string]: any;
};
export type CommandResponse = ResponseBase & {
  method?: "sessions.command";
  ok?: true;
  result?: Receipt;
  error?: null;
  [k: string]: any;
};
export type Receipt = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-session-receipt-v1";
  messageType: "receipt";
  commandId: string;
  idempotencyKeyDigest: string;
  action:
    | "session.create"
    | "session.send"
    | "session.abort"
    | "session.set-model"
    | "session.set-thinking"
    | "session.set-permission"
    | "session.rename"
    | "session.pin"
    | "session.archive"
    | "session.unarchive"
    | "session.fork"
    | "session.acquire"
    | "session.release";
  phase: "accepted" | "settled" | "uncertain" | "rejected";
  resultCode:
    | "accepted"
    | "created"
    | "started"
    | "queued"
    | "steered"
    | "aborted"
    | "model-changed"
    | "thinking-changed"
    | "permission-changed"
    | "renamed"
    | "pinned"
    | "unpinned"
    | "archived"
    | "unarchived"
    | "forked"
    | "acquired"
    | "released"
    | "no-change"
    | "stale-revision"
    | "owner-conflict"
    | "recovery-required"
    | "invalid-command"
    | "expired"
    | "unavailable"
    | "effect-unknown";
  requestedAt: string;
  settledAt: string | null;
  sessionRef: string | null;
  operationRef: string | null;
  catalogRevisionAfter: string;
  sessionRevisionAfter: string | null;
  deduplicated: boolean;
  evidenceRef: string | null;
  error: null | {
    code: string;
    message: string;
  };
};
export type ErrorResponse = ResponseBase & {
  ok?: false;
  result?: null;
  error?: ProtocolError;
  [k: string]: any;
};
export type Event =
  | CatalogChangedEvent
  | SessionChangedEvent
  | RuntimeChangedEvent
  | ResyncRequiredEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | OperationSettledEvent
  | ToolEvent;
export type CatalogChangedEvent = EventBase & {
  kind?: "catalog.changed";
  payload?: {
    catalogRevision: string;
  };
  [k: string]: any;
};
export type SessionChangedEvent = EventBase & {
  kind?: "session.changed";
  payload?: {
    catalogRevision: string;
    session: SessionRow;
  };
  [k: string]: any;
};
export type RuntimeChangedEvent = EventBase & {
  kind?: "runtime.changed";
  payload?: {
    [k: string]: any;
  };
  [k: string]: any;
};
export type ResyncRequiredEvent = EventBase & {
  kind?: "resync.required";
  payload?: {
    reasonCode: string;
    earliestSequence: StateVersion;
    currentSequence: StateVersion;
  };
  [k: string]: any;
};
export type MessageDeltaEvent = EventBase & {
  kind?: "message.delta";
  payload?: {
    sessionRef: string;
    operationRef: string;
    messageRef: string;
    messageSequence: StateVersion;
    delta: string;
  };
  [k: string]: any;
};
export type MessageCompletedEvent = EventBase & {
  kind?: "message.completed";
  payload?: {
    sessionRef: string;
    operationRef: string;
    messageRef: string;
    sessionRevision: string;
    truncated: boolean;
  };
  [k: string]: any;
};
export type OperationSettledEvent = EventBase & {
  kind?: "operation.settled";
  payload?: OperationCompletedPayload | OperationIncompletePayload;
  [k: string]: any;
};
export type ToolEvent = EventBase & {
  [k: string]: any;
};

export interface Connect {
  schemaVersion: 1;
  version: "piagent-gateway-protocol-v1";
  messageType: "connect";
  clientRef: string;
  minimumProtocol: 1;
  maximumProtocol: 1;
  lastEventSequence: StateVersion | null;
  catalogRevision: string | null;
}
export interface Hello {
  schemaVersion: 1;
  version: "piagent-gateway-protocol-v1";
  messageType: "hello";
  capabilities: PiagentGatewayCapabilityHandshakeV1;
}
export interface RequestBase {
  schemaVersion: 1;
  version: "piagent-gateway-protocol-v1";
  messageType: "request";
  requestId: RequestId;
  method: Method;
  params: {
    [k: string]: any;
  };
}
export interface BaseCommandProperties {
  schemaVersion: 1;
  version: "piagent-session-command-v1";
  messageType: "command";
  commandId: string;
  idempotencyKey: string;
  action:
    | "session.create"
    | "session.send"
    | "session.abort"
    | "session.set-model"
    | "session.set-thinking"
    | "session.set-permission"
    | "session.rename"
    | "session.pin"
    | "session.archive"
    | "session.unarchive"
    | "session.fork"
    | "session.acquire"
    | "session.release";
  requestedAt: string;
  expiresAt: string;
  sessionRef: string | null;
  expectedCatalogRevision: string;
  expectedSessionRevision: string | null;
  payload: {
    [k: string]: any;
  };
}
export interface ResponseBase {
  schemaVersion: 1;
  version: "piagent-gateway-protocol-v1";
  messageType: "response";
  requestId: RequestId;
  method: Method;
  ok: boolean;
  stateVersion: StateVersion;
  result: any;
  error: any;
}
export interface Page {
  limit: number;
  returned: number;
  total: number;
  nextCursor: string | null;
  truncated: boolean;
}
export interface SessionDetail {
  schemaVersion: 1;
  version: "piagent-session-detail-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  catalogRevision: string;
  session: SessionRow;
}
export interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface EventBase {
  schemaVersion: 1;
  version: "piagent-gateway-protocol-v1";
  messageType: "event";
  sequence: StateVersion;
  stateVersion: StateVersion;
  generatedAt: string;
  kind:
    | "catalog.changed"
    | "session.changed"
    | "runtime.changed"
    | "resync.required"
    | "message.delta"
    | "message.completed"
    | "operation.settled"
    | "tool.started"
    | "tool.completed";
  payload: {
    [k: string]: any;
  };
}
export interface OperationCompletedPayload {
  sessionRef: string;
  operationRef: string;
  messageRef: string;
  sessionRevision: string;
  settlement: "completed";
  reasonCode: null;
}
export interface OperationIncompletePayload {
  sessionRef: string;
  operationRef: string;
  messageRef: string | null;
  sessionRevision: string | null;
  settlement: "blocked" | "aborted" | "error" | "unknown";
  reasonCode: string;
}
