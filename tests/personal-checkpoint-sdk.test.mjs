import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { hostPackage } from '../packages/piagent-core/managed/pi-host.mjs';
import { CheckpointStore } from '../packages/piagent-core/runtime/checkpoints/checkpoint-store.mjs';
import { checkpointAuthority } from '../packages/piagent-core/runtime/checkpoints/checkpoint-authority.ts';

const sdk = process.env.PI_MANAGED_TEST_SDK || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const root = fileURLToPath(new URL('../', import.meta.url));
test('actual guard and SDK write/bash turns persist checkpoints and personal undo never calls a provider', {
  skip: !fs.existsSync(path.join(sdk, 'dist/index.js')), timeout: 60000,
}, async t => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'))).version,
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).peerDependencies['@earendil-works/pi-coding-agent']);
  const host = await import(pathToFileURL(path.join(sdk, 'dist/index.js')));
  const ai = await import(pathToFileURL(path.join(hostPackage(sdk, '@earendil-works/pi-ai'), 'dist/index.js')));
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-sdk-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, 'project'), agentDir = path.join(temp, 'agent'), sessionDir = path.join(temp, 'sessions');
  for (const dir of [cwd, agentDir, sessionDir]) fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const file = path.join(cwd, 'file.txt'); fs.writeFileSync(file, 'before\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member');
  const head = git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(cwd, '.git/index'));
  const model = { id: 'fixture', name: 'fixture', api: 'fixture', provider: 'fixture', baseUrl: '', reasoning: false,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 };
  const script = [
    [{ type: 'toolCall', id: 'write-one', name: 'write', arguments: { path: 'file.txt', content: 'turn one\n' } }],
    [{ type: 'text', text: 'First fixture turn complete.' }],
    [{ type: 'toolCall', id: 'bash-two', name: 'bash', arguments: { command: "printf 'turn two\\n' > file.txt" } }],
    [{ type: 'text', text: 'Second fixture turn complete.' }],
  ];
  let calls = 0;
  const runtime = {
    async refresh() {}, hasConfiguredAuth: () => true, checkAuth: async () => ({ configured: true }), isUsingOAuth: () => false,
    getAuth: async () => { throw Error('real-auth-forbidden'); }, getModel: () => model, getModels: () => [model],
    getAvailable: async () => [model], getAvailableSnapshot: () => [model], getProviders: () => [],
    registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
    streamSimple() {
      const content = script[calls++]; assert.ok(content, 'no unexpected provider call');
      const stopReason = content[0].type === 'toolCall' ? 'toolUse' : 'stop';
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } };
      const stream = ai.createAssistantMessageEventStream(); stream.push({ type: 'done', reason: stopReason, message }); return stream;
    },
  };
  const errors = [];
  const open = async manager => {
    const settingsManager = host.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true });
    const services = await host.createAgentSessionServices({ cwd, agentDir, modelRuntime: runtime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [path.join(root, 'packages/piagent-core/extensions/piagent-guard.ts')], systemPrompt: 'Offline checkpoint fixture.' } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    assert.ok(services.resourceLoader.getExtensions().extensions.some(extension => extension.path.endsWith('piagent-guard.ts')));
    const { session } = await host.createAgentSessionFromServices({ services, sessionManager: manager, model, thinkingLevel: 'off', tools: ['write', 'bash'] });
    session.extensionRunner.onError(error => errors.push(error));
    await session.bindExtensions({ mode: 'json' });
    return session;
  };
  const manager = host.SessionManager.create(cwd, sessionDir);
  let session = await open(manager);
  t.after(() => session.dispose());
  await session.prompt('Write file.txt with turn one.', { expandPromptTemplates: false });
  assert.equal(fs.readFileSync(file, 'utf8'), 'turn one\n', JSON.stringify(manager.getEntries().filter(entry => entry.message?.role === 'toolResult')));
  const store = new CheckpointStore(cwd, manager.getSessionId());
  assert.equal(store.load().points.length, 1, JSON.stringify(errors));
  await session.prompt('Use bash to write turn two to file.txt.', { expandPromptTemplates: false });
  assert.equal(fs.readFileSync(file, 'utf8'), 'turn two\n');
  const turns = manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user');
  assert.deepEqual(store.load().points.map(point => point.turnRef), turns.map(entry => entry.id));
  const oldPort = checkpointAuthority.resolve(cwd, manager.getSessionId());
  assert.equal((await oldPort.list()).points.length, 2, 'native module sees the SDK-loaded extension authority');
  const sessionFile = manager.getSessionFile(); session.dispose();
  const reopened = host.SessionManager.open(sessionFile, sessionDir);
  session = await open(reopened);
  assert.equal(oldPort.current(), false);
  assert.throws(() => oldPort.list(), /checkpoint-authority-changed/);
  const port = checkpointAuthority.resolve(cwd, reopened.getSessionId());
  const target = (await port.list()).points.at(-1).id;
  const preview = await port.preview(target);
  assert.equal(preview.result, 'ready');
  assert.equal((await port.restoreTo(target, preview)).result, 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), 'turn one\n');
  await session.prompt('/undo', { expandPromptTemplates: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\n', JSON.stringify({ errors, entries: reopened.getEntries().slice(-4) }));
  await session.prompt('/undo', { expandPromptTemplates: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\n');
  assert.equal(calls, 4);
  assert.equal(git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(cwd, '.git/index')), index);
  assert.deepEqual(store.load().points, []);
  assert.deepEqual(errors, []);
});
