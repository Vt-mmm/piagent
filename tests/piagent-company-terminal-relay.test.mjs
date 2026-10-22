import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CompanyTerminalRelay } from '../packages/piagent-webui/gateway/company-terminal-relay.ts';
import { ManagedTerminalSessions } from '../packages/piagent-webui/gateway/managed-terminal-sessions.ts';
import { GatewayProtocolService } from '../packages/piagent-webui/gateway/gateway-protocol-service.ts';
import { SessionAuthority } from '../packages/piagent-webui/server/session-auth.ts';
import { attachGatewayWebSocket } from '../packages/piagent-webui/server/gateway-websocket.ts';
import { sessionRefForPath } from '../packages/piagent-webui/gateway/session-catalog.ts';
import { controlActionDigest } from '../packages/piagent-webui/server/control-command-digest.ts';
import { terminalRouter } from '../packages/piagent-webui/gateway/terminal-router.ts';

async function fixture(t) {
  const key = Buffer.alloc(32, 6), infos = ['one', 'two'].map(id => ({ id, path: `/company/${id}.jsonl`, cwd: '/project' }));
  const refs = infos.map(info => sessionRefForPath(key, info.path)), handles = [], requests = [], cookies = [];
  const managers = infos.map(info => ({ getSessionId: () => info.id }));
  const owner = { gatewayInstanceRef: 'gateway.company', runtimeInstanceRef: 'runtime.company', ownerEpoch: 1, continuity: 'exact' };
  const service = new ManagedTerminalSessions({ key, managed: true, gatewayInstanceRef: owner.gatewayInstanceRef,
    runtimes: { listSessions: async () => infos, acquire: async () => ({ ...owner }), liveSessionManager: ref => managers[refs.indexOf(ref)],
      ownership: () => ({ state: 'gateway-owned', owner }) },
    managedTerminal: id => ({ current: () => true, terminals: { reasonCode: null, open: async (_size, emit) => {
      const handle = { id: `native.${handles.length}`, rawId: id, inputs: [], emit, closed: false,
        input: async data => { handle.inputs.push(data); emit({ kind: 'output', data }); }, resize: async () => {},
        close: async () => { handle.closed = true; emit({ kind: 'exit', exitCode: 0, signal: null }); } };
      handles.push(handle); return handle;
    } } }) });
  const authority = new SessionAuthority(), server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; authority.bindPort(server.address().port);
  const protocol = new GatewayProtocolService({ terminals: service, terminalEvents: service, catalog: async () => ({}), capabilities: () => ({}) });
  const execute = protocol.execute.bind(protocol); let dropNext = false, transport;
  const attach = () => attachGatewayWebSocket({ server, origin: () => origin, authority, protocol });
  protocol.execute = async request => {
    requests.push(request);
    const result = await execute(request);
    if (dropNext && request.method === 'terminals.command') { dropNext = false; await transport.close(); transport = attach(); }
    return result;
  };
  transport = attach();
  const relay = new CompanyTerminalRelay({ owns: ref => refs.includes(ref), link: async () => {
    const session = authority.exchange(authority.issueBootstrapCapability()), cookie = authority.cookieHeader(session).split(';', 1)[0];
    cookies.push(session); return { origin, cookie, csrf: session.csrf };
  } });
  t.after(async () => { relay.close(); await transport.close(); await service.dispose(); await new Promise(resolve => server.close(resolve)); });
  let id = 0;
  const command = async (ref, payload) => {
    const state = await relay.state(ref), value = { schemaVersion: 1, version: 'piagent-terminal-v1', messageType: 'command',
      commandId: `command.${++id}`, idempotencyKey: `key.${id}`, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
      action: 'terminal.command', identity: state.identity, expectedRevisions: state.revisions, payload };
    return { ...value, actionDigest: controlActionDigest(value) };
  };
  return { relay, service, refs, handles, requests, cookies, command, drop: () => { dropNext = true; } };
}
const wait = async check => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('relay observation timed out'); };

