import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { workspaceLanguage } from './workspace-language.ts';
import { EditorView, lineNumbers, highlightActiveLineGutter, keymap } from '@codemirror/view';
import { useTheme } from '@mui/material/styles';
import Box from '@mui/material/Box';

export default function WorkspaceCodeEditor({ content, path, line = 1, readOnly = true, onChange, onSave }: {
  content: string; path: string; line?: number; readOnly?: boolean; onChange?(value: string): void; onSave?(): void;
}) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), theme = useTheme();
  const callbacks = useRef({ onChange, onSave }); callbacks.current = { onChange, onSave };
  const initial = useRef(content); initial.current = content;
  const editable = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
    const language = new Compartment(); let disposed = false;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: initial.current, extensions: [
      EditorView.cspNonce.of(nonce ?? ''), editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      keymap.of(['Ctrl-s', 'Meta-s'].map(key => ({ key, run: () => { callbacks.current.onSave?.(); return true; } }))),
      EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString()); }),
      lineNumbers(), highlightActiveLineGutter(), syntaxHighlighting(defaultHighlightStyle), language.of([]), EditorView.contentAttributes.of({ 'aria-label': path, tabindex: '0' }),
      EditorView.theme({ '&': { height: '100%', color: theme.palette.text.primary, backgroundColor: theme.palette.background.paper },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
        '.cm-gutters': { backgroundColor: theme.palette.background.default, color: theme.palette.text.secondary } }, { dark: theme.palette.mode === 'dark' })
    ] }) }); editor.current = view;
    void workspaceLanguage(path).then(extension => { if (!disposed) view.dispatch({ effects: language.reconfigure(extension) }); }).catch(() => {});
    return () => { disposed = true; editor.current = null; view.destroy(); };
  }, [path, theme]);
  useEffect(() => {
    const view = editor.current; if (view && view.state.doc.toString() !== content)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, [content, path, theme]);
  useEffect(() => { editor.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly, path, theme]);
  useEffect(() => {
    const view = editor.current; if (!view) return;
    const target = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line))).from;
    view.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: 'center' }) });
  }, [line, path, theme]);
  return <Box ref={host} sx={{ height: '100%', minHeight: 240, overflow: 'hidden' }} />;
}
