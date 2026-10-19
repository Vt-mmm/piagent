import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { TeamMemory, findRepositories, memoryTools, PROTOCOL } from '../packages/piagent-core/managed/memory.mjs';
import { CheckLessons } from '../packages/piagent-core/managed/memory-lessons.mjs';
import { memoryScope, scopeID } from '../packages/piagent-core/managed/memory-outbox.mjs';

// Team memory P0/P1 in Piagent: folders that hold several repositories,
// remotes other than origin, protocol 3 (work context, files, checks,
// commit changes) only once Studio speaks it, and memory_ask.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-p1-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return fs.realpathSync(root); };
function repo(dir, remote, remoteName = 'origin') {
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { env }).toString();
  run('init', '-q', '-b', 'main');
  if (remote) run('remote', 'add', remoteName, remote);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'old.txt'), Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  run('add', '.'); run('commit', '-qm', 'First');
  return run;
}
const authority = { studio_instance_id: 'studio', dataset_epoch: 'epoch', auth_generation: 1 };
const manifest = { key_id: 'key-a', user: { id: 'member' }, authority };
const scope = () => memoryScope('http://studio.test', manifest);
function studio(protocol = PROTOCOL) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const op = url.split('/v1/memory/')[1], body = JSON.parse(init.body);
    calls.push({ op, body });
    if (op === 'ask' && protocol < PROTOCOL) return new Response('', { status: 404 });
    const answers = { brief: { protocol_version: protocol, text: body.repo_key ? `BRIEF ${body.repo_key}` : '', facts: 1, pages: ['Component map'], git_head: null, retain_sessions: true, ...(body.repo_key ? {} : { repository: 'missing' }) },
      retain: { status: 'pending', event_id: body.event_id, operation_id: randomUUID() }, git: { status: 'accepted' }, search: { text: `HIT ${body.repo_key}` },
      ask: { text: `ANSWER ${body.repo_key}\n\nSources:\n1. [commit abc] x` }, telemetry: { status: 'recorded' } };
    return new Response(JSON.stringify(answers[op]), { status: 200 });
  };
  return { calls, fetchImpl };
}
const grant = { token: 't', role_id: 'r' };
const round = text => [{ role: 'user', content: text }, { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }];

test('a folder that holds several repositories gets the memory of each, and a round goes to the repositories it touched', async t => {
  const root = temp(t);
  repo(path.join(root, 'backend'), 'git@github.com:acme/shop-api.git');
  repo(path.join(root, 'frontend'), 'https://github.com/acme/shop-web.git');
  repo(path.join(root, 'scratch'), null);
  fs.mkdirSync(path.join(root, 'notes'));
  const found = await findRepositories(root);
  assert.deepEqual(found.repos.map(r => [r.name, r.key]), [['backend', 'github.com/acme/shop-api'], ['frontend', 'github.com/acme/shop-web']]);
  const s = studio(), stateDir = temp(t);
  const memory = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir, conversationId: 'conversation-m1', scope, fetchImpl: s.fetchImpl, changed: () => ['backend/src/pay.go'] });
  const brief = await memory.beforeRound(grant, 'Fix the refund flow', false);
  assert.match(brief.text, /^Repository backend\/ \(github.com\/acme\/shop-api\):\nBRIEF github.com\/acme\/shop-api\n\nRepository frontend\/ \(github.com\/acme\/shop-web\):\nBRIEF/);
  assert.equal(brief.facts, 2);
  await memory.background;
  assert.deepEqual(s.calls.filter(c => c.op === 'git').map(c => c.body.repo_key).sort(), ['github.com/acme/shop-api', 'github.com/acme/shop-web']);
  // Brief bodies: the second conversation on this Mac sends the work context (Studio said 3).
  assert.equal(s.calls.find(c => c.op === 'brief').body.context, undefined);
  const lessons = new CheckLessons();
  lessons.event({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'c1', args: { command: 'npm test 2>&1 | tail -30' } });
  lessons.event({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'c1', isError: false, result: { content: [{ type: 'text', text: '4 passed' }] } });
  s.calls.length = 0;
  await memory.afterRound(grant, round('Fix the refund flow in the backend'), ['backend/src/pay.go'], { id: randomUUID(), at: new Date().toISOString(), scope: scope(), checks: lessons });
  const retains = s.calls.filter(c => c.op === 'retain');
  assert.deepEqual(retains.map(c => c.body.repo_key), ['github.com/acme/shop-api'], 'only the repository the round changed');
  assert.deepEqual(retains[0].body.files, ['src/pay.go']);
  assert.deepEqual(retains[0].body.context, { branch: 'main', paths: ['src'] });
  assert.deepEqual(retains[0].body.checks, { passed: 1, failed: 0, final: 'passed' });
  assert.match(retains[0].body.text, /Files changed in this conversation: src\/pay\.go/);
  // A round that changed nothing but names the front end goes there only.
  s.calls.length = 0;
  await memory.afterRound(grant, round('Why does the frontend cache prices?'), [], { id: randomUUID(), at: new Date().toISOString(), scope: scope() });
  assert.deepEqual(s.calls.filter(c => c.op === 'retain').map(c => c.body.repo_key), ['github.com/acme/shop-web']);
  // Neither: both, each under its own event identity.
  s.calls.length = 0;
  const id = randomUUID();
  await memory.afterRound(grant, round('What did we decide?'), [], { id, at: new Date().toISOString(), scope: scope() });
  const both = s.calls.filter(c => c.op === 'retain');
  assert.equal(both.length, 2);
  const api = both.find(c => c.body.repo_key.endsWith('shop-api')).body.event_id, web = both.find(c => c.body.repo_key.endsWith('shop-web')).body.event_id;
  assert.equal(api, id, 'the first repository keeps the round\'s own event');
  assert.notEqual(web, id); assert.match(web, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // The tools: search goes where the question points, or to the named repository.
  s.calls.length = 0;
  assert.equal(await memory.search(grant, 'backend refunds'), 'HIT github.com/acme/shop-api');
  assert.match(await memory.search(grant, 'refunds'), /^## backend\/ \(github.com\/acme\/shop-api\)\nHIT github.com\/acme\/shop-api\n\n## frontend\//);
  assert.equal(await memory.search(grant, 'refunds', undefined, 'frontend'), 'HIT github.com/acme/shop-web');
  assert.match(await memory.search(grant, 'refunds', undefined, 'mobile'), /No repository named "mobile" here; this folder has: backend, frontend\./);
});

