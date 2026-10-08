import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { capacityDelayMs } from '../packages/piagent-core/managed/request-stream.mjs';
import { describeFailure, failureKind, failureIsAdmissionRefusal, failureIsBriefRefusal, failureText, parseFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';
import { ManagedBrokerClient } from '../packages/piagent-core/managed/broker-client.mjs';

const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);
const REQUEST = 'c17783c2-e134-4715-be3f-b03d9b57efe2';

test('a failure names who failed, why and Studio\'s request, never the harness model', () => {
  const raw = {
    claude: `429 {"error":{"code":"upstream_rate_limited","message":"upstream_rate_limited","request_id":"${REQUEST}"}}`,
    codex: `agent_watch_managed API error (503): {"code":"connector_unavailable","message":"connector_unavailable","request_id":"${REQUEST}"}`,
  };
  assert.equal(describeFailure('main', raw.claude),
    `Agent Watch main agent: the company's model account is rate limited or out of usage at the provider [upstream_rate_limited] (request ${REQUEST})`);
  assert.deepEqual(parseFailure(describeFailure('research', raw.codex)),
    { role: 'research', code: 'connector_unavailable', kind: 'service', requestId: REQUEST, local: false });
  // Sessions written before this change keep Studio's raw answer: same result.
  assert.deepEqual(parseFailure(raw.claude), { role: 'main', code: 'upstream_rate_limited', kind: 'provider-limit', requestId: REQUEST, local: false });
  const kinds = { token_quota_exhausted: 'quota', account_capacity_unavailable: 'provider-limit', concurrency_limit: 'busy', live_trial_limit_reached: 'trial-limit',
    authentication_required: 'key', policy_denied: 'policy', session_account_unavailable_start_new_session: 'new-session', upstream_request_rejected: 'rejected', request_too_large: 'rejected',
    upstream_timeout: 'service', 'managed-broker:offline': 'unreachable', 'managed-session-scope-changed': 'new-session', 'managed-route-changed': 'config-changed' };
  for (const [code, kind] of Object.entries(kinds)) assert.equal(failureKind(code), kind, code);
  // The connector's own name for its live-test ceiling, an unknown Studio code, a dead connection, a helper.
  assert.equal(parseFailure('503 {"error":{"code":"initial_request_limit_reached"}}').code, 'live_trial_limit_reached');
  assert.deepEqual([parseFailure(`500 {"error":{"code":"brand_new","request_id":"${REQUEST}"}}`).code, parseFailure('fetch failed').code], ['studio-request-failed', 'studio-unreachable']);
  assert.equal(parseFailure('fetch failed').local, true);
  assert.equal(parseFailure('agent_watch_managed stream ended without a terminal event').code, 'upstream_incomplete');
  assert.equal(parseFailure('agent_watch_managed response has no body').code, 'upstream_incomplete');
  assert.equal(parseFailure('Anthropic stream ended without a stop reason').code, 'upstream_incomplete');
  // The provider declined the request under its usage policy: said in words, kind "refused".
  const refusal = parseFailure("This request triggered restrictions on violative cyber content and was blocked under the provider's Usage Policy.");
  assert.deepEqual([refusal.code, refusal.kind], ['upstream_policy_refusal', 'refused']);
  assert.equal(describeFailure('main', 'blocked under the Usage Policy'), "Agent Watch main agent: the model's provider declined this request under its usage policy [upstream_policy_refusal]");
  const helper = parseFailure(`managed-helper-failed: ${describeFailure('review', raw.claude)}`);
  assert.deepEqual([helper.role, helper.code, helper.requestId], ['review', 'upstream_rate_limited', REQUEST]);
  for (const text of Object.values(raw)) assert.doesNotMatch(describeFailure('main', text), /sonnet|gpt|opus|claude-/i);
});

