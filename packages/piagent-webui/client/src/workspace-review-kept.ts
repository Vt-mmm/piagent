import { useSyncExternalStore } from 'react';
const empty: ReadonlySet<string> = new Set();
const sessions = new Map<string, ReadonlySet<string>>(), listeners = new Set<() => void>();
const PREFIX = 'piagent.kept-hunks.', INDEX = 'piagent.kept-hunks';
// Reviewed identities (path, file digest, hunk) survive a reload in this
// browser; code is never stored, and a new digest is never treated as
// reviewed. Storage that is unavailable leaves page memory only.
function stored(session: string): ReadonlySet<string> {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + session) ?? '[]');
    return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === 'string').slice(-4096)) : empty;
  } catch { return empty; }
}
function persist(session: string, kept: ReadonlySet<string>) {
  try {
    const index = [...(JSON.parse(localStorage.getItem(INDEX) ?? '[]') as string[]).filter(item => item !== session), session];
    for (const old of index.splice(0, Math.max(0, index.length - 64))) localStorage.removeItem(PREFIX + old);
    localStorage.setItem(PREFIX + session, JSON.stringify([...kept]));
    localStorage.setItem(INDEX, JSON.stringify(index));
  } catch { /* page memory still holds it */ }
}
export const keptWorkspaceHunks = (session: string) => {
  if (!sessions.has(session)) sessions.set(session, stored(session));
  return sessions.get(session) ?? empty;
};
export function keepWorkspaceHunk(session: string, path: string, digest: string, hunkRef: string) {
  const next = new Set([...keptWorkspaceHunks(session), `${path}:${digest}:${hunkRef}`].slice(-4096));
  sessions.delete(session); sessions.set(session, next);
  while (sessions.size > 64) sessions.delete(sessions.keys().next().value!);
  persist(session, next);
  for (const notify of listeners) notify();
}
export function useKeptWorkspaceHunks(session: string) {
  return useSyncExternalStore(notify => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => keptWorkspaceHunks(session));
}
