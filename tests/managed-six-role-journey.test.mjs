import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

const sdkRoot = piSdkRoot();
const supported = process.platform === 'darwin' && fs.existsSync(path.join(sdkRoot, 'dist/index.js'));
const json = value => '```json\n' + JSON.stringify(value) + '\n```';
const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// The real ManagedSession, sandbox and pinned Pi host. Only Studio is a stand-in:
// a local model server that follows a script per role, and a broker that
// grants any role (the real Studio and Agent Watch do not issue advisor or
// general yet). So this proves the repo's side of the flow, not production.
test('a small change stays with main; a large one goes to general in its own clone and main integrates, checks and reviews it', { skip: !supported, timeout: 240000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'six-role-')));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.txt'), 'start\n'); fs.writeFileSync(path.join(project, 'check.sh'), 'grep -q fixed a.txt && test -f feature.txt\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Fixture\n## Checks\n```\nsh check.sh\n```\n');
  git(project, 'init', '-q', '-b', 'main'); git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.test'); git(project, 'add', '-A'); git(project, 'commit', '-qm', 'init');
  const start = git(project, 'rev-parse', 'HEAD');

  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const models = [{ id: 'main-model', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, { id: 'helper-model', provider_model_id: 'claude-opus-5-5', owned_by: 'claude' }];
  const ids = {}, asks = []; let fence = 0;
  const grant = role => { ids[role] ??= randomUUID(); const m = models[role === 'main' ? 0 : 1];
    return { ...authority, run_id: randomUUID(), role_id: ids[role], role, fence: ++fence, provider: 'claude', model_id: m.id, provider_model_id: m.provider_model_id, effort: 'medium', token: `as_run_${ids[role]}_${'x'.repeat(43)}` }; };
  const broker = { async request(action, args = {}) {
    asks.push({ action, ...args });
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, models, harness: { configuration: { main: { model_ids: ['main-model'] }, general: { model_ids: ['helper-model'] }, review: { model_ids: ['helper-model'] }, workflow: { lanes: false, plan: 'off', verify: 'off', review: 'off' } } } };
    if (['start', 'renew', 'child'].includes(action)) return grant(args.role ?? 'main');
    if (action === 'close') return true;
    throw Error('unexpected-broker-action');
  }, async dispose() {} };

  // The script of each role; a step may read the request it answers.
  const seen = {}, requests = [], text = value => typeof value === 'string';
  const script = {
    main: [
      { tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, 'Small change done by main.',                    // turn 1: solo
      { tool: 'delegate', input: { role: 'general', task: 'Add feature.txt containing "fixed feature" and commit it.', target: 'feature.txt', acceptance: 'committed' } }, // turn 2
      body => { const ref = /refs\/general\/[0-9a-f]{8}/.exec(JSON.stringify(body.messages))?.[0]; assert.ok(ref, 'main was told the ref');
        seen.beforeMerge = { head: git(project, 'rev-parse', 'HEAD'), refs: git(project, 'for-each-ref', '--format=%(refname)'), feature: fs.existsSync(path.join(project, 'feature.txt')), told: JSON.stringify(body.messages) };
        return { tool: 'bash', input: { command: `git merge --ff-only ${ref} && git update-ref -d ${ref}` } }; },
      { tool: 'bash', input: { command: 'sh check.sh' } },
      { tool: 'delegate', input: { role: 'review', task: 'Review the integrated change.' } },
      'Integrated, checked and reviewed.',
    ],
    general: [{ tool: 'write', input: { path: 'feature.txt', content: 'fixed feature\n' } }, { tool: 'bash', input: { command: 'git add -A && git commit -qm "Add feature"' } },
      'Added feature.txt and committed it.\n' + json({ brief_issues: [] })],
    review: [json({ findings: [], brief_issues: [], summary: 'fine' })],
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/studio/v1/managed/tool-failures') { res.writeHead(404).end(); return; }
    const body = JSON.parse(Buffer.concat(chunks)), role = Object.keys(ids).find(r => ids[r] === req.headers['x-session-id']);
    requests.push({ role, body });
    let step = script[role].shift() ?? 'Done.'; if (typeof step === 'function') { try { step = step(body); } catch (error) { step = 'STEP FAILED: ' + error.message; seen.error = error; } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'message_start', message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    emit({ type: 'content_block_start', index: 0, content_block: text(step) ? { type: 'text', text: '' } : { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), name: step.tool, input: {} } });
    emit({ type: 'content_block_delta', index: 0, delta: text(step) ? { type: 'text_delta', text: step } : { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
    emit({ type: 'content_block_stop', index: 0 });
    emit({ type: 'message_delta', delta: { stop_reason: text(step) ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
    emit({ type: 'message_stop' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let managed;
  try {
    managed = await ManagedSession.create({ sdkRoot, cwd: project, origin: `http://127.0.0.1:${server.address().port}`, broker });
    managed.session.setThinkingLevel('medium');

    await managed.session.prompt('Change a.txt to say fixed');
    assert.deepEqual(asks.filter(a => a.action === 'child'), [], 'a small change gets no helper');
    assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'fixed\n');

    await managed.session.prompt('Add a feature.txt file with a commit, as a large change for the general helper');
    if (seen.error) throw seen.error;
    // The main agent was offered general and told how it works.
    const mainBody = JSON.stringify(requests.find(r => r.role === 'main').body);
    assert.match(mainBody, /delegate role \\"general\\"/); assert.doesNotMatch(mainBody, /delegate role \\"advisor\\"/);
    assert.deepEqual(asks.filter(a => a.action === 'child').map(a => a.role), ['general', 'review']);

    // General worked, edited and ran git, in a tree that is not the project.
    const general = requests.filter(r => r.role === 'general');
    const tools = general[0].body.tools.map(t => t.name);
    for (const tool of ['write', 'edit', 'bash', 'read']) assert.ok(tools.includes(tool), tool);
    assert.ok(general.length >= 3);
    // Until main merged, the project, its HEAD and its refs were untouched; main was told the ref and what general could not see.
    assert.deepEqual([seen.beforeMerge.head, seen.beforeMerge.feature, seen.beforeMerge.refs], [start, false, 'refs/general/' + /refs\/general\/([0-9a-f]{8})/.exec(seen.beforeMerge.told)[1] + '\nrefs/heads/main']);
    assert.match(seen.beforeMerge.told, /did not see 1 uncommitted path\(s\) in the project \(a\.txt\)/);
    // Main integrated, checked and reviewed; nothing of general's is left over.
    assert.equal(fs.readFileSync(path.join(project, 'feature.txt'), 'utf8'), 'fixed feature\n');
    assert.match(git(project, 'log', '--format=%s', '-1'), /Add feature/);
    assert.equal(git(project, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
    const entries = managed.session.sessionManager.getEntries().filter(e => e.customType === 'agent-watch-general').map(e => e.data);
    assert.deepEqual(entries.map(e => e.status), ['running', 'returned']);
    assert.ok(!fs.existsSync(entries[0].root), 'the clone is gone');
    assert.equal(managed.run?.lastCheck?.ok ?? true, true);
    assert.ok(requests.some(r => r.role === 'review'));
  } finally { await managed?.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});
