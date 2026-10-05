import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
import { briefIssues, RunProcess } from '../packages/piagent-core/managed/workflow.mjs';
import { memberRequest, anchorText, beforeDelegate, relayObjection } from '../packages/piagent-core/managed/objections.mjs';
import { HELPER_SETUP, helperPrompt } from '../packages/piagent-core/managed/helper-roles.mjs';
import { parseFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';

// A helper may object to its brief with evidence; the main agent decides and
// answers; the same disagreement a second time goes to the member.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);

test('objections are read from the helper answer; the member request reaches back over short follow-ups', () => {
  assert.equal(briefIssues('no json'), null);
  assert.deepEqual(briefIssues('```json\n{"findings":[]}\n```'), null);
  const answer = 'There is no billing.js.\n```json\n{"brief_issues":[{"kind":"wrong_premise","detail":"billing.js does not exist","evidence":"ls: cart.js only"},{"kind":"style","detail":"x"},{"kind":"ambiguous","detail":"  "}]}\n```';
  assert.deepEqual(briefIssues(answer), [{ kind: 'wrong_premise', detail: 'billing.js does not exist', evidence: 'ls: cart.js only' }]);
  assert.deepEqual(briefIssues('```json\n{"verdicts":[],"brief_issues":[]}\n```'), []);
  // "tiếp tục" reaches back to the message that states the task; a long new request stands alone.
  const task = 'Add applyDiscount(items, percent) to src/cart.js: percent from 0 to 100, otherwise throw. Write tests for it and a short README section. Keep the public API unchanged and do not touch total().';
  assert.deepEqual(memberRequest(['Old question about the README', task, 'tiếp tục', 'Tiếp tục']), [task, 'tiếp tục', 'Tiếp tục']);
  assert.deepEqual(memberRequest(['short one', 'Thêm luôn test cho chuỗi rỗng nhé.']), ['short one', 'Thêm luôn test cho chuỗi rỗng nhé.']);
  assert.deepEqual(memberRequest([task, task + ' Also log it.']), [task + ' Also log it.']);
  assert.deepEqual(memberRequest([]), []);
  // A very long request keeps the newest words first.
  const long = 'x'.repeat(7000), kept = memberRequest([long]);
  assert.equal(kept[0].length, 6000);
  const entries = [{ type: 'message', message: { role: 'user', content: task } }, { type: 'custom', customType: 'agent-watch-plan', data: { plan: [{ step: 'Write tests', status: 'pending' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'tiếp tục' }] } }];
  const anchor = anchorText({ getEntries: () => entries }, false);
  assert.match(anchor, /^The member's request, verbatim \(the main agent wrote the brief below from it\):\n<<<\nEarlier message:\nAdd applyDiscount/);
  assert.match(anchor, /Current message:\ntiếp tục\n>>>\n\nCurrent plan:\n1\. \[ \] Write tests\n\nBrief from the main agent:\n$/);
  assert.match(anchorText({ getEntries: () => entries.slice(0, 1) }, true), /\(the harness wrote the brief below from it\)[\s\S]*Brief from the harness:\n$/);
  assert.equal(anchorText({ getEntries: () => [] }, false), '');
  // Every helper checks its brief and ends with brief_issues; the main agent is told it must answer.
  for (const role of ['scout', 'research', 'verify', 'review']) {
    assert.match(HELPER_SETUP[role].prompt, /Check the brief against the request/, role);
    assert.match(HELPER_SETUP[role].prompt, /"brief_issues":\[/, role);
  }
  assert.match(helperPrompt(['scout']), /answer every objection: send a corrected brief, change your approach, or tell the member why it does not hold/);
  assert.equal(helperPrompt([]), '');
});

test('a helper that objected twice is refused until the member answers; reports keep older versions unchanged', () => {
  const run = new RunProcess({ plan: 'off', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: false, checks: { commands: [] } });
  run.objections.push({ role: 'scout', issues: [], answered: false, disputed: false });
  beforeDelegate(run, 'scout', false);
  assert.equal(run.objections[0].answered, true, 'a new brief answers the objection');
  run.objections.push({ role: 'scout', issues: [], answered: false, disputed: true });
  run.disputes.push({ source: 'scout', brief: true });
  assert.throws(() => beforeDelegate(run, 'scout', false), /^Error: managed-helper-disputed: the scout subagent objected to your briefs twice/);
  assert.doesNotThrow(() => beforeDelegate(run, 'research', false));
  assert.doesNotThrow(() => beforeDelegate(run, 'scout', true), 'the harness itself is never refused');
  assert.equal(parseFailure('managed-helper-disputed: x').kind, 'tool');
  run.outcome = 'disputed'; run.legacyOutcome = 'no_change';
  const v3 = run.report(null, 3), v2 = run.report(null, 2);
  assert.deepEqual([v3.outcome, v3.objections, v3.objections_answered, v3.disputes], ['disputed', 2, 1, 1]);
  assert.equal(v2.outcome, 'no_change');
  assert.equal('objections' in v2, false);
  assert.deepEqual(Object.keys(run.report(null, 1)).includes('plan_skipped'), false);
});

test('an objection to a brief the harness wrote (its review, its re-check) only restates the request and is not relayed', async () => {
  const sent = [], run = new RunProcess({ plan: 'off', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: false, checks: { commands: [] } });
  const managed = { run, session: { sendCustomMessage: async message => { sent.push(message); } } };
  const reply = 'Fine.\n```json\n{"findings":[],"brief_issues":[{"kind":"wrong_premise","detail":"the request names billing.js, which does not exist","evidence":"find"}]}\n```';
  assert.equal(await relayObjection(managed, 'review', reply, true), '');
  assert.deepEqual([run.objections.length, sent.length], [0, 0]);
  assert.match(await relayObjection(managed, 'review', reply, false), /^\n\n\[Harness\] The review subagent objected to your brief/);
  assert.deepEqual([run.objections.length, sent.length, sent[0].details.phase, sent[0].details.by], [1, 1, 'objection', 'main']);
});

function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-objections-')));
  fs.writeFileSync(path.join(base, 'a.txt'), 'start\n');
  fs.writeFileSync(path.join(base, 'check.sh'), 'grep -q fixed a.txt\n');
  fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Fixture\n## Checks\n```\nsh check.sh\n```\n');
  execFileSync('git', ['init', '-q', '-b', 'main', base]);
  execFileSync('git', ['-C', base, 'add', '-A']);
  execFileSync('git', ['-C', base, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'init']);
  return base;
}
// A local Studio whose models follow a script per role (text, or tool calls).
async function studio(script) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)), role = script.roleOf(req.headers['x-session-id']);
    requests.push({ role, body });
    const step = script[role].shift() ?? 'Done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'message_start', message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    if (typeof step === 'string') {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step } });
      emit({ type: 'content_block_stop', index: 0 });
    } else {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), name: step.tool, input: {} } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
      emit({ type: 'content_block_stop', index: 0 });
    }
    emit({ type: 'message_delta', delta: { stop_reason: typeof step === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
    emit({ type: 'message_stop' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
const MAIN = { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, HELPER = { id: 'claude-opus-5-5', provider_model_id: 'claude-opus-5-5', owned_by: 'claude' };
function broker(workflow, helpers, features = ['process', 'process-v2', 'process-v3']) {
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const roles = Object.fromEntries(['main', ...helpers].map(role => [role, randomUUID()])), run = randomUUID(), closes = []; let fence = 0;
  const model = role => role === 'main' ? MAIN : HELPER;
  const grant = role => ({ ...authority, run_id: run, role_id: roles[role], role, fence: ++fence, provider: 'claude', model_id: model(role).id, provider_model_id: model(role).provider_model_id, effort: 'medium', token: `as_run_${roles[role]}_${'x'.repeat(43)}` });
  return { roles, closes, async request(action, args = {}) {
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key', user: { id: 'member' }, revision: 'r1', broker_features: features, models: [MAIN, HELPER],
      harness: { configuration: { main: { model_ids: [MAIN.id] }, ...Object.fromEntries(helpers.map(role => [role, { model_ids: [HELPER.id] }])), workflow } } };
    if (['start', 'renew', 'child'].includes(action)) return grant(args.role ?? 'main');
    if (action === 'close') { closes.push(args); return true; }
    throw Error('unexpected-broker-action');
  }, async dispose() {} };
}
const notes = managed => managed.session.messages.filter(m => m.role === 'custom' && m.customType === 'agent-watch-process');
const reports = agent => agent.closes.filter(c => c.process).map(c => c.process);
const delegateResults = managed => managed.session.messages.filter(m => m.role === 'toolResult' && m.toolName === 'delegate').map(m => m.content.map(p => p.text).join('\n'));
const json = value => '```json\n' + JSON.stringify(value) + '\n```';
const OBJECTION = 'billing.js does not exist; the discount is computed in cart.js:3.\n' + json({ brief_issues: [{ kind: 'wrong_premise', detail: 'billing.js does not exist', evidence: 'find . -name billing.js: nothing' }] });
async function session(workflow, helpers, script, features) {
  const root = project(), agent = broker(workflow, helpers, features);
  script.roleOf = id => Object.keys(agent.roles).find(r => agent.roles[r] === id);
  const server = await studio(script), managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  return { root, agent, server, managed, async close() { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const OFF = { plan: 'off', verify: 'off', review: 'off', max_fix_loops: 2 };

test('an objection the agent never answers with a new brief is answered to the member once; the helper read the member request', { skip: !supported, timeout: 120000 }, async () => {
  const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } }, 'The discount is in cart.js.',
    'The scout was right: there is no billing.js, so I answered from cart.js.'], scout: [OBJECTION] });
  try {
    await s.managed.session.prompt('Where is the discount computed?');
    const scout = s.server.requests.find(r => r.role === 'scout');
    assert.match(JSON.stringify(scout.body.messages), /The member's request, verbatim \(the main agent wrote the brief below from it\):\\n<<<\\nWhere is the discount computed\?\\n>>>/);
    assert.match(JSON.stringify(scout.body.messages), /Brief from the main agent:\\nFind where billing\.js computes the discount\./);
    assert.match(delegateResults(s.managed)[0], /\[Harness\] The scout subagent objected to your brief \(see brief_issues above\)\. You decide, but answer the objection/);
    assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['objection', 'answer']);
    assert.deepEqual(notes(s.managed)[0].details, { phase: 'objection', role: 'scout', by: 'main', issues: [{ kind: 'wrong_premise', detail: 'billing.js does not exist' }] });
    assert.match(notes(s.managed)[1].content, /- scout subagent: \[wrong_premise\] billing\.js does not exist\nIn your answer to the member, say in one or two sentences what you decided about it and why\./);
    assert.equal(s.server.requests.filter(r => r.role === 'main').length, 3);
    const report = reports(s.agent).at(-1);
    assert.deepEqual([report.version, report.outcome, report.objections, report.objections_answered, report.disputes], [3, 'no_change', 1, 1, 0]);
  } finally { await s.close(); }
});

test('a corrected brief answers the objection without another turn', { skip: !supported, timeout: 120000 }, async () => {
  const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } },
    { tool: 'delegate', input: { role: 'scout', task: 'Find where cart.js computes the discount and every caller.' } }, 'The discount is computed in cart.js:3.'],
  scout: [OBJECTION, 'cart.js:3 computes it; called from checkout.js:12.\n' + json({ brief_issues: [] })] });
  try {
    await s.managed.session.prompt('Where is the discount computed?');
    assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['objection']);
    assert.doesNotMatch(delegateResults(s.managed)[1], /\[Harness\]/);
    const report = reports(s.agent).at(-1);
    assert.deepEqual([report.outcome, report.objections, report.objections_answered, report.disputes], ['no_change', 1, 1, 0]);
  } finally { await s.close(); }
});

