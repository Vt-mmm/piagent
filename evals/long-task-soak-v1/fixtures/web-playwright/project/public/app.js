// Bảng việc — vanilla JS, không framework. Xem SPEC.md.
const COLUMNS = [
  { id: 'todo', title: 'Cần làm' },
  { id: 'doing', title: 'Đang làm' },
  { id: 'done', title: 'Xong' },
];

let cards = []; // { id, title, tags: string[], column }
let nextId = 1;

const board = document.querySelector('#board');
const form = document.querySelector('#new-card');
const titleInput = form.querySelector('[data-testid="new-card-title"]');
const tagsInput = form.querySelector('[data-testid="new-card-tags"]');

function render() {
  board.replaceChildren(...COLUMNS.map(column => {
    const section = document.createElement('section');
    section.className = 'column';
    section.dataset.testid = `column-${column.id}`;
    const heading = document.createElement('h2');
    heading.textContent = column.title;
    const list = document.createElement('ul');
    for (const card of cards.filter(c => c.column === column.id)) {
      const item = document.createElement('li');
      item.className = 'card';
      item.dataset.testid = 'card';
      item.innerHTML = `<span data-testid="card-title">${card.title}</span>`;
      list.append(item);
    }
    section.append(heading, list);
    return section;
  }));
}

form.addEventListener('submit', event => {
  event.preventDefault();
  // TODO: kiểm tra tiêu đề, chuẩn hoá nhãn, lưu localStorage (SPEC.md)
  cards.push({ id: String(nextId++), title: titleInput.value, tags: tagsInput.value.split(','), column: 'todo' });
  titleInput.value = '';
  tagsInput.value = '';
  render();
});

render();
