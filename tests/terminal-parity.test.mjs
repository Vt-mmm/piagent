import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { writeUpdateCache } from '../packages/piagent-core/extensions/update-check.js';
import { pendingUpdate, readSnooze, registerTerminalUpdateOffer, snoozeUpdate, SNOOZE_MS } from '../packages/piagent-core/runtime/update/terminal-update-offer.mjs';
import { companyCommandText, companyMode, companySuggestions, companyTerminalExtension, companyToolRenderers, failureLines, footerLines, harnessSummary, headerText, planLines, processLines, whatsNewMarkdown , argumentCompletions, turnStats, memoryResultLines } from '../scripts/company-terminal.mjs';
import { launchReasonText } from '../packages/piagent-webui/shared/company-copy.ts';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// The Terminal says what the dashboard says: a new release is asked about
// (Update now / Later for an hour), Bypass can be chosen, Harness notes and
// failures read in Vietnamese.
const sdkRoot = piSdkRoot();
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

test('/help is answered in the Terminal without a model request, and names how to reopen a company conversation', { skip: !fs.existsSync(sdkRoot) }, async (t) => {
  checksOn(t);
  const { pi, commands } = fakePi();
  await companyTerminalExtension({ managed: () => null, packageRoot: path.resolve('.'), sdkRoot })(pi);
  const ui = fakeUi([]);
  await commands.get('help').handler('', ui.ctx);
  const text = ui.notices.at(-1).message;
  for (const command of ['/undo', '/bypass', '/fast', '/resume', '/hotkeys', 'piagent studio --project']) assert.ok(text.includes(command), command);
});

// The Terminal's own UI (header, footer, Pi commands that would leave the
// company or pick what the Harness decides), as audited on 2026-10-18.
const manifest = { user: { team_name: 'Test Quý' }, harness: { configuration: { fast_mode: true, workflow: { review: 'require' },
  main: { model_ids: ['gpt-6-astra', 'gpt-6-sol'], effort: 'xhigh' }, review: { model_ids: ['gpt-6-sol'], effort: 'high' } } } };
const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };

test('the header names the team, the roles and effort (never a model), permission, Fast, memory and the release', () => {
  const managed = { manifest, permission: 'workspace-write', session: { managedFastState: () => 'off', state: { thinkingLevel: 'medium' } } };
  const before = harnessSummary(managed, { version: '1.28.3' });
  assert.equal(headerText(before), 'Piagent công ty · team Test Quý · Main agent (Rất cao) · Subagent review bật · Hỏi trước · Fast tắt · memory tắt · 1.28.3');
  // After a run: the model and effort Studio granted; Bypass and Fast as switched.
  Object.assign(managed, { permission: 'trusted-full-access' }); managed.session.managedFastState = () => 'on';
  assert.match(headerText(harnessSummary(managed, { last: { effort: 'high' } })), /Main agent \(Cao\) · Subagent review bật · Bypass · Fast bật/);
  // No Fast switch where the Harness does not allow it; no review when the workflow has none.
  const plain = { manifest: { harness: { configuration: { workflow: { review: 'off' }, main: { model_ids: ['m'] }, review: { model_ids: ['r'] } } } }, session: { managedFastState: () => null, state: { thinkingLevel: 'high' } } };
  assert.equal(headerText(harnessSummary(plain)), 'Piagent công ty · Main agent (Cao) · Hỏi trước · memory tắt');
});

test('the footer drops the USD cost and shows the Harness main model and effort before the first run', async () => {
  const { truncateToWidth, visibleWidth } = await import(pathToFileURL(createRequire(path.join(sdkRoot, 'package.json')).resolve('@earendil-works/pi-tui')).href);
  const usage = { input: 6900, output: 116, cacheRead: 5600, cacheWrite: 0, cost: { total: 0.243 } };
  const session = { state: { model: { contextWindow: 272000 } }, getContextUsage: () => ({ percent: 2.5, contextWindow: 272000 }),
    sessionManager: { getCwd: () => '/work/shop', getSessionName: () => undefined, getEntries: () => [{ type: 'message', message: { role: 'assistant', usage } }] } };
  const footerData = { getGitBranch: () => 'main', getExtensionStatuses: () => new Map([['agent-watch-permission', 'Bypass']]) };
  const lines = footerLines({ session, summary: harnessSummary({ manifest, session: { state: { thinkingLevel: 'medium' } } }), footerData, theme: plainTheme, width: 100, truncateToWidth, visibleWidth });
  assert.equal(lines[0], '/work/shop (main)');
  assert.match(lines[1], /^↑6\.9k ↓116 R5\.6k 2\.5%\/272k \(auto\) +Main agent • Rất cao$/);
  assert.equal(visibleWidth(lines[1]), 100);
  assert.doesNotMatch(lines.join('\n'), /\$|medium/);
  assert.equal(lines[2], 'Bypass');
}, { skip: !fs.existsSync(sdkRoot) });

