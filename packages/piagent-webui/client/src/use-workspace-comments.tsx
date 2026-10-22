import type { Hunk } from '../../contracts/generated/diff-v1.ts';
import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import { CommentBar, LineNotes, LineReviewContext, type LineReviewValue } from './LineReview.tsx';
import { LINE_COMMENTS_CHANGED, commentKey, readComments, reviewMessage, upsertComment, writeComments, type LineComment, type LineSide } from './line-review.ts';
import { appendToComposer } from './composer-drafts.ts';
import { localize, useUiPreferences } from './ui-preferences.tsx';
export function useWorkspaceComments(session: string, path: string | undefined, content: string, hunks: Hunk[] = []) {
  const { locale } = useUiPreferences();
  const [comments, setComments] = useState<LineComment[]>(() => readComments(session));
  const [editing, setEditing] = useState<{ path: string; line: number; code: string; side: LineSide }>();
  useEffect(() => {
    setComments(readComments(session)); setEditing(undefined);
    const changed = (event: Event) => { if ((event as CustomEvent).detail === session) setComments(readComments(session)); };
    window.addEventListener(LINE_COMMENTS_CHANGED, changed); return () => window.removeEventListener(LINE_COMMENTS_CHANGED, changed);
  }, [session]);
  useEffect(() => setEditing(undefined), [path]);
  const store = (next: LineComment[]) => { setComments(next); writeComments(session, next); };
  const review: LineReviewValue = { locale, comments, editing: editing ? commentKey(editing.path, editing.side, editing.line) : null,
    open: (file, side, line, code) => setEditing({ path: file, line, code, side }), cancel: () => setEditing(undefined),
    save: text => { if (editing) store(upsertComment(readComments(session), { ...editing, text })); setEditing(undefined); },
    remove: key => store(readComments(session).filter(comment => commentKey(comment.path, comment.side, comment.line) !== key)) };
  const lines = new Map(content.split('\n').map((code, index) => [commentKey(path ?? '', 'new', index + 1), code.slice(0, 400)]));
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.oldLineNumber !== null) lines.set(commentKey(path ?? '', 'old', line.oldLineNumber), line.text.slice(0, 400));
  }
  return {
    open: (line: number, code: string, side: LineSide = 'new') => { if (path) setEditing({ path, line, code, side }); },
    dialog: <Dialog open={!!editing} onClose={() => setEditing(undefined)} fullWidth>
      <DialogTitle>{localize(locale, 'Comment theo dòng', 'Line comment')} · {editing?.path}:{editing?.line}</DialogTitle>
      <DialogContent><LineReviewContext.Provider value={review}>{editing && <LineNotes path={editing.path} side={editing.side} line={editing.line} />}</LineReviewContext.Provider></DialogContent>
    </Dialog>,
    bar: <CommentBar comments={comments} lines={lines} linesPath={path} locale={locale} onClear={() => store([])}
      onSend={() => { const current = readComments(session); if (current.length) appendToComposer(session, reviewMessage(current, locale === 'en')); store([]); }} />
  };
}
