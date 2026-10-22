import { useSyncExternalStore } from 'react';
import type { PiagentWebUIWorkspaceFileV1 as WorkspaceFile } from '../../contracts/generated/workspace-file-v1.ts';
import type { WorkspaceWriteCommand } from '../../contracts/generated/workspace-write-v1.ts';
export type EditorTab = { file: WorkspaceFile; draft: string; line: number; fresh: boolean; pending?: WorkspaceWriteCommand };
type State = { tabs: EditorTab[]; active?: string };
const sessions = new Map<string, State>(), listeners = new Set<() => void>();
const empty: State = { tabs: [] };
export const tabDirty = (tab: EditorTab) => tab.fresh || tab.draft !== (tab.file.content ?? '');
// Keep drafts in this page's memory when its drawer or conversation closes.
// No source contents are copied into browser storage.
window.addEventListener('beforeunload', event => {
  if ([...sessions.values()].some(state => state.tabs.some(tabDirty))) { event.preventDefault(); event.returnValue = ''; }
});
export const workspaceEditorTabs = (session: string) => sessions.get(session) ?? empty;
export function useWorkspaceEditorTabs(session: string) {
  const state = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => sessions.get(session) ?? empty);
  const update = (change: (state: State) => State) => { sessions.set(session, change(sessions.get(session) ?? empty)); for (const callback of listeners) callback(); };
  return { ...state, update };
}
