/* Generated from schemas/piagent-webui/terminal-v1.schema.json. Do not edit. */

export type PiagentSessionTerminalV1 =
  TerminalState | TerminalCommand | TerminalReceipt | TerminalOutput | TerminalExit;

export interface TerminalState {
  schemaVersion: 1;
  version: "piagent-terminal-v1";
  messageType: "state";
  identity: TerminalIdentity;
  revisions: TerminalRevisions;
  available: boolean;
  reasonCode: string | null;
  /**
   * @maxItems 4
   */
  terminals:
    | []
    | [TerminalSummary]
    | [TerminalSummary, TerminalSummary]
    | [TerminalSummary, TerminalSummary, TerminalSummary]
    | [TerminalSummary, TerminalSummary, TerminalSummary, TerminalSummary];
}
export interface TerminalIdentity {
  gatewayInstanceRef: string;
  sessionRef: string;
  runtimeInstanceRef: string;
}
export interface TerminalRevisions {
  terminalRevision: string;
}
export interface TerminalSummary {
  terminalRef: string;
  number: number;
  state: "running" | "exited";
  cols: number;
  rows: number;
  sequence: number;
  exitCode: number | null;
}
export interface TerminalCommand {
  schemaVersion: 1;
  version: "piagent-terminal-v1";
  messageType: "command";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  action: "terminal.command";
  actionDigest: string;
  identity: TerminalIdentity;
  expectedRevisions: TerminalRevisions;
  payload: TerminalOpen | TerminalInput | TerminalResize | TerminalClose;
}
export interface TerminalOpen {
  kind: "open";
  cols: number;
  rows: number;
}
export interface TerminalInput {
  kind: "input";
  terminalRef: string;
  data: string;
}
export interface TerminalResize {
  kind: "resize";
  terminalRef: string;
  cols: number;
  rows: number;
}
export interface TerminalClose {
  kind: "close";
  terminalRef: string;
}
export interface TerminalReceipt {
  schemaVersion: 1;
  version: "piagent-terminal-v1";
  messageType: "receipt";
  commandId: string;
  idempotencyKey: string;
  action: "terminal.command";
  actionDigest: string;
  identity: TerminalIdentity;
  observedRevisions: TerminalRevisions;
  phase: "settled" | "rejected" | "uncertain";
  terminalRef: string | null;
  reasonCode: string | null;
  deduplicated: boolean;
}
export interface TerminalOutput {
  schemaVersion: 1;
  version: "piagent-terminal-v1";
  messageType: "output";
  identity: TerminalIdentity;
  terminalRef: string;
  sequence: number;
  data: string;
  replay: boolean;
  reset: boolean;
  complete: boolean;
  truncated: boolean;
}
export interface TerminalExit {
  schemaVersion: 1;
  version: "piagent-terminal-v1";
  messageType: "exit";
  identity: TerminalIdentity;
  terminalRef: string;
  sequence: number;
  exitCode: number;
  signal: number | null;
}
