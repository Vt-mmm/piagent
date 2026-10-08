import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeUpdateCache } from '../packages/piagent-core/extensions/update-check.js';
import { pendingUpdate, readSnooze, registerTerminalUpdateOffer, snoozeUpdate, SNOOZE_MS } from '../packages/piagent-core/runtime/update/terminal-update-offer.mjs';
import { companyTerminalExtension, failureLines, processLines } from '../scripts/company-terminal.mjs';
import { launchReasonText } from '../packages/piagent-webui/shared/company-copy.ts';

// The Terminal says what the dashboard says: a new release is asked about
// (Update now / Later for an hour), Bypass can be chosen, Harness notes and
// failures read in Vietnamese.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-parity-'));
// `npm test` switches update checks off for every other test; these turn them on.
const checksOn = (t) => { const before = process.env.PIAGENT_NO_UPDATE_CHECK; delete process.env.PIAGENT_NO_UPDATE_CHECK;
  t.after(() => { if (before === undefined) delete process.env.PIAGENT_NO_UPDATE_CHECK; else process.env.PIAGENT_NO_UPDATE_CHECK = before; }); };

function fakePi() {
  const handlers = new Map(), commands = new Map(), renderers = new Map();
  return { handlers, commands, renderers, pi: {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
  }, emit: async (name, event, ctx) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); } };
}
function fakeUi(answers = []) {
  const asked = [], notices = [], status = new Map();
  return { asked, notices, status, ctx: { hasUI: true, ui: {
    select: async (title, options) => { asked.push({ title, options }); return answers.shift(); },
    notify: (message, level) => notices.push({ message, level }),
    setStatus: (key, text) => status.set(key, text),
  } } };
}

test('a newer release is offered until it is put off, and put off for an hour per release', () => {
  const dir = home(), now = Date.now();
  writeUpdateCache(dir, '1.16.2', now);
  assert.equal(pendingUpdate({ installed: '1.16.1', home: dir, now }), '1.16.2');
  assert.equal(pendingUpdate({ installed: '1.16.2', home: dir, now }), null);
  snoozeUpdate('1.16.2', { home: dir, now });
  assert.equal(readSnooze(dir).until, now + SNOOZE_MS);
  assert.equal(pendingUpdate({ installed: '1.16.1', home: dir, now: now + 1000 }), null);
  assert.equal(pendingUpdate({ installed: '1.16.1', home: dir, now: now + SNOOZE_MS + 1 }), '1.16.2');
  // A newer release than the one put off is offered at once.
  writeUpdateCache(dir, '1.16.3', now);
  assert.equal(pendingUpdate({ installed: '1.16.1', home: dir, now: now + 1000 }), '1.16.3');
});

test('the Terminal asks between turns, updates on "Cập nhật ngay" and keeps a footer line until then', async (t) => {
  checksOn(t);
  const dir = home(), runs = [];
  writeUpdateCache(dir, '1.16.2', Date.now());
  const { pi, emit, commands } = fakePi();
  registerTerminalUpdateOffer(pi, { installed: '1.16.1', packageRoot: '/pkg', restart: 'piagent studio', home: dir, probe: async () => true,
    runUpdate: async (options) => { runs.push(options); return { ok: true, log: '/log' }; }, afterUpdate: () => 'Mở Agent Watch.' });
  assert.ok(commands.has('piagent-update'));
  const later = fakeUi(['Để sau (nhắc lại sau 1 giờ)']);
  await emit('session_start', {}, later.ctx);
  assert.equal(later.asked[0].title, 'Có bản Piagent mới: 1.16.2 (đang dùng 1.16.1)');
  assert.match(later.status.get('piagent-update'), /Piagent 1\.16\.2/);
  assert.equal(readSnooze(dir).version, '1.16.2');
  await emit('agent_end', {}, later.ctx);
  assert.equal(later.asked.length, 1, 'Later is not asked again within the hour');
  // /piagent-update asks again at once, and the update runs.
  const now = fakeUi(['Cập nhật ngay']);
  await commands.get('piagent-update').handler('', now.ctx);
  assert.deepEqual(runs, [{ packageRoot: '/pkg', version: '1.16.2', home: dir }]);
  assert.match(now.notices.at(-1).message, /Đã cập nhật Piagent 1\.16\.1 → 1\.16\.2\. Thoát rồi mở lại `piagent studio`.*Mở Agent Watch\./);
  assert.equal(now.status.get('piagent-update'), undefined);
});

