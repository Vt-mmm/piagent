// Bảng việc — vanilla JS, không framework. Xem SPEC.md.
const COLUMNS = [
  { id: 'todo', title: 'Cần làm' },
  { id: 'doing', title: 'Đang làm' },
  { id: 'done', title: 'Xong' },
];
const COLUMN_IDS = COLUMNS.map(c => c.id);
const STORAGE_KEY = 'bang-viec.v1';
const MAX_TITLE = 80;

const board = document.querySelector('#board');
const form = document.querySelector('#new-card');
const titleInput = form.querySelector('[data-testid="new-card-title"]');
const tagsInput = form.querySelector('[data-testid="new-card-tags"]');
const formError = form.querySelector('[data-testid="form-error"]');
const filterSelect = document.querySelector('[data-testid="tag-filter"]');
const announcer = document.querySelector('[data-testid="announcer"]');

const state = { cards: load(), filter: '', editing: null, editError: '' };

// ---- storage -------------------------------------------------------------
function isCard(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && c.id && typeof c.title === 'string'
    && Array.isArray(c.tags) && c.tags.every(t => typeof t === 'string') && COLUMN_IDS.includes(c.column);
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!data || !Array.isArray(data.cards) || !data.cards.every(isCard)) return [];
    if (new Set(data.cards.map(c => c.id)).size !== data.cards.length) return [];
    return data.cards.map(({ id, title, tags, column }) => ({ id, title, tags: [...tags], column }));
  } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ cards: state.cards })); } catch { /* quota/private mode */ }
}

// ---- rules ---------------------------------------------------------------
function titleError(title) {
  if (!title) return 'Tiêu đề không được để trống';
  if (title.length > MAX_TITLE) return `Tiêu đề tối đa ${MAX_TITLE} ký tự`;
  return '';
}
function parseTags(text) {
  const seen = new Set();
  for (const raw of text.split(',')) { const tag = raw.trim().toLowerCase(); if (tag) seen.add(tag); }
  return [...seen];
}
let counter = 0;
const newId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const columnTitle = id => COLUMNS.find(c => c.id === id).title;
const allTags = () => [...new Set(state.cards.flatMap(c => c.tags))].sort((a, b) => a.localeCompare(b, 'vi'));

// ---- actions -------------------------------------------------------------
function commit(focus) { save(); render(); focus?.(); }
const focusCard = id => () => board.querySelector(`[data-card-id="${CSS.escape(id)}"]`)?.focus();
const focusEdit = id => () => board.querySelector(`[data-card-id="${CSS.escape(id)}"] [data-action="edit"]`)?.focus();

function addCard() {
  const title = titleInput.value.trim(), error = titleError(title);
  if (error) { formError.textContent = error; formError.hidden = false; titleInput.focus(); return; }
  formError.textContent = ''; formError.hidden = true;
  state.cards.push({ id: newId(), title, tags: parseTags(tagsInput.value), column: 'todo' });
  titleInput.value = ''; tagsInput.value = '';
  commit(() => titleInput.focus());
}

function moveToColumn(id, column) {
  const index = state.cards.findIndex(c => c.id === id);
  if (index < 0 || !COLUMN_IDS.includes(column) || state.cards[index].column === column) return;
  const [card] = state.cards.splice(index, 1);
  card.column = column;
  state.cards.push(card);
  announcer.textContent = `Đã chuyển "${card.title}" sang ${columnTitle(column)}`;
  commit(focusCard(id));
}
function shiftColumn(id, step) {
  const card = state.cards.find(c => c.id === id);
  const target = COLUMN_IDS[COLUMN_IDS.indexOf(card.column) + step];
  if (target) moveToColumn(id, target);
}
function reorder(id, step) {
  const index = state.cards.findIndex(c => c.id === id), card = state.cards[index];
  let other = index + step;
  while (other >= 0 && other < state.cards.length && state.cards[other].column !== card.column) other += step;
  if (other < 0 || other >= state.cards.length) return;
  [state.cards[index], state.cards[other]] = [state.cards[other], state.cards[index]];
  commit(focusCard(id));
}
function removeCard(id) {
  const card = state.cards.find(c => c.id === id);
  if (!card || !window.confirm(`Xoá thẻ "${card.title}"?`)) return;
  state.cards = state.cards.filter(c => c.id !== id);
  commit(() => titleInput.focus());
}
function saveEdit(id, value) {
  const title = value.trim(), error = titleError(title);
  if (error) { state.editError = error; render(); const input = board.querySelector('[data-testid="edit-title"]'); input.value = value; input.focus(); return; }
  state.cards.find(c => c.id === id).title = title;
  state.editing = null; state.editError = '';
  commit(focusEdit(id));
}
function cancelEdit(id) { state.editing = null; state.editError = ''; render(); focusEdit(id)(); }

