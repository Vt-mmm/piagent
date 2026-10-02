import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';

// Long tasks: a company conversation shrinks by summary before it outgrows the
// model it runs on, including after the harness moved it to a model with a
// smaller window, and after the model refused a request as too long.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);
const WINDOW = { 'gpt-6-sol': 272000, 'claude-sonnet-5-5': 1000000 };
const SUMMARY = /context summarization assistant/;

// A Studio whose models count `perToken` characters as one token (Pi
// estimates four; Vietnamese and code are denser), report that as usage, and
// refuse (as the connector does) a request larger than their window. Studio
// itself refuses a body over 4 MiB.
async function studio(perToken = 4) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw), tokens = Math.ceil(raw.length / perToken);
    const summary = SUMMARY.test(raw), n = requests.push({ model: body.model, tokens, summary, previous: raw.includes('<previous-summary>'), raw: summary ? raw : null });
    if (raw.length > 4 << 20) {
      requests[n - 1].refused = 'studio';
      res.writeHead(413, { 'Content-Type': 'application/json', 'X-Should-Retry': 'false' });
      res.end(JSON.stringify({ error: { code: 'request_too_large', message: 'request_too_large', request_id: randomUUID() } })); return;
    }
    if (tokens > WINDOW[body.model]) {
      // Studio's own error body, the same on both routes.
      requests[n - 1].refused = true;
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Should-Retry': 'false' });
      res.end(JSON.stringify({ error: { code: 'upstream_request_rejected', message: 'upstream_request_rejected', request_id: randomUUID() } })); return;
    }
    const text = summary ? `SUMMARY_${n}` : `ANSWER_${n}`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (req.url.endsWith('/responses')) {
      const response = { id: `resp_${n}`, object: 'response', status: 'in_progress', model: body.model, output: [] }, item = { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: tokens, output_tokens: 20, total_tokens: tokens + 20 } } });
    } else {
      emit({ type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: tokens, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
      emit({ type: 'message_stop' });
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

const MODELS = { sonnet: { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, sol: { id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex' } };
function broker(authority, main, revision = 'r1') {
  const calls = [], role = randomUUID(); let fence = 0;
  return { calls, async request(action) {
    calls.push(action);
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key-a', user: { id: 'member-1' }, revision,
      models: Object.values(MODELS), harness: { configuration: { main: { model_ids: [MODELS[main].id] } } } };
    if (action === 'close') return true;
    const model = MODELS[main];
    return { ...authority, run_id: randomUUID(), role_id: role, role: 'main', fence: ++fence, provider: model.owned_by, model_id: model.id, provider_model_id: model.provider_model_id,
      effort: 'medium', token: `as_run_${role}_${'x'.repeat(43)}` };
  }, async dispose() {} };
}
const authorityOf = () => ({ studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 });
const words = (label, tokens) => `${label} ` + 'lorem ipsum dolor sit amet '.repeat(Math.ceil(tokens * 4 / 27));
const compactions = managed => managed.session.sessionManager.getEntries().filter(entry => entry.type === 'compaction');
const answers = managed => managed.session.messages.filter(message => message.role === 'assistant');

test('a conversation near the window is summarised inside its run and goes on', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-compaction-')), server = await studio(), agent = broker(authorityOf(), 'sol');
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt(words('first', 150000));
    assert.equal(compactions(managed).length, 0);
    await managed.session.prompt(words('second', 110000));
    // 260k of 272k: summarised before the run closed, with that run's grant.
    assert.equal(compactions(managed).length, 1);
    assert.deepEqual(server.requests.map(request => request.summary), [false, false, true]);
    assert.deepEqual(agent.calls, ['config', 'start', 'renew', 'close', 'start', 'renew', 'renew', 'close']);
    await managed.session.prompt('third');
    assert.equal(answers(managed).at(-1).stopReason, 'stop');
    assert.ok(server.requests.at(-1).tokens < 150000, 'the older part is now a summary');
    assert.ok(!server.requests.some(request => request.refused));
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a history longer than the new harness model\'s window is summarised in parts', { skip: !supported, timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-compaction-')), server = await studio(), authority = authorityOf();
  let revision = 'r1', current = broker(authority, 'sonnet');
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: current, renewBroker: () => current, bindingRevision: () => revision });
  try {
    // 375k tokens on a 1M-token model: nothing to summarise yet.
    for (let turn = 1; turn <= 5; turn++) await managed.session.prompt(words(`turn ${turn}`, 75000));
    assert.equal(compactions(managed).length, 0);
    assert.ok(server.requests.at(-1).tokens > 300000);
    // The harness moves to a 272k model. One summary request of the older
    // 300k would be refused; parts that fit are summarised one after another.
    revision = 'r2'; current = broker(authority, 'sol', revision);
    await managed.session.prompt('continue on the new model');
    assert.equal(compactions(managed).length, 1);
    const summaries = server.requests.filter(request => request.summary);
    assert.ok(summaries.length >= 3, `summarised in ${summaries.length} parts`);
    assert.ok(summaries.every(request => request.model === 'gpt-6-sol' && request.tokens < 272000 && !request.refused));
    assert.deepEqual(summaries.map(request => request.previous), summaries.map((_, index) => index > 0), 'each part updates the summary of the parts before');
    assert.match(summaries[1].raw, /SUMMARY_\d+/);
    assert.match(summaries[0].raw, /turn 1/); assert.match(summaries.at(-1).raw, /turn 4/);
    assert.match(compactions(managed)[0].summary, /^SUMMARY_\d+/);
    assert.equal(answers(managed).at(-1).stopReason, 'stop', answers(managed).at(-1).errorMessage);
    assert.equal(server.requests.at(-1).model, 'gpt-6-sol');
    assert.ok(!server.requests.some(request => request.refused));
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a request refused as too long is followed by a summary; continuing goes on', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-compaction-')), server = await studio(), agent = broker(authorityOf(), 'sol');
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt(words('first', 150000));
    // One more large message inside a turn: 300k tokens do not fit the 272k window.
    await managed.session.prompt(words('second', 150000));
    assert.equal(server.requests[1].refused, true);
    assert.match(answers(managed).at(-1).errorMessage, /\[upstream_request_rejected\]/);
    // Pi's estimate is past the threshold: the older part is summarised in the same run.
    assert.equal(compactions(managed).length, 1);
    await managed.session.prompt('continue');
    assert.equal(compactions(managed).length, 1, 'no second summary');
    assert.equal(answers(managed).at(-1).stopReason, 'stop', answers(managed).at(-1).errorMessage);
    assert.deepEqual(server.requests.map(request => [request.summary, Boolean(request.refused)]), [[false, false], [false, true], [true, false], [false, false]]);
    assert.match(JSON.stringify(managed.session.messages.filter(message => message.role === 'user').map(message => message.content)), /second[\s\S]*continue/, 'the refused message is kept');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('dense text the estimate undercounts: continuing after the refusal summarises first', { skip: !supported, timeout: 120000 }, async () => {
  // Three characters per token: Pi's estimate stays under its threshold.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-compaction-')), server = await studio(3), agent = broker(authorityOf(), 'sol');
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt(words('first', 105000));
    await managed.session.prompt(words('second', 105000));
    assert.equal(server.requests[1].refused, true);
    assert.equal(compactions(managed).length, 0, 'Pi did not see it coming');
    await managed.session.prompt('continue');
    assert.equal(compactions(managed).length, 1);
    assert.equal(answers(managed).at(-1).stopReason, 'stop', answers(managed).at(-1).errorMessage);
    assert.deepEqual(server.requests.map(request => [request.summary, Boolean(request.refused)]), [[false, false], [false, true], [true, false], [false, false]]);
    assert.deepEqual(agent.calls, ['config', 'start', 'renew', 'close', 'start', 'renew', 'close', 'start', 'renew', 'renew', 'close'], 'the summary is part of the continuing run');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a body over Studio\'s 4 MiB before a 1M-token window is full: continuing summarises first', { skip: !supported, timeout: 120000 }, async () => {
  // JSON-heavy history (escaped code, tool calls): five bytes per token, so
  // the body passes 4 MiB near 840k tokens, before Pi's threshold (984k).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-compaction-')), server = await studio(5), agent = broker(authorityOf(), 'sonnet');
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt(words('first', 550000));
    await managed.session.prompt(words('second', 500000));
    assert.equal(server.requests[1].refused, 'studio');
    assert.match(answers(managed).at(-1).errorMessage, /\[request_too_large\]/);
    assert.equal(compactions(managed).length, 0, 'far from the model\'s window');
    await managed.session.prompt('continue');
    assert.equal(compactions(managed).length, 1);
    assert.equal(answers(managed).at(-1).stopReason, 'stop', answers(managed).at(-1).errorMessage);
    assert.deepEqual(server.requests.map(request => [request.summary, request.refused ?? false]), [[false, false], [false, 'studio'], [true, false], [false, false]]);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unfinished plan is kept word for word through a summary', { skip: !supported, timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-compaction-')), server = await studio(), agent = broker(authorityOf(), 'sol');
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt(words('first', 150000));
    managed.session.sessionManager.appendCustomEntry('agent-watch-plan', { plan: [{ step: 'Migrate the cart schema', status: 'completed' }, { step: 'Backfill old orders', status: 'in_progress' }], explanation: '' });
    await managed.session.prompt(words('second', 110000));
    const [compaction] = compactions(managed);
    assert.match(compaction.summary, /Current plan \(kept verbatim[^\n]*\n1\. \[x\] Migrate the cart schema\n2\. \[>\] Backfill old orders$/);
    // A finished plan is not added again (an earlier summary may still mention it).
    managed.session.sessionManager.appendCustomEntry('agent-watch-plan', { plan: [{ step: 'Backfill old orders', status: 'completed' }], explanation: '' });
    await managed.session.prompt(words('third', 150000)); await managed.session.prompt(words('fourth', 110000));
    assert.ok(compactions(managed).length >= 2);
    assert.doesNotMatch(compactions(managed).at(-1).summary, /Current plan \(kept verbatim[^\n]*\n1\. \[x\] Backfill old orders/);
    assert.doesNotMatch(compactions(managed).at(-1).summary, /Backfill old orders\s*$/);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
