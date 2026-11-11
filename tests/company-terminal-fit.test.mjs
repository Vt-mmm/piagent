import assert from 'node:assert/strict';
import test from 'node:test';

import { fitPrompt, planPanelLines, promptRows } from '../scripts/company-terminal-fit.mjs';
import { companyMode, planWidget } from '../scripts/company-terminal.mjs';

const commit = ['cd /repo; git add -A && git commit -q -m "Memory engine: room for its database', '',
  ...Array.from({ length: 24 }, (_, i) => `- line ${i + 1} of a long commit message that wraps across the window width`),
  '" && git log -1 --format=\'%h %s\''].join('\n');
const body = `${commit}\n\nLý do: Commit hoặc push code\nAlways bypass vẫn hỏi: git commit records code\n\nĐồng ý: chạy lệnh trên máy\nTừ chối: lệnh không chạy, agent được báo bạn đã từ chối.`;
const rowsIn = (text, width) => text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);

test('a long approval fits the window: title, start of the command, a hidden-lines note and every answer line stay', () => {
  const rows = promptRows(36, 2), width = 118;
  const fitted = fitPrompt(`Commit hoặc push code\n${body}`, { rows, width });
  assert.ok(rowsIn(fitted, width) <= rows, `${rowsIn(fitted, width)} rows > ${rows}`);
  const lines = fitted.split('\n');
  assert.equal(lines[0], 'Commit hoặc push code');
  assert.match(lines[1], /^cd \/repo; git add -A/);
  assert.ok(lines.some((line) => /… ẩn \d+ dòng/.test(line)));
  for (const kept of ['Lý do: Commit hoặc push code', 'Always bypass vẫn hỏi: git commit records code', 'Đồng ý: chạy lệnh trên máy', 'Từ chối: lệnh không chạy, agent được báo bạn đã từ chối.']) assert.ok(lines.includes(kept), kept);
  assert.equal(fitPrompt('Short\nYes or no?', { rows, width }), 'Short\nYes or no?', 'a question that fits is unchanged');
  assert.ok(rowsIn(fitPrompt(`T\n${'x'.repeat(5000)}\nĐồng ý: a`, { rows: 6, width: 40 }), 40) <= 6, 'one huge line is cut too');
  assert.equal(promptRows(10, 2), 4, 'a tiny window still shows a few rows');
});

test('the pinned checklist stays within 6 lines: steps done first fold into a count', () => {
  const plan = ['Khảo sát', 'Sửa 1', 'Sửa 2', 'Sửa 3', 'Sửa 4', 'Sửa 5', 'Commit', 'Báo cáo'].map((step, i) => ({ step, status: i < 6 ? 'completed' : i === 6 ? 'in_progress' : 'pending' }));
  assert.deepEqual(planWidget({ plan }), ['Plan · 6/8 bước xong', '  ☑ 6 bước đầu đã xong', '  ☐ Commit  ← đang làm', '  ☐ Báo cáo']);
  const open = Array.from({ length: 9 }, (_, i) => ({ step: `B${i + 1}`, status: i === 0 ? 'in_progress' : 'pending' }));
  assert.deepEqual(planPanelLines(open), ['Plan · 0/9 bước xong', '  ☐ B1  ← đang làm', '  ☐ B2', '  ☐ B3', '  ☐ B4', '  … 5 bước nữa']);
  assert.deepEqual(planPanelLines(plan.slice(0, 3)).length, 4, 'a short checklist shows every step');
});

test('the company Terminal cuts every question to the window before Pi draws it', async () => {
  const seen = [];
  class Base { showExtensionSelector(title, options, opts, blocked) { seen.push({ title, options, blocked }); return Promise.resolve(options[0]); }
    async showExtensionConfirm(title, message) { return await this.showExtensionSelector(`${title}\n${message}`, ['Yes', 'No'], undefined, { kind: 'permission', message: title }) === 'Yes'; } }
  const Mode = companyMode(Base, { summary: () => ({}), whatsNew: () => '', components: {} });
  const mode = new Mode(); mode.ui = { terminal: { rows: 36, columns: 120 } };
  assert.equal(await mode.showExtensionConfirm('Commit hoặc push code', body), true);
  assert.ok(rowsIn(seen[0].title, 118) <= promptRows(36, 2));
  assert.deepEqual(seen[0].blocked, { kind: 'permission', message: 'Commit hoặc push code' });
  await mode.showExtensionSelector('Chọn một', ['A', 'B']);
  assert.deepEqual(seen[1], { title: 'Chọn một', options: ['A', 'B'], blocked: { kind: 'question', message: 'Chọn một' } });
});
