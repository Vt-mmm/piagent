import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';

export async function qualifyCompanyCheckpoints(page, project, requests, grant) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const responses = [];
  page.on('response', async response => {
    if (new URL(response.url()).pathname.includes('/checkpoints')) {
      try { responses.push(await response.json()); } catch { /* Failed transport is asserted by the UI below. */ }
    }
  });
  for (const turn of [1, 2]) {
    await page.getByPlaceholder('Nhắn cho Piagent…').fill(`checkpoint turn ${turn}`);
    await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(page.getByText(`COMPANY_CHECKPOINT_${turn}_OK`, { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect.poll(() => fs.readFileSync(path.join(project, turn === 1 ? 'checkpoint.txt' : 'checkpoint-new.txt'), 'utf8')).toBe(`agent turn ${turn}\n`);
  }
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  git('add', 'checkpoint.txt', 'checkpoint-new.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member commit after agent turns');
  const head = git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(project, '.git/index'));
  await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
  await page.getByRole('button', { name: 'checkpoint.txt', exact: true }).click();
  const editor = page.locator('.cm-content').first();
  await expect(editor).toContainText('agent turn 1');
  await editor.fill('member unsaved draft');
  const calls = requests.length;
  const restore = page.getByRole('button', { name: 'Khôi phục về trước lượt này', exact: true });
  await expect(restore).toHaveCount(2, { timeout: 15000 });
  await restore.first().click();
  const dialog = page.getByRole('dialog', { name: 'Khôi phục về trước lượt này', exact: true });
  // Preview performs multiple real sandbox Git operations, also in the full suite.
  await expect(dialog.getByText(/Sẽ hoàn tác 2 lượt/)).toBeVisible({ timeout: 30000 });
  await expect(dialog.getByText(/checkpoint-new.txt/)).toBeVisible();
  assert.equal(fs.readFileSync(path.join(project, 'checkpoint.txt'), 'utf8'), 'agent turn 1\n');
  await dialog.getByRole('button', { name: 'Xác nhận khôi phục', exact: true }).click();
  // A confirmed relay mutation has a 120s transport budget. Observe its actual
  // receipt instead of ending this test while sandbox restoration is in flight.
  await expect.poll(() => responses.find(response => response.messageType === 'receipt')?.resultCode,
    { timeout: 120000 }).toBe('restored');
  const conflict = page.getByRole('dialog', { name: 'Tệp đã thay đổi trên đĩa', exact: true });
  await expect(conflict).toBeVisible();
  await expect(editor).toHaveText('member unsaved draft');
  await conflict.getByRole('button', { name: 'Để sau', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Đã khôi phục 2 lượt.');
  assert.equal(fs.readFileSync(path.join(project, 'checkpoint.txt'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(project, 'checkpoint-new.txt')), false);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(project, '.git/index')), index);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'COMPANY_TERMINAL_FIXTURE_SECRET=hidden\n');
  assert.equal(requests.length, calls, 'restoration must not call the model');
  assert.ok(responses.some(response => response.messageType === 'receipt' && response.resultCode === 'restored'));
  assert.ok(responses.every(response => !JSON.stringify(response).includes(grant)), 'Studio grant never reaches checkpoint HTTP responses');
  await dialog.getByRole('button', { name: 'Đóng', exact: true }).click();
  await expect(restore).toHaveCount(0);
  await page.getByRole('tab', { name: 'Phiên', exact: true }).click();
}
