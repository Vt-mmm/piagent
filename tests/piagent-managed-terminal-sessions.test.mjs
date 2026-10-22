import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedTerminalSessions } from '../packages/piagent-webui/gateway/managed-terminal-sessions.ts';
import { managedTerminalBinding } from '../packages/piagent-webui/gateway/managed-terminal-binding.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { controlActionDigest } from '../packages/piagent-webui/server/control-command-digest.ts';

function fixture(t) {
  const key = Buffer.alloc(32, 4), info = { id: 'company-raw', path: '/sessions/company.jsonl', cwd: '/project' };
  const ref = sessionRefForPath(key, info.path), calls = [], handles = [];
  const owner = { gatewayInstanceRef: 'gateway.company', runtimeInstanceRef: 'runtime.company', ownerEpoch: 1, continuity: 'exact' };
  const manager = { getSessionId: () => info.id };
  let current = true;
  const boundary = { reasonCode: null, async open(size, emit) {
    calls.push(['open', size]);
    const handle = { id: `native.${handles.length}`, closed: false, emit,
      async input(data) { calls.push(['input', data]); emit({ kind: 'output', data }); },
      async resize(size) { calls.push(['resize', size]); },
      async close() { handle.closed = true; emit({ kind: 'exit', exitCode: 0, signal: null }); } };
    handles.push(handle); emit({ kind: 'output', data: 'EARLY_PROMPT\r\n' }); return handle;
  } };
  const options = { key, managed: true, gatewayInstanceRef: owner.gatewayInstanceRef,
    runtimes: { listSessions: async () => [info], acquire: async () => ({ ...owner }), liveSessionManager: () => manager,
      ownership: () => ({ state: 'gateway-owned', owner }) },
    managedTerminal: id => { assert.equal(id, info.id); return { terminals: boundary, current: () => current }; } };
  const service = new ManagedTerminalSessions(options); t.after(() => service.dispose()); let id = 0;
  const command = async payload => {
    const state = await service.state(ref), value = { schemaVersion: 1, version: 'piagent-terminal-v1', messageType: 'command',
      commandId: `command.${++id}`, idempotencyKey: `key.${id}`, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
      action: 'terminal.command', identity: state.identity, expectedRevisions: state.revisions, payload };
    return { ...value, actionDigest: controlActionDigest(value) };
  };
  return { ref, options, service, command, boundary, calls, handles, owner, manager, replace: () => { current = false; } };
}

test('managed terminal binding refuses absent boundaries and invalid session/runtime authority', async t => {
  const f = fixture(t);
  await assert.rejects(managedTerminalBinding({ ...f.options, managed: false }, f.ref), /company-boundary-required/);
  await assert.rejects(managedTerminalBinding({ ...f.options, managedTerminal: undefined }, f.ref), /company-boundary-required/);
  await assert.rejects(managedTerminalBinding(f.options, 'session.unknown'), /session-unavailable/);
  const binding = await managedTerminalBinding(f.options, f.ref);
  f.owner.ownerEpoch++; assert.throws(binding.assertCurrent, /runtime-replaced/);
  f.owner.ownerEpoch--; f.replace(); assert.throws(binding.assertCurrent, /runtime-replaced/);
  await assert.rejects(managedTerminalBinding(f.options, f.ref), /session-unavailable/);
  assert.equal(f.calls.length, 0);
});

test('managed terminal uses only the bound owner, retains early output, redacts replay and deduplicates effects', async t => {
  const f = fixture(t), open = await f.command({ kind: 'open', cols: 80, rows: 24 });
  const [first, retry] = await Promise.all([f.service.execute(open), f.service.execute(open)]);
  assert.equal(first.phase, 'settled'); assert.equal(retry.deduplicated, true); assert.equal(f.handles.length, 1);
  assert.match(f.service.replay(f.ref).map(item => item.data).join(''), /EARLY_PROMPT/);
  const secret = 'sk-' + 'a'.repeat(48);
  await f.service.execute(await f.command({ kind: 'input', terminalRef: first.terminalRef, data: `OPENAI_API_KEY=${secret}\n` }));
  assert.doesNotMatch(f.service.forAgent(f.ref).text, new RegExp(secret));
  assert.match(f.service.forAgent(f.ref).text, /REDACTED/);
  assert.equal((await f.service.execute(await f.command({ kind: 'resize', terminalRef: first.terminalRef, cols: 99, rows: 33 }))).phase, 'settled');
  await f.service.closeSession(f.ref); assert.equal(f.handles[0].closed, true);
  assert.equal(f.service.replay(f.ref).length, 0);
});

test('unavailable company terminal is an explicit state and never invokes a host fallback', async t => {
  const f = fixture(t); f.boundary.reasonCode = 'managed-terminal-seatbelt-unavailable';
  const state = await f.service.state(f.ref);
  assert.equal(state.available, false); assert.equal(state.reasonCode, f.boundary.reasonCode);
  const receipt = await f.service.execute(await f.command({ kind: 'open', cols: 80, rows: 24 }));
  assert.equal(receipt.phase, 'rejected'); assert.equal(receipt.reasonCode, f.boundary.reasonCode);
  assert.equal(f.calls.length, 0);
});

test('runtime replacement during asynchronous company PTY creation closes the old handle', async t => {
  const f = fixture(t), original = f.boundary.open;
  f.boundary.open = async (...args) => { const handle = await original(...args); f.replace(); return handle; };
  const receipt = await f.service.execute(await f.command({ kind: 'open', cols: 80, rows: 24 }));
  assert.equal(receipt.phase, 'uncertain'); assert.equal(f.handles[0].closed, true);
  assert.throws(() => f.service.replay(f.ref), /runtime-replaced/);
});

test('lost company input receipt remains uncertain and exact retry never sends input twice', async t => {
  const f = fixture(t), opened = await f.service.execute(await f.command({ kind: 'open', cols: 80, rows: 24 }));
  let inputs = 0;
  f.handles[0].input = async () => { inputs++; throw Error('managed-terminal-effect-uncertain'); };
  const command = await f.command({ kind: 'input', terminalRef: opened.terminalRef, data: 'one\n' });
  assert.equal((await f.service.execute(command)).phase, 'uncertain');
  const retry = await f.service.execute(command);
  assert.equal(retry.phase, 'uncertain'); assert.equal(retry.deduplicated, true); assert.equal(inputs, 1);
});

test('company terminal refuses stale revisions and cross-session terminal references', async t => {
  const f = fixture(t), old = await f.command({ kind: 'open', cols: 80, rows: 24 });
  await f.service.execute(old);
  const stale = { ...old, idempotencyKey: 'key.stale', commandId: 'command.stale' }; stale.actionDigest = controlActionDigest(stale);
  assert.equal((await f.service.execute(stale)).reasonCode, 'terminal-stale-revision');
  assert.equal((await f.service.execute(await f.command({ kind: 'input', terminalRef: 'terminal.foreign', data: 'x' }))).reasonCode, 'terminal-not-found');
  assert.equal(f.calls.length, 1);
});
