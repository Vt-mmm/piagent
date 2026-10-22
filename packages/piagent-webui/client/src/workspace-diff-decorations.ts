import { StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap } from '@codemirror/view';
import type { Hunk } from '../../contracts/generated/diff-v1.ts';
type RemovedLine = { line: number; text: string };
class DeletedLines extends WidgetType {
  constructor(readonly lines: RemovedLine[], readonly label: string, readonly comment?: (line: number, code: string, side: 'old') => void) { super(); }
  toDOM() {
    const element = document.createElement('div'); element.className = 'cm-agent-deleted';
    for (const line of this.lines) {
      const row = document.createElement('div'), text = document.createElement('span'); text.textContent = `− ${line.text}`; row.append(text);
      if (this.comment) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = this.label;
        button.setAttribute('aria-label', `${this.label} ${line.line}`);
        button.addEventListener('click', () => this.comment?.(line.line, line.text, 'old')); row.append(button);
      }
      element.append(row);
    }
    return element;
  }
}
class ReviewActions extends WidgetType {
  constructor(readonly ref: string, readonly label: string, readonly keep: (ref: string) => void, readonly revertLabel: string, readonly revert?: (ref: string) => void) { super(); }
  toDOM() {
    const row = document.createElement('div'); row.className = 'cm-agent-actions';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = this.label;
    button.addEventListener('click', () => this.keep(this.ref)); row.append(button);
    if (this.revert) { const revert = document.createElement('button'); revert.type = 'button'; revert.textContent = this.revertLabel;
      revert.addEventListener('click', () => this.revert?.(this.ref)); row.append(revert); }
    return row;
  }
}
class AgentMarker extends GutterMarker {
  toDOM() { const marker = document.createElement('span'); marker.textContent = '▎'; marker.className = 'cm-agent-marker'; return marker; }
}
const marker = new AgentMarker();
export function workspaceDiffDecorations(view: EditorView, hunks: Hunk[], keepLabel: string, keep: (ref: string) => void, revertLabel: string, revert?: (ref: string) => void, commentLabel = '', comment?: (line: number, code: string, side: 'old') => void): Extension {
  const expected = view.state.doc.toString(), ranges: Range<Decoration>[] = [], starts: number[] = [];
  const position = (line: number) => view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line))).from;
  for (const hunk of hunks) {
    const start = position(hunk.newStart + (hunk.newLineCount === 0 ? 1 : 0)); starts.push(start);
    ranges.push(Decoration.widget({ widget: new ReviewActions(hunk.hunkRef, keepLabel, keep, revertLabel, revert), block: true, side: -1 }).range(start));
    let nextLine = hunk.newStart + (hunk.newLineCount === 0 ? 1 : 0), deleted: RemovedLine[] = [];
    const flush = () => { if (deleted.length) { ranges.push(Decoration.widget({ widget: new DeletedLines(deleted, commentLabel, comment), block: true, side: -1 }).range(position(nextLine))); deleted = []; } };
    for (const line of hunk.lines) {
      if (line.kind === 'deleted') { if (line.oldLineNumber !== null) deleted.push({ line: line.oldLineNumber, text: line.text }); continue; }
      flush();
      if (line.newLineNumber !== null) {
        nextLine = line.newLineNumber + 1;
        if (line.kind === 'added') ranges.push(Decoration.line({ class: 'cm-agent-added' }).range(position(line.newLineNumber)));
      }
    }
    flush();
  }
  const field = StateField.define({ create: () => Decoration.set(ranges, true),
    update: (value, transaction) => transaction.docChanged ? Decoration.none : value,
    provide: value => EditorView.decorations.from(value) });
  const move = (direction: number) => (editor: EditorView) => {
    if (!starts.length || editor.state.doc.toString() !== expected) return false;
    const cursor = editor.state.selection.main.head;
    const target = direction > 0 ? starts.find(at => at > cursor) ?? starts[0] : [...starts].reverse().find(at => at < cursor) ?? starts.at(-1)!;
    editor.dispatch({ selection: { anchor: target }, effects: EditorView.scrollIntoView(target, { y: 'center' }) }); return true;
  };
  return [field, hunks.length ? gutter({ class: 'cm-agent-gutter', lineMarker: (editor, line) => editor.state.field(field).size && starts.includes(line.from) ? marker : null }) : [],
    keymap.of([{ key: 'Alt-ArrowDown', run: move(1) }, { key: 'Alt-ArrowUp', run: move(-1) }]),
    EditorView.theme({ '.cm-agent-added': { backgroundColor: 'color-mix(in srgb, #2e9d55 15%, transparent)' },
      '.cm-agent-deleted': { margin: '0', padding: '2px 8px', whiteSpace: 'pre-wrap', backgroundColor: 'color-mix(in srgb, #df4545 15%, transparent)', fontFamily: 'monospace' },
      '.cm-agent-marker': { color: '#2e9d55' }, '.cm-agent-actions': { padding: '2px 8px' },
      '.cm-agent-actions button': { color: 'inherit', background: 'transparent', border: '1px solid currentColor', borderRadius: '4px', cursor: 'pointer' } })];
}
