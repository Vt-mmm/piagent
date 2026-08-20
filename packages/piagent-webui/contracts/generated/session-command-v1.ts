/* Generated from schemas/piagent-webui/session-command-v1.schema.json. Do not edit. */

export type PiagentGatewaySessionCommandAndReceiptV1 = Command | Receipt;
export type Command =
  | CreateCommand
  | SendCommand
  | AbortCommand
  | SessionOptionCommand
  | RenameCommand
  | PinCommand
  | EmptySessionCommand
  | ForkCommand;
export type CreateCommand = BaseCommandProperties & {
  action?: "session.create";
  sessionRef?: null;
  expectedSessionRevision?: null;
  payload?: {
    projectRef: string;
    placeRef: string;
    modelRef: string | null;
    thinkingLevel: ThinkingLevel;
    permissionMode?: PermissionMode;
    workflow?: Workflow;
    message: string;
    messageRequestId: string;
    /**
     * Create the durable session without dispatching the first turn so the client can stage selected attachments against the new session before sending it.
     */
    deferInitialMessage?: boolean;
  };
  [k: string]: any;
};
export type IdempotencyKey = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PermissionMode = "read-only" | "workspace-write" | "trusted-full-access";
export type Workflow =
  "task" | "scout" | "be-to-fe" | "discuss" | "plan" | "review" | "commit" | "pr" | "onboard" | "platform-improve";
export type SendCommand = BaseCommandProperties & {
  action?: "session.send";
  sessionRef?: string;
  expectedSessionRevision?: string;
  payload?: {
    [k: string]: any;
  };
  [k: string]: any;
};
export type AbortCommand = BaseCommandProperties & {
  action?: "session.abort";
  sessionRef?: string;
  expectedSessionRevision?: string;
  payload?: {
    operationRef: string;
    clearQueued: boolean;
  };
  [k: string]: any;
};
export type SessionOptionCommand = BaseCommandProperties & {
  [k: string]: any;
};
export type RenameCommand = BaseCommandProperties & {
  action?: "session.rename";
  sessionRef?: string;
  expectedSessionRevision?: string;
  payload?: {
    title: string;
  };
  [k: string]: any;
};
export type PinCommand = BaseCommandProperties & {
  action?: "session.pin";
  sessionRef?: string;
  expectedSessionRevision?: string;
  payload?: {
    pinned: boolean;
  };
  [k: string]: any;
};
export type EmptySessionCommand = BaseCommandProperties & {
  action?: "session.archive" | "session.unarchive" | "session.acquire" | "session.release";
  sessionRef?: string;
  expectedSessionRevision?: string;
  payload?: {};
  [k: string]: any;
};
export type ForkCommand = BaseCommandProperties & {
  action?: "session.fork";
  sessionRef?: string;
  expectedSessionRevision?: string;
  payload?: {
    entryRef: string | null;
    title: string | null;
  };
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

export interface BaseCommandProperties {
  schemaVersion: 1;
  version: "piagent-session-command-v1";
  messageType: "command";
  commandId: string;
  idempotencyKey: IdempotencyKey;
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
