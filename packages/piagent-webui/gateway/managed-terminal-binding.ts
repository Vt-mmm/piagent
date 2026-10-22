import { sessionRefForPath } from './session-catalog.ts';
import type { SessionRuntimeSupervisor } from './session-runtime-supervisor.ts';

export type ManagedTerminalEvent = { kind: 'output'; data: string } | { kind: 'exit'; exitCode: number | null; signal: number | null };
export type ManagedTerminalHandle = { id: string; input(data: string): Promise<void>;
  resize(size: { cols: number; rows: number }): Promise<void>; close(): Promise<void> };
export type ManagedTerminalRuntime = { current(): boolean; terminals: { reasonCode: string | null;
  open(size: { cols: number; rows: number }, emit: (event: ManagedTerminalEvent) => void): Promise<ManagedTerminalHandle> } };
export type ManagedTerminalOptions = { key: Buffer; gatewayInstanceRef: string; managed: boolean;
  runtimes: Pick<SessionRuntimeSupervisor, 'listSessions' | 'acquire' | 'liveSessionManager' | 'ownership'>;
  managedTerminal?(rawSessionId: string): ManagedTerminalRuntime };

export async function managedTerminalBinding(options: ManagedTerminalOptions, sessionRef: string) {
  if (!options.managed || !options.managedTerminal) throw Error('terminal-company-boundary-required');
  const { runtimes } = options;
  const matches = (await runtimes.listSessions()).filter(info => sessionRefForPath(options.key, info.path) === sessionRef);
  if (matches.length !== 1) throw Error('terminal-session-unavailable');
  const info = matches[0]!, lease = await runtimes.acquire(sessionRef), manager = runtimes.liveSessionManager(sessionRef);
  const runtimeInstanceRef = lease.runtimeInstanceRef, runtime = options.managedTerminal(info.id);
  if (!runtimeInstanceRef || !manager || manager.getSessionId() !== info.id || !runtime.current()) throw Error('terminal-session-unavailable');
  const assertCurrent = () => {
    const ownership = runtimes.ownership(sessionRef);
    if (runtimes.liveSessionManager(sessionRef) !== manager || manager.getSessionId() !== info.id || !runtime.current()
      || ownership.state !== 'gateway-owned' || ownership.owner.continuity !== 'exact'
      || ownership.owner.gatewayInstanceRef !== options.gatewayInstanceRef || ownership.owner.runtimeInstanceRef !== runtimeInstanceRef
      || ownership.owner.ownerEpoch !== lease.ownerEpoch) throw Error('terminal-runtime-replaced');
  };
  assertCurrent();
  return { identity: { gatewayInstanceRef: options.gatewayInstanceRef, sessionRef, runtimeInstanceRef }, runtime, assertCurrent };
}
