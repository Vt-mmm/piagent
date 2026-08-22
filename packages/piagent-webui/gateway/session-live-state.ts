import type { PiagentWebUICanonicalVolatileSessionOperationStateV1 } from "../contracts/generated/session-live-state-v1.ts";
import type { GatewayTerminalSettlement } from "./gateway-events.ts";
import type { CurrentOperationProjection } from "./session-runtime-supervisor.ts";

export function buildSessionLiveState(options: { gatewayInstanceRef: string; eventSequence: number;
  operations: Array<CurrentOperationProjection & { sessionRef: string }>; settlements: GatewayTerminalSettlement[];
  now?: Date }): PiagentWebUICanonicalVolatileSessionOperationStateV1 {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("session-live-state-time-invalid");
  return {
    schemaVersion: 1,
    version: "piagent-session-live-state-v1",
    generatedAt: now.toISOString(),
    gatewayInstanceRef: options.gatewayInstanceRef,
    eventSequence: options.eventSequence,
    state: "ready",
    operations: [...options.operations].sort((left, right) => left.sessionRef.localeCompare(right.sessionRef)),
    settlements: [...options.settlements].sort((left, right) => right.sequence - left.sequence).slice(0, 100),
    reasonCode: null
  };
}
