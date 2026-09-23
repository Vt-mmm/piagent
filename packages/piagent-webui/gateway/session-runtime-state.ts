import type { PiSessionInfo } from "./session-catalog.ts";
import type { GatewaySessionStream } from "./gateway-session-stream.ts";
import type { SessionLeaseSnapshot } from "./session-lease-store.ts";
import type { SessionOperationWatchdog } from "./session-operation-watchdog.ts";
import type { RuntimeHandle } from "./session-runtime-factory.ts";

export type ActiveRuntime = {
  runtime: RuntimeHandle;
  lease: SessionLeaseSnapshot;
  info: PiSessionInfo;
  operationRef: string | null;
  messageRequestId: string | null;
  cancelWire: ((reason: string) => void) | null;
  stream: GatewaySessionStream | null;
  unsubscribe: (() => void) | null;
  completion: Promise<void> | null;
  settling: boolean;
  approvalWaiting: boolean;
  unbindApproval: (() => void) | null;
  unsubscribeApproval: (() => void) | null;
  sessionManager: any | null;
  watchdog: SessionOperationWatchdog | null;
  lastSessionRevision: string | null;
};
