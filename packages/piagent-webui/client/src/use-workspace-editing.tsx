import { useEffect, useRef, useState } from 'react';
import type { PiagentWebUIWorkspaceFileV1 as WorkspaceFile } from '../../contracts/generated/workspace-file-v1.ts';
import type { WorkspaceWriteState } from '../../contracts/generated/workspace-write-v1.ts';
import { readWorkspaceFile } from './workspace-api.ts';
import { saveWorkspaceFile, workspaceWriteCommand, workspaceWriteState } from './workspace-write-api.ts';
import { tabDirty, useWorkspaceEditorTabs, workspaceEditorTabs } from './workspace-editor-tabs.ts';
import { localize, useUiPreferences } from './ui-preferences.tsx';
export function useWorkspaceEditing(session: string) {
  const { locale } = useUiPreferences(), state = useWorkspaceEditorTabs(session);
  const [authority, setAuthority] = useState<WorkspaceWriteState>(), [saving, setSaving] = useState(false), busy = useRef(false);
  const [message, setMessage] = useState<string>(), [conflict, setConflict] = useState<WorkspaceFile>();
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void workspaceWriteState(session, controller.signal).then(setAuthority).catch(() => { if (!controller.signal.aborted) setAuthority(undefined); }); };
    refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [session]);
  const load = (file: WorkspaceFile, line = 1, fresh = false) => state.update(current => ({ active: file.path,
    tabs: [...current.tabs.filter(tab => tab.file.path !== file.path), { file, line, fresh, draft: file.content ?? '' }] }));
  const select = (path: string, line?: number) => state.update(current => ({ ...current, active: path,
    tabs: current.tabs.map(tab => tab.file.path === path && line !== undefined ? { ...tab, line } : tab) }));
  const change = (path: string, draft: string) => state.update(current => ({ ...current,
    tabs: current.tabs.map(tab => tab.file.path === path ? { ...tab, draft } : tab) }));
  const close = (path: string) => {
    const tab = workspaceEditorTabs(session).tabs.find(tab => tab.file.path === path);
    if (tab && (tabDirty(tab) || tab.pending) && !window.confirm(localize(locale, 'Bỏ thay đổi chưa lưu và đóng tệp?', 'Discard unsaved changes and close this file?'))) return;
    state.update(current => ({ tabs: current.tabs.filter(tab => tab.file.path !== path), active: current.active === path ? current.tabs.find(tab => tab.file.path !== path)?.file.path : current.active }));
  };
  const reload = async (path: string) => {
    try { load(await readWorkspaceFile(session, path)); setConflict(undefined); setMessage(undefined); }
    catch { setMessage(localize(locale, 'Chưa tải lại được tệp. Bản sửa của bạn vẫn được giữ.', 'Could not reload the file. Your draft is preserved.')); }
  };
  const save = async (path: string, overwrite?: WorkspaceFile) => {
    const tab = workspaceEditorTabs(session).tabs.find(tab => tab.file.path === path);
    if (!tab || busy.current || (!tabDirty(tab) && !tab.pending) || tab.file.protected || tab.file.readOnly) return;
    if (overwrite && !window.confirm(localize(locale, 'Ghi đè phiên bản trên đĩa bằng bản sửa của bạn?', 'Replace the version on disk with your draft?'))) return;
    busy.current = true; setSaving(true); setMessage(undefined);
    try {
      const current = await workspaceWriteState(session); setAuthority(current);
      if (!current.writable) throw Error('read-only');
      const expectedDigest = overwrite?.digest ?? (tab.fresh ? 'absent' : tab.file.digest);
      if (!expectedDigest) throw Error('unavailable');
      const command = tab.pending ?? await workspaceWriteCommand(current, { path, content: tab.draft, expectedDigest });
      state.update(value => ({ ...value, tabs: value.tabs.map(item => item.file.path === path ? { ...item, pending: command } : item) }));
      const receipt = await saveWorkspaceFile(session, command);
      if (receipt.phase === 'uncertain') {
        setMessage(localize(locale, 'Chưa xác định được kết quả lưu. Tải lại để kiểm tra trước khi lưu tiếp.', 'The save result is uncertain. Reload to check before saving again.')); return;
      }
      state.update(value => ({ ...value, tabs: value.tabs.map(item => item.file.path === path ? { ...item, pending: undefined } : item) }));
      if (receipt.phase === 'settled' && receipt.resultCode === 'saved') {
        state.update(value => ({ ...value, tabs: value.tabs.map(item => item.file.path === path ? { ...item, fresh: false,
          file: { ...item.file, content: command.payload.content, digest: receipt.digest, revision: receipt.observedRevisionsAfter.workspaceRevision } } : item) }));
        setConflict(undefined);
        window.dispatchEvent(new CustomEvent('piagent-workspace-saved', { detail: { sessionRef: session, path } }));
      } else if (receipt.resultCode === 'stale-content' || receipt.resultCode === 'stale-revision') {
        setConflict(await readWorkspaceFile(session, path));
      } else setMessage(localize(locale, 'Chưa lưu được tệp. Kiểm tra quyền ghi và thử lại.', 'Could not save the file. Check write access and try again.'));
    } catch { setMessage(localize(locale, 'Chưa lưu được tệp. Bản sửa vẫn được giữ; thử lưu lại hoặc tải lại để kiểm tra.', 'Could not confirm the save. Your draft is preserved; retry the save or reload to check.')); }
    finally { busy.current = false; setSaving(false); }
  };
  return { ...state, authority, saving, message, conflict, setConflict, load, select, change, close, reload, save };
}