test('company terminal relay authenticates two independent sessions, preserves commands and waits for complete redacted replay', { timeout: 15000 }, async t => {
  const f = await fixture(t), messages = [[], []];
  const subscriptions = f.refs.map((ref, index) => f.relay.subscribe(ref, message => messages[index].push(message))); t.after(() => subscriptions.forEach(stop => stop()));
  const opened = [];
  for (const ref of f.refs) opened.push(await f.relay.execute(await f.command(ref, { kind: 'open', cols: 80, rows: 24 })));
  assert.ok(opened.every(receipt => receipt.phase === 'settled')); assert.equal(f.cookies.length, 2);
  const command = await f.command(f.refs[0], { kind: 'input', terminalRef: opened[0].terminalRef, data: 'ONLY_ONE\n' });
  await f.relay.execute(command);
  assert.deepEqual(f.requests.filter(request => request.method === 'terminals.command').at(-1).params.command, command);
  assert.ok(f.requests.every(request => f.cookies.some(cookie => cookie.csrf === request.params.csrfToken)));
  await wait(() => messages[0].some(message => message.data?.includes('ONLY_ONE')));
  assert.ok(messages[1].every(message => message.identity.sessionRef === f.refs[1] && !message.data?.includes('ONLY_ONE')));
  const secret = 'sk-' + 'a'.repeat(48);
  f.handles[0].emit({ kind: 'output', data: `OPENAI_API_KEY=${secret}\n${'line\n'.repeat(10000)}REPLAY_END\n` });
  await f.relay.state(f.refs[0]);
  const replay = f.relay.replay(f.refs[0]);
  assert.ok(replay.length > 1 && replay[0].reset && replay.at(-1).complete);
  const output = replay.map(message => message.data).join('');
  assert.match(output, /REPLAY_END/); assert.match(output, /REDACTED/); assert.ok(!output.includes(secret));
  subscriptions[0](); assert.equal(f.handles[0].closed, false, 'disconnect does not close the company PTY');
  await f.relay.state(f.refs[0]);
  assert.match(f.relay.replay(f.refs[0]).map(message => message.data).join(''), /REPLAY_END/);
  assert.equal(f.handles.length, 2, 'reconnection never opens another PTY');
});

test('lost upstream receipt disables the stream, reconnects reads and only explicit identical retry reaches the ledger', { timeout: 15000 }, async t => {
  const f = await fixture(t), ref = f.refs[0], messages = [];
  const unsubscribe = f.relay.subscribe(ref, message => messages.push(message)); t.after(unsubscribe);
  const opened = await f.relay.execute(await f.command(ref, { kind: 'open', cols: 80, rows: 24 }));
  const command = await f.command(ref, { kind: 'input', terminalRef: opened.terminalRef, data: 'ONCE\n' });
  f.drop(); await assert.rejects(f.relay.execute(command), /disconnected/);
  await wait(() => messages.some(message => message.messageType === 'state' && message.reasonCode === 'company-terminal-disconnected'));
  await wait(() => f.cookies.length >= 2 && messages.at(-1)?.messageType === 'output');
  assert.deepEqual(f.handles[0].inputs, ['ONCE\n']);
  assert.equal(f.requests.filter(request => request.params.command?.idempotencyKey === command.idempotencyKey).length, 1);
  const retry = await f.relay.execute(command);
  assert.equal(retry.deduplicated, true); assert.equal(retry.phase, 'settled'); assert.deepEqual(f.handles[0].inputs, ['ONCE\n']);
  assert.equal(f.handles[0].closed, false);
});

test('terminal router never falls back to personal for known company refs', async () => {
  let personal = 0;
  const local = { state: async () => { personal++; }, execute: async () => { personal++; }, subscribe: () => () => {}, replay: () => [] };
  const routed = terminalRouter(local, { owns: ref => ref === 'company.one', terminals: { ...local, state: async () => { throw Error('company-offline'); } } });
  await assert.rejects(routed.state('company.one'), /company-offline/); assert.equal(personal, 0);
  await routed.state('personal.one'); assert.equal(personal, 1);
});