test('/share and /bug are refused, the Harness answers /login, /model, /thinking and /settings, /changelog is Piagent\'s', () => {
  const summary = { effort: 'xhigh' };
  assert.match(companyCommandText('share', summary), /^\/share bị tắt .*GitHub Gist.*\/export/);
  assert.match(companyCommandText('bug', summary), /^\/bug bị tắt .*ra ngoài công ty/);
  assert.match(companyCommandText('login', summary), /tài khoản AI của team qua Agent Watch/);
  for (const name of ['model', 'scoped-models', 'thinking']) assert.match(companyCommandText(name, summary), /Harness của team quyết định \(Main agent: Rất cao\)/);
  assert.match(companyCommandText('settings', summary), /Harness quyết định/);
  assert.equal(companyCommandText('resume', summary), null);
  // They stay in the / list (a hidden one would let Enter pick a skill instead), in the company's words.
  const listed = companySuggestions({ prefix: '/s', items: [{ value: 'share', label: 'share', description: 'Share session as a secret GitHub gist' }, { value: 'session', label: 'session', description: 'Show session info' }, { value: 'skill:debug', label: 'skill:debug' }] });
  assert.deepEqual(listed.items.map((item) => [item.value, item.description]), [['share', 'Tắt trong cuộc trò chuyện công ty'], ['session', 'Show session info'], ['skill:debug', undefined]]);
  const args = { prefix: 'gp', items: [{ value: 'model', label: 'model' }] };
  assert.equal(companySuggestions(args), args);
  // Newest releases first, from the installed CHANGELOG.md.
  const notes = whatsNewMarkdown(fs.readFileSync('CHANGELOG.md', 'utf8'), 2);
  assert.match(notes, /^## v\d+\.\d+\.\d+/);
  assert.equal(notes.match(/^## v/gm).length, 2);
  assert.equal(whatsNewMarkdown(''), 'Chưa có ghi chú phát hành.');
});

test('the company InteractiveMode answers Pi\'s commands and keys itself and never suggests /bug', () => {
  const notices = [], added = [];
  class Base {
    chatContainer = { addChild: (child) => added.push(child) };
    ui = { requestRender() {} };
    showExtensionNotify(message, tone) { notices.push({ message, tone }); }
    getMarkdownThemeWithSettings() { return 'md-theme'; }
  }
  class Markdown { constructor(text) { this.text = text; } }
  class Spacer {}
  const Mode = companyMode(Base, { summary: () => ({ effort: 'xhigh' }), whatsNew: () => '## v9.9.9', components: { Markdown, Spacer } });
  const mode = new Mode();
  mode.handleShareCommand(); mode.handleBugCommand(); mode.suggestBugReport();
  mode.handleLoginCommand(); mode.showOAuthSelector('logout'); mode.showModelSelector(); mode.cycleModel('forward'); mode.cycleThinkingLevel(); mode.showSettingsSelector();
  assert.deepEqual(notices.map((n) => n.tone), ['warning', 'warning', 'info', 'info', 'info', 'info', 'info', 'info']);
  assert.match(notices[0].message, /^\/share bị tắt/);
  assert.match(notices.at(-1).message, /Harness quyết định/);
  assert.equal(mode.getChangelogForDisplay(), undefined);
  assert.doesNotMatch(mode.crashReportInstructions(), /\/bug/);
  mode.handleChangelogCommand();
  assert.equal(added.find((child) => child instanceof Markdown).text, '# Có gì mới trong Piagent\n\n## v9.9.9');
});

test('the methods the company InteractiveMode replaces exist in the pinned Pi', { skip: !fs.existsSync(sdkRoot) }, async () => {
  const { InteractiveMode } = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
  const Mode = companyMode(InteractiveMode, { summary: () => ({}), whatsNew: () => '', components: {} });
  const own = Object.getOwnPropertyNames(Mode.prototype).filter((name) => name !== 'constructor');
  for (const name of [...own, 'showExtensionNotify', 'getMarkdownThemeWithSettings']) assert.equal(typeof InteractiveMode.prototype[name], 'function', name);
});

test('a question waiting for the member replaces "Working", and the plan is a checklist', { skip: !fs.existsSync(sdkRoot) }, async (t) => {
  checksOn(t);
  const { pi, emit } = fakePi();
  await companyTerminalExtension({ managed: () => null, packageRoot: path.resolve('.'), sdkRoot })(pi);
  const loader = [];
  const ctx = { hasUI: true, ui: { setWorkingMessage: (m) => loader.push(['message', m]), setWorkingIndicator: (o) => loader.push(['indicator', o]) } };
  await emit('tool_execution_start', { toolName: 'bash' }, ctx);
  await emit('tool_execution_start', { toolName: 'ask_user' }, ctx);
  await emit('tool_execution_end', { toolName: 'ask_user' }, ctx);
  assert.deepEqual(loader, [['message', 'Đang chờ bạn trả lời'], ['indicator', { frames: ['?'] }], ['message', 'Đang làm…'], ['indicator', undefined]]);
  const plan = [{ step: 'Tạo note.txt', status: 'completed' }, { step: 'Kiểm tra', status: 'in_progress' }, { step: 'Docs', status: 'deferred' }, { step: 'Push', status: 'pending' }];
  assert.deepEqual(planLines(plan), ['Plan · 1/4 bước xong', '  ☑ Tạo note.txt', '  ☐ Kiểm tra  ← đang làm', '  ⊘ Docs  (để sau)', '  ☐ Push']);
  const { update_plan: renderer } = await companyToolRenderers(sdkRoot);
  const view = renderer.renderResult({ content: [{ type: 'text', text: 'Plan updated: 1/4 steps completed.' }], details: { plan } }, {}, plainTheme);
  assert.deepEqual(view.render(80).map((line) => line.trimEnd()), planLines(plan));
  assert.match(renderer.renderResult({ content: [{ type: 'text', text: 'managed-plan-invalid' }] }, {}, plainTheme).render(80).join(''), /managed-plan-invalid/);
});

test('a complete argument runs on the first Enter; a partial one is completed', () => {
  const complete = argumentCompletions(['on', 'off', 'status']);
  assert.deepEqual(complete('status'), []);
  assert.deepEqual(complete('st').map((c) => c.value), ['status']);
  assert.deepEqual(complete('o').map((c) => c.value), ['on', 'off']);
});

test('a turn ends with its requests, tokens, time and output speed; memory results stay short', () => {
  const t0 = Date.parse('2026-10-18T10:00:00Z');
  const messages = [{ role: 'user', content: 'old', timestamp: t0 - 999_000 }, { role: 'assistant', usage: { totalTokens: 5, output: 1 } },
    { role: 'user', content: 'task', timestamp: t0 },
    { role: 'assistant', usage: { totalTokens: 40_000, output: 300 } }, { role: 'toolResult' }, { role: 'assistant', usage: { totalTokens: 27_000, output: 900 } }];
  assert.equal(turnStats(messages, t0 + 78_000), '2 request · 67k token · 1 phút 18 giây · 15 tok/s');
  assert.equal(turnStats([{ role: 'user', content: 'x', timestamp: t0 }], t0 + 5000), null);
  const text = ['Memories (past notes):', '- a', '- b', '- c', '- d', '- e'].join('\n');
  assert.deepEqual(memoryResultLines(text), ['Memories (past notes):', '- a', '- b', '… 5 ghi chú, 3 dòng nữa (Ctrl+O để xem hết)']);
  assert.equal(memoryResultLines(text, true).length, 6);
});

test('the company Terminal never shows a model id: header, footer, command answers, Pi warnings', async () => {
  const { harnessSummary, headerText, companyCommandText, companyWarning } = await import('../scripts/company-terminal.mjs');
  const ids = ['gpt-6-astra', 'gpt-6-sol', 'claude-haiku-5-5'];
  const managed = { manifest: { user: { team_name: 'T' }, harness: { configuration: {
    main: { model_ids: ids.slice(0, 2), effort: 'xhigh' }, review: { model_ids: [ids[2]] } } } } };
  const summary = harnessSummary(managed, { last: { model_id: ids[1], effort: 'high' } });
  const shown = [JSON.stringify(summary), headerText(summary),
    ...['model', 'scoped-models', 'thinking', 'settings'].map((n) => companyCommandText(n, summary)),
    companyWarning('Could not restore model agent_watch_managed/gpt-6-astra'),
    companyWarning('pi crashed on 10/18/2026, 9:39:57 PM (read EIO). Run /bug to report it; the crash details are attached automatically.')].join('\n');
  for (const id of ids) assert.ok(!shown.includes(id), id);
  assert.ok(!shown.includes('/bug'));
});