// A local Studio: answers every model request through `answer`, else a short text.
async function studio(answer) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ path: req.url.split('?')[0], body, session: req.headers['x-session-id'] });
    if (answer?.(req, res, body) === true) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (req.url.endsWith('/chat/completions')) {
      // An API-key vendor over Chat Completions: content, stop, then usage.
      const chunk = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      chunk({ id: 'chat_fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture answer' }, finish_reason: null }] });
      chunk({ id: 'chat_fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ id: 'chat_fixture', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
      res.write('data: [DONE]\n\n');
    } else if (req.url.endsWith('/responses')) {
      const response = { id: 'resp_fixture', object: 'response', status: 'in_progress', model: body.model, output: [] };
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      emit({ type: 'response.created', response });
      emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture answer' });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'Fixture answer', annotations: [] }] } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } });
    } else {
      emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture answer' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      emit({ type: 'message_stop' });
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
const refuse = (status, code, anthropic) => (_req, res) => {
  const error = { code, message: code, request_id: REQUEST };
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(anthropic ? { error } : error)); return true;
};

const MODELS = { sonnet: { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, sol: { id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex' },
  opus: { id: 'claude-opus-5-5', provider_model_id: 'claude-opus-5-5', owned_by: 'claude' }, sol61: { id: 'gpt-6.1-sol', provider_model_id: 'gpt-6.1-sol', owned_by: 'codex' },
  deepseek: { id: 'deepseek-flash', provider_model_id: 'deepseek-flash', owned_by: 'deepseek', max_output_tokens: 16384 }, grok: { id: 'grok-4.6', provider_model_id: 'grok-4.6', owned_by: 'xai', max_output_tokens: 16384 } };
// An Agent Watch broker for one key: `main` is the harness main model, `knows`
// the models of the key when this broker enrolled.
// Like Studio, a run carries the member's level (start) unless the Harness fixes
// it: `mainEffort` for the main agent, `helperEffort` for both helpers.
function broker(authority, { key = 'key-a', member = 'member-1', main = 'sonnet', knows = [main], revision = 'r1', fail = {}, helper = 'opus', helpers = ['research'], mainEffort, helperEffort } = {}) {
  const calls = [], efforts = [], roles = { main: randomUUID(), research: randomUUID(), review: randomUUID() }, run = randomUUID(); let fence = 0, runEffort = 'medium';
  const grant = role => { const model = MODELS[role === 'main' ? main : helper]; return { ...authority, run_id: run, role_id: roles[role], role, fence: ++fence, provider: model.owned_by,
    model_id: model.id, provider_model_id: model.provider_model_id, effort: role === 'main' ? runEffort : helperEffort ?? runEffort, token: `as_run_${roles[role]}_${'x'.repeat(43)}` }; };
  return { calls, efforts, roles, disposed: false, async request(action, args = {}) {
    calls.push(action);
    if (fail[action]) throw Error(fail[action]);
    if (action === 'start') { efforts.push(args.effort); runEffort = mainEffort ?? args.effort; }
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: key, user: { id: member }, revision,
      models: [...new Set([...knows, helper])].map(name => MODELS[name]), harness: { configuration: { main: { model_ids: [MODELS[knows[0]].id] }, ...Object.fromEntries(helpers.map(role => [role, { model_ids: [MODELS[helper].id] }])) } } };
    if (['start', 'renew', 'child'].includes(action)) return grant(args.role ?? 'main');
    if (action === 'close') return true;
    throw Error('unexpected-broker-action');
  }, async dispose() { this.disposed = true; } };
}
const authorityOf = () => ({ studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 });
const last = managed => managed.session.messages.at(-1);
const roles = managed => managed.session.messages.map(message => message.role);

test('Studio\'s reason for a refused run or subagent reaches the member, not just "configuration changed"', async () => {
  // Agent Watch passes Studio's code beside its coarse error; the message
  // itself stays the coarse error, which start and renewal decide on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-broker-code-'));
  const executable = path.join(fs.realpathSync(dir), 'agentwatch');
  fs.writeFileSync(executable, `#!${process.execPath}
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => { const { id, role } = JSON.parse(line);
  const answer = role === 'scout' ? { id, error: 'identityChanged', studio_code: 'harness_profile_unavailable' } : role === 'verify' ? { id, error: 'identityChanged', studio_code: 'Not a code!' } : { id, error: 'serverUnavailable', studio_code: 'harness_route_unavailable' };
  process.stdout.write(JSON.stringify(answer) + '\\n'); });
`, { mode: 0o700 });
  const client = new ManagedBrokerClient({ executable, profileID: 'a'.repeat(64) });
  try {
    const refused = await client.request('child', { role: 'scout' }).catch(error => error);
    assert.equal(refused.message, 'managed-broker:identityChanged');
    assert.equal(describeFailure('scout', failureText(refused)), "Agent Watch scout subagent: the team's harness has no model for this role [harness_profile_unavailable]");
    const unavailable = await client.request('child', { role: 'research' }).catch(error => error);
    assert.equal(unavailable.message, 'managed-broker:serverUnavailable');
    assert.deepEqual(parseFailure(describeFailure('research', failureText(unavailable))), { role: 'research', code: 'harness_route_unavailable', kind: 'provider-limit', requestId: null, local: false });
    const malformed = await client.request('child', { role: 'verify' }).catch(error => error);
    assert.equal(malformed.studioCode, undefined);
    assert.match(describeFailure('verify', failureText(malformed)), /\[managed-broker:identityChanged\]$/);
  } finally { client.dispose().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed request is answered in words; the conversation continues with the next message', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')); let failing = true;
  const server = await studio((req, res) => failing && refuse(429, 'upstream_rate_limited', true)(req, res));
  const authority = authorityOf(), agent = broker(authority);
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'error');
    assert.match(last(managed).errorMessage, new RegExp(`^Agent Watch main agent: .+ \\[upstream_rate_limited\\] \\(request ${REQUEST}\\)$`));
    assert.doesNotMatch(last(managed).errorMessage, /sonnet|"code"/);
    failing = false;
    await managed.session.prompt('again');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(agent.calls, ['config', 'start', 'renew', 'close', 'start', 'renew', 'close']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Studio refuses at admission when every company model account that can serve
// the conversation is busy (one request at a time per account). Nothing reached
// the model, so the request waits in line and is asked again.
test('a request Studio held in its own line is asked again at once; one refused at once backs off', () => {
  assert.equal(capacityDelayMs(1, 30_000, 0), 500); assert.equal(capacityDelayMs(9, 30_000, 1), 1500);
  assert.deepEqual([1, 2, 3, 4, 8].map(asks => capacityDelayMs(asks, 40, 0.5)), [2000, 4000, 8000, 15000, 15000]);
});

test('only an admission refusal is asked again; a failure after admission never is', () => {
  for (const code of ['session_account_busy_retry_later', 'session_account_not_ready_retry_later', 'concurrency_limit', 'account_capacity_unavailable', 'request_rate_limit', 'gateway_busy', 'connector_busy'])
    assert.equal(failureIsAdmissionRefusal(code), true, code);
  for (const code of ['upstream_rate_limited', 'upstream_interrupted', 'upstream_timeout', 'connector_execution_failed', 'token_quota_exhausted', 'live_trial_limit_reached', 'studio-unreachable'])
    assert.equal(failureIsAdmissionRefusal(code), false, code);
  // Brief refusals (an account sign-in being renewed) are asked again a few times, separately.
  for (const code of ['execution_precondition_failed', 'upstream_auth_required', 'invalid_run_grant', 'operation_unavailable']) assert.equal(failureIsBriefRefusal(code), true, code);
  // Studio's grant check that ran out of time is named, not "Studio answered with an error".
  assert.deepEqual([parseFailure('503 {"error":{"code":"operation_unavailable","message":"operation_unavailable","request_id":""}}').code, failureKind('operation_unavailable')], ['operation_unavailable', 'busy']);
  for (const code of ['upstream_interrupted', 'upstream_incomplete', 'session_account_busy_retry_later']) assert.equal(failureIsBriefRefusal(code), false, code);
});

for (const main of ['sonnet', 'sol']) test(`a request Studio has no free account for waits in line, then runs: one answer, no failed turn (${main})`, { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')); let refusals = 2;
  const server = await studio((req, res) => refusals-- > 0 && refuse(503, 'session_account_busy_retry_later', true)(req, res));
  const authority = authorityOf(), agent = broker(authority, { main });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  const waits = []; managed.session.subscribe(event => { if (event.type === 'managed_capacity_wait') waits.push([event.state, event.outcome ?? null, event.code]); });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(roles(managed).filter(role => role !== 'system'), ['user', 'assistant'], 'the refusals left nothing in the conversation');
    assert.equal(server.requests.length, 3);
    assert.deepEqual(agent.calls, ['config', 'start', 'renew', 'renew', 'renew', 'close'], 'each ask renews the grant');
    assert.deepEqual(waits, [['start', null, 'session_account_busy_retry_later'], ['waiting', null, 'session_account_busy_retry_later'], ['end', 'admitted', 'session_account_busy_retry_later']]);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Stop ends a wait for a free account; a wait that lasts too long fails with Studio\'s reason', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(refuse(429, 'concurrency_limit', true)), authority = authorityOf(), agent = broker(authority);
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  const waits = []; let stop = true; managed.session.subscribe(event => {
    if (event.type !== 'managed_capacity_wait') return;
    waits.push([event.state, event.outcome ?? null]);
    if (event.state === 'start' && stop) { stop = false; setTimeout(() => void managed.session.abort(), 50); }
  });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'aborted', JSON.stringify(last(managed)));
    assert.deepEqual(waits, [['start', null], ['end', 'stopped']]);
    assert.equal(server.requests.length, 1, 'nothing is asked after Stop');
    waits.length = 0; managed.capacityWaitMs = 0;
    await managed.session.prompt('again');
    assert.equal(last(managed).stopReason, 'error');
    assert.match(last(managed).errorMessage, new RegExp(`^Agent Watch main agent: this key already runs its maximum number of requests \\[concurrency_limit\\] \\(request ${REQUEST}\\)$`));
    assert.deepEqual(waits.at(-1), ['end', 'gave-up']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Studio admitted the request and the answer stream ended with nothing in it:
// a named service failure, asked again twice (turn-retry.mjs) and then shown.
// A failure no code names is not asked again and keeps its own words,
// redacted, in the conversation file for a later look.
test('an empty answer stream is a named failure after two retries; an unnamed one keeps its words', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')); let mode = 'empty';
  const server = await studio((_req, res) => {
    if (mode === 'ok') return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (mode === 'garbled') res.write(`event: content_block_delta\ndata: {not json as_live_${'1'.repeat(8)}-1111-1111-1111-111111111111_${'x'.repeat(43)}}\n\n`);
    res.end(); return true;
  });
  const authority = authorityOf(), agent = broker(authority);
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  managed.services.settingsManager.applyOverrides({ retry: { baseDelayMs: 5 } });
  try {
    assert.equal(managed.turnRetry, true);
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'error');
    assert.match(last(managed).errorMessage, /^Agent Watch main agent: the model returned no response \[upstream_incomplete\]$/);
    assert.equal(server.requests.length, 3, 'asked again twice, then shown');
    mode = 'garbled';
    await managed.session.prompt('again');
    const kept = managed.session.sessionManager.getEntries().filter(entry => entry.customType === 'agent-watch-failure-detail');
    assert.equal(server.requests.length, 4, 'a failure no code names is not asked again');
    if (/\[managed-request-failed\]$/.test(last(managed).errorMessage)) {
      assert.equal(kept.length, 1); assert.equal(kept[0].data.role, 'main');
      assert.doesNotMatch(kept[0].data.text, /as_live_1/, 'credentials are redacted');
    } else assert.equal(kept.length, 0, last(managed).errorMessage);
    mode = 'ok';
    await managed.session.prompt('once more');
    assert.equal(last(managed).stopReason, 'stop');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// One passing failure after admission costs the member nothing: the answer
// comes on the next ask, the failed attempt is not in what the model sees,
// and a request the model rejected is never asked again.
test('a passing failure after admission is asked again once and answered; a rejected request is not', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')); let mode = 'cut-once';
  const server = await studio((req, res) => {
    if (mode === 'cut-once') { mode = 'ok'; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); return true; }
    if (mode === 'rejected') return refuse(400, 'upstream_request_rejected', true)(req, res);
    return false;
  });
  const authority = authorityOf(), agent = broker(authority);
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  managed.services.settingsManager.applyOverrides({ retry: { baseDelayMs: 5 } });
  const retries = []; managed.session.subscribe(event => { if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end') retries.push([event.type, event.attempt, event.success ?? null]); });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.equal(server.requests.length, 2);
    assert.deepEqual(retries, [['auto_retry_start', 1, null], ['auto_retry_end', 1, true]]);
    assert.equal(JSON.stringify(server.requests[1].body.messages ?? server.requests[1].body.input).includes('no response'), false,
      'the failed attempt is not sent to the model');
    mode = 'rejected';
    await managed.session.prompt('again');
    assert.equal(last(managed).stopReason, 'error');
    assert.match(last(managed).errorMessage, /\[upstream_request_rejected\]/);
    assert.equal(server.requests.length, 3, 'a rejected request is not asked again');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// The company account's sign-in was being renewed: the provider refused the
// old one, or the account changed just before the request started. Nothing
// was done, so it is asked again a few times; an account that really has to
// sign in again still says so.
test('a refusal while the account sign-in is renewed is asked again a few times', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')); let plan = ['execution_precondition_failed', 'operation_unavailable'];
  const server = await studio((req, res) => {
    const code = plan.shift();
    return code ? refuse({ execution_precondition_failed: 409, operation_unavailable: 503 }[code] ?? 502, code, true)(req, res) : false;
  });
  const authority = authorityOf(), agent = broker(authority);
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  managed.briefPauseMs = 10;
  const waits = []; managed.session.subscribe(event => { if (event.type === 'managed_capacity_wait') waits.push(event.state); });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(roles(managed).filter(role => role !== 'system'), ['user', 'assistant']);
    assert.equal(server.requests.length, 3);
    assert.deepEqual(waits, [], 'no wait step for a brief refusal');
    plan = Array(5).fill('upstream_auth_required');
    await managed.session.prompt('again');
    assert.equal(last(managed).stopReason, 'error');
    assert.match(last(managed).errorMessage, /\[upstream_auth_required\]/);
    assert.equal(server.requests.length, 3 + 4, 'asked again three times, then the reason is shown');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// After the Mac slept: Studio's clock caught up at once and the run's
// two-minute grant lapsed under the request, and a broker request that
// outlived the sleep killed the Agent Watch helper. Both recover by themselves.
test('after a sleep, a lapsed run grant is renewed and asked again; a dead helper is replaced at the next turn', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')); let lapsed = 1;
  const server = await studio((req, res) => lapsed-- > 0 && refuse(401, 'invalid_run_grant', true)(req, res));
  const authority = authorityOf(), made = [];
  const next = () => { const value = broker(authority); made.push(value); return value; };
  const first = next();
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: first, renewBroker: next });
  managed.briefPauseMs = 10;
  try {
    await managed.session.prompt('hello after a sleep');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(first.calls, ['config', 'start', 'renew', 'renew', 'close'], 'renewed before asking again');
    assert.equal(server.requests.length, 2);
    // The helper died: its next request says so at once.
    const request = first.request.bind(first);
    first.request = async () => { throw Error('managed-broker-disconnected'); };
    await managed.session.prompt('the next message');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.equal(made.length, 2, 'a fresh helper enrolled'); assert.deepEqual(made[1].calls, ['config', 'start', 'renew', 'close']);
    first.request = request;
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Many requests of one key at once: Studio answers a configuration read or a
// run start too late once. Both are asked again; the conversation opens and
// the turn runs.
test('a busy Studio is asked again for the configuration and the run start', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf(), agent = broker(authority);
  const busyOnce = new Set(['config', 'start']), request = agent.request.bind(agent);
  agent.request = async (action, args) => {
    if (busyOnce.delete(action)) { agent.calls.push(action); throw Error('managed-broker:serverUnavailable'); }
    return request(action, args);
  };
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(agent.calls, ['config', 'config', 'start', 'start', 'renew', 'close']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// The run was closed under the request: Studio refuses its grant, and asking
// again cannot renew it. The member is told the run is no longer valid, not
// that the key is.
test('a refused grant that cannot be renewed reports the refusal, not the renewal', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(refuse(401, 'invalid_run_grant', true)), authority = authorityOf(), agent = broker(authority);
  let renewals = 0; const request = agent.request.bind(agent);
  agent.request = async (action, args) => (action === 'renew' && ++renewals > 1 ? Promise.reject(Error('managed-broker:invalidKey')) : request(action, args));
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  managed.briefPauseMs = 10;
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'error');
    assert.match(last(managed).errorMessage, /\[invalid_run_grant\]/);
    assert.equal(server.requests.length, 1);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a run that cannot start becomes a turn with the reason, and nothing is sent', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf(), agent = broker(authority, { fail: { start: 'managed-broker:offline' } });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('hello');
    assert.deepEqual(roles(managed).filter(role => role !== 'system'), ['user', 'assistant']);
    assert.match(last(managed).errorMessage, /^Agent Watch main agent: Agent Watch could not reach Studio \[managed-broker:offline\]$/);
    assert.equal(parseFailure(last(managed).errorMessage).local, true);
    assert.equal(server.requests.length, 0);
    assert.deepEqual(agent.calls, ['config', 'start'], 'no run was opened, so none is closed');
    assert.equal(managed.session.sessionManager.getEntries().some(entry => entry.customType === 'agent-watch-run'), false);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a harness changed to a model the conversation did not know: it enrolls again and runs on it', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf();
  // Enrolled when the key had Sonnet; Studio now issues runs on the new main model.
  const old = broker(authority, { main: 'sol', knows: ['sonnet'] }), fresh = broker(authority, { main: 'sol', knows: ['sol'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: old, renewBroker: () => fresh });
  try {
    await managed.session.prompt('hello');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual([server.requests.length, server.requests[0].path, server.requests[0].body.model], [1, '/v1/responses', 'gpt-6-sol']);
    assert.deepEqual(old.calls, ['config', 'start', 'close'], 'the run it could not verify is closed');
    assert.equal(old.disposed, true);
    assert.deepEqual(fresh.calls, ['config', 'start', 'renew', 'close']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude history continues on a Codex main model and back after the harness changes', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf();
  let revision = 'r1', current = broker(authority, { main: 'sonnet', knows: ['sonnet', 'sol'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: current, renewBroker: () => current, bindingRevision: () => revision });
  try {
    await managed.session.prompt('first');
    revision = 'r2'; current = broker(authority, { main: 'sol', knows: ['sol', 'sonnet'], revision });
    await managed.session.prompt('second');
    revision = 'r3'; current = broker(authority, { main: 'sonnet', knows: ['sonnet', 'sol'], revision });
    await managed.session.prompt('third');
    assert.deepEqual(server.requests.map(request => [request.path, request.body.model]),
      [['/claude/v1/messages', 'claude-sonnet-5-5'], ['/v1/responses', 'gpt-6-sol'], ['/claude/v1/messages', 'claude-sonnet-5-5']]);
    assert.deepEqual(managed.session.messages.filter(message => message.role === 'assistant').map(message => message.stopReason), ['stop', 'stop', 'stop']);
    // Each model received the whole conversation so far, whoever answered it.
    assert.match(JSON.stringify(server.requests[1].body.input), /first[\s\S]*Fixture answer[\s\S]*second/);
    assert.match(JSON.stringify(server.requests[2].body.messages), /first[\s\S]*Fixture answer[\s\S]*second[\s\S]*Fixture answer[\s\S]*third/);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a helper the harness adds while the member works is offered in the same conversation', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf();
  let revision = 'r1', current = broker(authority, { main: 'sol', knows: ['sol'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: current, renewBroker: () => current, bindingRevision: () => revision });
  const offered = request => ['research', 'verify'].filter(role => JSON.stringify(request.body).includes(`delegate role \\"${role}\\"`));
  try {
    await managed.session.prompt('first');
    revision = 'r2'; current = broker(authority, { main: 'sol', knows: ['sol'], helpers: ['research', 'verify'], revision });
    await managed.session.prompt('second');
    assert.deepEqual(server.requests.map(offered), [['research'], ['research', 'verify']]);
    // The tool schema fixed when the conversation opened accepts the new helper.
    const delegate = server.requests[1].body.tools.find(t => t.name === 'delegate');
    assert.ok(delegate.parameters.properties.role.enum.includes('verify'));
    assert.deepEqual(managed.session.messages.filter(message => message.role === 'assistant').map(message => message.stopReason), ['stop', 'stop']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('GPT-6.1 Sol, newer than the bundled Pi catalog, runs with its reviewed window and effort', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf();
  let revision = 'r1', current = broker(authority, { main: 'sonnet', knows: ['sonnet', 'sol61'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: current, renewBroker: () => current, bindingRevision: () => revision });
  try {
    await managed.session.prompt('first');
    revision = 'r2'; current = broker(authority, { main: 'sol61', knows: ['sol61', 'sonnet'], revision });
    managed.session.setThinkingLevel('high');
    await managed.session.prompt('second');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(server.requests.map(request => [request.path, request.body.model]), [['/claude/v1/messages', 'claude-sonnet-5-5'], ['/v1/responses', 'gpt-6.1-sol']]);
    assert.equal(server.requests[1].body.reasoning?.effort, 'high');
    assert.deepEqual([managed.session.model.contextWindow, managed.session.model.maxTokens], [272000, 128000]);
    assert.match(JSON.stringify(server.requests[1].body.input), /first[\s\S]*Fixture answer[\s\S]*second/);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an API-key vendor model (DeepSeek, then Grok) continues a Claude conversation over Chat Completions', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  // The company search pool answers a vendor role's web search.
  const server = await studio((req, res) => { if (req.url !== '/v1/search') return false; res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ provider: 'exa', answer: 'Pool answer', results: [{ title: 'Doc', url: 'https://docs.example/a', content: 'snippet' }], credits: 0, attempts: 1 })); return true; }), authority = authorityOf();
  let revision = 'r1', current = broker(authority, { main: 'sonnet', knows: ['sonnet', 'deepseek', 'grok'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: current, renewBroker: () => current, bindingRevision: () => revision });
  try {
    await managed.session.prompt('first');
    revision = 'r2'; current = broker(authority, { main: 'deepseek', knows: ['deepseek', 'sonnet', 'grok'], revision });
    managed.session.setThinkingLevel('high');
    await managed.session.prompt('second');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.equal(last(managed).content.find(part => part.type === 'text')?.text, 'Fixture answer');
    const chat = server.requests[1];
    assert.deepEqual([chat.path, chat.body.model, chat.body.stream, chat.body.stream_options?.include_usage], ['/openai/v1/chat/completions', 'deepseek-flash', true, true]);
    assert.equal(chat.body.max_tokens, 16384, 'the key\'s output cap, not the model\'s 384k');
    assert.deepEqual([chat.body.thinking?.type, chat.body.reasoning_effort], ['enabled', 'high']);
    assert.match(JSON.stringify(chat.body.messages), /first[\s\S]*Fixture answer[\s\S]*second/);
    assert.equal(chat.session, current.roles.main);
    // Grok over Chat Completions: no thinking parameters; its web search goes to the company pool.
    revision = 'r3'; current = broker(authority, { main: 'grok', knows: ['grok', 'sonnet', 'deepseek'], revision });
    await managed.session.prompt('third');
    const grok = server.requests[2];
    assert.deepEqual([grok.path, grok.body.model, grok.body.reasoning_effort, grok.body.reasoning], ['/openai/v1/chat/completions', 'grok-4.6', undefined, undefined]);
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    const search = managed.webTools(managed.modelRuntime, 'main').find(tool => tool.name === 'web_search');
    const found = await search.execute('call', { query: 'x' });
    const asked = server.requests.at(-1);
    assert.deepEqual([asked.path, asked.body, asked.session], ['/v1/search', { query: 'x', max_results: 5 }, current.roles.main], 'the pool gets the run token\'s role, no model or effort');
    assert.match(found.content[0].text, /Pool answer[\s\S]*1\. Doc — https:\/\/docs\.example\/a\n   snippet/);
    assert.equal(found.details.provider, 'exa');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a Claude role searches the company pool first and its own search tool when the pool has no answer', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  let pool = 'answer';
  const server = await studio((req, res) => {
    if (req.url !== '/v1/search') return false;
    if (pool === 'missing') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"not_found"}}'); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ provider: 'tavily', answer: 'Pool answer', results: [{ title: 'Doc', url: 'https://docs.example/a', content: 'snippet' }], credits: 1, attempts: 1 })); return true;
  }), authority = authorityOf();
  const current = broker(authority, { main: 'sonnet', knows: ['sonnet'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: current, renewBroker: () => current });
  try {
    const search = managed.webTools(managed.modelRuntime, 'main').find(tool => tool.name === 'web_search');
    const pooled = await search.execute('call', { query: 'react release' });
    assert.equal(pooled.details.provider, 'tavily');
    assert.match(pooled.content[0].text, /Pool answer/);
    assert.deepEqual(server.requests.map(r => r.path), ['/v1/search'], 'the pool answered: no Claude search request');
    pool = 'missing';
    const hosted = await search.execute('call', { query: 'react release' });
    assert.equal(hosted.details.provider, 'claude');
    assert.deepEqual(server.requests.map(r => r.path), ['/v1/search', '/v1/search', '/claude/v1/messages'], 'an older Studio: the provider search tool answers');
    assert.deepEqual(server.requests.at(-1).body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a member\'s next key continues the conversation; another member\'s key only reads it', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')), sessions = path.join(root, 'sessions');
  const api = await import(pathToFileURL(path.join(fs.realpathSync(sdkRoot), 'dist/index.js')));
  const server = await studio(), authority = authorityOf();
  const scopes = managed => managed.session.sessionManager.getEntries().filter(entry => entry.customType === 'agent-watch-scope').map(entry => entry.data.key_id);
  const first = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: broker(authority, { key: 'key-a' }), sessionManager: api.SessionManager.create(root, sessions) });
  await first.session.prompt('started with key A');
  const file = first.session.sessionManager.getSessionFile(); await first.dispose();
  // The key ran out and the member was issued another: same conversation, new key.
  const next = broker(authority, { key: 'key-b', main: 'sol' });
  const continued = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: next, sessionManager: api.SessionManager.open(file) });
  await continued.session.prompt('continue with key B');
  assert.equal(last(continued).stopReason, 'stop', JSON.stringify(last(continued)));
  assert.deepEqual([server.requests.length, server.requests[1].session, scopes(continued)], [2, next.roles.main, ['key-a', 'key-b']]);
  assert.match(JSON.stringify(server.requests[1].body.input), /started with key A[\s\S]*Fixture answer[\s\S]*continue with key B/);
  await continued.dispose();
  // Another member's key on this machine: readable, never run, nothing recorded.
  const other = broker(authority, { key: 'key-c', member: 'member-2' });
  const reopened = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: other, sessionManager: api.SessionManager.open(file) });
  try {
    assert.match(JSON.stringify(reopened.session.messages), /started with key A[\s\S]*continue with key B/);
    await reopened.session.prompt('as someone else');
    assert.match(last(reopened).errorMessage, /this conversation belongs to another member or another Studio \[managed-session-scope-changed\]$/);
    assert.deepEqual([server.requests.length, other.calls.includes('start'), scopes(reopened)], [2, false, ['key-a', 'key-b']]);
  } finally { await reopened.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a warm conversation follows Agent Watch: the member\'s next key continues it, another member\'s key blocks it', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const server = await studio(), authority = authorityOf();
  let revision = 'r1'; const made = [];
  const next = options => { const value = broker(authority, options); made.push(value); return value; };
  let enroll = () => next({ key: 'key-b', main: 'sol', revision: 'r2' });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: next({ key: 'key-a' }), renewBroker: () => enroll(), bindingRevision: () => revision });
  try {
    await managed.session.prompt('with key A');
    revision = 'r2';
    await managed.session.prompt('Agent Watch now holds key B of the same member');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual([made.length, made[0].disposed, server.requests.length, server.requests[1].session], [2, true, 2, made[1].roles.main]);
    await managed.session.prompt('still key B: no new enrollment per message');
    assert.deepEqual([made.length, server.requests.length], [2, 3]);
    revision = 'r3'; enroll = () => next({ key: 'key-c', member: 'member-2', revision: 'r3' });
    await managed.session.prompt('Agent Watch now holds another member\'s key');
    assert.match(last(managed).errorMessage, /\[managed-session-scope-changed\]$/);
    assert.deepEqual([made.length, made[2].calls.includes('start'), server.requests.length], [3, false, 3]);
    revision = 'r4'; enroll = () => next({ key: 'key-a', revision: 'r4' });
    await managed.session.prompt('the member is back');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.equal(server.requests.length, 4);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a subagent that fails tells the main agent why', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  const authority = authorityOf(), agent = broker(authority, { main: 'sol' });
  let release; const held = new Promise(resolve => { release = resolve; });
  let entered; const running = new Promise(resolve => { entered = resolve; });
  const server = await studio((req, res) => {
    if (req.headers['x-session-id'] === agent.roles.research) return refuse(429, 'token_quota_exhausted', true)(req, res);
    entered(); held.then(() => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'gpt-6-sol', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`); });
    return true;
  });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  let prompt;
  try {
    prompt = managed.session.prompt('Research this'); await running;
    await assert.rejects(managed.delegate({ role: 'research', task: 'Find the docs' }),
      new RegExp(`^Error: managed-helper-failed: Agent Watch research subagent: this key's token quota is used up \\[token_quota_exhausted\\] \\(request ${REQUEST}\\)$`));
    assert.equal(managed.helpers.size, 0);
    // A helper can be called again in the same message (a second review after a fix), up to Studio's limit of 8.
    for (let call = 2; call <= 8; call++) await assert.rejects(managed.delegate({ role: 'research', task: 'Try again' }), /^Error: managed-helper-failed: .*\[token_quota_exhausted\]/);
    const children = agent.calls.filter(call => call === 'child').length;
    assert.equal(children, 8);
    await assert.rejects(managed.delegate({ role: 'research', task: 'Once more' }), /^Error: managed-helper-limit: the research subagent already ran 8 times for this user message/);
    assert.equal(agent.calls.filter(call => call === 'child').length, children, 'the ninth is not requested from Studio');
    assert.equal(parseFailure('managed-helper-limit: the review subagent already ran 8 times').kind, 'tool');
    assert.equal(parseFailure('managed-helper-used: the review subagent already ran').kind, 'tool', 'older transcripts');
  } finally { release(); await prompt?.catch(() => {}); await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('each role runs at the level Studio grants it, whatever the member picked', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-'));
  // The Harness fixes main at high and the helpers at low; the member picked medium.
  const authority = authorityOf(), agent = broker(authority, { main: 'sol', helper: 'sol', mainEffort: 'high', helperEffort: 'low' });
  let release; const held = new Promise(resolve => { release = resolve; });
  let entered; const running = new Promise(resolve => { entered = resolve; });
  const efforts = {};
  const server = await studio((req, res, body) => {
    const role = Object.entries(agent.roles).find(([, id]) => id === req.headers['x-session-id'])?.[0];
    efforts[role] = body.reasoning?.effort ?? null;
    if (role !== 'main') return false;
    entered(); held.then(() => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: 'gpt-6-sol', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`); });
    return true;
  });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  let prompt;
  try {
    managed.session.setThinkingLevel('medium');
    prompt = managed.session.prompt('Research this'); await running;
    assert.deepEqual(agent.efforts, ['medium'], 'the member\'s level is what the run is asked for');
    assert.equal(managed.session.thinkingLevel, 'high');
    await managed.delegate({ role: 'research', task: 'Find the docs' });
    assert.deepEqual(efforts, { main: 'high', research: 'low' });
  } finally { release(); await prompt?.catch(() => {}); await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// The common way a task stops: several tool steps in, the account or the key
// hits its limit. "tiếp tục" must then send a history the provider accepts
// (every tool call answered, nothing left of the failed request) on a new run.
for (const provider of ['claude', 'codex']) test(`a ${provider} task that fails between tool steps continues on "tiếp tục"`, { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-failures-')));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'FIXTURE_NOTE\n');
  const authority = authorityOf(), agent = broker(authority, { main: provider === 'claude' ? 'sonnet' : 'sol' });
  let step = 0;
  const server = await studio((req, res, body) => {
    step += 1;
    if (step === 2) return refuse(429, provider === 'claude' ? 'upstream_rate_limited' : 'token_quota_exhausted', provider === 'claude')(req, res);
    if (step !== 1) return false; // step 3: the plain fixture answer
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`), args = JSON.stringify({ path: 'notes.txt' });
    if (provider === 'claude') {
      emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'read', input: {} } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } });
      emit({ type: 'content_block_stop', index: 0 }); emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }); emit({ type: 'message_stop' });
    } else {
      const response = { id: 'resp_fixture', object: 'response', status: 'in_progress', model: body.model, output: [] };
      const item = { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'read', arguments: '', status: 'in_progress' };
      emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: args });
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args, status: 'completed' } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [{ ...item, arguments: args, status: 'completed' }], usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } });
    }
    res.end(); return true;
  });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('Read notes.txt and summarise it');
    assert.equal(last(managed).stopReason, 'error');
    assert.deepEqual(roles(managed).filter(role => role !== 'system'), ['user', 'assistant', 'toolResult', 'assistant']);
    await managed.session.prompt('tiếp tục');
    assert.equal(last(managed).stopReason, 'stop', JSON.stringify(last(managed)));
    assert.deepEqual(agent.calls.filter(call => call === 'start' || call === 'close'), ['start', 'close', 'start', 'close'], 'the continuation is a new run');
    const sent = server.requests[2].body, text = JSON.stringify(sent);
    assert.match(text, /FIXTURE_NOTE/, 'the tool result from before the failure is still there');
    assert.match(text, /tiếp tục/);
    if (provider === 'claude') {
      const uses = sent.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_use').map(part => part.id) : []);
      const results = sent.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_result').map(part => part.tool_use_id) : []);
      assert.deepEqual(uses, results); assert.equal(uses.length, 1);
      if (process.env.SHOW_WIRE) console.log(JSON.stringify(sent.messages.map(message => [message.role, Array.isArray(message.content) ? message.content.map(part => part.type + (part.text ? ':' + part.text.slice(0, 60) : '')) : String(message.content).slice(0, 60)])));
      // The tool result directly follows its call; the new message comes after both.
      const at = sent.messages.findIndex(message => Array.isArray(message.content) && message.content.some(part => part.type === 'tool_use'));
      assert.equal(sent.messages[at + 1].role, 'user'); assert.equal(sent.messages[at + 1].content.some(part => part.type === 'tool_result'), true);
      assert.equal(sent.messages.slice(at + 1).some(message => message.role === 'assistant'), false, 'nothing of the failed request is sent as an answer');
    } else {
      const calls = sent.input.filter(item => item.type === 'function_call').map(item => item.call_id), outputs = sent.input.filter(item => item.type === 'function_call_output').map(item => item.call_id);
      assert.deepEqual(calls, outputs); assert.equal(calls.length, 1);
    }
    assert.doesNotMatch(text, /upstream_rate_limited|token_quota_exhausted|Agent Watch main agent/, 'the failure itself is not replayed to the model');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('only a passing failure after admission is asked again by the turn retry, by code, never by words', async () => {
  const { companyTurnRetryable, enableCompanyTurnRetry } = await import('../packages/piagent-core/managed/turn-retry.mjs');
  const failed = (code) => ({ stopReason: 'error', errorMessage: describeFailure('main', `503 {"error":{"code":"${code}","request_id":"${REQUEST}"}}`) });
  for (const code of ['upstream_interrupted', 'upstream_incomplete', 'upstream_timeout', 'upstream_unavailable', 'connector_unavailable', 'connector_execution_failed', 'inference_unavailable'])
    assert.equal(companyTurnRetryable(failed(code)), true, code);
  assert.equal(companyTurnRetryable({ stopReason: 'error', errorMessage: describeFailure('main', 'fetch failed') }), true, 'Studio unreachable');
  // Words Pi would retry on ("rate limited", "quota", "timeout" in a sentence) do not count here.
  for (const code of ['upstream_rate_limited', 'token_quota_exhausted', 'concurrency_limit', 'authentication_required', 'policy_denied', 'upstream_request_rejected',
    'upstream_policy_refusal', 'request_too_large', 'session_account_unavailable_start_new_session', 'run_state_conflict', 'live_trial_limit_reached', 'operation_unavailable'])
    assert.equal(companyTurnRetryable(failed(code)), false, code);
  assert.equal(companyTurnRetryable({ stopReason: 'aborted', errorMessage: 'Request was aborted' }), false, 'a Stop is never retried');
  assert.equal(companyTurnRetryable({ stopReason: 'error', errorMessage: 'something nobody named' }), false);
  // A Pi without the hook keeps retry off rather than retrying by words.
  const applied = []; const settings = { applyOverrides: (value) => applied.push(value) };
  assert.equal(enableCompanyTurnRetry({}, settings), false); assert.deepEqual(applied, []);
  const session = { _isRetryableError: () => true };
  assert.equal(enableCompanyTurnRetry(session, settings), true);
  assert.equal(session._isRetryableError(failed('upstream_rate_limited')), false);
  assert.deepEqual(applied, [{ retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 } }]);
});
