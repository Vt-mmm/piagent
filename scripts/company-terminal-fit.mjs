// What the company Terminal pins under the conversation must fit the window:
// the checklist above the input and a question in the input's place. Pi draws
// a question's whole text as its title, so a long command (a commit message
// of many lines) pushed the answers off the screen, under the checklist.

const MARK = { completed: '☑', in_progress: '☐', deferred: '⊘', pending: '☐' };
const stepLine = (p, added) => `  ${MARK[p.status] ?? '☐'} ${p.step}${added?.(p) ? `  [+${added(p)}]` : ''}${p.status === 'in_progress' ? '  ← đang làm' : p.status === 'deferred' ? '  (để phase sau)' : ''}`;

// The checklist in at most `max` lines: the steps done before the first open
// one fold into a count, and the open steps that do not fit into another.
// `phase` (managed/plan-phase.mjs): the header with original and added steps,
// and where an added step came from.
export function planPanelLines(plan, max = 6, phase = null) {
  const steps = Array.isArray(plan) ? plan : [];
  const head = phase?.head ?? `Plan · ${steps.filter((p) => p.status === 'completed').length}/${steps.length} bước xong`;
  const line = (p) => stepLine(p, phase?.addedFrom);
  if (steps.length + 1 <= max) return [head, ...steps.map(line)];
  const first = steps.findIndex((p) => p.status !== 'completed');
  const done = first < 0 ? steps.length : first;
  const lines = [head];
  if (done) lines.push(`  ☑ ${done} bước đầu đã xong`);
  const rest = steps.slice(done), room = max - lines.length;
  if (rest.length <= room) return [...lines, ...rest.map(line)];
  return [...lines, ...rest.slice(0, room - 1).map(line), `  … ${rest.length - room + 1} bước nữa`];
}

// The rows a question's text may take: the window less the question's frame
// and answers, the checklist, the footer and a line of the conversation.
const FRAME = 7, PANEL = 6, FOOTER = 3, AROUND = 3;
export function promptRows(terminalRows, answers) {
  return Math.max(4, Number(terminalRows) - FRAME - Math.max(1, answers) - PANEL - FOOTER - AROUND);
}

const rowsOf = (line, width, measure) => Math.max(1, Math.ceil(measure(line) / width));
// A line cut to `rows` rows of the window, ending in "…" when cut.
function cut(line, rows, width, measure) {
  if (rowsOf(line, width, measure) <= rows) return line;
  const room = Math.max(1, rows * width - 1);
  let text = line.slice(0, room);
  while (text && measure(text) > room) text = text.slice(0, -1);
  return `${text}…`;
}

// The question's text in `rows` rows of `width` columns: its first line (the
// title) and its last lines (reason, what yes and no do) stay; the middle (the
// rest of a long command) becomes one line saying how much is hidden.
export function fitPrompt(text, { rows, width, measure = (s) => s.length }) {
  const lines = String(text ?? '').split('\n');
  const w = Math.max(10, width);
  const total = lines.reduce((sum, line) => sum + rowsOf(line, w, measure), 0);
  if (!rows || total <= rows) return String(text ?? '');
  const title = cut(lines[0], 2, w, measure);
  const note = (n) => `  … ẩn ${n} dòng (cửa sổ thấp)`;
  let budget = rows - rowsOf(title, w, measure) - rowsOf(note(lines.length), w, measure);
  // The start of the command keeps up to 3 rows; the end gets the rest.
  const keep = Math.min(3, Math.floor(budget / 3));
  const tail = [];
  for (let i = lines.length - 1, room = budget - keep; i > 0; i--) {
    const need = rowsOf(lines[i], w, measure);
    if (need > room) break;
    tail.unshift(lines[i]); room -= need; budget -= need;
  }
  const head = [];
  for (let i = 1; i < lines.length - tail.length && budget > 0; i++) {
    const line = cut(lines[i], budget, w, measure);
    head.push(line); budget -= rowsOf(line, w, measure);
    if (line !== lines[i]) break;
  }
  const hidden = lines.length - 1 - tail.length - head.filter((line, i) => line === lines[i + 1]).length;
  return [title, ...head, note(Math.max(1, hidden)), ...tail].join('\n');
}
