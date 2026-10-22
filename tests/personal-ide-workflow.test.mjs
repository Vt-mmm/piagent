import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startPiagentGateway } from '../packages/piagent-webui/gateway/gateway-service.ts';
import { loadPinnedPiHost, installedPiHostRoot } from '../packages/piagent-webui/gateway/pi-host.ts';
import { gatewayProfileState } from '../packages/piagent-webui/gateway/profile-state.ts';
import { requestGatewayControl } from '../packages/piagent-webui/gateway/control-socket.ts';
import { hostPackage } from '../packages/piagent-core/managed/pi-host.mjs';
import { ensureWebUiBuild } from './helpers/piagent-webui-build.mjs';
import { memberEditorAndTests, reviewAgentHunk } from './helpers/ide-member-browser.mjs';

test('personal member saves, tests in terminal, reviews SDK edits and restores two turns in one browser workflow', { timeout: 120000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..'); ensureWebUiBuild(root);
  const expectedPiVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).peerDependencies['@earendil-works/pi-coding-agent'];
  const host = await loadPinnedPiHost(expectedPiVersion);
  const ai = await import(pathToFileURL(path.join(hostPackage(installedPiHostRoot(), '@earendil-works/pi-ai'), 'dist/index.js')));
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'personal-ide-')));
  const project = path.join(temp, 'project'), agentDir = path.join(temp, 'agent');
  fs.mkdirSync(project); fs.mkdirSync(agentDir, { mode: 0o700 });
  for (const name of ['checkpoint.txt', 'member.txt']) fs.writeFileSync(path.join(project, name), 'before\n');
  fs.writeFileSync(path.join(project, 'member.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('member saved project file',()=>assert.equal(fs.readFileSync('member.txt','utf8'),'member saved\\n'));\n");
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'baseline');
  const model = { id: 'fixture', name: 'Offline IDE fixture', api: 'fixture', provider: 'fixture', baseUrl: '', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const message = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, api: model.api,
    provider: model.provider, model: model.id, timestamp: Date.now(), usage });
  const script = [1, 2].flatMap(turn => [
    message([{ type: 'toolCall', id: `ide-write-${turn}`, name: 'write', arguments: {
      path: turn === 1 ? 'checkpoint.txt' : 'checkpoint-new.txt', content: `agent turn ${turn}\n` } }], 'toolUse'),
    message([{ type: 'text', text: `PERSONAL_IDE_${turn}_OK` }]),
  ]);
  let calls = 0;
  const runtime = { async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => { throw Error('real-auth-forbidden'); }, getModel: () => model, getModels: () => [model],
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
    streamSimple() { const response = script[calls++]; assert.ok(response, 'no unexpected provider call');
      const stream = ai.createAssistantMessageEventStream(); stream.push({ type: 'done', reason: response.stopReason, message: response }); return stream; } };
  // Only the provider and fixture trust are supplied; Gateway/runtime/tools and
  // all browser routes use their production implementations.
  t.mock.method(host.ModelRuntime, 'create', async () => runtime);
  const createSettings = host.SettingsManager.create.bind(host.SettingsManager);
  t.mock.method(host.SettingsManager, 'create', (cwd, dir, options) => createSettings(cwd, dir, { ...options, projectTrusted: true }));
  const manager = host.SessionManager.create(project, path.join(agentDir, 'sessions', 'ide'));
  manager.appendModelChange(model.provider, model.id);
  manager.appendMessage({ role: 'user', content: 'Personal IDE workflow', timestamp: Date.now() });
  manager.appendMessage(message([{ type: 'text', text: 'Ready for the member workflow.' }]));
  let gateway, browser;
  try {
    gateway = await startPiagentGateway({ packageRoot: root, expectedPiVersion, agentDir });
    const launch = await requestGatewayControl(gatewayProfileState(agentDir).controlSocket, { action: 'issue-launch-url' });
    assert.equal(launch.ok, true);
    browser = await chromium.launch(); const page = await browser.newPage({ locale: 'vi-VN' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', event => window.__csp.push(event.violatedDirective)); });
    await page.goto(launch.value.launchUrl);
    await page.getByRole('navigation').getByText('Personal IDE workflow', { exact: true }).click();
    await memberEditorAndTests(page, project);
    for (const turn of [1, 2]) {
      await page.getByPlaceholder('Nhắn cho Piagent…').fill(`Personal IDE turn ${turn}`);
      await page.getByRole('button', { name: 'Gửi', exact: true }).click();
      await expect(page.getByText(`PERSONAL_IDE_${turn}_OK`, { exact: true }).first()).toBeVisible({ timeout: 30000 });
      if (turn === 1) await reviewAgentHunk(page, project);
    }
    git('add', 'checkpoint.txt', 'checkpoint-new.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member commit after agent turns');
    const head = git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(project, '.git/index'));
    const restore = page.getByRole('button', { name: 'Khôi phục về trước lượt này', exact: true });
    await expect(restore).toHaveCount(2, { timeout: 15000 }); await restore.first().click();
    const dialog = page.getByRole('dialog', { name: 'Khôi phục về trước lượt này', exact: true });
    await expect(dialog.getByText(/Sẽ hoàn tác 2 lượt/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Xác nhận khôi phục', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Đã khôi phục 2 lượt.', { timeout: 30000 });
    assert.equal(fs.readFileSync(path.join(project, 'checkpoint.txt'), 'utf8'), 'before\n');
    assert.equal(fs.existsSync(path.join(project, 'checkpoint-new.txt')), false);
    assert.equal(fs.readFileSync(path.join(project, 'member.txt'), 'utf8'), 'member saved\n');
    assert.equal(git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(project, '.git/index')), index);
    assert.equal(calls, 4); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => window.__csp), []);
  } finally { await browser?.close(); await gateway?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
