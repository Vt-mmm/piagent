import { useSyncExternalStore } from 'react';
const empty: ReadonlySet<string> = new Set();
const sessions = new Map<string, ReadonlySet<string>>(), listeners = new Set<() => void>();
export const keptWorkspaceHunks = (session: string) => sessions.get(session) ?? empty;
// Page memory only: remember reviewed identities across drawer and tab mounts,
// without persisting code or treating a new digest as already reviewed.
export function keepWorkspaceHunk(session: string, path: string, digest: string, hunkRef: string) {
  const next = new Set([...keptWorkspaceHunks(session), `${path}:${digest}:${hunkRef}`].slice(-4096));
  sessions.delete(session); sessions.set(session, next);
  while (sessions.size > 64) sessions.delete(sessions.keys().next().value!);
  for (const notify of listeners) notify();
}
export function useKeptWorkspaceHunks(session: string) {
  return useSyncExternalStore(notify => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => keptWorkspaceHunks(session));
}
