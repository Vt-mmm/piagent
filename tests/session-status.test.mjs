import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { failureOf, gatewayRow, liveRow, onlyInTerminal, readSessions, sessionStatusDir, sessionStatusExtension, spaceSummary } from '../packages/piagent-core/extensions/session-status.js';

// A developer runs many Piagent sessions and follows them from outside: which
// one is processing, which waits for them, which failed.
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-status-'));
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

function harness(options = {}) {
  const agentDir = tempDir(), handlers = {}, sent = [];
  const pi = { on: (name, handler) => { handlers[name] = handler; }, getSessionName: () => 'fix login' };
  sessionStatusExtension({ agentDir, pid: process.pid, heartbeatMs: 60_000, send: async (_socket, request) => { sent.push(request); }, ...options })(pi);
  const file = path.join(sessionStatusDir(agentDir), `${process.pid}.json`);
  const ctx = { cwd: '/work/shop', isIdle: () => true, sessionManager: { getSessionId: () => 's1' } };
  return { agentDir, handlers, sent, file, ctx, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a session walks through processing, paused, failed and done', async () => {
  const { handlers, ctx, read, file, agentDir } = harness();
  await handlers.session_start({ reason: 'startup' }, ctx);
  assert.equal(read().state, 'idle');
  assert.equal(read().project, 'shop');
  assert.equal(read().title, 'fix login');

  handlers.agent_start({}, ctx);
  assert.equal(read().state, 'processing');
  handlers.ui_prompt_start({ title: 'Allow npm publish?' });
  assert.deepEqual([read().state, read().message], ['paused', 'Allow npm publish?']);
  handlers.ui_prompt_end({});
  assert.deepEqual([read().state, read().message], ['processing', undefined]);

  // A retried provider error that then succeeds is not a failure.
  handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' }] });
  handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'stop' }] });
  handlers.agent_settled({ aborted: false }, ctx);
  assert.equal(read().state, 'done');

  handlers.agent_start({}, ctx);
  handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'quota exceeded' }] });
  handlers.agent_settled({ aborted: false }, ctx);
  assert.deepEqual([read().state, read().message], ['failed', 'quota exceeded']);

  handlers.agent_start({}, ctx);
  assert.deepEqual([read().state, read().message], ['processing', undefined]);
  handlers.agent_settled({ aborted: true }, ctx);
  assert.equal(read().state, 'paused');

  await handlers.session_shutdown({}, ctx);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test('an answered question after a failed task shows the failure again', async () => {
  const { handlers, ctx, read } = harness();
  await handlers.session_start({}, ctx);
  handlers.agent_start({}, ctx);
  handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom' }] });
  handlers.agent_settled({ aborted: false }, ctx);
  handlers.ui_prompt_start({ title: 'Retry?' });
  assert.equal(read().state, 'paused');
  handlers.ui_prompt_end({});
  assert.deepEqual([read().state, read().message], ['failed', 'boom']);
  await handlers.session_shutdown({}, ctx);
});

test('a turn that has not settled yet is not over', async () => {
  const { handlers, ctx, read } = harness();
  await handlers.session_start({}, ctx);
  handlers.agent_start({}, ctx);
  handlers.agent_settled({ aborted: false }, { ...ctx, isIdle: () => false });
  assert.equal(read().state, 'processing');
  await handlers.session_shutdown({}, ctx);
});

test('Herdr gets the state on the pane and the summary on the space', async () => {
  const { handlers, ctx, sent } = harness({ herdr: { socket: '/s', pane: 'w4:p2' } });
  await handlers.session_start({}, ctx);
  handlers.agent_start({}, ctx);
  await flush();
  handlers.agent_end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'boom' }] });
  handlers.agent_settled({ aborted: false }, ctx);
  await flush();
  const pane = sent.filter(r => r.method === 'pane.report_metadata').at(-1), space = sent.filter(r => r.method === 'workspace.report_metadata').at(-1);
  assert.equal(pane.params.pane_id, 'w4:p2');
  assert.equal(pane.params.tokens.piagent_status, 'failed: boom');
  assert.equal(space.params.workspace_id, 'w4');
  assert.equal(space.params.tokens.piagent_sessions, '✖ failed');
  assert.ok(space.params.ttl_ms > 0, 'a dead Terminal cannot leave its state behind for ever');
  const sequences = sent.map(r => r.params.seq);
  assert.ok(sequences.every((seq, i) => i === 0 || seq > sequences[i - 1]), 'reports are ordered');
  // Closing the last session of a space clears its summary.
  await handlers.session_shutdown({}, ctx);
  await flush();
  assert.equal(sent.filter(r => r.method === 'workspace.report_metadata').at(-1).params.tokens.piagent_sessions, null);
});

