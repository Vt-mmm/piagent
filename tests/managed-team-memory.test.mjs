import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { repoKey, turnRecord, MEMORY_ENTRY, TeamMemory } from '../packages/piagent-core/managed/memory.mjs';
import { memoryScope, scopeID } from '../packages/piagent-core/managed/memory-outbox.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// Team memory in company conversations (memory.mjs): the brief opens a new
// conversation, every round goes back to memory on its run token, new commits
// are sent once, a failed write waits in the outbox, and Studio's 204 (memory
// off) means no memory traffic and no memory tools.
const sdkRoot = piSdkRoot();
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);

test('repository keys come from the origin remote', () => {
  assert.equal(repoKey('https://github.com/Acme/Shop.git'), 'github.com/acme/shop');
  assert.equal(repoKey('git@github.com:acme/shop.git'), 'github.com/acme/shop');
  assert.equal(repoKey('ssh://git@gitlab.example.com:2222/team/app.git/'), 'gitlab.example.com/team/app');
  assert.equal(repoKey('https://user:token@github.com/acme/shop'), 'github.com/acme/shop');
  for (const bad of ['', null, '/Users/me/repo', 'file:///tmp/repo', 'https://github.com/']) assert.equal(repoKey(bad), null, String(bad));
});

test('a round is kept as the member\'s words and the final answer, without secrets or tool output', () => {
  const messages = [
    { role: 'custom', customType: MEMORY_ENTRY, content: 'brief' },
    { role: 'user', content: [{ type: 'text', text: 'Deploy with key as_live_abcdefghijklmnopqrstuv and sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading files' }, { type: 'toolCall', name: 'read' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'FILE CONTENT' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done: deploy uses the release script.' }] }];
  const text = turnRecord(messages, new Set(['scripts/release.sh']));
  assert.match(text, /^Member: Deploy with key \[REDACTED_SECRET\] and \[REDACTED_SECRET\]/);
  assert.match(text, /Agent: Done: deploy uses the release script\./);
  assert.match(text, /Files changed in this conversation: scripts\/release\.sh/);
  assert.doesNotMatch(text, /FILE CONTENT|Reading files|brief|as_live_|sk-proj-/);
  assert.equal(turnRecord([{ role: 'assistant', content: [{ type: 'text', text: 'continuing' }] }]), 'Agent (continuing): continuing');
});

const MODEL = { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' };
function broker(authority) {
  const calls = [], role = randomUUID();
  return { calls, async request(action) {
    calls.push(action);
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key-a', user: { id: 'member-1' }, revision: 'r1',
      models: [MODEL], harness: { configuration: { main: { model_ids: [MODEL.id] } } } };
    if (action === 'close') return true;
    return { ...authority, run_id: randomUUID(), role_id: role, role: 'main', fence: 1, provider: 'claude', model_id: MODEL.id, provider_model_id: MODEL.id,
      effort: 'medium', token: `as_run_${role}_${'x'.repeat(43)}` };
  }, async dispose() {} };
}

// Studio: the model answers ANSWER_n; memory follows `memory.mode`.
async function studio() {
  const state = { mode: 'on', countTokens: false, retainStatus: 200, model: [], memory: [], protocol: 2 };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url.startsWith('/v1/memory/')) {
      const op = req.url.slice('/v1/memory/'.length), body = JSON.parse(raw);
      state.memory.push({ op, body, auth: req.headers.authorization });
      if (state.mode === 'off') { res.writeHead(204); res.end(); return; }
      if (state.mode === 'absent') { res.writeHead(404); res.end(); return; }
      if (op === 'retain' && state.retainStatus !== 200) { res.writeHead(state.retainStatus, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"memory_unavailable"}}'); return; }
      const answers = { brief: { protocol_version: state.protocol, text: 'Team memory for x:\n- [2026-10-01] RULE_CENTS: money is integer cents.', facts: 1, pages: ['Key decisions and rationale'], git_head: null, retain_sessions: true },
        telemetry: { status: 'recorded' }, retain: { status: 'pending', event_id: body.event_id, operation_id: randomUUID() }, git: { status: 'accepted' }, search: { text: 'SEARCH_HIT' }, page: { markdown: '# PAGE' }, ask: { text: 'ASK_ANSWER' } };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answers[op])); return;
    }
    const body = JSON.parse(raw), n = state.model.push({ raw, tools: (body.tools ?? []).map(t => t.name) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: state.countTokens ? Math.ceil(raw.length / 4) : 10, output_tokens: 0 } } });
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `ANSWER_${n}` } });
    emit({ type: 'content_block_stop', index: 0 });
    emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    emit({ type: 'message_stop' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-'));
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
  run('init', '-q'); run('remote', 'add', 'origin', 'git@github.com:acme/shop.git');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a'); run('add', '.'); run('commit', '-qm', 'Store money as integer cents', '-m', 'Floats lost cents.');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b'); run('add', '.'); run('commit', '-qm', 'Add refunds');
  return { root, head: run('rev-parse', 'HEAD').toString().trim() };
}