test('a second objection from the same helper stops the exchange: the member decides and the helper is refused until then', { skip: !supported, timeout: 120000 }, async () => {
  for (const features of [['process', 'process-v2', 'process-v3'], ['process', 'process-v2']]) {
    const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } },
      { tool: 'delegate', input: { role: 'scout', task: 'Look again in billing.js, it must be there.' } },
      { tool: 'delegate', input: { role: 'scout', task: 'Third try at billing.js.' } }, 'The scout and I disagree about billing.js; please decide.'],
    scout: [OBJECTION, OBJECTION] }, features);
    try {
      await s.managed.session.prompt('Where is the discount computed?');
      const results = delegateResults(s.managed);
      assert.match(results[1], /This is its second objection for this message, so the harness ends the exchange/);
      assert.match(results[2], /managed-helper-disputed: the scout subagent objected to your briefs twice/);
      assert.equal(s.server.requests.filter(r => r.role === 'scout').length, 2);
      assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['objection', 'dispute', 'final']);
      const final = notes(s.managed).at(-1);
      assert.equal(final.details.outcome, 'disputed'); assert.equal(final.details.disputes, 1);
      assert.match(final.content, /^Process status for this turn: no code changed; 1 disagreement\(s\) between the main agent and a subagent go to the member\.$/);
      const report = reports(s.agent).at(-1);
      if (features.includes('process-v3')) assert.deepEqual([report.outcome, report.objections, report.objections_answered, report.disputes], ['disputed', 2, 1, 1]);
      else assert.deepEqual([report.version, report.outcome, 'disputes' in report], [2, 'no_change', false]);
      // The next member message starts fresh: the helper can be asked again.
      s.server.requests.length = 0;
      await s.managed.session.prompt('Look in cart.js then.');
      assert.equal(reports(s.agent).at(-1).outcome, 'no_change');
    } finally { await s.close(); }
  }
});

