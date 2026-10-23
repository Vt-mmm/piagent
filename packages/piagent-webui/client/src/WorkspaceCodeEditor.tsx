import Button from '@mui/material/Button';
import type { Hunk } from '../../contracts/generated/diff-v1.ts';
import { workspaceDiffDecorations } from './workspace-diff-decorations.ts';
import { localize, useThemePreset, useUiPreferences } from './ui-preferences.tsx';
const noHunks: Hunk[] = [];
const ignoreHunk = (_ref: string) => {};
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { presetHighlight } from './editor-highlight.ts';
import { workspaceLanguage } from './workspace-language.ts';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap } from '@codemirror/view';
import { alpha, useTheme } from '@mui/material/styles';
import Box from '@mui/material/Box';

export default function WorkspaceCodeEditor({ content, path, line = 1, readOnly = true, onChange, onSave, hunks = noHunks, onKeep = ignoreHunk, onRevert, onComment }: {
  onComment?(line: number, code: string, side?: 'new' | 'old'): void;
  hunks?: Hunk[]; onKeep?(ref: string): void; onRevert?(ref: string): void;
  content: string; path: string; line?: number; readOnly?: boolean; onChange?(value: string): void; onSave?(): void;
}) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), theme = useTheme();
  const callbacks = useRef({ onChange, onSave, onComment }); callbacks.current = { onChange, onSave, onComment };
  const initial = useRef(content); initial.current = content;
  const editable = useRef(new Compartment()), review = useRef(new Compartment());
  const { locale } = useUiPreferences(), preset = useThemePreset();
  useEffect(() => {
    if (!host.current) return;
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    const language = new Compartment(); let disposed = false;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: initial.current, extensions: [
      review.current.of([]), EditorView.cspNonce.of(nonce ?? ''), editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      keymap.of([{ key: 'Mod-Shift-m', run: view => {
        const selected = view.state.doc.lineAt(view.state.selection.main.head);
        callbacks.current.onComment?.(selected.number, selected.text); return !!callbacks.current.onComment;
      } }]),
      keymap.of(['Ctrl-s', 'Meta-s'].map(key => ({ key, run: () => { callbacks.current.onSave?.(); return true; } }))),
      EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString()); }),
      lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), syntaxHighlighting(presetHighlight(preset)), language.of([]), EditorView.contentAttributes.of({ 'aria-label': path, tabindex: '0' }),
      EditorView.theme({ '&': { height: '100%', color: theme.palette.text.primary, backgroundColor: theme.palette.background.paper },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '13px', lineHeight: 1.55 },
        '.cm-content': { caretColor: theme.palette.primary.main },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: theme.palette.primary.main },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: alpha(theme.palette.primary.main, 0.25) },
        '.cm-activeLine': { backgroundColor: alpha(theme.palette.text.primary, 0.04) },
        '.cm-gutters': { backgroundColor: theme.palette.background.paper, color: theme.palette.text.secondary, borderRight: `1px solid ${theme.palette.divider}` },
        '.cm-activeLineGutter': { backgroundColor: alpha(theme.palette.text.primary, 0.06), color: theme.palette.text.primary } }, { dark: theme.palette.mode === 'dark' })
    ] }) }); editor.current = view;
    void workspaceLanguage(path).then(extension => { if (!disposed) view.dispatch({ effects: language.reconfigure(extension) }); }).catch(() => {});
    return () => { disposed = true; editor.current = null; view.destroy(); };
  }, [path, theme]);
  useEffect(() => {
    const view = editor.current; if (view && view.state.doc.toString() !== content)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, [content, path, theme]);
  useEffect(() => {
    const view = editor.current;
    if (view) view.dispatch({ effects: review.current.reconfigure(workspaceDiffDecorations(view, hunks, localize(locale, 'Giữ', 'Keep'), onKeep, localize(locale, 'Hoàn tác', 'Revert'), onRevert, localize(locale, 'Comment dòng đã xóa', 'Comment on removed line'), onComment)) });
  }, [hunks, onKeep, onRevert, onComment, content, path, theme, locale]);
  useEffect(() => { editor.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly, path, theme]);
  useEffect(() => {
    const view = editor.current; if (!view) return;
    const target = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line))).from;
    view.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: 'center' }) });
  }, [line, path, theme]);
  return <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    {onComment && <Button size="small" onClick={() => {
      const view = editor.current; if (!view) return;
      const selected = view.state.doc.lineAt(view.state.selection.main.head); onComment(selected.number, selected.text);
    }}>{localize(locale, 'Comment dòng hiện tại', 'Comment on current line')}</Button>}
    <Box ref={host} sx={{ flex: 1, minHeight: 240, overflow: 'hidden' }} />
  </Box>;
}
