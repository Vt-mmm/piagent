import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';

const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);
const REQUEST = 'c17783c2-e134-4715-be3f-b03d9b57efe2';
const MODELS = { sol: { id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex' },
  flash: { id: 'deepseek-flash', provider_model_id: 'deepseek-flash', owned_by: 'deepseek', max_output_tokens: 16384 },
  sonnet: { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' } };

// Studio gives each new helper the model of its role that serves now: the
// first research helper the vendor model, the next one (after a quota
// refusal) the next model of the role's list. `helpers` is that sequence.
function broker(authority, helpers) {
  const calls = [], roles = { main: randomUUID(), research: randomUUID() }, run = randomUUID(); let fence = 0, children = 0, current = helpers[0];
  const grant = (role, model) => ({ ...authority, run_id: run, role_id: roles[role], role, fence: ++fence, provider: model.owned_by, model_id: model.id,
    provider_model_id: model.provider_model_id, effort: 'medium', token: `as_run_${roles[role]}_${'x'.repeat(43)}` });
  return { calls, roles, async request(action, args = {}) {
    calls.push(action === 'child' || action === 'close' && args.role ? `${action}:${args.role}` : action);
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key-a', user: { id: 'member-1' }, revision: 'r1',
      models: Object.values(MODELS), harness: { configuration: { main: { model_ids: [MODELS.sol.id] }, research: { model_ids: helpers.map(m => m.id) } } } };
    if (action === 'child') { current = helpers[Math.min(children++, helpers.length - 1)]; return grant('research', current); }
    if (action === 'start') return grant('main', MODELS.sol);
    if (action === 'renew') return args.role === 'research' ? grant('research', current) : grant('main', MODELS.sol);
    if (action === 'close') return true;
    throw Error('unexpected-broker-action');
  }, async dispose() {} };
}
// A local Studio: `answer` may refuse a request; otherwise a short answer on
// the request's own wire (Chat Completions, Responses or Messages).
async function studio(answer) {
  const requests = []; let entered, release;
  const mainEntered = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ path: req.url.split('?')[0], session: req.headers['x-session-id'] });
    if (answer?.(req, res) === true) return;
    if (req.url.endsWith('/responses')) { entered(); await held; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (req.url.endsWith('/chat/completions')) {
      const chunk = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Vendor answer' }, finish_reason: null }] });
      chunk({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
      res.write('data: [DONE]\n\n');
    } else if (req.url.endsWith('/responses')) {
      const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      emit({ type: 'response.completed', response });
    } else {
      emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Next model answer' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      emit({ type: 'message_stop' });
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, mainEntered, releaseMain: release, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
const refuse = (status, code) => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: code, request_id: REQUEST } })); return true;
};
const authorityOf = () => ({ studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 });
const text = result => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');

// The main agent's turn stays open (its answer held) while helpers run.
async function withMain(agent, server, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-helper-switch-'));
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  let prompt;
  try {
    prompt = managed.session.prompt('Research this');
    await server.mainEntered;
    await body(managed);
  } finally { server.releaseMain(); await prompt?.catch(() => {}); await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

// The vendor's company account is out of usage: the helper starts once more,
// on the model Studio gives the new helper, and answers. Nothing the first
// helper did is lost work: it read only.
test('a helper refused for its account\'s usage starts once more on the next model', { skip: !supported, timeout: 120000 }, async () => {
  const agent = broker(authorityOf(), [MODELS.flash, MODELS.sonnet]);
  const server = await studio((req, res) => req.headers['x-session-id'] === agent.roles.research && req.url.endsWith('/chat/completions') && refuse(429, 'upstream_rate_limited')(req, res));
  await withMain(agent, server, async managed => {
    const result = await managed.delegate({ role: 'research', task: 'Find the docs' });
    assert.match(text(result), /Next model answer/);
    assert.deepEqual(agent.calls.filter(call => /:research$/.test(call)), ['child:research', 'close:research', 'child:research', 'close:research']);
    assert.deepEqual(server.requests.filter(r => r.session === agent.roles.research).map(r => r.path.split('/').at(-1)), ['completions', 'messages']);
    assert.equal(managed.helpers.size, 0);
  });
});

// Once only: a helper refused again says why; a failure another model would
// not cure (this key's own token quota) is not started again.
test('a helper starts again once, and only for a failure another model may not have', { skip: !supported, timeout: 120000 }, async () => {
  const agent = broker(authorityOf(), [MODELS.flash, MODELS.flash]);
  let code = 'upstream_rate_limited';
  const server = await studio((req, res) => req.headers['x-session-id'] === agent.roles.research && refuse(429, code)(req, res));
  await withMain(agent, server, async managed => {
    await assert.rejects(managed.delegate({ role: 'research', task: 'Find the docs' }), /^Error: managed-helper-failed: Agent Watch research subagent: .+ \[upstream_rate_limited\]/);
    assert.equal(agent.calls.filter(call => call === 'child:research').length, 2);
    code = 'token_quota_exhausted';
    await assert.rejects(managed.delegate({ role: 'research', task: 'Again' }), /\[token_quota_exhausted\]/);
    assert.equal(agent.calls.filter(call => call === 'child:research').length, 3, 'not started again');
  });
});

// The helper's account rests (Studio holds its conversation for it): the
// helper waits a while, then stops waiting and starts on the next model
// rather than waiting out the provider's reset.
test('a helper waiting on a resting account moves to the next model', { skip: !supported, timeout: 120000 }, async () => {
  const agent = broker(authorityOf(), [MODELS.flash, MODELS.sonnet]);
  const server = await studio((req, res) => req.headers['x-session-id'] === agent.roles.research && req.url.endsWith('/chat/completions') && refuse(503, 'session_account_not_ready_retry_later')(req, res));
  await withMain(agent, server, async managed => {
    managed.helperSwitchMs = 0;
    const waits = []; managed.session.subscribe(event => { if (event.type === 'managed_capacity_wait' && event.role === 'research') waits.push([event.state, event.outcome ?? null]); });
    const result = await managed.delegate({ role: 'research', task: 'Find the docs' });
    assert.match(text(result), /Next model answer/);
    assert.deepEqual(waits, [['start', null], ['end', 'switched']]);
    assert.equal(agent.calls.filter(call => call === 'child:research').length, 2);
  });
});

// The helper's account was switched off or removed while it ran: Studio says
// its conversation must start over; a new helper does, on the next model.
test('a helper whose account went away starts once more on the next model', { skip: !supported, timeout: 120000 }, async () => {
  const agent = broker(authorityOf(), [MODELS.flash, MODELS.sonnet]);
  const server = await studio((req, res) => req.headers['x-session-id'] === agent.roles.research && req.url.endsWith('/chat/completions') && refuse(409, 'session_account_unavailable_start_new_session')(req, res));
  await withMain(agent, server, async managed => {
    const result = await managed.delegate({ role: 'research', task: 'Find the docs' });
    assert.match(text(result), /Next model answer/);
    assert.equal(agent.calls.filter(call => call === 'child:research').length, 2);
  });
});
