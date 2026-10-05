import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {ManagedSession} from '../packages/piagent-core/managed/session.mjs';

// One company turn where the model searches the web: the company search pool
// is asked first; this Studio has none, so the search is a separate Studio
// request with the provider's search tool. The answer returns to the model as
// a tool result, and the project's AGENTS.md is in the instructions.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');

test('a company turn can search the web through Studio and sees the project instructions', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 60000}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-web-tools-')));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Shop\nUse pnpm for every package command.\n');
  const requests = [], pool = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    // A Studio without the company search pool: the role's own search tool answers.
    if (req.url === '/v1/search') { pool.push({body, headers: req.headers}); res.writeHead(404, {'Content-Type': 'application/json'}); res.end('{"error":{"code":"not_found"}}'); return; }
    requests.push({path: req.url, body, headers: req.headers});
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const response = {id: `resp_${requests.length}`, object: 'response', status: 'in_progress', model: body.model, output: []};
    emit({type: 'response.created', response});
    let item;
    if (requests.length === 1) {
      item = {id: 'fc_search', type: 'function_call', call_id: 'call_search', name: 'web_search', arguments: '{"query":"current Node.js LTS"}', status: 'completed'};
      emit({type: 'response.output_item.added', output_index: 0, item: {...item, arguments: '', status: 'in_progress'}});
      emit({type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments});
      emit({type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments});
    } else {
      const answer = requests.length === 2 ? 'Node.js 24 is the active LTS.' : 'SEARCH_USED_OK';
      item = {id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{type: 'output_text', text: answer, annotations: requests.length === 2 ? [{type: 'url_citation', url: 'https://nodejs.org/en/about/previous-releases', title: 'Node.js releases'}] : []}]};
      emit({type: 'response.output_item.added', output_index: 0, item: {...item, content: [], status: 'in_progress'}});
      emit({type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: {type: 'output_text', text: '', annotations: []}});
      emit({type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer});
    }
    emit({type: 'response.output_item.done', output_index: 0, item});
    emit({type: 'response.completed', response: {...response, status: 'completed', output: [item], usage: {input_tokens: 10, output_tokens: 3, total_tokens: 13}}});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authority = {studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1}, roleID = randomUUID(), runID = randomUUID();
  const models = [{id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex'}];
  const calls = []; let fence = 0;
  const grant = () => ({...authority, run_id: runID, role_id: roleID, role: 'main', fence: ++fence, provider: 'codex', model_id: 'gpt-6-sol',
    provider_model_id: 'gpt-6-sol', profile_id: randomUUID(), effort: 'medium', token: `as_run_${roleID}_${'x'.repeat(43)}`});
  const broker = {async request(action) {
    calls.push(action);
    if (action === 'config') return {schema_version: 2, credential_mode: 'managed', authority, models, harness: {configuration: {main: {model_ids: ['gpt-6-sol']}, review: {model_ids: ['gpt-6-sol']}}}};
    if (action === 'start' || action === 'renew') return grant();
    if (action === 'close') return true;
    throw Error('unexpected ' + action);
  }, async dispose() {}};
  const managed = await ManagedSession.create({sdkRoot, cwd: root, origin: `http://127.0.0.1:${server.address().port}`, broker});
  try {
    managed.session.setThinkingLevel('medium');
    await managed.session.prompt('What is the current Node.js LTS?');
    assert.match(JSON.stringify(managed.session.messages.at(-1).content), /SEARCH_USED_OK/);
    assert.equal(requests.length, 3);
    const offered = requests[0].body.tools.map((tool) => tool.name).filter(Boolean).sort();
    for (const name of ['bash', 'delegate', 'edit', 'fetch_origin', 'find', 'grep', 'ls', 'read', 'run_with_network', 'web_fetch', 'web_search', 'write'])
      assert.ok(offered.includes(name), `${name} offered: ${offered}`);
    const system = String(requests[0].body.input.find((message) => message.role === 'developer')?.content ?? '');
    assert.match(system, /<project_instructions path="[^"]*AGENTS\.md">\n# Shop\nUse pnpm for every package command\./);
    assert.match(system, /use web_search for current information/);
    // The company search pool is asked first, with the run token and role.
    assert.equal(pool.length, 1);
    assert.deepEqual([pool[0].body.query, pool[0].headers['x-session-id'], /^Bearer as_run_/.test(pool[0].headers.authorization)], ['current Node.js LTS', roleID, true]);
    // Every company request names Piagent and its version to Studio.
    const agent = `piagent/${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version}`;
    assert.deepEqual([pool[0].headers['user-agent'], ...new Set(requests.map((r) => r.headers['user-agent']))], [agent, agent]);
    // The search itself: the provider's tool, the grant's model/effort and run token.
    assert.deepEqual(requests[1].body.tools, [{type: 'web_search'}]);
    assert.deepEqual([requests[1].path, requests[1].body.model, requests[1].body.reasoning], ['/v1/responses', 'gpt-6-sol', {effort: 'medium'}]);
    assert.match(requests[1].headers.authorization, /^Bearer as_run_/);
    assert.equal(requests[1].headers['x-session-id'], roleID);
    const toolOutput = JSON.stringify(requests[2].body.input);
    assert.match(toolOutput, /Node\.js 24 is the active LTS/);
    assert.match(toolOutput, /https:\/\/nodejs\.org\/en\/about\/previous-releases/);
    assert.deepEqual(calls.filter((action) => action === 'renew').length, 3, 'two model calls and one search, each on a fresh grant');
  } finally { await managed.dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true}); }
});

