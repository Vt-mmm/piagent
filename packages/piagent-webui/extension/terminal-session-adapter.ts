import { randomBytes } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { gatewayProfileState, readOrCreateCatalogKey } from "../ownership/profile-state.ts";
import { sessionRefForPath } from "../ownership/session-refs.ts";
import { SessionLeaseStore, type SessionLeaseSnapshot } from "../ownership/session-lease-store.ts";

type Binding = {
  rawSessionId: string;
  sessionRef: string;
  lease: SessionLeaseSnapshot;
};

/**
 * Registers the Pi TUI as the exact session writer in the same durable lease
 * authority used by the Gateway. A failed registration is fail-closed for new
 * input/tool work; it never claims that two runtimes can safely share JSONL.
 */
export class TerminalSessionAdapter {
  readonly #terminalInstanceRef = `terminal_${process.pid}_${randomBytes(16).toString("base64url")}`;
  readonly #runtimeInstanceRef: string;
  readonly #leases: SessionLeaseStore;
  readonly #key: Buffer;
  #binding: Binding | null = null;
  #reasonCode: string | null = "terminal-session-not-bound";

  constructor(runtimeInstanceRef: string, agentDir?: string) {
    this.#runtimeInstanceRef = runtimeInstanceRef;
    const state = gatewayProfileState(agentDir);
    this.#key = readOrCreateCatalogKey(state);
    this.#leases = new SessionLeaseStore(state.root, this.#key);
  }

  bind(ctx: ExtensionContext): void {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) { this.#reasonCode = "terminal-session-not-persisted"; throw new Error(this.#reasonCode); }
    const rawSessionId = ctx.sessionManager.getSessionId();
    const sessionRef = sessionRefForPath(this.#key, file);
    if (this.#binding?.rawSessionId === rawSessionId && this.#binding.sessionRef === sessionRef
      && this.#leases.inspect(sessionRef).ownerEpoch === this.#binding.lease.ownerEpoch) {
      this.#reasonCode = null; return;
    }
    this.release();
    const lease = this.#leases.acquireTerminal(sessionRef, this.#terminalInstanceRef, this.#runtimeInstanceRef);
    this.#binding = { rawSessionId, sessionRef, lease };
    this.#reasonCode = null;
  }

  dispatchAllowed(ctx: ExtensionContext): boolean {
    const binding = this.#binding;
    if (!binding || binding.rawSessionId !== ctx.sessionManager.getSessionId()) return false;
    const current = this.#leases.inspect(binding.sessionRef);
    const exact = current.state === "terminal-owned" && current.ownerEpoch === binding.lease.ownerEpoch
      && current.gatewayInstanceRef === this.#terminalInstanceRef && current.runtimeInstanceRef === this.#runtimeInstanceRef;
    if (!exact) this.#reasonCode = current.state === "gateway-owned" ? "session-owned-by-gateway" : "terminal-session-lease-lost";
    return exact;
  }

  reasonCode(): string { return this.#reasonCode ?? "terminal-session-lease-unavailable"; }

  release(): void {
    const binding = this.#binding;
    this.#binding = null;
    if (!binding?.lease.ownerEpoch) return;
    try {
      this.#leases.releaseTerminal(binding.sessionRef, binding.lease.ownerEpoch, this.#terminalInstanceRef, this.#runtimeInstanceRef);
      this.#reasonCode = "terminal-session-released";
    } catch {
      this.#reasonCode = "terminal-session-release-unproven";
    }
  }
}
