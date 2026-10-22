import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// `piagent studio --rpc`: a client plays the member over Pi's RPC protocol
// (the long-task soak lane drives the company Terminal this way): several
// messages in one conversation, and ask_user arrives as an extension UI
// select the client answers.
const sdkRoot = piSdkRoot();
test('studio --rpc carries one company conversation across messages and answers ask_user through the client', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 120000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-studio-rpc-'))), project = path.join(root, 'project'); fs.mkdirSync(project);
  execFileSync('/usr/bin/git', ['init', '-q', project]);
  const roleID = randomUUID(), authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }, requests = [];
  const models = [{ id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude', max_output_tokens: 16384 }];
  const manifest = { schema_version: 2, credential_mode: 'managed', authority, key_id: randomUUID(), models, harness: { configuration: { main: { model_ids: [models[0].id] } } } };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url === '/v1/capabilities') { res.writeHead(404); return res.end(); }
    if (!req.url.includes('/messages')) { res.writeHead(204); return res.end(); }
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    emit({ type: 'message_start', message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
    const sent = JSON.stringify(body.messages.filter(m => m.role !== 'system').at(-1));
    if (requests.length === 1) {
      const input = { questions: [{ header: 'Gói', question: 'Which plan should the price use?', options: [{ label: 'Basic' }, { label: 'Pro' }] }] };
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ask', name: 'ask_user', input: {} } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } });
    } else {
      const text = requests.length === 2 ? (sent.includes('2. Pro') ? 'CHOSE_PRO' : 'NO_ANSWER') : sent.includes('second message') ? 'SECOND_OK' : 'LOST_MESSAGE';
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
    }
    emit({ type: 'message_stop' }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const profileID = createHash('sha256').update(root).digest('hex'), sessions = path.join(os.homedir(), 'Library/Application Support/AgentWatch/ManagedSessions', profileID);
  let child;
  try {
    const broker = path.join(root, 'broker');
    fs.writeFileSync(broker, `#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},authority=${JSON.stringify(authority)};let fence=0;for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line),m=manifest.models[0];process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...authority,run_id:'${randomUUID()}',role_id:'${roleID}',role:q.role??'main',fence:++fence,token:'as_run_${roleID}_'+String(fence).padStart(43,'0'),provider:m.owned_by,model_id:m.id,provider_model_id:m.id,effort:q.effort??'medium'}})+'\\n');}`, { mode: 0o700 });
    const entry = fs.realpathSync(path.resolve('scripts/piagent-studio.mjs')), node = fs.realpathSync(process.execPath), hash = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, model: 'agent-watch-auto', profile_id: profileID, origin: `http://127.0.0.1:${server.address().port}`, node, entrypoint: entry, node_sha256: hash(node), entrypoint_sha256: hash(entry), sdk_root: sdkRoot, broker, broker_sha256: hash(broker) }));
    child = spawn(node, [entry, '--config', file, '--project', project, '--rpc'], { env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [], waiters = [];
    let buffer = '', stderr = '';
    child.stderr.on('data', d => stderr += d);
    child.stdout.on('data', d => {
      buffer += d;
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line); events.push(event);
        if (event.type === 'extension_ui_request' && event.method === 'select') {
          const pick = event.options.find(o => o.includes('Pro'));
          child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, value: pick }) + '\n');
        }
        for (const w of [...waiters]) if (w.match(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
      }
    });
    const exited = new Promise(r => child.once('exit', r));
    const next = (match, what) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`timeout waiting for ${what}: ${stderr.slice(-500)}`)), 60000);
      waiters.push({ match, resolve: e => { clearTimeout(timer); resolve(e); } });
    });
    const send = command => child.stdin.write(JSON.stringify(command) + '\n');
    const text = () => JSON.stringify(events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message.content));

    let settled = next(e => e.type === 'agent_settled', 'first settle');
    send({ id: 'p1', type: 'prompt', message: 'Price the order' });
    await settled;
    assert.ok(events.some(e => e.type === 'response' && e.id === 'p1' && e.success), stderr);
    assert.ok(events.some(e => e.type === 'extension_ui_request' && e.method === 'select' && e.title.includes('Which plan')), 'ask_user reached the client');
    assert.match(text(), /CHOSE_PRO/);
    assert.ok(events.some(e => e.type === 'managed_turn_end'), 'the company turn end is in the stream');

    settled = next(e => e.type === 'agent_settled', 'second settle');
    send({ id: 'p2', type: 'prompt', message: 'This is the second message' });
    await settled;
    assert.match(text(), /SECOND_OK/);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].messages.filter(m => m.role === 'user').length >= 2, true, 'the second message continues the same conversation');

    child.stdin.end();
    assert.equal(await exited, 0, stderr);
    child = null;
  } finally {
    child?.kill('SIGKILL');
    await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(sessions, { recursive: true, force: true });
  }
});