const BLOCKING = 'Missing header.\n' + json({ findings: [{ severity: 'blocking', file: 'a.txt', line: 1, issue: 'a.txt lacks the license header', evidence: 'line 1' }], brief_issues: [], summary: 'one issue' });
const CLEAN = 'Fine.\n' + json({ findings: [], brief_issues: [], summary: 'clean' });
test('an answer instead of a fix goes back to the reviewer, who withdraws the finding or keeps it for the member', { skip: !supported, timeout: 180000 }, async () => {
  for (const [second, expected] of [[CLEAN, { phases: ['review', 'rejudge', 'final'], outcome: 'clean', legacy: 'clean', open: 0 }],
    [BLOCKING, { phases: ['review', 'rejudge', 'dispute', 'final'], outcome: 'disputed', legacy: 'blocking_open', open: 1 }]]) {
    const s = await session({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 2 }, ['review'], { main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, 'Done.',
      'The finding is wrong: a.txt is a plain data file and this repository has no license headers anywhere.'], review: [BLOCKING, second] });
    try {
      await s.managed.session.prompt('Make a.txt say fixed');
      assert.deepEqual(notes(s.managed).map(n => n.details.phase), expected.phases);
      const reviews = s.server.requests.filter(r => r.role === 'review');
      assert.equal(reviews.length, 2);
      assert.match(JSON.stringify(reviews[0].body.messages), /Brief from the harness:\\nReview the current patch against the member's request/);
      assert.match(JSON.stringify(reviews[1].body.messages), /The main agent answered them without changing the code:\\nThe finding is wrong: a\.txt is a plain data file/);
      assert.match(JSON.stringify(reviews[1].body.messages), /Your previous blocking findings:\\n1\. \[blocking\] a\.txt:1 — a\.txt lacks the license header/);
      const final = notes(s.managed).at(-1).details;
      assert.equal(final.outcome, expected.outcome); assert.equal(final.blockingOpen, expected.open);
      const report = reports(s.agent).at(-1);
      assert.deepEqual([report.outcome, report.fix_loops, report.disputes], [expected.outcome, 1, expected.outcome === 'disputed' ? 1 : 0]);
      assert.equal(s.server.requests.filter(r => r.role === 'main').length, 3, 'the reviewer judged the answer; the agent was not sent back again');
    } finally { await s.close(); }
  }
  // Under version 2 the same disagreement reads as an open blocking issue.
  const s = await session({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 2 }, ['review'], { main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, 'Done.', 'Not real.'], review: [BLOCKING, BLOCKING] }, ['process', 'process-v2']);
  try { await s.managed.session.prompt('Make a.txt say fixed'); assert.equal(reports(s.agent).at(-1).outcome, 'blocking_open'); } finally { await s.close(); }
});

