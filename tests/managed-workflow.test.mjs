import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { workflowPolicy, declaredChecks, detectedChecks, repositoryChecks, isCheckCommand, normalizePlan, planText, planTool, reviewFindings, workflowPrompt, RunProcess } from '../packages/piagent-core/managed/workflow.mjs';
import { parseFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';

// The Harness workflow: a plan for multi-step work, the repository's checks
// after a code change, an independent review of the final patch. "require"
// is enforced by the harness before a code-changing turn ends.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);

test('policy, checks and review findings are read conservatively', () => {
  assert.deepEqual(workflowPolicy({ harness: { configuration: { main: {}, review: { model_ids: ['r'] } } } }), { plan: 'suggest', verify: 'suggest', review: 'suggest', maxFixLoops: 2 });
  // No review helper: review is off whatever the policy says; unknown values fall back.
  assert.deepEqual(workflowPolicy({ harness: { configuration: { main: {}, workflow: { plan: 'always', verify: 'require', review: 'require', max_fix_loops: 9 } } } }), { plan: 'suggest', verify: 'require', review: 'off', maxFixLoops: 2 });
  const agents = [{ content: '# Repo\n## Checks\n```sh\nnpm test\n# a comment\nnpm run typecheck\n```\n- `go test ./...`\n## Other\n```\nrm -rf /\n```' }];
  assert.deepEqual(declaredChecks(agents), ['npm test', 'npm run typecheck', 'go test ./...']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc', build: 'vite build' } }));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    assert.deepEqual(detectedChecks(dir), ['npm run typecheck', 'npm test', 'go vet ./...', 'go test ./...']);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(detectedChecks(dir)[0], 'pnpm run typecheck');
    assert.deepEqual(repositoryChecks(agents, dir), { source: 'agents', commands: ['npm test', 'npm run typecheck', 'go test ./...'] });
    assert.equal(repositoryChecks([], dir).source, 'detected');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const command of ['npm test', 'cd web && npm run lint', 'node --test tests/a.test.mjs', 'npx tsc --noEmit', 'go test ./internal/...', 'swift build', 'python3 -m pytest -q', './check.sh'])
    assert.equal(isCheckCommand(command, ['./check.sh']), true, command);
  for (const command of ['ls', 'grep -rn "npm test" .', 'echo go test', 'git commit -m "npm test"', 'cat package.json'])
    assert.equal(isCheckCommand(command), false, command);
  assert.throws(() => normalizePlan({ plan: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] }), /managed-plan-invalid/);
  assert.throws(() => normalizePlan({ plan: [] }), /managed-plan-invalid/);
  assert.equal(planText(normalizePlan({ plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'in_progress' }, { step: 'Test', status: 'pending' }] })), '1. [x] Read\n2. [>] Fix\n3. [ ] Test');
  const answer = 'Looks mostly fine.\n```json\n{"findings":[{"severity":"blocking","file":"a.js","line":3,"issue":"off by one","evidence":"i <= n"},{"severity":"style","issue":"x"},{"severity":"minor","issue":"naming"}],"summary":"x"}\n```';
  assert.deepEqual(reviewFindings(answer).map(f => [f.severity, f.file, f.line]), [['blocking', 'a.js', 3], ['minor', '', null]]);
  assert.equal(reviewFindings('No JSON here'), null);
  assert.deepEqual(reviewFindings('```json\n{"findings":[]}\n```'), []);
  const prompt = workflowPrompt({ plan: 'require', verify: 'suggest', review: 'require', maxFixLoops: 2 }, { source: 'detected', commands: ['npm test'] });
  assert.match(prompt, /update_plan/); assert.match(prompt, /`npm test` \(detected/); assert.match(prompt, /harness reviews the final patch/);
  assert.match(prompt, /stops after 10 minutes .* stops when the turn ends: run the checks that cover your change first and a long suite in parts/);
  assert.equal(workflowPrompt({ plan: 'off', verify: 'off', review: 'off', maxFixLoops: 0 }, { source: 'detected', commands: [] }), '');
  // The plan guard refuses every edit of a complex task without a plan, for
  // three answers (edits of one answer count once); then edits go through.
  const run = new RunProcess({ plan: 'require', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: true, checks: { commands: [] } });
  for (const answer of [1, 1, 2, 3, 3]) assert.throws(() => run.beforeEdit('write', null, answer), /managed-plan-required/);
  assert.equal(run.planSkipped, false);
  assert.doesNotThrow(() => run.beforeEdit('edit', null, 4));
  assert.equal(run.planSkipped, true);
  assert.doesNotThrow(() => run.beforeEdit('bash', null, 5), 'commands are not edits');
  // Once a command changed files without the plan, commands wait for it too.
  const shell = new RunProcess({ plan: 'require', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: true, checks: { commands: [] } });
  assert.doesNotThrow(() => shell.beforeEdit('bash', null, 1));
  shell.changedWithoutPlan();
  assert.equal(shell.planSkipped, true);
  assert.throws(() => shell.beforeEdit('bash', null, 2), /managed-plan-required/);
  assert.equal(new RunProcess({ plan: 'suggest', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: true, checks: { commands: [] } }).planMissing(null), false);
  const planned = new RunProcess({ plan: 'require', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: true, checks: { commands: [] } });
  planned.planUpdated = true;
  assert.doesNotThrow(() => planned.beforeEdit('write', null, 1));
  assert.equal(parseFailure('managed-plan-required: write a checklist').kind, 'tool');
  // A plan sent as a JSON string is read as the list; other strings stay invalid.
  const tool = planTool(async plan => plan);
  assert.deepEqual(tool.prepareArguments({ plan: '[{"step":"A","status":"pending"}]' }).plan, [{ step: 'A', status: 'pending' }]);
  assert.equal(tool.prepareArguments({ plan: 'not json' }).plan, 'not json');
  const asIs = { plan: [] }; assert.equal(tool.prepareArguments(asIs), asIs);
});

