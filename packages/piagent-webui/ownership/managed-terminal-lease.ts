import { randomBytes } from "node:crypto";

import { gatewayProfileState, readOrCreateCatalogKey } from "./profile-state.ts";
import { sessionRefForPath } from "./session-refs.ts";
import { SessionLeaseStore } from "./session-lease-store.ts";

export type ManagedSessionHold = { sessionRef: string; release(): void };

/**
 * A company conversation run outside the Gateway (the company Terminal,
 * `piagent studio --prompt`, scripts) holds the same lease the Gateway uses.
 * The WebUI then shows it running elsewhere and offers neither sending nor
 * "continue" until it is released. A conversation the Gateway holds is
 * refused (`session-owner-conflict`): two writers never share one JSONL.
 */
export function holdManagedSession(agentDir: string, sessionFile: string): ManagedSessionHold {
  const state = gatewayProfileState(agentDir), key = readOrCreateCatalogKey(state), leases = new SessionLeaseStore(state.root, key);
  const sessionRef = sessionRefForPath(key, sessionFile);
  const owner = `terminal_${process.pid}_${randomBytes(16).toString("base64url")}`, runtime = `runtime_${randomBytes(16).toString("base64url")}`;
  const lease = leases.acquireTerminal(sessionRef, owner, runtime);
  let held = true;
  return { sessionRef, release() {
    if (!held || !lease.ownerEpoch) return;
    held = false;
    try { leases.releaseTerminal(sessionRef, lease.ownerEpoch, owner, runtime); } catch { /* a dead owner is recovered by the next acquirer */ }
  } };
}
