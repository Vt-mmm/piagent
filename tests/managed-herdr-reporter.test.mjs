import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { companyHerdrExtension, herdrEnvironment, herdrResumeArgv, sendHerdrRequest } from '../packages/piagent-core/managed/herdr-reporter.mjs';
import { companySessionFile } from '../packages/piagent-core/managed/store.mjs';

// A member runs `piagent studio` in a Herdr pane (Windows: Herdr inside WSL).
// Herdr shows whether the conversation works, waits for them or is idle, and
// after its server restarts it reopens the same company conversation with
// `piagent studio --session`, never personal `pi --session`.
const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-reporter-')));

test('only a Herdr pane is reported to', () => {
  assert.equal(herdrEnvironment({}), null);
  assert.equal(herdrEnvironment({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }), null);
  assert.equal(herdrEnvironment({ HERDR_ENV: '0', HERDR_SOCKET_PATH: '/s', HERDR_PANE_ID: 'w1:p1' }), null);
  assert.deepEqual(herdrEnvironment({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/run/herdr.sock', HERDR_PANE_ID: 'w1:p1', OPENAI_API_KEY: 'x' }), { socket: '/run/herdr.sock', pane: 'w1:p1' });
});

test('the resume command reopens the company conversation and is one Herdr accepts', () => {
  assert.deepEqual(herdrResumeArgv('/home/a/shop', '/home/a/.local/share/agentwatch/ManagedSessions/s/sessions/x.jsonl'),
    ['piagent', 'studio', '--project', '/home/a/shop', '--session', '/home/a/.local/share/agentwatch/ManagedSessions/s/sessions/x.jsonl']);
  assert.deepEqual(herdrResumeArgv('/home/a/shop'), ['piagent', 'studio', '--project', '/home/a/shop']);
  // Herdr refuses apostrophes and control characters: no command at all.
  assert.equal(herdrResumeArgv("/home/a/o'brien", '/x.jsonl'), null);
  assert.equal(herdrResumeArgv('/home/a/shop\n', '/x.jsonl'), null);
});

test('state and the conversation reach Herdr over its socket', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir(), socket = path.join(dir, 'herdr.sock'), received = [];
  const server = net.createServer(connection => connection.on('data', chunk => {
    for (const line of String(chunk).split('\n').filter(Boolean)) { const request = JSON.parse(line); received.push(request); connection.write(JSON.stringify({ id: request.id, result: {} }) + '\n'); }
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    const handlers = {}, bus = {};
    const pi = { on: (name, handler) => { handlers[name] = handler; }, events: { on: (name, handler) => { bus[name] = handler; } } };
    companyHerdrExtension({ socket, pane: 'w1:p2' })(pi);
    let file = path.join(dir, 'sessions/a.jsonl'), idle = true;
    const ctx = () => ({ cwd: '/home/a/shop', isIdle: () => idle, sessionManager: { getSessionFile: () => file } });
    const settle = async count => { for (let i = 0; i < 100 && received.length < count; i++) await new Promise(r => setTimeout(r, 20)); };

    await handlers.session_start({ reason: 'startup' }, ctx()); await settle(1);
    idle = false; handlers.agent_start({}, ctx()); await settle(2);
    bus['herdr:blocked']({ active: true, label: 'Hỏi trước: npm publish' }); await settle(3);
    bus['herdr:blocked']({ active: false }); await settle(4);
    idle = true; handlers.agent_settled({}, ctx()); await settle(5);
    // /new: Herdr follows the new conversation.
    file = path.join(dir, 'sessions/b.jsonl'); await handlers.session_start({ reason: 'new' }, ctx()); await settle(6);

    assert.deepEqual(received.map(r => [r.method, r.params.state, r.params.message]), [
      ['pane.report_agent', 'idle', undefined], ['pane.report_agent', 'working', undefined], ['pane.report_agent', 'blocked', 'Hỏi trước: npm publish'],
      ['pane.report_agent', 'working', undefined], ['pane.report_agent', 'idle', undefined], ['pane.report_agent', 'idle', undefined]]);
    for (const r of received) { assert.equal(r.params.pane_id, 'w1:p2'); assert.equal(r.params.source, 'custom:piagent-studio'); assert.equal(r.params.agent, 'piagent'); }
    assert.deepEqual(received[0].params.resume_argv, ['piagent', 'studio', '--project', '/home/a/shop', '--session', path.join(dir, 'sessions/a.jsonl')]);
    assert.equal(received.at(-1).params.resume_argv.at(-1), path.join(dir, 'sessions/b.jsonl'));
    assert.ok(received.every((r, i) => i === 0 || r.params.seq > received[i - 1].params.seq), 'reports are ordered');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Herdr that is gone costs the conversation nothing', async () => {
  const started = Date.now();
  await sendHerdrRequest(path.join(tempDir(), 'missing.sock'), { id: 'x', method: 'ping', params: {} });
  assert.ok(Date.now() - started < 2500);
});

test('--session opens only a conversation of this store; one never written starts anew', () => {
  const root = tempDir(), sessions = path.join(root, 'store/sessions'); fs.mkdirSync(sessions, { recursive: true });
  try {
    const kept = path.join(sessions, 'a.jsonl'); fs.writeFileSync(kept, '{}\n');
    assert.equal(companySessionFile(sessions, kept), kept);
    assert.equal(companySessionFile(sessions, path.join(sessions, 'never.jsonl')), null);
    const personal = path.join(root, 'personal.jsonl'); fs.writeFileSync(personal, '{}\n');
    assert.throws(() => companySessionFile(sessions, personal), /managed-session-outside-store/);
    assert.throws(() => companySessionFile(sessions, path.join(sessions, '../../personal.jsonl')), /managed-session-outside-store/);
    assert.throws(() => companySessionFile(sessions, path.join(sessions, 'notes.txt')), /managed-session-outside-store/);
    // A link inside the store that leads out of it is refused too.
    fs.symlinkSync(personal, path.join(sessions, 'link.jsonl'));
    assert.throws(() => companySessionFile(sessions, path.join(sessions, 'link.jsonl')), /managed-session-outside-store/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
