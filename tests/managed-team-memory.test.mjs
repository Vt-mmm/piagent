import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { repoKey, turnRecord, MEMORY_ENTRY } from '../packages/piagent-core/managed/memory.mjs';
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
  const state = { mode: 'on', retainStatus: 200, model: [], memory: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.url.startsWith('/v1/memory/')) {
      const op = req.url.slice('/v1/memory/'.length), body = JSON.parse(raw);
      state.memory.push({ op, body, auth: req.headers.authorization });
      if (state.mode === 'off') { res.writeHead(204); res.end(); return; }
      if (op === 'retain' && state.retainStatus !== 200) { res.writeHead(state.retainStatus, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"memory_unavailable"}}'); return; }
      const answers = { brief: { text: 'Team memory for x:\n- [2026-10-01] RULE_CENTS: money is integer cents.', facts: 1, pages: ['Key decisions and rationale'], git_head: null, retain_sessions: true },
        retain: { status: 'accepted' }, git: { status: 'accepted' }, search: { text: 'SEARCH_HIT' }, page: { markdown: '# PAGE' } };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(answers[op])); return;
    }
    const body = JSON.parse(raw), n = state.model.push({ raw, tools: (body.tools ?? []).map(t => t.name) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
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
    const ops = server.state.memory.map(m => m.op);
    assert.deepEqual(ops, ['brief', 'git', 'retain']);
    const [brief, git, retain] = server.state.memory;
    assert.equal(brief.body.repo_key, 'github.com/acme/shop');
    assert.match(brief.auth, /^Bearer as_run_/);
    assert.equal(git.body.head, repo.head);
    assert.deepEqual(git.body.commits.map(c => c.subject), ['Store money as integer cents', 'Add refunds']);
    assert.equal(git.body.commits[0].body, 'Floats lost cents.');
    assert.equal(retain.body.conversation_id, managed.session.sessionManager.getSessionId());
    assert.match(retain.body.text, /^Member: How do we store money\?\n\nAgent: ANSWER_1$/);

    // The next round: no second brief, no second git, its own retain.
    await managed.session.prompt('And refunds?');
    assert.deepEqual(server.state.memory.map(m => m.op), ['brief', 'git', 'retain', 'retain']);
    assert.equal((server.state.model[1].raw.match(/RULE_CENTS/g) ?? []).length, 1, 'the brief stays once in the conversation');

    // Memory down: the round still answers, its record waits and goes with the next round.
    server.state.retainStatus = 503;
    await managed.session.prompt('Third question');
    assert.match(managed.session.messages.findLast(m => m.role === 'assistant').content[0].text, /^ANSWER_/);
    assert.equal(fs.readFileSync(path.join(agentDir, 'memory-outbox.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
    server.state.retainStatus = 200;
    await managed.session.prompt('Fourth question');
    assert.ok(!fs.existsSync(path.join(agentDir, 'memory-outbox.jsonl')));
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

test('a folder without an origin remote sends nothing to memory', { skip: !supported, timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-memory-plain-')), server = await studio();
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: broker({ studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }) });
  try {
    await managed.session.prompt('hello');
    assert.equal(server.state.memory.length, 0);
    assert.equal(server.state.model.length, 1);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
