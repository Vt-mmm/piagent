import type { PiagentGatewayCapabilityHandshakeV1 } from "../../contracts/generated/gateway-capabilities-v1.ts";
import type { Attachment } from "../../contracts/generated/attachment-v1.ts";
import type { Catalog, SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import type { PermissionMode, Receipt, Workflow } from "../../contracts/generated/session-command-v1.ts";
import type { LiveConversation, TerminalOperationActivity } from "./live-state-view-model.ts";
import type { ConnectionState } from "./use-inspection.ts";

type GatewayCursor = { gatewayInstanceRef: string; sequence: number };

export const GATEWAY_CURSOR_KEY = "piagent-gateway-event-cursor-v1";
export const COMMAND_RESPONSE_TIMEOUT_MS = 30_000;
export const CANONICAL_RESYNC_CLOSE_CODE = 4_001;

export type SessionSendResult = { state: "confirmed" | "observed" | "unconfirmed"; receipt: Receipt | null };

export type SessionHubCreateOptions = {
  projectRef: string;
  placeRef: string;
  modelRef: string | null;
  thinkingLevel: string;
  message: string;
  workflow: Workflow;
  permissionMode: PermissionMode | null;
  messageRequestId?: string;
  deferInitialMessage?: boolean;
};

export type SessionHubSendAttachment = {
  messageRequestId: string;
  attachmentRefs: string[];
  attachments?: Attachment[];
  workflow?: Workflow;
};

export type SessionHub = {
  catalog?: Catalog;
  capabilities?: PiagentGatewayCapabilityHandshakeV1;
  connection: ConnectionState;
  live: Readonly<Record<string, LiveConversation>>;
  terminalActivities: Readonly<Record<string, TerminalOperationActivity[]>>;
  refresh(): Promise<Catalog | undefined>;
  create(options: SessionHubCreateOptions): Promise<Receipt>;
  send(session: SessionRow, message: string, attachment?: SessionHubSendAttachment): Promise<SessionSendResult>;
  abort(session: SessionRow): Promise<Receipt>;
  restart(session: SessionRow): Promise<Receipt>;
  setModel(session: SessionRow, modelRef: string): Promise<Receipt>;
  setThinking(session: SessionRow, thinkingLevel: string): Promise<Receipt>;
  setPermission(session: SessionRow, permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<Receipt>;
  rename(session: SessionRow, title: string): Promise<Receipt>;
  pin(session: SessionRow, pinned: boolean): Promise<Receipt>;
  archive(session: SessionRow): Promise<Receipt>;
  unarchive(session: SessionRow): Promise<Receipt>;
  fork(session: SessionRow, title: string | null): Promise<Receipt>;
};

export class SessionSendRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string) { super(reasonCode); this.name = "SessionSendRejectedError"; this.reasonCode = reasonCode; }
}

export function parseGatewayCursor(raw: string | null, gatewayInstanceRef: string): number | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GatewayCursor>;
    return value.gatewayInstanceRef === gatewayInstanceRef && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0
      ? Number(value.sequence) : null;
  } catch { return null; }
}

export function persistGatewayCursor(gatewayRef: string, sequence: number | null): void {
  if (sequence === null) return;
  try { window.sessionStorage.setItem(GATEWAY_CURSOR_KEY, JSON.stringify({ gatewayInstanceRef: gatewayRef, sequence })); }
  catch { /* Cursor persistence is an optimization; live-state remains canonical. */ }
}

export function opaque(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function revisionStale(receipt: Receipt): boolean {
  return receipt.phase === "rejected" && receipt.resultCode === "stale-revision"
    && receipt.error?.code === "session-revision-stale";
}