test('after a fix the reviewer also reads the answer the agent gave with it', { skip: !supported, timeout: 180000 }, async () => {
  const s = await session({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 2 }, ['review'], { main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, 'Done.',
    { tool: 'write', input: { path: 'a.txt', content: '# header\nfixed\n' } }, 'Added the header as asked.'], review: [BLOCKING, CLEAN] });
  try {
    await s.managed.session.prompt('Make a.txt say fixed');
    assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['review', 'final']);
    const reviews = s.server.requests.filter(r => r.role === 'review');
    assert.match(JSON.stringify(reviews[1].body.messages), /The main agent's answer to your previous blocking findings \(the code changed after it\):\\nAdded the header as asked\./);
    assert.equal(notes(s.managed).at(-1).details.outcome, 'clean');
  } finally { await s.close(); }
});

const FAIL = 'The check fails.\n' + json({ verdicts: [{ claim: 'a.txt says fixed', status: 'fail', evidence: 'cat a.txt: broken' }], brief_issues: [], summary: 'failed' });
const PASS = 'Confirmed.\n' + json({ verdicts: [{ claim: 'a.txt says fixed', status: 'pass', evidence: 'sh check.sh: exit 0' }], brief_issues: [], summary: 'passed' });
test('under a required verify a failed claim goes back to the agent, is checked again with its answer, and a lasting failure goes to the member', { skip: !supported, timeout: 180000 }, async () => {
  for (const [recheck, expected] of [[PASS, { phases: ['claims', 'rejudge', 'final'], outcome: 'clean' }], [FAIL, { phases: ['claims', 'rejudge', 'dispute', 'final'], outcome: 'disputed' }]]) {
    const s = await session({ plan: 'off', verify: 'require', review: 'off', max_fix_loops: 2 }, ['verify'], { main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, { tool: 'bash', input: { command: 'sh check.sh' } },
      { tool: 'delegate', input: { role: 'verify', task: 'Confirm a.txt says fixed.' } }, 'Done and verified.', 'The verdict is wrong: a.txt says fixed, the check passed above.'], verify: [FAIL, recheck] });
    try {
      await s.managed.session.prompt('Make a.txt say fixed');
      assert.deepEqual(notes(s.managed).map(n => n.details.phase), expected.phases);
      assert.deepEqual(notes(s.managed)[0].details.claims, [{ claim: 'a.txt says fixed' }]);
      const checks = s.server.requests.filter(r => r.role === 'verify');
      assert.equal(checks.length, 2);
      assert.match(JSON.stringify(checks[1].body.messages), /Brief from the harness:\\nCheck these claims again on the current code[\s\S]*The main agent's answer:\\nThe verdict is wrong/);
      assert.equal(notes(s.managed).at(-1).details.outcome, expected.outcome);
      assert.equal(reports(s.agent).at(-1).outcome, expected.outcome);
    } finally { await s.close(); }
  }
});

test('under a suggested verify a failed claim stays the agent\'s to weigh: no extra turn', { skip: !supported, timeout: 120000 }, async () => {
  const s = await session({ plan: 'off', verify: 'suggest', review: 'off', max_fix_loops: 2 }, ['verify'], { main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, { tool: 'bash', input: { command: 'sh check.sh' } },
    { tool: 'delegate', input: { role: 'verify', task: 'Confirm a.txt says fixed.' } }, 'Done.'], verify: [FAIL] });
  try {
    await s.managed.session.prompt('Make a.txt say fixed');
    assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['final']);
    assert.equal(s.server.requests.filter(r => r.role === 'main').length, 4);
  } finally { await s.close(); }
});