test('the dashboard runtime and print mode are not asked, nor anyone with checks switched off', async (t) => {
  checksOn(t);
  const dir = home();
  writeUpdateCache(dir, '1.16.2', Date.now());
  const { pi, emit } = fakePi();
  registerTerminalUpdateOffer(pi, { installed: '1.16.1', packageRoot: '/pkg', restart: 'pi', home: dir, probe: async () => true, runUpdate: async () => ({ ok: true }) });
  const gateway = fakeUi(['Cập nhật ngay']);
  gateway.ctx.ui[Symbol.for('piagent.webui.gateway-runtime-ui.v1')] = true;
  await emit('session_start', {}, gateway.ctx);
  await emit('session_start', {}, { hasUI: false, ui: gateway.ctx.ui });
  assert.equal(gateway.asked.length, 0);
  process.env.PIAGENT_NO_UPDATE_CHECK = '1';
  const off = fakePi();
  registerTerminalUpdateOffer(off.pi, { installed: '1.16.1', packageRoot: '/pkg', restart: 'pi', home: dir });
  assert.equal(off.handlers.size + off.commands.size, 0);
});

test('Harness notes and failures read as on the dashboard', () => {
  assert.deepEqual(processLines({ phase: 'final', outcome: 'clean', verified: true, reviewed: true, blockingOpen: 0, policy: { verify: 'require', review: 'require' } }),
    ['Tiến trình: Check đã pass trên code cuối · Review không có lỗi blocking']);
  assert.deepEqual(processLines({ phase: 'objection', role: 'scout', issues: [{ kind: 'wrong_premise', detail: 'File không tồn tại' }] }),
    ['Subagent scout phản biện brief của main agent', '  1. [sai giả định] File không tồn tại']);
  assert.deepEqual(processLines({ phase: 'review', loop: 1, maxLoops: 2, findings: [{ severity: 'blocking', file: 'a.js', line: 3, issue: 'Sai' }] }),
    ['Harness: review tìm thấy 1 lỗi blocking, gửi lại agent để fix hoặc giải thích (vòng 1/2)', '  1. [blocking] a.js:3 — Sai']);
  assert.equal(processLines({ nothing: true }), null);
  // Every failure of a company request is explained; an unknown one as unclassified, with its code.
  assert.match(failureLines('plain text'), /^Lỗi chưa phân loại: .* \[managed-request-failed\]$/);
  assert.equal(failureLines(undefined), null);
  assert.match(launchReasonText('managed-launch-binding-changed', 'vi'), /Agent Watch hoặc Piagent vừa cập nhật/);
  assert.equal(launchReasonText('managed-unknown', 'vi'), null);
});

test('/bypass switches the conversation between ask first and Bypass, and the footer says so', { skip: !fs.existsSync(sdkRoot) }, async (t) => {
  checksOn(t);
  const managed = { permission: 'workspace-write', session: { managedSetPermission(mode) { managed.permission = mode; } } };
  const { pi, emit, commands, renderers } = fakePi();
  await companyTerminalExtension({ managed: () => managed, packageRoot: path.resolve('.'), sdkRoot })(pi);
  assert.ok(renderers.has('agent-watch-process') && renderers.has('agent-watch-review-status') && renderers.has('agent-watch-helper-receipt'));
  const ui = fakeUi(['Bypass: chỉ hỏi việc bắt buộc']);
  await emit('session_start', {}, ui.ctx);
  assert.equal(ui.status.get('agent-watch-permission'), undefined);
  await commands.get('bypass').handler('', ui.ctx);
  assert.equal(managed.permission, 'trusted-full-access');
  assert.equal(ui.status.get('agent-watch-permission'), 'Bypass');
  assert.match(ui.notices.at(-1).message, /^Bypass:/);
  await commands.get('bypass').handler('off', ui.ctx);
  assert.equal(managed.permission, 'workspace-write');
  assert.equal(ui.status.get('agent-watch-permission'), undefined);
  // A failed request is explained in a notice.
  await emit('message_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'x [managed-helper-not-configured]' } }, ui.ctx);
  const theme = { bg: (_c, t) => t, fg: (_c, t) => t };
  const view = renderers.get('agent-watch-process')({ details: { phase: 'final', outcome: 'disputed', disputes: 1, unchanged: true } }, { expanded: false, outputPad: 1 }, theme);
  assert.match(view.render(120).join('\n'), /Main agent và subagent conflict, bạn quyết định/);
});