// A git project whose check passes once a.txt says "fixed".
function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-workflow-')));
  fs.writeFileSync(path.join(base, 'a.txt'), 'start\n');
  fs.writeFileSync(path.join(base, 'check.sh'), 'grep -q fixed a.txt\n');
  fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Fixture\n## Checks\n```\nsh check.sh\n```\n');
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  execFileSync('git', ['-C', base, 'add', '-A']);
  execFileSync('git', ['-C', base, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'init']);
  return base;
}

// A local Studio whose models follow a script per role: each entry is the
// text of an answer or a tool call {tool, input}. Requests are kept.
async function studio(script) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)), role = script.roleOf(req.headers['x-session-id']);
    requests.push({ role, body });
    let step = script[role].shift() ?? 'Done.';
    // { wait, then }: answer late (a request still running when the member stops).
    if (step?.wait) { await new Promise(resolve => setTimeout(resolve, step.wait)); if (res.destroyed || req.destroyed) return; step = step.then; }
    if (step?.fail) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'upstream_unavailable', request_id: randomUUID() } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'message_start', message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    if (typeof step === 'string') {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step } });
      emit({ type: 'content_block_stop', index: 0 });
    } else {
      // An array is several tool calls in one answer.
      (Array.isArray(step) ? step : [step]).forEach((call, index) => {
        emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), name: call.tool, input: {} } });
        emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
        emit({ type: 'content_block_stop', index });
      });
    }
    emit({ type: 'message_delta', delta: { stop_reason: typeof step === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
    emit({ type: 'message_stop' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
const MODELS = { main: { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, review: { id: 'claude-opus-5-5', provider_model_id: 'claude-opus-5-5', owned_by: 'claude' } };
function broker(workflow, { features = ['process'], review = true, failProcessClose = false } = {}) {
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const roles = { main: randomUUID(), research: randomUUID(), review: randomUUID() }, run = randomUUID(), closes = []; let fence = 0;
  const grant = role => ({ ...authority, run_id: run, role_id: roles[role], role, fence: ++fence, provider: 'claude', model_id: MODELS[role === 'main' ? 'main' : 'review'].id,
    provider_model_id: MODELS[role === 'main' ? 'main' : 'review'].provider_model_id, effort: 'medium', token: `as_run_${roles[role]}_${'x'.repeat(43)}` });
  return { roles, closes, async request(action, args = {}) {
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key', user: { id: 'member' }, revision: 'r1', ...(features ? { broker_features: features } : {}),
      models: [MODELS.main, MODELS.review], harness: { configuration: { main: { model_ids: [MODELS.main.id] }, research: null, review: review ? { model_ids: [MODELS.review.id] } : null, workflow } } };
    if (['start', 'renew', 'child'].includes(action)) return grant(args.role ?? 'main');
    if (action === 'close') { if (args.process && failProcessClose) throw Error('managed-broker:invalidResponse'); closes.push(args); return true; }
    throw Error('unexpected-broker-action');
  }, async dispose() {} };
}
const processNotes = managed => managed.session.messages.filter(m => m.role === 'custom' && m.customType === 'agent-watch-process');
const runReport = agent => agent.closes.find(c => c.process)?.process;

test('required checks and review: the harness sends the agent back until the final patch is checked and clean', { skip: !supported, timeout: 180000 }, async () => {
  const root = project();
  const agent = broker({ plan: 'suggest', verify: 'require', review: 'require', max_fix_loops: 2 });
  const script = { roleOf: id => Object.keys(agent.roles).find(r => agent.roles[r] === id),
    main: [{ tool: 'write', input: { path: 'a.txt', content: 'broken\n' } }, 'Done.',
      { tool: 'bash', input: { command: 'sh check.sh' } }, { tool: 'write', input: { path: 'a.txt', content: 'fixed' } }, { tool: 'bash', input: { command: 'sh check.sh' } }, 'Checks pass.',
      { tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, { tool: 'bash', input: { command: 'sh check.sh' } }, 'Newline added.'],
    review: ['The file lacks a final newline.\n```json\n{"findings":[{"severity":"blocking","file":"a.txt","line":1,"issue":"no final newline","evidence":"git diff shows \\\\ No newline"}],"summary":"one issue"}\n```',
      'Fine now.\n```json\n{"findings":[],"summary":"clean"}\n```'] };
  const server = await studio(script);
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    // The member's message is one run, its harness rounds included: a listener
    // (the WebUI keeps Stop and the live view until then) hears it settle once.
    const settled = [], helpers = [];
    managed.session.subscribe(event => {
      if (event.type === 'agent_settled') settled.push(processNotes(managed).length);
      // The review runs while the main agent is quiet; listeners still hear it start and end.
      if (event.type === 'managed_helpers') helpers.push(event.active);
    });
    await managed.session.prompt('Make a.txt say fixed for the release checklist');
    assert.deepEqual(settled, [3]);
    assert.deepEqual(helpers, [1, 0, 1, 0]);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'fixed\n');
    const notes = processNotes(managed);
    assert.deepEqual(notes.map(n => n.details.phase), ['verify', 'review', 'final']);
    assert.match(notes[1].content, /1 blocking issue\(s\):\n1\. \[blocking\] a\.txt:1 — no final newline/);
    assert.equal(notes[2].details.outcome, 'clean');
    // The reviewer reads the project but cannot write, and sees the member's request.
    const reviews = server.requests.filter(r => r.role === 'review');
    assert.equal(reviews.length, 2);
    const tools = reviews[0].body.tools.map(t => t.name);
    assert.ok(tools.includes('read') && !tools.includes('write') && !tools.includes('bash'), tools.join(','));
    assert.match(JSON.stringify(reviews[0].body.messages), /Make a\.txt say fixed for the release checklist/);
    // The main agent was told the repository's check.
    assert.match(JSON.stringify(server.requests.find(r => r.role === 'main').body.system), /`sh check\.sh`/);
    assert.deepEqual(runReport(agent), { version: 1, policy: { plan: 'suggest', verify: 'require', review: 'require' }, changed: true, plan_steps: 0, plan_done: 0,
      checks: 3, checks_failed: 1, verified: true, reviews: 2, reviewed: true, blocking: 1, blocking_open: 0, fix_loops: 2, outcome: 'clean' });
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('suggested steps never add a turn; a required check that never passes ends the turn as unverified', { skip: !supported, timeout: 180000 }, async () => {
  for (const [workflow, mainScript, expected] of [
    [{ plan: 'suggest', verify: 'suggest', review: 'suggest', max_fix_loops: 2 }, [{ tool: 'write', input: { path: 'a.txt', content: 'changed\n' } }, 'Done.'], { requests: 2, phases: ['final'], outcome: 'unverified', loops: 0 }],
    [{ plan: 'off', verify: 'require', review: 'off', max_fix_loops: 1 }, [{ tool: 'write', input: { path: 'a.txt', content: 'changed\n' } }, 'Done.', 'The check needs a database that is not available here.'], { requests: 3, phases: ['verify', 'final'], outcome: 'unverified', loops: 1 }],
    // No fix rounds: nobody is sent back, but the required review still runs once.
    [{ plan: 'off', verify: 'require', review: 'require', max_fix_loops: 0 }, [{ tool: 'write', input: { path: 'a.txt', content: 'changed\n' } }, 'Done.'], { requests: 3, phases: ['final'], outcome: 'unverified', loops: 0, reviews: 1 }],
  ]) {
    const root = project(), agent = broker(workflow, { review: workflow.review !== 'off' });
    const script = { roleOf: id => Object.keys(agent.roles).find(r => agent.roles[r] === id), main: mainScript, review: ['Looks right.\n```json\n{"findings":[],"summary":"fine"}\n```'] };
    const server = await studio(script);
    const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
    try {
      await managed.session.prompt('Change a.txt');
      assert.equal(server.requests.length, expected.requests);
      assert.deepEqual(processNotes(managed).map(n => n.details.phase), expected.phases);
      const report = runReport(agent);
      assert.equal(report.outcome, expected.outcome); assert.equal(report.fix_loops, expected.loops); assert.equal(report.changed, true);
      assert.equal(report.reviews, expected.reviews ?? 0); assert.equal(report.reviewed, (expected.reviews ?? 0) > 0);
      assert.match(processNotes(managed).at(-1).content, /no check passed on the final code/);
      // A message that changes nothing reports no change and adds no note.
      await managed.session.prompt('Thanks');
      assert.equal(agent.closes.filter(c => c.process).at(-1).process.outcome, 'no_change');
      assert.equal(processNotes(managed).length, expected.phases.length);
    } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('a complex task plans before its first edit; an unfinished checklist comes back once before the turn ends', { skip: !supported, timeout: 180000 }, async () => {
  const steps = [{ step: 'Change a.txt', status: 'completed' }, { step: 'Explain', status: 'in_progress' }], done = steps.map(s => ({ ...s, status: 'completed' }));
  // The agent brings its checklist up to date when asked, or ignores the request (asked only once).
  for (const [after, expected] of [[[{ tool: 'update_plan', input: { plan: done } }, 'Checklist updated.'], { plan: done, report: [2, 2, 'clean'], planOpen: undefined }],
    [['Nothing to add.'], { plan: steps, report: [2, 1, 'clean'], planOpen: 1 }]]) {
    const root = project(), agent = broker({ plan: 'require', verify: 'off', review: 'off', max_fix_loops: 0 }, { review: false });
    const script = { roleOf: id => Object.keys(agent.roles).find(r => agent.roles[r] === id), review: [],
      main: [{ tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, { tool: 'update_plan', input: { plan: [{ step: 'Change a.txt', status: 'in_progress' }, { step: 'Explain', status: 'pending' }] } },
        { tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, { tool: 'update_plan', input: { plan: steps } }, 'Changed.', ...after] };
    const server = await studio(script);
    const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
    try {
      await managed.session.prompt('Plan the architecture migration of a.txt');
      const results = managed.session.messages.filter(m => m.role === 'toolResult');
      assert.equal(results[0].isError, true); assert.match(JSON.stringify(results[0].content), /managed-plan-required/);
      assert.equal(results[2].isError, false);
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x\n');
      const notes = processNotes(managed);
      assert.deepEqual(notes.map(n => n.details.phase), ['plan', 'final']);
      assert.equal(notes[0].details.planOpen, 1); assert.match(notes[0].content, /1 step\(s\) not marked completed:\n1\. \[x\] Change a\.txt\n2\. \[>\] Explain/);
      assert.equal(notes[1].details.planOpen, expected.planOpen);
      if (expected.planOpen) assert.match(notes[1].content, /plan: 1 step\(s\) not completed/);
      const plan = managed.session.sessionManager.getEntries().filter(e => e.customType === 'agent-watch-plan').at(-1).data;
      assert.deepEqual(plan.plan, expected.plan);
      assert.deepEqual([runReport(agent).plan_steps, runReport(agent).plan_done, runReport(agent).outcome], expected.report);
      // A later message that changes nothing is not asked about the old checklist.
      await managed.session.prompt('Thanks');
      assert.equal(processNotes(managed).length, 2);
    } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('edits sent with an invented plan tool are all refused; a plan sent as a JSON string is read; v2 reports count unknown tools', { skip: !supported, timeout: 180000 }, async () => {
  const root = project(), agent = broker({ plan: 'require', verify: 'off', review: 'off', max_fix_loops: 0 }, { review: false, features: ['process', 'process-v2'] });
  const steps = [{ step: 'Write a.txt and b.txt', status: 'in_progress' }];
  const server = await studio({ roleOf: () => 'main', review: [],
    main: [[{ tool: 'rival_update_plan', input: { plan: JSON.stringify(steps) } }, { tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, { tool: 'write', input: { path: 'b.txt', content: 'y\n' } }],
      { tool: 'update_plan', input: { plan: JSON.stringify(steps) } },
      [{ tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, { tool: 'write', input: { path: 'b.txt', content: 'y\n' } }],
      { tool: 'update_plan', input: { plan: [{ ...steps[0], status: 'completed' }] } }, 'Done.'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('Plan the architecture migration of a.txt and b.txt');
    const results = managed.session.messages.filter(m => m.role === 'toolResult').map(m => [m.toolName, m.isError, JSON.stringify(m.content)]);
    assert.match(results[0][2], /Tool rival_update_plan not found/);
    assert.deepEqual(results.slice(1, 3).map(r => [r[0], r[1], /managed-plan-required/.test(r[2])]), [['write', true, true], ['write', true, true]], 'both edits of that answer are refused');
    assert.deepEqual(results.slice(3).map(r => [r[0], r[1]]), [['update_plan', false], ['write', false], ['write', false], ['update_plan', false]]);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'y\n');
    const report = runReport(agent);
    assert.deepEqual([report.version, report.plan_steps, report.plan_done, report.plan_skipped, report.unknown_tools, report.outcome], [2, 1, 1, false, 1, 'clean']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a model that never plans is refused for three answers, then its edit goes through and the turn says so', { skip: !supported, timeout: 180000 }, async () => {
  const root = project(), agent = broker({ plan: 'require', verify: 'off', review: 'off', max_fix_loops: 0 }, { review: false });
  const edit = { tool: 'write', input: { path: 'a.txt', content: 'x\n' } };
  const server = await studio({ roleOf: () => 'main', review: [], main: [edit, edit, edit, edit, 'Done without a checklist.'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('Plan the architecture migration of a.txt');
    assert.deepEqual(managed.session.messages.filter(m => m.role === 'toolResult').map(m => m.isError), [true, true, true, false]);
    const final = processNotes(managed).at(-1);
    assert.deepEqual([final.details.phase, final.details.planSkipped], ['final', true]);
    assert.match(final.content, /code was changed before the required plan existed/);
    // A broker without "process-v2" gets the first version, without the new fields.
    const report = runReport(agent);
    assert.deepEqual([report.version, 'plan_skipped' in report, 'unknown_tools' in report, report.outcome], [1, false, false, 'clean']);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a shell command that edits files before the required plan is caught; later calls wait for the plan; the turn reports it', { skip: !supported, timeout: 180000 }, async () => {
  // The agent plans after being told (first), or never plans and only uses the shell (second).
  for (const [after, expected] of [
    [[{ tool: 'bash', input: { command: 'cat a.txt' } }, { tool: 'update_plan', input: { plan: [{ step: 'Change a.txt', status: 'completed' }] } }, { tool: 'bash', input: { command: 'cat a.txt' } }, 'Done.'],
      { errors: [false, true, false, false], planSteps: 1 }],
    [['Done.'], { errors: [false], planSteps: 0 }],
  ]) {
    const root = project(), agent = broker({ plan: 'require', verify: 'off', review: 'off', max_fix_loops: 0 }, { review: false, features: ['process', 'process-v2'] });
    const server = await studio({ roleOf: () => 'main', review: [], main: [{ tool: 'bash', input: { command: "printf 'shell\\n' > a.txt" } }, ...after] });
    const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
    try {
      await managed.session.prompt('Plan the architecture migration of a.txt');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'shell\n');
      const results = managed.session.messages.filter(m => m.role === 'toolResult');
      assert.deepEqual(results.map(m => m.isError), expected.errors);
      assert.match(JSON.stringify(results[0].content), /\[Harness\] This command changed files before the required plan existed/);
      if (expected.errors[1]) assert.match(JSON.stringify(results[1].content), /managed-plan-required/);
      const final = processNotes(managed).at(-1);
      assert.deepEqual([final.details.phase, final.details.planSkipped], ['final', true]);
      const report = runReport(agent);
      assert.deepEqual([report.plan_skipped, report.plan_steps, report.changed], [true, expected.planSteps, true]);
    } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('outside git, a turn that changed code under a required plan it never wrote still reports it', { skip: !supported, timeout: 120000 }, async () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-plain-plan-'))), agent = broker({ plan: 'require', verify: 'off', review: 'off', max_fix_loops: 0 }, { review: false });
  const server = await studio({ roleOf: () => 'main', review: [], main: [{ tool: 'bash', input: { command: "printf 'x\\n' > a.txt" } }, 'Done.'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: plain, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('Plan the architecture migration of a.txt');
    assert.equal(processNotes(managed).at(-1).details.planSkipped, true);
    assert.match(processNotes(managed).at(-1).content, /code was changed before the required plan existed/);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(plain, { recursive: true, force: true }); }
});

test('what a command left running in the background stops when the turn ends', { skip: !supported, timeout: 120000 }, async () => {
  const root = project(), agent = broker({ plan: 'off', verify: 'off', review: 'off', max_fix_loops: 0 }, { review: false }), marker = `turnstray${process.pid}`;
  const running = () => execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(row => row.includes(marker));
  const server = await studio({ roleOf: () => 'main', review: [], main: [{ tool: 'bash', input: { command: `(nohup node -e "setTimeout(() => {}, 60000)" ${marker} > /dev/null 2>&1 &); echo started` } }, 'Started the suite in the background.'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('Run the long suite');
    assert.deepEqual(running(), []);
  } finally {
    for (const row of running()) try { process.kill(Number(row.trim().split(/\s+/)[0]), 'SIGKILL'); } catch {}
    await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stopping while a helper runs ends the turn as stopped, not as a failed request', { skip: !supported, timeout: 120000 }, async () => {
  const root = project(), agent = broker({ plan: 'off', verify: 'off', review: 'suggest', max_fix_loops: 0 });
  const server = await studio({ roleOf: id => Object.keys(agent.roles).find(r => agent.roles[r] === id),
    main: [{ tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, { tool: 'delegate', input: { role: 'review', task: 'Review the change to a.txt' } }, 'Reviewed.'],
    review: [{ wait: 8000, then: 'Fine.\n```json\n{"findings":[],"summary":"ok"}\n```' }] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    // Stop once the review helper's request is in flight. A fixed delay fired
    // before the helper started on a loaded machine and left nothing to check.
    const stop = setInterval(() => {
      if (server.requests.some(request => request.role === 'review')) { clearInterval(stop); void managed.session.abort(); }
    }, 50);
    await managed.session.prompt('Change a.txt and have it reviewed').finally(() => clearInterval(stop));
    const last = managed.session.messages.filter(m => m.role === 'assistant').at(-1);
    assert.notEqual(last.stopReason, 'error', `ended with an error: ${last.errorMessage}`);
    assert.equal(managed.session.messages.some(m => m.role === 'assistant' && /managed-request-failed/.test(String(m.errorMessage ?? ''))), false);
    // The helper's step says it was stopped, not that it failed.
    const helper = managed.session.messages.find(m => m.role === 'toolResult' && m.toolName === 'delegate');
    assert.match(JSON.stringify(helper?.content ?? ''), /managed-helper-cancelled/);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a broker without process reports, or a Studio that refuses one, still closes the run', { skip: !supported, timeout: 120000 }, async () => {
  for (const options of [{ features: null }, { failProcessClose: true }]) {
    const root = project(), agent = broker({ plan: 'suggest', verify: 'suggest', review: 'off', max_fix_loops: 2 }, { ...options, review: false });
    const server = await studio({ roleOf: () => 'main', main: [{ tool: 'write', input: { path: 'a.txt', content: 'y\n' } }, 'Done.'], review: [] });
    const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
    try {
      await managed.session.prompt('Change a.txt');
      assert.equal(agent.closes.length, 1); assert.equal(agent.closes[0].process, undefined);
      assert.equal(managed.grant, null);
    } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('a change of a turn that stopped before its process ran is settled by the next one ("continue")', { skip: !supported, timeout: 180000 }, async () => {
  const root = project(), agent = broker({ plan: 'off', verify: 'require', review: 'off', max_fix_loops: 1 }, { review: false });
  const server = await studio({ roleOf: () => 'main', review: [],
    main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, { fail: true }, { tool: 'bash', input: { command: 'sh check.sh' } }, 'The check passes now.', 'Nothing else to do.'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    await managed.session.prompt('Make a.txt say fixed');
    assert.equal(runReport(agent).outcome, 'interrupted');
    // The next message changes nothing itself, but the stopped turn's change is still to be checked.
    await managed.session.prompt('Tiếp tục');
    const second = agent.closes.filter(c => c.process).at(-1).process;
    assert.deepEqual([second.changed, second.verified, second.outcome], [true, true, 'clean']);
    // Settled: a further message without changes is no change again.
    await managed.session.prompt('Thanks');
    assert.equal(agent.closes.filter(c => c.process).at(-1).process.outcome, 'no_change');
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a patch above the shell output limit is still reviewed; a review that cannot run says why', { skip: !supported, timeout: 180000 }, async () => {
  const root = project(), agent = broker({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 1 });
  const big = Array.from({ length: 1400 }, (_, i) => `export const value${i} = "${'x'.repeat(30)} ${i}";`).join('\n') + '\n';
  const server = await studio({ roleOf: id => Object.keys(agent.roles).find(r => agent.roles[r] === id),
    main: [{ tool: 'write', input: { path: 'big.js', content: big } }, 'Done.'], review: ['Fine.\n```json\n{"findings":[],"summary":"ok"}\n```'] });
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  try {
    const snapshot = await managed.patchSnapshot();
    assert.ok(snapshot.patch.length < 100);
    await managed.session.prompt('Add big.js');
    const reviewed = await managed.patchSnapshot();
    assert.ok(Buffer.byteLength(reviewed.patch) > 60000, 'the patch is larger than one shell output');
    assert.deepEqual([runReport(agent).outcome, runReport(agent).reviews], ['clean', 1]);
    const review = server.requests.find(r => r.role === 'review');
    assert.match(JSON.stringify(review.body.messages), /value1399/);
  } finally { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
  // Studio too busy to grant the review role once: asked again, the review runs.
  // Busy every time: the review cannot run, and why is kept as a code.
  for (const busy of [1, 9]) {
    const root3 = project(), agent3 = broker({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 1 });
    const server3 = await studio({ roleOf: id => Object.keys(agent3.roles).find(r => agent3.roles[r] === id),
      main: [{ tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, 'Done.'], review: ['Fine.\n```json\n{"findings":[],"summary":"ok"}\n```'] });
    let left = busy; const request = agent3.request.bind(agent3);
    agent3.request = async (action, args) => (action === 'child' && left-- > 0 ? Promise.reject(Error('managed-broker:serverUnavailable')) : request(action, args));
    const managed3 = await ManagedSession.create({ sdkRoot, cwd: root3, origin: server3.origin, broker: agent3 });
    try {
      await managed3.session.prompt('Write a.txt');
      const final = processNotes(managed3).at(-1);
      const detail = managed3.session.sessionManager.getEntries().filter(e => e.customType === 'agent-watch-failure-detail').map(e => e.data);
      if (busy === 1) assert.deepEqual([final.details.outcome, detail], ['clean', []]);
      else assert.deepEqual([final.details.outcome, detail], ['review_unavailable', [{ role: 'review', code: 'managed-broker:serverUnavailable' }]]);
    } finally { await managed3.dispose(); await server3.close(); fs.rmSync(root3, { recursive: true, force: true }); }
  }
  // Not a git repository: the reason reaches the final note.
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-plain-'))), other = broker({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 1 });
  const server2 = await studio({ roleOf: () => 'main', main: [{ tool: 'write', input: { path: 'a.txt', content: 'x\n' } }, 'Done.'], review: [] });
  const managed2 = await ManagedSession.create({ sdkRoot, cwd: plain, origin: server2.origin, broker: other });
  try {
    await managed2.session.prompt('Write a.txt');
    const final = processNotes(managed2).at(-1);
    assert.deepEqual([final.details.outcome, final.details.reviewUnavailable], ['review_unavailable', 'not_git']);
    assert.match(final.content, /review could not run \(not_git\)/);
  } finally { await managed2.dispose(); await server2.close(); fs.rmSync(plain, { recursive: true, force: true }); }
  // Not a git repository and the agent only ran a command that reads: no code
  // changed, so there is no process step and no "code changed" note.
  const reader = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-plain-read-'))), quiet = broker({ plan: 'off', verify: 'require', review: 'require', max_fix_loops: 1 });
  fs.writeFileSync(path.join(reader, 'notes.txt'), 'x\n');
  const server4 = await studio({ roleOf: () => 'main', main: [{ tool: 'bash', input: { command: 'cat notes.txt' } }, 'Done.'], review: [] });
  const managed4 = await ManagedSession.create({ sdkRoot, cwd: reader, origin: server4.origin, broker: quiet });
  try {
    await managed4.session.prompt('Show notes.txt');
    assert.deepEqual(processNotes(managed4), []);
    assert.deepEqual([runReport(quiet).changed, runReport(quiet).outcome], [false, 'no_change']);
  } finally { await managed4.dispose(); await server4.close(); fs.rmSync(reader, { recursive: true, force: true }); }
});
