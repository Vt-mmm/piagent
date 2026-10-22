import type { EditorTab } from './workspace-editor-tabs.ts';
import type { PiagentWebUIWorkspaceFileV1 as WorkspaceFile } from '../../contracts/generated/workspace-file-v1.ts';
export function reconcileWorkspaceRead(tab: EditorTab, expected: WorkspaceFile, incoming: WorkspaceFile):
  { tab: EditorTab; conflict?: WorkspaceFile } {
  if (tab.file !== expected || tab.file.path !== incoming.path || tab.pending || tab.fresh) return { tab };
  if (tab.file.digest === incoming.digest && tab.file.protected === incoming.protected && tab.file.readOnly === incoming.readOnly) return { tab };
  if (tab.draft !== (tab.file.content ?? '')) return { tab, conflict: incoming };
  return { tab: { ...tab, file: incoming, draft: incoming.content ?? '' } };
}