// ---- view ----------------------------------------------------------------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
  return node;
}
const button = (label, text, action, extra = {}) => el('button', { type: 'button', 'aria-label': label, dataset: { action }, ...extra }, text);

function renderCard(card) {
  const col = COLUMN_IDS.indexOf(card.column);
  const editing = state.editing === card.id;
  const title = editing
    ? el('input', { 'data-testid': 'edit-title', 'aria-label': 'Sửa tiêu đề', value: card.title, dataset: { action: 'edit-input' } })
    : el('span', { 'data-testid': 'card-title', className: 'title' }, card.title);
  return el('li', { 'data-testid': 'card', className: 'card', tabIndex: 0, draggable: !editing, dataset: { cardId: card.id } },
    title,
    editing && state.editError ? el('p', { role: 'alert', className: 'error' }, state.editError) : null,
    card.tags.length ? el('ul', { className: 'tags', 'aria-label': 'Nhãn' }, ...card.tags.map(t => el('li', { 'data-testid': 'card-tag', className: 'tag' }, t))) : null,
    el('div', { className: 'actions' },
      col > 0 ? button(`Chuyển sang trái: ${card.title}`, '←', 'left') : null,
      button(`Sửa thẻ: ${card.title}`, 'Sửa', 'edit'),
      button(`Xoá thẻ: ${card.title}`, 'Xoá', 'delete'),
      col < COLUMN_IDS.length - 1 ? button(`Chuyển sang phải: ${card.title}`, '→', 'right') : null));
}

function render() {
  const tags = allTags();
  if (state.filter && !tags.includes(state.filter)) state.filter = '';
  filterSelect.replaceChildren(el('option', { value: '' }, 'Tất cả nhãn'), ...tags.map(t => el('option', { value: t }, t)));
  filterSelect.value = state.filter;
  const visible = state.cards.filter(c => !state.filter || c.tags.includes(state.filter));
  board.replaceChildren(...COLUMNS.map(column => {
    const cards = visible.filter(c => c.column === column.id);
    const headingId = `heading-${column.id}`;
    return el('section', { 'data-testid': `column-${column.id}`, className: 'column', 'aria-labelledby': headingId, dataset: { column: column.id } },
      el('h2', { id: headingId }, column.title),
      el('span', { 'data-testid': `count-${column.id}`, className: 'count' }, String(cards.length)),
      el('ul', { className: 'cards' }, ...cards.map(renderCard)));
  }));
}

// ---- events --------------------------------------------------------------
form.addEventListener('submit', event => { event.preventDefault(); addCard(); });
filterSelect.addEventListener('change', () => { state.filter = filterSelect.value; render(); });

board.addEventListener('click', event => {
  const action = event.target.closest('button[data-action]')?.dataset.action;
  const id = event.target.closest('[data-card-id]')?.dataset.cardId;
  if (!action || !id) return;
  if (action === 'left') shiftColumn(id, -1);
  else if (action === 'right') shiftColumn(id, 1);
  else if (action === 'delete') removeCard(id);
  else if (action === 'edit') {
    state.editing = id; state.editError = ''; render();
    const input = board.querySelector('[data-testid="edit-title"]');
    input.focus(); input.select();
  }
});

board.addEventListener('keydown', event => {
  const input = event.target.closest('[data-testid="edit-title"]');
  if (input) {
    const id = input.closest('[data-card-id]').dataset.cardId;
    if (event.key === 'Enter') { event.preventDefault(); saveEdit(id, input.value); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelEdit(id); }
    return;
  }
  if (!event.altKey || !event.target.matches('[data-testid="card"]')) return;
  const id = event.target.dataset.cardId;
  const moves = { ArrowLeft: () => shiftColumn(id, -1), ArrowRight: () => shiftColumn(id, 1), ArrowUp: () => reorder(id, -1), ArrowDown: () => reorder(id, 1) };
  if (moves[event.key]) { event.preventDefault(); moves[event.key](); }
});

board.addEventListener('dragstart', event => {
  const card = event.target.closest?.('[data-card-id]');
  if (!card) return;
  event.dataTransfer.setData('text/plain', card.dataset.cardId);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
board.addEventListener('dragend', event => event.target.closest?.('[data-card-id]')?.classList.remove('dragging'));
board.addEventListener('dragover', event => {
  if (!event.target.closest('[data-column]')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
board.addEventListener('drop', event => {
  const column = event.target.closest('[data-column]')?.dataset.column;
  const id = event.dataTransfer.getData('text/plain');
  if (!column || !id) return;
  event.preventDefault();
  moveToColumn(id, column);
});

render();