test('a memory call whose token a model request renewed asks again once with a renewed token', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-renew-'));
  execFileSync('git', ['-C', work, 'init', '-q']); execFileSync('git', ['-C', work, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
  const seen = [];
  const fetchImpl = async (_url, init) => { const token = init.headers.Authorization.slice(7); seen.push(token);
    return token === 'live' ? new Response(JSON.stringify({ text: 'cents only' }), { status: 200 }) : new Response('{}', { status: 401 }); };
  let renewals = 0;
  const memory = new TeamMemory({ origin: 'http://studio.test', cwd: work, stateDir: null, conversationId: 'c', fetchImpl, renew: async () => { renewals++; return { token: 'live', role_id: 'r' }; } });
  assert.equal(await memory.search({ token: 'voided', role_id: 'r' }, 'money'), 'cents only');
  assert.deepEqual(seen, ['voided', 'live']); assert.equal(renewals, 1);
  // A token that stays refused is not asked forever.
  const stuck = new TeamMemory({ origin: 'http://studio.test', cwd: work, stateDir: null, conversationId: 'c', fetchImpl, renew: async () => ({ token: 'voided', role_id: 'r' }) });
  seen.length = 0;
  assert.match(await stuck.search({ token: 'voided', role_id: 'r' }, 'money'), /did not answer/);
  assert.deepEqual(seen, ['voided']);
});

test('a v1 Studio gets the round in its old body, and closing a round stays within its budget', async () => {
  // AbortSignal.timeout timers do not hold the event loop; a running gateway does, so the test holds it too.
  const alive = setInterval(() => {}, 50);
  try {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v1-'));
  execFileSync('git', ['-C', work, 'init', '-q']); execFileSync('git', ['-C', work, 'remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
  const bodies = [];
  const v1 = new TeamMemory({ origin: 'http://studio.test', cwd: work, stateDir: null, conversationId: 'c1',
    fetchImpl: async (url, init) => { bodies.push([url, JSON.parse(init.body)]); return new Response('{"status":"accepted"}', { status: 200 }); } });
  v1.protocol = 1;
  await v1.afterRound({ token: 't', role_id: 'r' }, [{ role: 'user', content: 'money is integer cents' }, { role: 'assistant', content: [{ type: 'text', text: 'noted' }] }], []);
  assert.equal(bodies.length, 1); assert.match(bodies[0][0], /\/v1\/memory\/retain$/);
  assert.deepEqual(Object.keys(bodies[0][1]).sort(), ['conversation_id', 'repo_key', 'text']);
  // An engine that never answers: the backlog and the write are cut at the close budget.
  let calls = 0;
  const hang = (_url, init) => { calls++; return new Promise((_resolve, reject) => { if (init.signal.aborted) reject(init.signal.reason); else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); }); };
  const slow = new TeamMemory({ origin: 'http://studio.test', cwd: work, stateDir: null, conversationId: 'c2', fetchImpl: hang });
  slow.protocol = 1; slow.background = new Promise(() => {});
  const started = Date.now();
  await slow.afterRound({ token: 't', role_id: 'r' }, [{ role: 'user', content: 'x' }], [], {}, AbortSignal.timeout(300));
  assert.ok(Date.now() - started < 1500, `closed after ${Date.now() - started} ms`);
  assert.equal(calls, 0, 'nothing is sent once the close budget is spent');
  // No backlog, a write that never answers: cut at the budget too.
  slow.background = null; const again = Date.now();
  await slow.afterRound({ token: 't', role_id: 'r' }, [{ role: 'user', content: 'x' }], [], {}, AbortSignal.timeout(300));
  assert.equal(calls, 1); assert.ok(Date.now() - again < 1500, `write cut after ${Date.now() - again} ms`);
  let telemetry = 0;
  const late = new TeamMemory({ origin: 'http://studio.test', cwd: work, stateDir: null, conversationId: 'c3', fetchImpl: async () => { telemetry++; return new Response('{}'); } });
  late.protocol = 2; late.repo = 'github.com/acme/shop';
  await late.reportTurn({ token: 't', role_id: 'r' }, { id: 'e', at: new Date().toISOString(), scope: null }, 'answered', 100);
  assert.equal(telemetry, 0);
  } finally { clearInterval(alive); }
});

test('a new conversation opens with the team brief, and every round goes back to memory', { skip: !supported, timeout: 120000 }, async () => {
  const repo = repository(), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-agent-')), server = await studio(), authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  fs.mkdirSync(path.join(agentDir, 'sessions'));
  let managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker(authority), agentDir });
  try {
    // No answer from memory yet on this Mac: no memory tools.
    await managed.session.prompt('How do we store money?');
    assert.ok(!server.state.model[0].tools.includes('memory_search'));
    assert.match(server.state.model[0].raw, /RULE_CENTS: money is integer cents/);
    assert.ok(server.state.model[0].raw.indexOf('RULE_CENTS') < server.state.model[0].raw.indexOf('How do we store money?'), 'the brief comes before the member\'s message');
    const ops = server.state.memory.filter(m => m.op !== 'telemetry').map(m => m.op);
    assert.deepEqual(ops, ['brief', 'git', 'retain']);
    const [brief, git, retain] = server.state.memory;
    assert.equal(brief.body.repo_key, 'github.com/acme/shop');
    assert.match(brief.auth, /^Bearer as_run_/);
    assert.equal(git.body.head, repo.head);
    assert.deepEqual(git.body.commits.map(c => c.subject), ['Store money as integer cents', 'Add refunds']);
    assert.equal(git.body.commits[0].body, 'Floats lost cents.');
    assert.equal(retain.body.conversation_id, managed.session.sessionManager.getSessionId());
    assert.match(retain.body.text, /^Member: How do we store money\?\n\nAgent: ANSWER_1$/);

    const metrics = server.state.memory.find(m => m.op === 'telemetry').body;
    assert.equal(metrics.event_id, retain.body.event_id);
    assert.equal(metrics.counters.brief_nonempty, 1);
    assert.ok(metrics.counters.brief_exposed_requests > 0);
    assert.equal(metrics.outcome, 'answered');
    assert.doesNotMatch(JSON.stringify(metrics), /RULE_CENTS|How do we store|ANSWER_1/);

    // The next round: no second brief, no second git, its own retain.
    await managed.session.prompt('And refunds?');
    assert.deepEqual(server.state.memory.filter(m => m.op !== 'telemetry').map(m => m.op), ['brief', 'git', 'retain', 'retain']);
    assert.equal((server.state.model[1].raw.match(/RULE_CENTS/g) ?? []).length, 1, 'the brief stays once in the conversation');

    // Memory down: the round still answers, its record waits and goes with the next round.
    server.state.retainStatus = 503;
    await managed.session.prompt('Third question');
    assert.match(managed.session.messages.findLast(m => m.role === 'assistant').content[0].text, /^ANSWER_/);
    assert.equal(managed.memory.outbox.files().length, 1);
    server.state.retainStatus = 200;
    managed.memory.now = () => Date.now() + 10000; managed.memory.outbox.now = managed.memory.now;
    await managed.session.prompt('Fourth question');
    assert.equal(managed.memory.outbox.files().length, 0);
    const retained = server.state.memory.filter(m => m.op === 'retain').map(m => m.body.text.split('\n')[0]);
    assert.deepEqual(retained.slice(-3), ['Member: Third question', 'Member: Third question', 'Member: Fourth question']);
    await managed.dispose();

    // A new conversation now has the memory tools, and the agent can search.
    managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker(authority), agentDir });
    const before = server.state.model.length;
    await managed.session.prompt('New topic');
    assert.ok(server.state.model[before].tools.includes('memory_search') && server.state.model[before].tools.includes('memory_page'));
    await managed.dispose();

    // Memory turned off for the team: one 204, then nothing; the next conversation has no memory tools.
    server.state.mode = 'off';
    managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker(authority), agentDir });
    const sent = server.state.memory.length;
    await managed.session.prompt('Off one');
    await managed.session.prompt('Off two');
    assert.deepEqual(server.state.memory.slice(sent).map(m => m.op), ['brief']);
    await managed.dispose();
    managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker(authority), agentDir });
    const at = server.state.model.length;
    await managed.session.prompt('Off three');
    assert.ok(!server.state.model[at].tools.includes('memory_search'));
  } finally { await managed.dispose(); await server.close(); for (const dir of [repo.root, agentDir]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Studio without team memory (404) is asked once per conversation, and nothing waits in the outbox', { skip: !supported, timeout: 60000 }, async () => {
  const repo = repository(), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-agent-')), server = await studio();
  server.state.mode = 'absent';
  const managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker({ studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }), agentDir });
  try {
    await managed.session.prompt('one'); await managed.session.prompt('two');
    assert.deepEqual(server.state.memory.filter(m => m.op !== 'telemetry').map(m => m.op), ['brief']);
    assert.equal(server.state.model.length, 2);
    assert.equal(managed.memory.outbox.files().length, 0);
  } finally { await managed.dispose(); await server.close(); for (const dir of [repo.root, agentDir]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a folder without a repository only tells Studio so, once, and sends nothing else to memory', { skip: !supported, timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-plain-')), server = await studio(), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-agent-'));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }, agent = broker(authority);
  // Studio answered memory on this Mac before (another folder): the folder is reported.
  fs.writeFileSync(path.join(agentDir, 'memory-known.json'), JSON.stringify({ origin: server.origin, scope: scopeID(memoryScope(server.origin, await agent.request('config'))), at: Date.now(), protocol: 3 }));
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent, agentDir });
  try {
    await managed.session.prompt('hello');
    await managed.session.prompt('again');
    assert.deepEqual(server.state.memory.map(m => [m.op, m.body.repo_key, m.body.folder]), [['brief', '', 'not_a_repository']]);
    assert.equal(server.state.model.length, 2);
  } finally { await managed.dispose(); await server.close(); for (const dir of [root, agentDir]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a helper reads team memory with its own run token, and only reads', { skip: !supported, timeout: 120000 }, async () => {
  const repo = repository(), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-agent-'));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const roles = { main: randomUUID(), research: randomUUID() }, token = role => `as_run_${roles[role]}_${'x'.repeat(43)}`;
  const models = [{ id: 'main-model', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, { id: 'helper-model', provider_model_id: 'claude-haiku-5-5', owned_by: 'claude' }];
  const broker = { async request(action, args = {}) {
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key-a', user: { id: 'member-1' }, revision: 'r1', models,
      harness: { configuration: { main: { model_ids: ['main-model'] }, research: { model_ids: ['helper-model'] } } } };
    if (action === 'close') return true;
    const role = args.role ?? 'main';
    return { ...authority, run_id: 'run-1', role_id: roles[role], role, fence: 1, provider: 'claude', model_id: role === 'main' ? 'main-model' : 'helper-model',
      provider_model_id: role === 'main' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5', effort: 'medium', token: token(role) };
  }, async dispose() {} };
  const memory = [], helperTools = [];
  let helperTurns = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (req.url.startsWith('/v1/memory/')) {
      memory.push({ op: req.url.slice(11), auth: req.headers.authorization });
      const answers = { brief: { text: '', facts: 0, pages: [], git_head: null, retain_sessions: true }, search: { text: 'HELPER_MEMORY_HIT' } };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answers[req.url.slice(11)] ?? { status: 'accepted' })); return;
    }
    const helper = req.headers['x-session-id'] === roles.research;
    if (helper) helperTools.push((body.tools ?? []).map(t => t.name));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    if (helper && helperTurns++ === 0) {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'memory_search', input: {} } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"money rule"}' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: helper ? 'HELPER_DONE' : 'MAIN_DONE' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    }
    emit({ type: 'message_stop' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(agentDir, 'memory-known.json'), JSON.stringify({ origin, scope: scopeID(memoryScope(origin, await broker.request('config'))), at: Date.now() }));
  const managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin, broker, agentDir });
  try {
    const prompt = managed.session.prompt('Start');
    // While the main round runs, its research helper reads the team memory.
    while (!managed.grant) await new Promise(r => setTimeout(r, 20));
    const answer = await managed.delegate({ role: 'research', task: 'What does the team memory say about money?' });
    await prompt;
    assert.ok(helperTools[0].includes('memory_search'), helperTools[0].join(','));
    assert.ok(!helperTools[0].includes('memory_page'));
    const search = memory.find(m => m.op === 'search');
    assert.equal(search?.auth, `Bearer ${token('research')}`, 'the helper searches on its own run token');
    assert.ok(!memory.some(m => m.op === 'retain' && m.auth === `Bearer ${token('research')}`), 'a helper never writes memory');
    assert.match(JSON.stringify(answer), /HELPER_DONE/);
  } finally { await managed.dispose(); await new Promise(resolve => server.close(resolve)); for (const dir of [repo.root, agentDir]) fs.rmSync(dir, { recursive: true, force: true }); }
});


