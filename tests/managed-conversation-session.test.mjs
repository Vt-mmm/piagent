import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {ManagedSession} from '../packages/piagent-core/managed/session.mjs';

// Studio binds a conversation to one company account; the provider's prompt
// cache lives there (Claude) or follows prompt_cache_key (Codex). The main
// agent names its conversation on every turn, although each turn is a new
// run with a new role. When Studio says the account is gone, the next
// generation of the name lets it bind the conversation elsewhere.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');

test('turns of one conversation share its session name; a gone account moves it once', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 60000}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-conversation-')));
  const requests = []; let refuseNext = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({headers: req.headers, body});
    if (refuseNext) {
      refuseNext = false;
      res.writeHead(409, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: {code: 'session_account_unavailable_start_new_session', message: 'session_account_unavailable_start_new_session'}}));
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const response = {id: `resp_${requests.length}`, object: 'response', status: 'in_progress', model: body.model, output: []};
    const item = {id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'OK', annotations: []}]};
    emit({type: 'response.created', response});
    emit({type: 'response.output_item.added', output_index: 0, item: {...item, content: [], status: 'in_progress'}});
    emit({type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: {type: 'output_text', text: '', annotations: []}});
    emit({type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK'});
    emit({type: 'response.output_item.done', output_index: 0, item});
    emit({type: 'response.completed', response: {...response, status: 'completed', output: [item], usage: {input_tokens: 10, output_tokens: 1, total_tokens: 11}}});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authority = {studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1};
  const models = [{id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex'}];
  // Like Studio: every run has its own main role.
  let roleID = null, runID = null, fence = 0;
  const grant = () => ({...authority, run_id: runID, role_id: roleID, role: 'main', fence: ++fence, provider: 'codex', model_id: 'gpt-6-sol',
    provider_model_id: 'gpt-6-sol', profile_id: randomUUID(), effort: 'medium', token: `as_run_${roleID}_${String(fence).padStart(43, 'x')}`});
  const broker = {async request(action) {
    if (action === 'config') return {schema_version: 2, credential_mode: 'managed', authority, models, harness: {configuration: {main: {model_ids: ['gpt-6-sol']}}}};
    if (action === 'start') { roleID = randomUUID(); runID = randomUUID(); return grant(); }
    if (action === 'renew') return grant();
    if (action === 'close') return true;
    throw Error('unexpected ' + action);
  }, async dispose() {}};
  const managed = await ManagedSession.create({sdkRoot, cwd: root, origin: `http://127.0.0.1:${server.address().port}`, broker});
  try {
    managed.session.setThinkingLevel('medium');
    const conversation = managed.session.sessionManager.getSessionId();
    await managed.session.prompt('first');
    await managed.session.prompt('second');
    assert.equal(requests.length, 2);
    const [a, b] = requests;
    assert.notEqual(a.headers['x-session-id'], b.headers['x-session-id'], 'each turn is its own run role');
    for (const r of [a, b]) {
      assert.equal(r.headers['x-claude-code-session-id'], conversation);
      assert.equal(r.body.prompt_cache_key, conversation, 'Codex keys its cache by the conversation');
    }
    // The account went away: the turn is asked again once under the next generation, and later turns keep it.
    refuseNext = true;
    await managed.session.prompt('third');
    await managed.session.prompt('fourth');
    assert.match(JSON.stringify(managed.session.messages.at(-1).content), /OK/);
    assert.equal(requests.length, 5);
    assert.equal(requests[2].headers['x-claude-code-session-id'], conversation);
    assert.equal(requests[3].headers['x-claude-code-session-id'], `${conversation}-1`);
    assert.equal(requests[4].headers['x-claude-code-session-id'], `${conversation}-1`);
    assert.equal(requests[4].body.prompt_cache_key, `${conversation}-1`);
  } finally { await managed.dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true}); }
});
