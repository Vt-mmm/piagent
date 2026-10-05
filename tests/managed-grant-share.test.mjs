import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';

const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);
const MODELS = { sol: { id: 'gpt-6.1-sol', provider_model_id: 'gpt-6.1-sol', owned_by: 'codex' }, sonnet: { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' } };

// Like Studio, every renew replaces the role's token: a request with an older
// token is refused (invalid_run_grant). The reviewers of a large patch run
// under one review grant (one after another: Studio admits one request of a
// role at a time); none may void another's token.
test('reviewers of a patch in parts each run on a live review grant', { skip: !supported, timeout: 240000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grant-share-')));
  execFileSync('git', ['init', '-q', '-b', 'main', root]); fs.writeFileSync(path.join(root, 'a.txt'), 'start\n');
  execFileSync('git', ['-C', root, 'add', '-A']); execFileSync('git', ['-C', root, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'i']);
  const content = n => Array.from({ length: 850 }, (_, i) => `export const v${n}_${i} = "${'x'.repeat(30)} ${i}";`).join('\n') + '\n';
  for (const n of [1, 2, 3, 4, 5]) fs.writeFileSync(path.join(root, `p${n}.js`), content(n));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const roles = { main: randomUUID(), review: randomUUID() }, latest = {}, renews = { main: 0, review: 0 }, run = randomUUID();
  let fence = 0;
  const grant = (role, model) => { fence += 1; latest[role] = `as_run_${roles[role]}_${String(fence).padStart(43, 'x')}`;
    return { ...authority, run_id: run, role_id: roles[role], role, fence, provider: model.owned_by, model_id: model.id, provider_model_id: model.provider_model_id, effort: 'medium', token: latest[role] }; };
  const broker = { async request(action, args = {}) {
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'k', user: { id: 'm' }, revision: 'r1', models: [MODELS.sol, MODELS.sonnet],
      harness: { configuration: { main: { model_ids: [MODELS.sol.id] }, review: { model_ids: [MODELS.sonnet.id] } } } };
    if (action === 'start') return grant('main', MODELS.sol);
    if (action === 'child') return grant('review', MODELS.sonnet);
    if (action === 'renew') { renews[args.role ?? 'main'] += 1; return args.role === 'review' ? grant('review', MODELS.sonnet) : grant('main', MODELS.sol); }
    if (action === 'close') return true;
    throw Error('unexpected ' + action);
  }, async dispose() {} };
  let entered, release; const mainEntered = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const refused = [], reviews = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)), role = Object.keys(roles).find(r => roles[r] === req.headers['x-session-id']);
    const token = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '').replace(/^Bearer /, '');
    if (token !== latest[role]) { refused.push(role); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'invalid_run_grant', message: 'invalid_run_grant', request_id: randomUUID() } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (role === 'main') { entered(); await held; const response = { id: 'r', object: 'response', status: 'completed', model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; emit({ type: 'response.completed', response }); res.end(); return; }
    reviews.push(JSON.stringify(body.messages));
    // A reviewer takes a moment, so the parts overlap.
    await new Promise(r => setTimeout(r, 300));
    emit({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fine.\n```json\n{"findings":[],"summary":"ok"}\n```' } });
    emit({ type: 'content_block_stop', index: 0 }); emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }); emit({ type: 'message_stop' }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: `http://127.0.0.1:${server.address().port}`, broker });
  let prompt;
  try {
    prompt = managed.session.prompt('Review the new modules'); await mainEntered;
    const result = await managed.delegate({ role: 'review', task: 'Review the patch' });
    assert.equal(result.details.parts, 3, 'the patch was reviewed in parts');
    assert.equal(reviews.length, 3, 'one reviewer request per part');
    assert.deepEqual(refused, [], 'no reviewer voided another one\'s grant');
    assert.ok(renews.review <= 3, `review renewals: ${renews.review}`);
  } finally { release(); await prompt?.catch(() => {}); await managed.dispose(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); }
});
