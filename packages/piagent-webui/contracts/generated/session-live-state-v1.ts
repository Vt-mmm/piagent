/* Generated from schemas/piagent-webui/session-live-state-v1.schema.json. Do not edit. */

export type PiagentWebUICanonicalVolatileSessionOperationStateV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-session-live-state-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  eventSequence: number;
  state: "ready" | "unavailable";
  /**
   * @maxItems 100
   */
  operations: CurrentOperation[];
  /**
   * Bounded, Gateway-epoch-local non-success terminal operation outcomes retained for Activity reconciliation.
   *
   * @maxItems 100
   */
  settlements: TerminalSettlement[];
  reasonCode: string | null;
};
export type CurrentOperation = {
  [k: string]: any;
} & {
  sessionRef: string;
  operationRef: string;
  state: "running" | "waiting-approval" | "settling";
  abortable: boolean;
};

export interface TerminalSettlement {
  sessionRef: string;
  operationRef: string;
  settlement: "blocked" | "aborted" | "error" | "unknown";
  reasonCode: string;
  settledAt: string;
  sequence: number;
}
