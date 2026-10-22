import { useEffect, useState } from 'react';
import type { PiagentWebUIBoundedFileDiffV1 as Diff } from '../../contracts/generated/diff-v1.ts';
import type { EditorTab } from './workspace-editor-tabs.ts';
import { workspaceReviewDiff, workspaceReviewSources } from './workspace-review-api.ts';
import { editorReviewHunks } from './workspace-review-model.ts';
import { keepWorkspaceHunk, useKeptWorkspaceHunks } from './workspace-review-kept.ts';
export function useWorkspaceReview(session: string, tabs: EditorTab[], active: string | undefined) {
  const [loaded, setLoaded] = useState<{ session: string; diffs: Map<string, Diff> }>();
  const kept = useKeptWorkspaceHunks(session), pathsKey = JSON.stringify(tabs.map(tab => tab.file.path).sort());
  useEffect(() => {
    const paths = JSON.parse(pathsKey) as string[];
    if (!paths.length) { setLoaded(undefined); return; }
    const controller = new AbortController(); let busy = false, pending = false;
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        const sources = await workspaceReviewSources(session, controller.signal), diffs = new Map<string, Diff>();
        for (const path of paths) {
          if (controller.signal.aborted) return;
          const file = sources.files.find(item => item.path === path && item.pathDisplay === 'exact-safe');
          if (!file) continue;
          try { diffs.set(path, await workspaceReviewDiff(session, file.fileRef, controller.signal)); }
          catch { /* A failed file read does not hide other tabs' review state. */ }
        }
        if (!controller.signal.aborted) setLoaded({ session, diffs });
      } catch { if (!controller.signal.aborted) setLoaded(undefined); }
      finally { busy = false; if (pending && !controller.signal.aborted) { pending = false; void refresh(); } }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 3000);
    const saved = (event: Event) => { if ((event as CustomEvent).detail?.sessionRef === session) void refresh(); };
    window.addEventListener('piagent-workspace-saved', saved); window.addEventListener('piagent-workspace-changed', saved);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('piagent-workspace-saved', saved); window.removeEventListener('piagent-workspace-changed', saved); };
  }, [session, pathsKey]);
  const diffs = loaded?.session === session ? loaded.diffs : undefined;
  const forTab = (tab: EditorTab) => editorReviewHunks(diffs?.get(tab.file.path), tab.file.path, tab.file.digest,
    !tab.fresh && !tab.pending && tab.draft === (tab.file.content ?? ''), kept);
  const tab = tabs.find(tab => tab.file.path === active), hunks = tab ? forTab(tab) : [];
  return { diff: active ? diffs?.get(active) : undefined, hunks,
    counts: new Map(tabs.map(tab => [tab.file.path, forTab(tab).length])),
    keep: (hunkRef: string) => {
      if (tab?.file.digest && hunks.some(hunk => hunk.hunkRef === hunkRef)) keepWorkspaceHunk(session, tab.file.path, tab.file.digest, hunkRef);
    } };
}
