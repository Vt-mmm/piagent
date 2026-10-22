import { useEffect, useRef, type MutableRefObject } from 'react';
import type { PiagentWebUIWorkspaceFileV1 as WorkspaceFile } from '../../contracts/generated/workspace-file-v1.ts';
import { readWorkspaceFile } from './workspace-api.ts';
import { useWorkspaceEditorTabs, workspaceEditorTabs } from './workspace-editor-tabs.ts';
import { reconcileWorkspaceRead } from './workspace-refresh-model.ts';
export function useWorkspaceRefresh(session: string, saving: MutableRefObject<boolean>, conflict: (file: WorkspaceFile) => void) {
  const { update } = useWorkspaceEditorTabs(session), callbacks = useRef({ update, conflict }); callbacks.current = { update, conflict };
  useEffect(() => {
    const controller = new AbortController(), notified = new Map<string, string>();
    let reading = false, pending = false, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (controller.signal.aborted || saving.current) return;
      if (reading) { pending = true; return; }
      reading = true;
      try {
        for (const captured of workspaceEditorTabs(session).tabs) {
          if (captured.fresh || captured.pending || saving.current) continue;
          try {
            const incoming = await readWorkspaceFile(session, captured.file.path, controller.signal);
            if (controller.signal.aborted || saving.current) return;
            let changed: WorkspaceFile | undefined;
            callbacks.current.update(state => ({ ...state, tabs: state.tabs.map(tab => {
              if (tab.file.path !== captured.file.path) return tab;
              const next = reconcileWorkspaceRead(tab, captured.file, incoming);
              if (next.conflict && state.active === tab.file.path) changed = next.conflict;
              return next.tab;
            }) }));
            if (changed) {
              const version = `${changed.digest}:${changed.protected}:${changed.readOnly}`;
              if (notified.get(changed.path) !== version) { notified.set(changed.path, version); callbacks.current.conflict(changed); }
            }
          } catch { /* A failed refresh cannot discard an editor draft. */ }
        }
      } finally { reading = false; if (pending && !controller.signal.aborted) { pending = false; schedule(); } }
    };
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 100); };
    const notice = (event: Event) => { if ((event as CustomEvent).detail?.sessionRef === session) schedule(); };
    window.addEventListener('piagent-workspace-changed', notice);
    window.addEventListener('piagent-workspace-saved', notice);
    const interval = setInterval(schedule, 5000); schedule();
    return () => { controller.abort(); clearTimeout(timer); clearInterval(interval);
      window.removeEventListener('piagent-workspace-changed', notice); window.removeEventListener('piagent-workspace-saved', notice); };
  }, [session, saving]);
}
