// Hidden acceptance spec for SPEC.md (laid over the agent's work by the soak
// oracle; run with playwright.hidden.config.mjs on chromium).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const KEY = 'bang-viec.v1';
const column = (page, id) => page.getByTestId(`column-${id}`);
const titles = (page, id) => column(page, id).getByTestId('card-title');
const card = (page, title) => page.getByTestId('card').filter({ has: page.getByTestId('card-title').getByText(title, { exact: true }) });
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), KEY);

async function add(page, title, tags) {
  await page.getByTestId('new-card-title').fill(title);
  if (tags !== undefined) await page.getByTestId('new-card-tags').fill(tags);
  await page.getByTestId('add-card').click();
}
async function absentOrDisabled(locator) {
  if (await locator.count() === 0) return;
  await expect(locator).toBeDisabled();
}

test.describe('hidden acceptance', { tag: '@hidden' }, () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
  });
  test.afterEach(() => { expect(errors, 'no JavaScript errors on the page').toEqual([]); });

  test('0 layout: named column regions and counts', async ({ page }) => {
    for (const [id, name] of [['todo', 'Cần làm'], ['doing', 'Đang làm'], ['done', 'Xong']]) {
      await expect(page.getByRole('region', { name, exact: true })).toHaveAttribute('data-testid', `column-${id}`);
      await expect(column(page, id).getByRole('heading', { level: 2 })).toHaveText(name);
      await expect(page.getByTestId(`count-${id}`)).toHaveText('0');
    }
  });

  test('1 add card: validation, trimming, tags, order, Enter, literal text', async ({ page }) => {
    await expect(page.getByTestId('new-card-title')).toHaveAccessibleName('Tiêu đề thẻ');
    await expect(page.getByTestId('new-card-tags')).toHaveAccessibleName('Nhãn');
    await expect(page.getByTestId('add-card')).toHaveAccessibleName('Thêm thẻ');

    await add(page, '    ');
    await expect(page.getByTestId('form-error')).toHaveText('Tiêu đề không được để trống');
    await expect(page.getByTestId('form-error')).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('card')).toHaveCount(0);
    await add(page, 'y'.repeat(81));
    await expect(page.getByTestId('form-error')).toHaveText('Tiêu đề tối đa 80 ký tự');
    await expect(page.getByTestId('card')).toHaveCount(0);

    await add(page, 'z'.repeat(80));
    await expect(page.getByTestId('form-error')).toBeHidden();
    await add(page, '  Gọi khách hàng  ', ' Gấp , KHÁCH,gấp,, ,khách ');
    await expect(page.getByTestId('new-card-title')).toHaveValue('');
    await expect(page.getByTestId('new-card-tags')).toHaveValue('');
    await expect(page.getByTestId('new-card-title')).toBeFocused();
    await expect(card(page, 'Gọi khách hàng').getByTestId('card-tag')).toHaveText(['gấp', 'khách']);

    await page.getByTestId('new-card-title').fill('<img src=x onerror="window.__xss=1"><b>đậm</b>');
    await page.getByTestId('new-card-title').press('Enter');
    await expect(titles(page, 'todo')).toHaveText(['z'.repeat(80), 'Gọi khách hàng', '<img src=x onerror="window.__xss=1"><b>đậm</b>']);
    expect(await page.evaluate(() => window.__xss ?? null)).toBeNull();
    await expect(page.getByTestId('count-todo')).toHaveText('3');
    await expect(page.getByTestId('count-doing')).toHaveText('0');
  });

  test('2 edit title: Enter saves, Escape cancels, invalid keeps editing, focus returns', async ({ page }) => {
    await add(page, 'Bản nháp');
    await add(page, 'Khác');
    await page.getByRole('button', { name: 'Sửa thẻ: Bản nháp', exact: true }).click();
    const input = page.getByTestId('edit-title');
    await expect(input).toHaveAccessibleName('Sửa tiêu đề');
    await expect(input).toHaveValue('Bản nháp');
    await expect(input).toBeFocused();
    await input.fill('   ');
    await input.press('Enter');
    await expect(page.getByTestId('card').first().getByRole('alert')).toHaveText('Tiêu đề không được để trống');
    await expect(page.getByTestId('edit-title')).toBeVisible();
    await page.getByTestId('edit-title').fill('w'.repeat(81));
    await page.getByTestId('edit-title').press('Enter');
    await expect(page.getByTestId('card').first().getByRole('alert')).toHaveText('Tiêu đề tối đa 80 ký tự');
    await page.getByTestId('edit-title').fill('  Bản chính thức ');
    await page.getByTestId('edit-title').press('Enter');
    await expect(page.getByTestId('edit-title')).toHaveCount(0);
    await expect(titles(page, 'todo')).toHaveText(['Bản chính thức', 'Khác']);
    await expect(page.getByRole('button', { name: 'Sửa thẻ: Bản chính thức', exact: true })).toBeFocused();

    await page.getByRole('button', { name: 'Sửa thẻ: Khác', exact: true }).click();
    await page.getByTestId('edit-title').fill('Không lưu');
    await page.getByTestId('edit-title').press('Escape');
    await expect(titles(page, 'todo')).toHaveText(['Bản chính thức', 'Khác']);
    await expect(page.getByRole('button', { name: 'Sửa thẻ: Khác', exact: true })).toBeFocused();
    await page.reload();
    await expect(titles(page, 'todo')).toHaveText(['Bản chính thức', 'Khác']);
  });

  test('3 delete asks window.confirm and only deletes on accept', async ({ page }) => {
    await add(page, 'Giữ lại');
    await add(page, 'Bỏ đi');
    const messages = [];
    page.once('dialog', d => { messages.push([d.type(), d.message()]); d.dismiss(); });
    await page.getByRole('button', { name: 'Xoá thẻ: Bỏ đi', exact: true }).click();
    await expect(titles(page, 'todo')).toHaveText(['Giữ lại', 'Bỏ đi']);
    page.once('dialog', d => { messages.push([d.type(), d.message()]); d.accept(); });
    await page.getByRole('button', { name: 'Xoá thẻ: Bỏ đi', exact: true }).click();
    await expect(titles(page, 'todo')).toHaveText(['Giữ lại']);
    expect(messages).toEqual([['confirm', 'Xoá thẻ "Bỏ đi"?'], ['confirm', 'Xoá thẻ "Bỏ đi"?']]);
    await page.reload();
    await expect(titles(page, 'todo')).toHaveText(['Giữ lại']);
  });

  test('4 move with buttons: edges, end of target column, announcer', async ({ page }) => {
    for (const t of ['A', 'B', 'C']) await add(page, t);
    await expect(page.getByTestId('announcer')).toHaveAttribute('aria-live', 'polite');
    await absentOrDisabled(page.getByRole('button', { name: 'Chuyển sang trái: A', exact: true }));
    await page.getByRole('button', { name: 'Chuyển sang phải: B', exact: true }).click();
    await expect(page.getByTestId('announcer')).toHaveText('Đã chuyển "B" sang Đang làm');
    await page.getByRole('button', { name: 'Chuyển sang phải: A', exact: true }).click();
    await expect(titles(page, 'doing')).toHaveText(['B', 'A']);
    await expect(titles(page, 'todo')).toHaveText(['C']);
    await page.getByRole('button', { name: 'Chuyển sang phải: B', exact: true }).click();
    await expect(page.getByTestId('announcer')).toHaveText('Đã chuyển "B" sang Xong');
    await absentOrDisabled(page.getByRole('button', { name: 'Chuyển sang phải: B', exact: true }));
    await page.getByRole('button', { name: 'Chuyển sang trái: A', exact: true }).click();
    await expect(titles(page, 'todo')).toHaveText(['C', 'A']);
    await expect(page.getByTestId('announcer')).toHaveText('Đã chuyển "A" sang Cần làm');
    await expect(page.getByTestId('count-todo')).toHaveText('2');
    await expect(page.getByTestId('count-done')).toHaveText('1');
  });

  test('4 keyboard: Tab-focusable cards, Alt+arrows move and reorder, focus stays', async ({ page }) => {
    for (const t of ['K1', 'K2', 'K3']) await add(page, t);
    expect(await card(page, 'K2').evaluate(el => el.tabIndex)).toBeGreaterThanOrEqual(0);
    await card(page, 'K3').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(titles(page, 'todo')).toHaveText(['K1', 'K3', 'K2']);
    await expect(card(page, 'K3')).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(titles(page, 'todo')).toHaveText(['K3', 'K1', 'K2']);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(titles(page, 'todo')).toHaveText(['K1', 'K3', 'K2']);
    await expect(card(page, 'K3')).toBeFocused();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(titles(page, 'doing')).toHaveText(['K3']);
    await expect(card(page, 'K3')).toBeFocused();
    await expect(page.getByTestId('announcer')).toHaveText('Đã chuyển "K3" sang Đang làm');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(titles(page, 'done')).toHaveText(['K3']);
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(titles(page, 'todo')).toHaveText(['K1', 'K2', 'K3']);
    await expect(card(page, 'K3')).toBeFocused();
    await page.reload();
    await expect(titles(page, 'todo')).toHaveText(['K1', 'K2', 'K3']);
  });

  test('4 drag and drop between columns', async ({ page }) => {
    for (const t of ['D1', 'D2', 'D3']) await add(page, t);
    await card(page, 'D2').dragTo(column(page, 'done'));
    await expect(titles(page, 'done')).toHaveText(['D2']);
    await expect(page.getByTestId('announcer')).toHaveText('Đã chuyển "D2" sang Xong');
    await card(page, 'D1').dragTo(column(page, 'done'));
    await expect(titles(page, 'done')).toHaveText(['D2', 'D1']);
    await card(page, 'D2').dragTo(column(page, 'doing'));
    await expect(titles(page, 'doing')).toHaveText(['D2']);
    await expect(titles(page, 'todo')).toHaveText(['D3']);
    await page.reload();
    await expect(titles(page, 'done')).toHaveText(['D1']);
  });

  test('5 filter by tag: sorted options, filtering, counts, reset when tag disappears', async ({ page }) => {
    const filter = page.getByTestId('tag-filter');
    await expect(filter).toHaveAccessibleName('Lọc theo nhãn');
    await add(page, 'F1', 'web, bug');
    await add(page, 'F2', 'api');
    await add(page, 'F3', 'web');
    await page.getByRole('button', { name: 'Chuyển sang phải: F3', exact: true }).click();
    await expect(filter.locator('option')).toHaveText(['Tất cả nhãn', 'api', 'bug', 'web']);
    expect(await filter.locator('option').first().getAttribute('value')).toBe('');
    await filter.selectOption('web');
    await expect(page.getByTestId('card-title')).toHaveText(['F1', 'F3']);
    await expect(page.getByTestId('count-todo')).toHaveText('1');
    await expect(page.getByTestId('count-doing')).toHaveText('1');
    await filter.selectOption('api');
    await expect(page.getByTestId('card-title')).toHaveText(['F2']);
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Xoá thẻ: F2', exact: true }).click();
    await expect(filter).toHaveValue('');
    await expect(filter.locator('option')).toHaveText(['Tất cả nhãn', 'bug', 'web']);
    await expect(page.getByTestId('card')).toHaveCount(2);
    await add(page, 'F4', 'Zeta');
    await expect(filter.locator('option')).toHaveText(['Tất cả nhãn', 'bug', 'web', 'zeta']);
  });

  test('6 localStorage format, reload, external data, corrupt data', async ({ page }) => {
    await add(page, 'S1', 'x, y');
    await add(page, 'S2');
    await page.getByRole('button', { name: 'Chuyển sang phải: S1', exact: true }).click();
    const data = await stored(page);
    expect(Object.keys(data)).toEqual(['cards']);
    expect(data.cards.map(({ title, tags, column }) => ({ title, tags, column }))).toEqual(
      expect.arrayContaining([{ title: 'S1', tags: ['x', 'y'], column: 'doing' }, { title: 'S2', tags: [], column: 'todo' }]));
    expect(data.cards).toHaveLength(2);
    expect(new Set(data.cards.map(c => typeof c.id === 'string' && c.id)).size).toBe(2);
    await page.reload();
    await expect(titles(page, 'doing')).toHaveText(['S1']);
    await expect(titles(page, 'todo')).toHaveText(['S2']);

    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ cards: [
      { id: 'e1', title: 'Ngoài 1', tags: ['ops'], column: 'done' },
      { id: 'e2', title: 'Ngoài 2', tags: [], column: 'todo' },
      { id: 'e3', title: 'Ngoài 3', tags: ['ops', 'db'], column: 'done' },
    ] })), KEY);
    await page.reload();
    await expect(titles(page, 'done')).toHaveText(['Ngoài 1', 'Ngoài 3']);
    await expect(titles(page, 'todo')).toHaveText(['Ngoài 2']);
    await expect(page.getByTestId('tag-filter').locator('option')).toHaveText(['Tất cả nhãn', 'db', 'ops']);
    await page.getByRole('button', { name: 'Chuyển sang trái: Ngoài 3', exact: true }).click();
    const after = await stored(page);
    expect(after.cards.find(c => c.id === 'e3').column).toBe('doing');

    for (const bad of ['{not json', JSON.stringify({ cards: 'nope' }), JSON.stringify([1, 2]), JSON.stringify({ cards: [{ id: 'x', title: 'T', tags: [], column: 'later' }] })]) {
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [KEY, bad]);
      await page.reload();
      await expect(page.getByTestId('card')).toHaveCount(0);
      await expect(page.getByTestId('count-todo')).toHaveText('0');
    }
    await add(page, 'Sau khi hỏng');
    await expect(titles(page, 'todo')).toHaveText(['Sau khi hỏng']);
  });

  test('7 every control has an accessible name; card controls are named exactly', async ({ page }) => {
    await add(page, 'Tên', 'a');
    await page.getByRole('button', { name: 'Chuyển sang phải: Tên', exact: true }).click();
    for (const name of ['Chuyển sang trái: Tên', 'Chuyển sang phải: Tên', 'Sửa thẻ: Tên', 'Xoá thẻ: Tên']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    }
    const controls = await page.locator('button, input, select, textarea').all();
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const control of controls) await expect(control).toHaveAccessibleName(/\S/);
    await page.getByRole('button', { name: 'Sửa thẻ: Tên', exact: true }).click();
    for (const control of await page.locator('button, input, select, textarea').all()) await expect(control).toHaveAccessibleName(/\S/);
  });

  test('8 the project has its own Playwright config and e2e tests', async () => {
    const root = process.cwd();
    const config = fs.readdirSync(root).find(f => /^playwright\.config\.(js|mjs|cjs|ts)$/.test(f));
    expect(config, 'playwright.config.* exists').toBeTruthy();
    const text = fs.readFileSync(path.join(root, config), 'utf8');
    for (const word of ['webServer', 'npm start', 'PORT', 'baseURL']) expect(text, `config mentions ${word}`).toContain(word);
    const dir = path.join(root, 'e2e');
    const own = fs.readdirSync(dir).filter(f => /\.(spec|test)\.(js|mjs|ts)$/.test(f) && !f.startsWith('zz-hidden'));
    const code = own.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const groups = [
      ['new-card-title', 'add-card', 'Thêm thẻ'], ['Sửa'], ['dialog'], ['Alt+Arrow'],
      ['dragTo', 'dragAndDrop', 'dispatchEvent', 'mouse.down'], ['tag-filter', 'Lọc theo nhãn'], ['reload'], ['localStorage'],
      ['toHaveAccessibleName', 'accessibleName', 'aria-label', 'getByRole', 'getByLabel'],
    ];
    for (const words of groups) expect(words.some(w => code.includes(w)), `own e2e tests mention one of ${words.join(' | ')}`).toBe(true);
  });
});
