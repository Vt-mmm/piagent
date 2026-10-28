import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect, repair } from '../scripts/personal-pi-config.mjs';
import { isCompanySession, registerCompanySessionGuard } from '../packages/piagent-core/extensions/company-session-guard.ts';

// Personal Pi must not load Piagent twice nor keep old Agent Watch company
// entries; a company conversation is not continued in personal Pi.
function agentDir({ managed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-pi-'));
  const copy = path.join(dir, 'copy'); fs.mkdirSync(path.join(copy, 'packages/piagent-core/extensions'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ name: '@piagent/platform', version: '1.0.0' }));
  fs.writeFileSync(path.join(copy, 'packages/piagent-core/package.json'), JSON.stringify({ name: '@piagent/core' }));
  fs.writeFileSync(path.join(copy, 'packages/piagent-core/extensions/piagent-guard.ts'), '');
  const git = path.join(dir, 'git/github.com/Vt-mmm/piagent'); fs.mkdirSync(git, { recursive: true });
  fs.writeFileSync(path.join(git, 'package.json'), JSON.stringify({ name: '@piagent/platform', version: '1.28.0' }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: ['git:github.com/Vt-mmm/piagent@abc', 'npm:pi-web-access@0.17.0'],
    extensions: [path.join(dir, 'agentwatch-studio-session.mjs'), path.join(copy, 'packages/piagent-core/extensions/piagent-guard.ts'), path.join(dir, 'mine.ts')],
    defaultProvider: 'agent_watch_codex', defaultModel: 'gpt-6-sol', enabledModels: ['agent_watch_codex/gpt-6-sol', 'openai-codex/gpt-6-luna'], theme: 'dark' }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { agent_watch_codex: { baseUrl: 'http://127.0.0.1:17922/v1', apiKey: '!agent-watch credential' }, anthropic: { models: [] } } }));
  if (managed) fs.writeFileSync(path.join(dir, 'agent-watch-managed.json'), '{}');
  return dir;
}

test('duplicate Piagent extensions and old company entries are found, backed up and removed; the member keeps the rest', () => {
  const dir = agentDir();
  const found = inspect(dir);
  assert.deepEqual(found.findings.map((f) => f.kind).sort(), ['company-defaults', 'company-extension', 'company-providers', 'duplicate-extensions']);
  assert.deepEqual(found.packages, [{ source: 'git:github.com/Vt-mmm/piagent@abc', version: '1.28.0' }]);
  const fixed = repair(dir, new Date('2026-10-18T00:00:00Z'));
  assert.equal(fixed.after.findings.length, 0);
  assert.equal(fixed.backups.length, 2);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.extensions, [path.join(dir, 'mine.ts')]);
  assert.deepEqual(settings.enabledModels, ['openai-codex/gpt-6-luna']);
  assert.equal(settings.defaultProvider, undefined); assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.packages, ['git:github.com/Vt-mmm/piagent@abc', 'npm:pi-web-access@0.17.0']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers), ['anthropic']);
  assert.equal(JSON.parse(fs.readFileSync(fixed.backups[0], 'utf8')).defaultProvider, 'agent_watch_codex');
});

test('without a managed binding the company providers are a direct setup and stay; duplicates are still removed', () => {
  const dir = agentDir({ managed: false });
  assert.deepEqual(inspect(dir).findings.map((f) => f.kind), ['duplicate-extensions']);
  repair(dir);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers.agent_watch_codex);
});

test('personal Pi refuses to continue a company conversation; the company Terminal and personal chats go on', async () => {
  const handlers = [];
  registerCompanySessionGuard({ on: (name, handler) => name === 'input' && handlers.push(handler) });
  const notices = [];
  const ctx = (file, provider, entries = []) => ({ cwd: '/work/shop', hasUI: true, model: { provider }, ui: { notify: (m) => notices.push(m) },
    sessionManager: { getSessionFile: () => file, getEntries: () => entries } });
  const company = '/Users/a/Library/Application Support/AgentWatch/ManagedSessions/p/sessions/x.jsonl';
  assert.equal(isCompanySession(ctx(company).valueOf()), true);
  assert.deepEqual(await handlers[0]({ text: 'hi' }, ctx(company, 'openai-codex')), { action: 'handled' });
  assert.match(notices.at(-1), /piagent studio --project \/work\/shop/);
  assert.deepEqual(await handlers[0]({ text: 'hi' }, ctx(company, 'agent_watch_managed')), { action: 'continue' });
  // WSL and Linux keep it in the XDG data folder; a conversation with no run yet is still the company's.
  assert.deepEqual(await handlers[0]({ text: 'hi' }, ctx('/home/a/.local/share/agentwatch/ManagedSessions/p/sessions/x.jsonl', 'openai-codex')), { action: 'handled' });
  assert.deepEqual(await handlers[0]({ text: 'hi' }, ctx('/tmp/x.jsonl', 'openai-codex', [{ type: 'custom', customType: 'agent-watch-run' }])), { action: 'handled' });
  assert.deepEqual(await handlers[0]({ text: 'hi' }, ctx('/Users/a/.pi/agent/sessions/x.jsonl', 'openai-codex')), { action: 'continue' });
});