test('a live session corrects the space of a dead Terminal, in its own Herdr only', async () => {
  const { handlers, ctx, sent, agentDir } = harness({ herdr: { socket: '/s', pane: 'w1:p1' } });
  const old = new Date(Date.now() - 1000).toISOString();
  const put = (name, value) => { fs.mkdirSync(sessionStatusDir(agentDir), { recursive: true }); fs.writeFileSync(path.join(sessionStatusDir(agentDir), `${name}.json`), JSON.stringify({ id: name, since: old, updated_at: old, ...value })); };
  put('dead', { pid: 999999, state: 'processing', workspace: 'w2', pane: 'w2:p1', socket: '/s' });
  put('other', { pid: process.pid, state: 'failed', workspace: 'w3', pane: 'w3:p1', socket: '/other-server' });
  await handlers.session_start({}, ctx);
  await flush();
  const spaces = Object.fromEntries(sent.filter(r => r.method === 'workspace.report_metadata').map(r => [r.params.workspace_id, r.params.tokens.piagent_sessions]));
  assert.deepEqual(spaces, { w1: null, w2: '✖ failed' });
  await handlers.session_shutdown({}, ctx);
});

test('a Herdr that is gone costs the session nothing', async () => {
  const { handlers, ctx, read } = harness({ herdr: { socket: '/s', pane: 'w1:p1' }, send: async () => { throw new Error('gone'); } });
  await handlers.session_start({}, ctx);
  handlers.agent_start({}, ctx);
  await flush();
  assert.equal(read().state, 'processing');
  await handlers.session_shutdown({}, ctx);
});

test('a Terminal that died during a task reads as failed; one at rest disappears', () => {
  const now = Date.parse('2026-11-02T10:00:00Z'), updated_at = new Date(now - 1000).toISOString(), dead = () => false, alive = () => true;
  assert.equal(liveRow({ pid: 1, state: 'processing', updated_at }, now, alive).state, 'processing');
  assert.deepEqual([liveRow({ pid: 1, state: 'processing', updated_at }, now, dead).state, liveRow({ pid: 1, state: 'processing', updated_at }, now, dead).alive], ['failed', false]);
  assert.equal(liveRow({ pid: 1, state: 'paused', updated_at }, now, dead).state, 'failed');
  assert.equal(liveRow({ pid: 1, state: 'done', updated_at }, now, dead), null);
  // A live pid with no heartbeat is another process that reused the number.
  assert.equal(liveRow({ pid: 1, state: 'processing', updated_at: new Date(now - 300_000).toISOString() }, now, alive).state, 'failed');
});

test('the list puts what needs the developer first and covers company conversations', () => {
  const agentDir = tempDir(), controlDir = tempDir(), now = Date.now(), iso = new Date(now).toISOString();
  fs.mkdirSync(sessionStatusDir(agentDir), { recursive: true });
  fs.mkdirSync(path.join(controlDir, 'status/company'), { recursive: true });
  const put = (name, value) => fs.writeFileSync(path.join(sessionStatusDir(agentDir), `${name}.json`), JSON.stringify({ id: name, updated_at: iso, since: iso, ...value }));
  put('1', { pid: 1, state: 'processing' }); put('2', { pid: 2, state: 'failed', message: 'boom' }); put('3', { pid: 3, state: 'done' }); put('4', { pid: 4, state: 'done' });
  fs.writeFileSync(path.join(sessionStatusDir(agentDir), 'broken.json'), '{');
  fs.writeFileSync(path.join(controlDir, 'status/company/a.json'), JSON.stringify({ conversation: 'c', title: 't', project: 'p', state: 'blocked', kind: 'permission', since: iso, updated_at: iso }));
  const rows = readSessions({ agentDir, controlDir, now, alive: pid => pid !== 4, prune: true });
  assert.deepEqual(rows.map(row => row.state), ['failed', 'paused', 'processing', 'done']);
  assert.equal(rows[1].source, 'company');
  assert.equal(fs.existsSync(path.join(sessionStatusDir(agentDir), '4.json')), false, 'a closed session at rest is cleaned up');
  assert.equal(readSessions({ agentDir, controlDir, now, alive: () => true, gateways: false }).some(row => row.source === 'company'), false);
});