test('a repository whose only remote is not called origin is still known; a folder without one is reported once', async t => {
  const root = temp(t);
  repo(root, 'https://gitlab.example.com/team/app.git', 'upstream');
  assert.deepEqual((await findRepositories(root)).repos.map(r => r.key), ['gitlab.example.com/team/app']);
  const bare = temp(t);
  repo(bare, null);
  assert.deepEqual(await findRepositories(bare), { repos: [], folder: 'no_origin' });
  const odd = temp(t);
  repo(odd, 'file:///srv/git/app');
  assert.equal((await findRepositories(odd)).folder, 'unsupported_remote');
  const s = studio(), stateDir = temp(t);
  const fresh = new TeamMemory({ origin: 'http://studio.test', cwd: bare, stateDir, conversationId: 'conversation-m0', scope, fetchImpl: s.fetchImpl });
  assert.equal(await fresh.beforeRound(grant, 'hello', false), null);
  assert.equal(s.calls.length, 0, 'a Mac Studio never answered memory on reports nothing');
  fs.writeFileSync(path.join(stateDir, 'memory-known.json'), JSON.stringify({ origin: 'http://studio.test', scope: scopeID(scope()), at: Date.now(), protocol: 3 }));
  const memory = new TeamMemory({ origin: 'http://studio.test', cwd: bare, stateDir, conversationId: 'conversation-m2', scope, fetchImpl: s.fetchImpl });
  assert.equal(await memory.beforeRound(grant, 'hello', false), null);
  assert.equal(await memory.beforeRound(grant, 'again', false), null);
  assert.deepEqual(s.calls.map(c => [c.op, c.body.repo_key, c.body.folder]), [['brief', '', 'no_origin']]);
  assert.equal(TeamMemory.knownProtocol(memory.stateDir, 'http://studio.test', scope()), 3, 'the report leaves what this Mac knows alone');
});