// Each renew replaces the role's token. Two searches the model asks for in
// one reply run side by side; a renew of their own would void the first
// one's token before Studio admits it (seen live: the first search of a pair
// lost Codex and fell to the next source). They share one renew instead.
test('searches running side by side share one grant renew', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 60000}, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-web-pair-')));
  const requests = [], pool = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/v1/search') {
      pool.push({body, headers: req.headers});
      await new Promise((resolve) => setTimeout(resolve, 300));
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({provider: 'codex', answer: `Answer for ${body.query}`, results: [{title: 'Source', url: 'https://example.com/' + pool.length}], credits: 0, attempts: 1}));
      return;
    }
    requests.push({path: req.url, body, headers: req.headers});
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const emit = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const response = {id: `resp_${requests.length}`, object: 'response', status: 'in_progress', model: body.model, output: []};
    emit({type: 'response.created', response});
    const items = requests.length === 1
      ? ['Go 1.24 release date', 'Node.js 24 codename'].map((query, i) => ({id: `fc_${i}`, type: 'function_call', call_id: `call_${i}`, name: 'web_search', arguments: JSON.stringify({query}), status: 'completed'}))
      : [{id: 'msg_final', type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'PAIR_OK', annotations: []}]}];
    items.forEach((item, index) => {
      if (item.type === 'function_call') {
        emit({type: 'response.output_item.added', output_index: index, item: {...item, arguments: '', status: 'in_progress'}});
        emit({type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments});
        emit({type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments});
      } else {
        emit({type: 'response.output_item.added', output_index: index, item: {...item, content: [], status: 'in_progress'}});
        emit({type: 'response.content_part.added', item_id: item.id, output_index: index, content_index: 0, part: {type: 'output_text', text: '', annotations: []}});
        emit({type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: 'PAIR_OK'});
      }
      emit({type: 'response.output_item.done', output_index: index, item});
    });
    emit({type: 'response.completed', response: {...response, status: 'completed', output: items, usage: {input_tokens: 10, output_tokens: 3, total_tokens: 13}}});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authority = {studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1}, roleID = randomUUID(), runID = randomUUID();
  const models = [{id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', owned_by: 'codex'}];
  const calls = []; let fence = 0;
  // Like Studio: each renew is a new token.
  const grant = () => { fence++; return {...authority, run_id: runID, role_id: roleID, role: 'main', fence, provider: 'codex', model_id: 'gpt-6-sol',
    provider_model_id: 'gpt-6-sol', profile_id: randomUUID(), effort: 'medium', token: `as_run_${roleID}_${String(fence).padStart(43, 'x')}`}; };
  const broker = {async request(action) {
    calls.push(action);
    if (action === 'config') return {schema_version: 2, credential_mode: 'managed', authority, models, harness: {configuration: {main: {model_ids: ['gpt-6-sol']}, review: {model_ids: ['gpt-6-sol']}}}};
    if (action === 'start' || action === 'renew') return grant();
    if (action === 'close') return true;
    throw Error('unexpected ' + action);
  }, async dispose() {}};
  const managed = await ManagedSession.create({sdkRoot, cwd: root, origin: `http://127.0.0.1:${server.address().port}`, broker});
  try {
    managed.session.setThinkingLevel('medium');
    await managed.session.prompt('Two facts, please.');
    assert.match(JSON.stringify(managed.session.messages.at(-1).content), /PAIR_OK/);
    assert.equal(pool.length, 2);
    assert.deepEqual(pool.map((p) => p.body.query).sort(), ['Go 1.24 release date', 'Node.js 24 codename']);
    assert.equal(pool[0].headers.authorization, pool[1].headers.authorization, 'both searches carry the one live token');
    assert.equal(calls.filter((action) => action === 'renew').length, 3, 'two model calls and one renew shared by the two searches');
    assert.match(JSON.stringify(requests[1].body.input), /Searched with OpenAI's web search on a company Codex account\./);
    assert.match(JSON.stringify(requests[1].body.input), /Answer for Go 1\.24 release date[\s\S]*Answer for Node\.js 24 codename|Answer for Node\.js 24 codename[\s\S]*Answer for Go 1\.24 release date/);
  } finally { await managed.dispose(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, {recursive: true, force: true}); }
});
