import { test, expect } from '@playwright/test';

const add = async (page, title, tags = '') => {
  await page.getByTestId('new-card-title').fill(title);
  await page.getByTestId('new-card-tags').fill(tags);
  await page.getByRole('button', { name: 'Thêm thẻ' }).click();
};
const card = (page, title) => page.getByTestId('card').filter({ has: page.getByTestId('card-title').getByText(title, { exact: true }) });

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('thêm thẻ: chuẩn hoá nhãn, kiểm tra tiêu đề, Enter', async ({ page }) => {
  await add(page, '   ');
  await expect(page.getByTestId('form-error')).toHaveText('Tiêu đề không được để trống');
  await add(page, 'x'.repeat(81));
  await expect(page.getByTestId('form-error')).toHaveText('Tiêu đề tối đa 80 ký tự');
  await add(page, '  Viết báo cáo ', ' Gấp, khách ,gấp,, ');
  await expect(page.getByTestId('form-error')).toBeHidden();
  await expect(page.getByTestId('new-card-title')).toBeFocused();
  const c = card(page, 'Viết báo cáo');
  await expect(c.getByTestId('card-tag')).toHaveText(['gấp', 'khách']);
  await page.getByTestId('new-card-title').fill('<b>Enter</b>');
  await page.getByTestId('new-card-title').press('Enter');
  await expect(page.getByTestId('column-todo').getByTestId('card-title')).toHaveText(['Viết báo cáo', '<b>Enter</b>']);
  await expect(page.getByTestId('count-todo')).toHaveText('2');
});

test('sửa tiêu đề: Enter lưu, Escape huỷ, lỗi khi rỗng', async ({ page }) => {
  await add(page, 'Cũ');
  await page.getByRole('button', { name: 'Sửa thẻ: Cũ' }).click();
  const input = page.getByRole('textbox', { name: 'Sửa tiêu đề' });
  await expect(input).toBeFocused();
  await input.fill('');
  await input.press('Enter');
  await expect(page.getByTestId('card').getByRole('alert')).toHaveText('Tiêu đề không được để trống');
  await input.fill('Mới');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Sửa thẻ: Mới' })).toBeFocused();
  await page.getByRole('button', { name: 'Sửa thẻ: Mới' }).click();
  await page.getByTestId('edit-title').fill('Bỏ');
  await page.getByTestId('edit-title').press('Escape');
  await expect(page.getByTestId('card-title')).toHaveText(['Mới']);
});

test('xoá thẻ hỏi xác nhận qua dialog', async ({ page }) => {
  await add(page, 'Rác');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Xoá thẻ: Rác' }).click();
  await expect(page.getByTestId('card')).toHaveCount(1);
  page.once('dialog', dialog => { expect(dialog.message()).toBe('Xoá thẻ "Rác"?'); dialog.accept(); });
  await page.getByRole('button', { name: 'Xoá thẻ: Rác' }).click();
  await expect(page.getByTestId('card')).toHaveCount(0);
});

test('chuyển cột bằng nút, Alt+ArrowRight và kéo thả', async ({ page }) => {
  await add(page, 'A'); await add(page, 'B');
  await page.getByRole('button', { name: 'Chuyển sang phải: A' }).click();
  await expect(page.getByTestId('announcer')).toHaveText('Đã chuyển "A" sang Đang làm');
  await card(page, 'A').press('Alt+ArrowRight');
  await expect(page.getByTestId('column-done').getByTestId('card-title')).toHaveText(['A']);
  await expect(card(page, 'A')).toBeFocused();
  await card(page, 'B').dragTo(page.getByTestId('column-doing'));
  await expect(page.getByTestId('column-doing').getByTestId('card-title')).toHaveText(['B']);
});

test('lọc theo nhãn', async ({ page }) => {
  await add(page, 'A', 'web'); await add(page, 'B', 'api'); await add(page, 'C', 'web, api');
  await page.getByTestId('tag-filter').selectOption('web');
  await expect(page.getByTestId('card-title')).toHaveText(['A', 'C']);
  await expect(page.getByTestId('count-todo')).toHaveText('2');
});

test('localStorage: tải lại giữ nguyên, dữ liệu hỏng thì rỗng', async ({ page }) => {
  await add(page, 'Lưu', 'x');
  await page.reload();
  await expect(page.getByTestId('card-title')).toHaveText(['Lưu']);
  await page.evaluate(() => localStorage.setItem('bang-viec.v1', '{hỏng'));
  await page.reload();
  await expect(page.getByTestId('card')).toHaveCount(0);
});

test('mọi control có accessible name', async ({ page }) => {
  await add(page, 'A', 'x');
  for (const control of await page.locator('button, input, select').all()) await expect(control).toHaveAccessibleName(/\S/);
});