test('protocol 3 fields go only to a Studio that speaks 3; commits carry folders and stale-making changes', async t => {
  const root = temp(t), run = repo(root, 'git@github.com:acme/shop.git');
  fs.writeFileSync(path.join(root, 'src', 'old.txt'), 'rewritten\n');
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'a');
  run('mv', 'README.md', 'docs/README.md'); run('add', '.'); run('commit', '-qm', 'Rewrite old.txt, move the readme');
  for (const protocol of [2, 3]) {
    const s = studio(protocol), stateDir = temp(t);
    const memory = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir, conversationId: `conversation-v${protocol}`, scope, fetchImpl: s.fetchImpl });
    await memory.beforeRound(grant, 'start', false);
    await memory.background;
    const commits = s.calls.find(c => c.op === 'git').body.commits;
    const last = commits.at(-1);
    if (protocol === 2) {
      assert.deepEqual(Object.keys(last).sort(), ['body', 'date', 'sha', 'subject']);
    } else {
      assert.deepEqual(last.dirs.sort(), ['docs', 'src']);
      assert.deepEqual(last.changes.sort((a, b) => a.path.localeCompare(b.path)), [{ path: 'README.md', kind: 'renamed' }, { path: 'src/old.txt', kind: 'rewritten' }]);
    }
    await memory.afterRound(grant, round('Done?'), ['src/old.txt'], { id: randomUUID(), at: new Date().toISOString(), scope: scope(), checks: new CheckLessons() });
    const retain = s.calls.find(c => c.op === 'retain').body;
    assert.equal('context' in retain || 'files' in retain || 'checks' in retain, protocol === 3, `protocol ${protocol} retain ${Object.keys(retain)}`);
    assert.equal(TeamMemory.knownProtocol(stateDir, 'http://studio.test', scope()), protocol);
    // The next conversation knows the protocol before its first brief.
    const next = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir, conversationId: `conversation-n${protocol}`, scope, fetchImpl: s.fetchImpl });
    s.calls.length = 0;
    await next.beforeRound(grant, 'next', false);
    assert.equal(!!s.calls[0].body.context, protocol === 3);
    if (protocol === 3) assert.equal(s.calls[0].body.context.branch, 'main');
  }
});

test('memory_ask: sends the question with its context, and a 404 does not turn memory off', async t => {
  const root = temp(t);
  repo(root, 'git@github.com:acme/shop.git');
  const s = studio(3), stateDir = temp(t);
  const self = { grant };
  self.memory = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir, conversationId: 'conversation-a1', scope, fetchImpl: s.fetchImpl });
  assert.deepEqual(memoryTools(self).map(t => t.name), ['memory_search', 'memory_page']);
  const tools = memoryTools(self, { ask: true });
  assert.deepEqual(tools.map(t => t.name), ['memory_search', 'memory_ask', 'memory_page']);
  await self.memory.beforeRound(grant, 'start', false);
  const ask = tools.find(t => t.name === 'memory_ask');
  const out = await ask.execute('id', { question: 'why is the eKYC order locked?' });
  assert.match(out.content[0].text, /^ANSWER github.com\/acme\/shop/);
  const body = s.calls.find(c => c.op === 'ask').body;
  assert.equal(body.question, 'why is the eKYC order locked?'); assert.equal(body.context.branch, 'main');
  assert.equal(self.memory.stats.ask_calls, 1);
  // An older Studio without ask: a message, memory stays on.
  const old = studio(2);
  const m2 = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir: temp(t), conversationId: 'conversation-a2', scope, fetchImpl: old.fetchImpl });
  await m2.beforeRound(grant, 'start', false);
  assert.match(await m2.ask(grant, 'why?'), /cannot answer memory_ask yet/);
  assert.equal(m2.active, true);
  assert.equal(old.calls.find(c => c.op === 'ask').body.context, undefined, 'no protocol-3 fields to a protocol-2 Studio');
});

test('a round queued for protocol 3 is sent without the new fields when Studio speaks 2 again', async t => {
  const root = temp(t);
  repo(root, 'git@github.com:acme/shop.git');
  const stateDir = temp(t), s3 = studio(3);
  const memory = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir, conversationId: 'conversation-d1', scope, fetchImpl: async (url, init) => url.endsWith('/retain') ? new Response('', { status: 503 }) : s3.fetchImpl(url, init) });
  await memory.beforeRound(grant, 'start', false); await memory.background;
  await memory.afterRound(grant, round('x'), ['src/a.go'], { id: randomUUID(), at: new Date().toISOString(), scope: scope(), checks: new CheckLessons() });
  assert.equal(memory.outbox.files().length, 1);
  const s2 = studio(2);
  const later = new TeamMemory({ origin: 'http://studio.test', cwd: root, stateDir, conversationId: 'conversation-d2', scope, fetchImpl: s2.fetchImpl, now: () => Date.now() + 60_000 });
  await later.beforeRound(grant, 'start', false); await later.background;
  const retain = s2.calls.find(c => c.op === 'retain')?.body;
  assert.ok(retain, 'the queued round was sent');
  assert.deepEqual(Object.keys(retain).sort(), ['conversation_id', 'event_id', 'occurred_at', 'repo_key', 'source_key_id', 'text']);
  assert.equal(scopeID(scope()) !== null, true);
});
