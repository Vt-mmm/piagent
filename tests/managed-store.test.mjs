import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { memberId, resolveStore, storedSlot } from '../packages/piagent-core/managed/store.mjs';

// Agent Watch gives every key its own slot. Conversations must not split with
// it: one store per member per Studio on the machine, whichever key is held.
const slot = letter => letter.repeat(64);
const ORIGIN = 'http://127.0.0.1:17922';
function tempRoot() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-store-'))); }
function conversation(root, name, scope) {
  const dir = path.join(root, name, 'sessions'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${randomUUID()}.jsonl`), [JSON.stringify({ type: 'session', id: randomUUID() }),
    JSON.stringify({ type: 'custom', customType: 'agent-watch-scope', data: scope })].join('\n') + '\n');
}

test('a member\'s keys share one store; another member or Studio gets its own', () => {
  const root = tempRoot();
  try {
    const me = { origin: ORIGIN, userId: 'F7C7D047-0000-4000-8000-000000000001' };
    assert.equal(storedSlot(root, slot('a')), null);
    assert.equal(resolveStore(root, slot('a'), me), slot('a'), 'the first slot a member uses is their store');
    assert.equal(storedSlot(root, slot('a')), slot('a'));
    // The next key: another slot, the same store. Case of the id does not matter.
    assert.equal(resolveStore(root, slot('b'), { ...me, userId: me.userId.toLowerCase() }), slot('a'));
    assert.equal(storedSlot(root, slot('b')), slot('a'));
    assert.equal(resolveStore(root, slot('b'), me), slot('a'), 'asked again: the same answer');
    // Another member on this machine, and the same member at another Studio.
    assert.equal(resolveStore(root, slot('c'), { origin: ORIGIN, userId: 'other-member' }), slot('c'));
    assert.equal(resolveStore(root, slot('d'), { ...me, origin: 'https://studio.example' }), slot('d'));
    // An old Studio that does not say who the member is: the slot stays alone, nothing recorded.
    assert.equal(resolveStore(root, slot('e'), { origin: ORIGIN, userId: undefined }), slot('e'));
    assert.equal(storedSlot(root, slot('e')), null);
    assert.equal(memberId(ORIGIN, ''), null);
    assert.throws(() => resolveStore(root, '../escape', me), /binding-changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('slots from before stores existed are adopted by who started their conversations', () => {
  const root = tempRoot();
  try {
    const user = 'F7C7D047-0000-4000-8000-000000000001', scope = { origin: ORIGIN, key_id: 'key-1', user_id: user };
    // The member's history is under their first key's slot; a later key's slot has two conversations.
    for (let n = 0; n < 5; n++) conversation(root, slot('a'), scope);
    for (let n = 0; n < 2; n++) conversation(root, slot('b'), { ...scope, key_id: 'key-2' });
    conversation(root, slot('c'), { ...scope, user_id: 'someone-else' });
    assert.equal(resolveStore(root, slot('b'), { origin: ORIGIN, userId: user }), slot('a'), 'the slot holding the history is the store');
    assert.equal(storedSlot(root, slot('a')), slot('a'));
    assert.equal(resolveStore(root, slot('f'), { origin: ORIGIN, userId: user }), slot('a'), 'a brand-new key joins it');
    assert.equal(resolveStore(root, slot('c'), { origin: ORIGIN, userId: 'someone-else' }), slot('c'));
    assert.equal(fs.readdirSync(path.join(root, slot('a'), 'sessions')).length, 5, 'nothing is moved or removed');
    assert.equal(fs.readdirSync(path.join(root, slot('b'), 'sessions')).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The real launcher, a broker that answers per slot, and a Studio fixture.
const repo = path.resolve(import.meta.dirname, '..');
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const studioScript = fs.realpathSync(path.join(repo, 'scripts/piagent-studio.mjs'));
function launch(home, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [studioScript, ...args], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('launching under a member\'s second key keeps writing to the store of the first', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 120000 }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-store-launch-')));
  const project = path.join(home, 'project'); fs.mkdirSync(project);
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, { recursive: true });
  const sessions = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req); sessions.push(req.headers['x-session-id']);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const response = { id: 'resp_fixture', object: 'response', status: 'in_progress', model: 'gpt-6-sol', output: [] }, item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'STORE_OK' });
    emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'STORE_OK', annotations: [] }] } });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
    // slot a and b: two keys of one member; slot c: another member.
    const keys = { [slot('a')]: { key: randomUUID(), user: 'member-1', role: randomUUID() }, [slot('b')]: { key: randomUUID(), user: 'member-1', role: randomUUID() },
      [slot('c')]: { key: randomUUID(), user: 'member-2', role: randomUUID() } };
    const broker = path.join(home, 'broker');
    fs.writeFileSync(broker, `#!${process.execPath}
import readline from 'node:readline';
const keys=${JSON.stringify(keys)},authority=${JSON.stringify(authority)},mine=keys[process.argv[process.argv.indexOf('--profile')+1]];
const manifest={schema_version:2,credential_mode:'managed',thinking_levels:['low','medium','high'],authority,key_id:mine.key,user:{id:mine.user},models:[{id:'gpt-6-sol',owned_by:'codex',provider_model_id:'gpt-6-sol'}],harness:{configuration:{main:{model_ids:['gpt-6-sol']}}}};
let fence=0;
for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);
 process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...authority,run_id:'${randomUUID()}',role_id:mine.role,role:'main',fence:++fence,token:'as_run_'+mine.role+'_'+'x'.repeat(43),model_id:'gpt-6-sol',provider_model_id:'gpt-6-sol',provider:'codex',effort:'medium'}})+'\\n');}
`, { mode: 0o700 });
    const node = fs.realpathSync(process.execPath), binding = path.join(agent, 'agent-watch-managed.json');
    const hold = profile => fs.writeFileSync(binding, JSON.stringify({ schema_version: 1, model: 'agent-watch-auto', profile_id: profile, origin: `http://127.0.0.1:${server.address().port}`,
      node, entrypoint: studioScript, node_sha256: sha(node), entrypoint_sha256: sha(studioScript), sdk_root: sdkRoot, broker, broker_sha256: sha(broker) }));
    const root = path.join(home, 'Library/Application Support/AgentWatch/ManagedSessions');
    const files = name => { try { return fs.readdirSync(path.join(root, name, 'sessions')).filter(f => f.endsWith('.jsonl')).length; } catch { return 0; } };
    for (const profile of [slot('a'), slot('b'), slot('c')]) {
      hold(profile);
      const run = await launch(home, ['--config', binding, '--project', project, '--prompt', 'hello']);
      assert.equal(run.code, 0, run.stderr); assert.match(run.stdout, /STORE_OK/);
    }
    assert.deepEqual([files(slot('a')), files(slot('b')), files(slot('c'))], [2, 0, 1], 'both keys of member-1 wrote to one store');
    assert.deepEqual([storedSlot(root, slot('a')), storedSlot(root, slot('b')), storedSlot(root, slot('c'))], [slot('a'), slot('a'), slot('c')]);
    // Each request was made with the key Agent Watch held at that moment.
    assert.deepEqual(sessions, [keys[slot('a')].role, keys[slot('b')].role, keys[slot('c')].role]);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
});