test('company states read the same way', () => {
  const row = value => gatewayRow({ conversation: 'c', ...value }, 'company').state;
  assert.equal(row({ state: 'working' }), 'processing');
  assert.equal(row({ state: 'blocked' }), 'paused');
  assert.equal(row({ state: 'error', ended: 'failed' }), 'failed');
  assert.equal(row({ state: 'done', ended: 'stopped' }), 'paused');
  assert.equal(row({ state: 'done', ended: 'done' }), 'done');
  assert.equal(row({ state: 'idle' }), 'idle');
});

test('a space reads as one word or as counts', () => {
  assert.equal(spaceSummary([]), null);
  assert.equal(spaceSummary([{ state: 'idle' }]), null);
  assert.equal(spaceSummary([{ state: 'paused' }, { state: 'idle' }]), '⏸ paused');
  assert.equal(spaceSummary([{ state: 'processing' }, { state: 'failed' }, { state: 'processing' }, { state: 'done' }]), '✖1 ▶2 ✓1');
});

test('only an interactive Terminal counts as a session', async () => {
  const handlers = {}, seen = [];
  const gated = onlyInTerminal({ on: (name, handler) => { handlers[name] = handler; } });
  gated.on('session_start', () => seen.push('start')); gated.on('agent_start', () => seen.push('agent'));
  await handlers.session_start({}, { mode: 'rpc' }); await handlers.agent_start({}, {});
  assert.deepEqual(seen, []);
  await handlers.session_start({}, { mode: 'tui' }); await handlers.agent_start({}, {});
  assert.deepEqual(seen, ['start', 'agent']);
});

test('failureOf reads the last answer only', () => {
  assert.equal(failureOf([]), null);
  assert.equal(failureOf([{ role: 'assistant', stopReason: 'error', errorMessage: 'x' }, { role: 'assistant', stopReason: 'stop' }]), null);
  assert.equal(failureOf([{ role: 'assistant', stopReason: 'error' }]), 'The model request failed');
});

test('piagent sessions lists them and --setup-herdr leaves a member\'s own rows alone', () => {
  const home = tempDir(), agentDir = path.join(home, '.piagent/agent'), iso = new Date().toISOString();
  fs.mkdirSync(sessionStatusDir(agentDir), { recursive: true });
  fs.writeFileSync(path.join(sessionStatusDir(agentDir), '1.json'), JSON.stringify({ id: 's', source: 'terminal', pid: process.pid, state: 'failed', message: 'boom', project: 'shop', title: 'fix login', since: iso, updated_at: iso }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'cfg'), PATH: '/usr/bin:/bin:' + path.dirname(process.execPath) };
  delete env.PIAGENT_AGENT_DIR; delete env.PI_CODING_AGENT_DIR;
  const cli = (...args) => spawnSync(process.execPath, ['scripts/piagent-sessions.mjs', ...args], { env, encoding: 'utf8' });
  const list = cli();
  assert.match(list.stdout, /failed\s+-\s+shop\s+fix login\s+\d+s\s+boom/);
  assert.equal(JSON.parse(cli('--json').stdout).sessions[0].state, 'failed');

  const config = path.join(home, 'cfg/herdr/config.toml');
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, 'onboarding = false');
  assert.equal(cli('--setup-herdr').status, 0);
  assert.match(fs.readFileSync(config, 'utf8'), /^onboarding = false\n[\s\S]*\$piagent_sessions/);
  assert.equal(fs.readFileSync(`${config}.before-piagent-sessions`, 'utf8'), 'onboarding = false');
  const once = fs.readFileSync(config, 'utf8');
  assert.equal(cli('--setup-herdr').status, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), once);
  fs.writeFileSync(config, '[ui.sidebar.spaces]\nrows = [["workspace"]]\n');
  assert.equal(cli('--setup-herdr').status, 1);
  assert.equal(fs.readFileSync(config, 'utf8'), '[ui.sidebar.spaces]\nrows = [["workspace"]]\n');
});
