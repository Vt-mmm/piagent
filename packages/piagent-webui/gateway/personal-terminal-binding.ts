import { sessionRefForPath } from "./session-catalog.ts";
import type { SessionRuntimeSupervisor } from "./session-runtime-supervisor.ts";

type Options = {
  key: Buffer;
  managed: boolean;
  gatewayInstanceRef: string;
  runtimes: Pick<SessionRuntimeSupervisor, "listSessions" | "acquire" | "liveSessionManager" | "ownership">;
};

// Browser refs select catalog entries, never host paths or shell environments.
// Keep a synchronous authority check for the instant before each native effect.
export async function personalTerminalBinding(options: Options, sessionRef: string) {
  if (options.managed) throw new Error("company-boundary-required");
  const { runtimes } = options;
  const matches = (await runtimes.listSessions()).filter(info => sessionRefForPath(options.key, info.path) === sessionRef);
  if (matches.length !== 1) throw new Error("terminal-session-unavailable");
  const info = matches[0]!;
  const lease = await runtimes.acquire(sessionRef);
  const manager = runtimes.liveSessionManager(sessionRef);
  const runtimeInstanceRef = lease.runtimeInstanceRef;
  if (!runtimeInstanceRef || !manager || manager.getSessionId() !== info.id)
    throw new Error("terminal-session-unavailable");
  const assertCurrent = () => {
    const current = runtimes.liveSessionManager(sessionRef), ownership = runtimes.ownership(sessionRef);
    if (current !== manager || current.getSessionId() !== info.id || ownership.state !== "gateway-owned"
      || ownership.owner.continuity !== "exact" || ownership.owner.gatewayInstanceRef !== options.gatewayInstanceRef
      || ownership.owner.runtimeInstanceRef !== runtimeInstanceRef || ownership.owner.ownerEpoch !== lease.ownerEpoch)
      throw new Error("terminal-runtime-replaced");
    if (current.buildSessionContext().model?.provider === "agent_watch_managed")
      throw new Error("company-boundary-required");
  };
  assertCurrent();
  return { scope: { sessionRef, mode: "personal" as const, cwd: info.cwd },
    identity: { gatewayInstanceRef: options.gatewayInstanceRef, sessionRef, runtimeInstanceRef }, assertCurrent };
}
