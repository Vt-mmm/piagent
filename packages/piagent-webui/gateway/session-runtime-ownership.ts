import { createHmac } from "node:crypto";
import type { SessionOwnerProjection } from "./session-catalog.ts";
import type { SessionLeaseSnapshot } from "./session-lease-store.ts";

type ActiveOwnership = {
  lease: SessionLeaseSnapshot;
  operationRef: string | null;
  approvalWaiting: boolean;
};

export function projectSessionRuntimeOwnership(options: {
  lease: SessionLeaseSnapshot;
  active?: ActiveOwnership;
  gatewayInstanceRef: string;
  key: Buffer;
}): SessionOwnerProjection {
  const { lease, active, gatewayInstanceRef, key } = options;
  if (lease.state === "released") return {
    state: "offline", liveState: "offline", composerAvailable: true, needsAttention: false,
    owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "released" },
    reasonCode: null
  };
  if (lease.state === "gateway-owned" && active && active.lease.ownerEpoch === lease.ownerEpoch
    && lease.gatewayInstanceRef === gatewayInstanceRef && active.lease.runtimeInstanceRef === lease.runtimeInstanceRef) return {
    state: "gateway-owned", liveState: active.approvalWaiting ? "waiting-approval" : active.operationRef ? "running" : "idle",
    composerAvailable: true, needsAttention: active.approvalWaiting,
    owner: { kind: "gateway", ownerEpoch: lease.ownerEpoch!, gatewayInstanceRef: lease.gatewayInstanceRef!,
      runtimeInstanceRef: lease.runtimeInstanceRef!, continuity: "exact" }, reasonCode: null
  };
  if (lease.state === "unavailable") return {
    state: "recovery-required", liveState: "uncertain", composerAvailable: false, needsAttention: true,
    owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "unknown" },
    reasonCode: lease.reasonCode ?? "session-lease-unavailable"
  };
  if (lease.state === "terminal-owned") return {
    state: "terminal-owned", liveState: "uncertain", composerAvailable: false, needsAttention: false,
    owner: { kind: "terminal", ownerEpoch: lease.ownerEpoch!,
      gatewayInstanceRef: `terminal_${createHmac("sha256", key).update(lease.gatewayInstanceRef!).digest("base64url").slice(0, 43)}`,
      runtimeInstanceRef: lease.runtimeInstanceRef!, continuity: "exact" },
    reasonCode: "terminal-owner-active"
  };
  return {
    state: "recovery-required", liveState: "uncertain", composerAvailable: false, needsAttention: true,
    owner: { kind: "gateway", ownerEpoch: lease.ownerEpoch!, gatewayInstanceRef: lease.gatewayInstanceRef!,
      runtimeInstanceRef: lease.runtimeInstanceRef!, continuity: "uncertain" },
    reasonCode: lease.reasonCode ?? "session-owner-continuity-unknown"
  };
}