test('real managed compaction refreshes the brief and keeps the final answer under the original event', { skip: !supported, timeout: 120000 }, async () => {
  const repo = repository(), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-compact-')), server = await studio();
  server.state.countTokens = true;
  const managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker({ studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }), agentDir });
  try {
    await managed.session.prompt('Implement integer cents. ' + 'synthetic task context '.repeat(29000));
    await managed.session.prompt('Verify invoice rounding. ' + 'synthetic task context '.repeat(29000));
    assert.ok(managed.session.sessionManager.getBranch().some(e => e.type === 'compaction'));
    const second = server.state.memory.filter(m => m.op === 'retain')[1];
    assert.match(second.body.text, /Agent: ANSWER_2/);
    assert.ok(second.body.event_id);
    await managed.session.prompt('Continue the invoice task');
    const briefs = server.state.memory.filter(m => m.op === 'brief');
    assert.equal(briefs.length, 2);
    assert.match(briefs[1].body.prompt, /Continue the invoice task/);
    const next = server.state.model.at(-1);
    assert.equal((next.raw.match(/RULE_CENTS/g) ?? []).length, 1);
    const telemetry = server.state.memory.filter(m => m.op === 'telemetry').at(-1);
    assert.equal(telemetry.body.counters.brief_refreshes, 1);
  } finally { await managed.dispose(); await server.close(); for (const dir of [repo.root,agentDir]) fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a conversation with team memory gets memory_ask, and protocol 3 brings the work context', { skip: !supported, timeout: 120000 }, async () => {
  const repo = repository(), agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-ask-')), server = await studio(), authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  fs.mkdirSync(path.join(agentDir, 'sessions'));
  server.state.protocol = 3;
  let managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker(authority), agentDir });
  try {
    await managed.session.prompt('First conversation');
    // The very first conversation does not know yet that this key has memory (no memory tools at all).
    assert.ok(!server.state.model[0].tools.includes('memory_search'));
    assert.equal(server.state.memory[0].body.context, undefined, 'the first brief does not know the protocol yet');
    const retain = server.state.memory.find(m => m.op === 'retain').body;
    assert.deepEqual(retain.checks, { passed: 0, failed: 0, final: 'none' });
    assert.equal(retain.context.branch, execFileSync('git', ['-C', repo.root, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim());
    await managed.dispose();
    managed = await ManagedSession.create({ sdkRoot, cwd: repo.root, origin: server.origin, broker: broker(authority), agentDir });
    const at = server.state.model.length, sent = server.state.memory.length;
    await managed.session.prompt('Second conversation');
    assert.ok(server.state.model[at].tools.includes('memory_ask') && server.state.model[at].tools.includes('memory_search'));
    assert.ok(server.state.memory[sent].body.context?.branch, 'the brief carries the branch');
  } finally { await managed.dispose(); await server.close(); for (const dir of [repo.root, agentDir]) fs.rmSync(dir, { recursive: true, force: true }); }
});
