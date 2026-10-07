import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession, taskClass } from '../packages/piagent-core/managed/session.mjs';
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');

test('short prompts do not require helpers or a workflow', () => {
  for (const text of ['alo 123', 'hi', 'hello', '2 + 2?', 'cảm ơn']) assert.equal(taskClass(text), 'simple');
  assert.equal(taskClass('Review the current patch'), 'standard');
  for(const text of ['sua loi','sửa lỗi','kiểm tra','kiem tra'])assert.equal(taskClass(text),'standard');
  for(const text of ['debug deadlock','sua loi race condition','kiến trúc','bao mat'])assert.equal(taskClass(text),'complex');
});

test('isolated SDK session sends native Claude/Codex streams with role tokens and native context', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-managed-session-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ path: req.url, body, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (req.url.endsWith('/responses')) {
      const response = { id: 'resp_fixture', object: 'response', status: 'in_progress', model: body.model, output: [] };
      emit({ type: 'response.created', response });
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Local fixture OK' });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'Local fixture OK', annotations: [] }] } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } });
    } else {
      emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Local fixture OK' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      emit({ type: 'message_stop' });
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const models = [{ id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex', max_output_tokens:16384 }, { id: 'claude-opus-5-5', provider_model_id: 'claude-opus-5-5', owned_by: 'claude', max_output_tokens:16384 }, { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }];
  try {
    for (const m of models) {
      const calls = [], roleID = randomUUID(), runID = randomUUID(), profileID = randomUUID(); let fence = 0;
      const grant = () => ({ ...authority, run_id: runID, role_id: roleID, role: 'main', fence: ++fence, provider: m.owned_by,
        model_id: m.id, provider_model_id: m.id, profile_id: profileID, effort: 'medium', token: `as_run_${roleID}_${'x'.repeat(43)}` });
      const broker = { async request(action) {
        calls.push(action);
        if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, models, harness: { configuration: { main: { model_ids: [m.id] } } } };
        if (action === 'start' || action === 'renew') return grant();
        if (action === 'close') return true;
        throw Error('unexpected helper');
      }, async dispose() {} };
      const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: `http://127.0.0.1:${server.address().port}`, broker });
      try {
        assert.equal(managed.session.model.name, 'agent-watch-auto');
        assert.equal(managed.session.model.contextWindow, m.owned_by === 'claude' ? 1000000 : 272000);
        assert.equal(managed.session.model.maxTokens, m.owned_by==='claude'&&m.max_output_tokens?m.max_output_tokens:128000);
        managed.session.setThinkingLevel('medium');
        await managed.session.prompt('alo 123');
        const last = managed.session.messages.at(-1);
        assert.equal(last.stopReason, 'stop', JSON.stringify(last));
        assert.match(JSON.stringify(last.content), /Local fixture OK/);
        assert.deepEqual(calls, ['config', 'start', 'renew', 'close']);
        const wire = requests.at(-1);
        assert.equal(wire.path.split('?')[0], m.owned_by === 'claude' ? '/claude/v1/messages' : '/v1/responses');
        assert.equal(wire.body.model, m.id);
        if(m.owned_by==='claude'&&m.max_output_tokens) assert.ok(wire.body.max_tokens<=m.max_output_tokens);
        if(m.owned_by==='codex') assert.equal(wire.body.max_output_tokens,undefined);
        assert.equal(m.owned_by === 'claude' ? wire.body.messages.at(-1).output_config?.effort : wire.body.reasoning?.effort, 'medium');
        assert.equal(wire.headers['x-session-id'], roleID);
        assert.match(wire.headers.authorization, /^Bearer as_run_/);
        assert.equal(JSON.stringify(wire.body).includes('/task'), false);
        assert.throws(() => managed.session.setModel({ provider: 'openai-codex', id: 'gpt-6-sol' }), /new-session/);
        // A long conversation compacts itself inside the turn. Pi's compaction
        // resolves the provider's own auth headers (the registered placeholder
        // key) and passes them in; the role token must still reach Studio.
        const settings = managed.session.settingsManager, compaction = settings.getCompactionSettings.bind(settings);
        settings.getCompactionSettings = model => ({ ...compaction(model), keepRecentTokens: 1, reserveTokens: model.contextWindow - 1 });
        const before = requests.length;
        await managed.session.prompt('alo 456');
        const summary = requests.slice(before).find(r => r.headers['x-agent-purpose'] === 'summary');
        assert.ok(summary, 'the turn compacted its context');
        assert.match(summary.headers.authorization, /^Bearer as_run_/);
        assert.ok(requests.slice(before).every(r => /^Bearer as_run_/.test(r.headers.authorization)));
        assert.equal(managed.session.messages.some(m => m.role === 'compactionSummary'), true);
      } finally { await managed.dispose(); }
    }
    assert.equal(requests.filter(r => r.headers['x-agent-purpose'] !== 'summary').length, 6);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
