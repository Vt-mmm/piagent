import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

// The member saves through CodeMirror, then runs the project's test in xterm.
export async function memberEditorAndTests(page, project) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
  await page.getByRole('button', { name: 'member.txt', exact: true }).click();
  const editor = page.locator('.cm-content').first();
  await expect(editor).toHaveText('before');
  await editor.fill('member saved\n');
  await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await expect.poll(() => fs.readFileSync(path.join(project, 'member.txt'), 'utf8'), { timeout: 30000 }).toBe('member saved\n');
  await expect(page.getByRole('tab', { name: 'member.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const open = page.getByRole('button', { name: 'Mở terminal', exact: true });
  {
    await open.click();
    await page.locator('.xterm-helper-textarea:visible').focus();
    await page.keyboard.type("env -u NODE_TEST_CONTEXT node --test --test-reporter=tap member.test.mjs && printf 'IDE_%s\\n' TEST_PASS");
    await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText('IDE_TEST_PASS', { timeout: 30000 });
    await expect(page.locator('.xterm-rows')).toContainText('# pass 1');
    await page.getByRole('button', { name: /Đóng terminal|Close terminal/ }).click();
  }
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'checkpoint.txt', exact: true }).click();
  await expect(editor).toContainText('before');
  assert.equal(fs.readFileSync(path.join(project, 'member.txt'), 'utf8'), 'member saved\n');
}

export async function reviewAgentHunk(page, project) {
  await expect(page.locator('.cm-content').first()).toContainText('agent turn 1', { timeout: 30000 });
  await expect(page.locator('.cm-agent-added')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('.cm-agent-deleted')).toHaveCount(1);
  await page.getByRole('button', { name: /^(Giữ|Keep)$/ }).first().click();
  await expect(page.locator('.cm-agent-added')).toHaveCount(0);
  assert.equal(fs.readFileSync(path.join(project, 'checkpoint.txt'), 'utf8'), 'agent turn 1\n', 'Keep changes only review state');
}
