/* Generated from schemas/piagent-webui/runtime-command-v1.schema.json. Do not edit. */

export type PiagentWebUITypedRuntimeCommandAndReceiptV1 = Command | Receipt;
export type Action =
  | "runtime.status"
  | "runtime.inspector"
  | "runtime.commands"
  | "orchestration.status"
  | "usage.live"
  | "usage.history"
  | "usage.logs"
  | "usage.efficiency"
  | "usage.preflight"
  | "onboarding.status"
  | "onboarding.profile"
  | "onboarding.tech"
  | "profile.status"
  | "profile.options"
  | "profile.tech-options"
  | "profile.apply"
  | "profile.auto"
  | "context.status"
  | "context.rebuild"
  | "context.search"
  | "context.pack"
  | "context.impact"
  | "context.efficiency"
  | "context.preflight"
  | "context.compact"
  | "memory.status"
  | "mcp.status"
  | "mcp.doctor"
  | "mcp.detail"
  | "mcp.approve"
  | "mcp.reject"
  | "mcp.reset";
export type Effect = "read-only" | "workspace-write" | "model-assisted";

export interface Command {
  schemaVersion: 1;
  version: "piagent-runtime-command-v1";
  messageType: "command";
  requestId: string;
  sessionRef: string;
  expectedSessionRevision: string;
  action: Action;
  argument: string | null;
  confirmed: boolean;
}
export interface Receipt {
  schemaVersion: 1;
  version: "piagent-runtime-receipt-v1";
  messageType: "receipt";
  requestId: string;
  sessionRef: string;
  action: Action;
  state: "settled" | "rejected" | "uncertain";
  resultCode:
    | "completed"
    | "stale-revision"
    | "confirmation-required"
    | "runtime-busy"
    | "invalid-command"
    | "effect-unknown"
    | "unavailable";
  effect: Effect;
  modelCallObserved: boolean;
  /**
   * @maxItems 8
   */
  outputs:
    | []
    | [Output]
    | [Output, Output]
    | [Output, Output, Output]
    | [Output, Output, Output, Output]
    | [Output, Output, Output, Output, Output]
    | [Output, Output, Output, Output, Output, Output]
    | [Output, Output, Output, Output, Output, Output, Output]
    | [Output, Output, Output, Output, Output, Output, Output, Output];
  sessionRevisionAfter: string | null;
  reasonCode: string | null;
}
export interface Output {
  customType: string;
  content: string;
  truncated: boolean;
  redacted: boolean;
}
