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
import { memberRequest, anchorText, beforeDelegate, relayObjection, recordVerdicts } from '../packages/piagent-core/managed/objections.mjs';
import { addItems, checkRef, evidenceRef, ledgerGuard, ledgerWords, recordFindings, resolveTool, reviewFocus } from '../packages/piagent-core/managed/ledger.mjs';
import { focusParts } from '../packages/piagent-core/managed/patch-snapshot.mjs';
import { copyNote, fanOut, mergeCopies, namedCount } from '../packages/piagent-core/managed/copies.mjs';
import { baseRole, slotArgs } from '../packages/piagent-core/managed/grant-share.mjs';
import { stepText } from '../packages/piagent-core/managed/helper-run.mjs';
import { helperLines, planWidget } from '../scripts/company-terminal.mjs';
import { reviewFindings, verifyVerdicts } from '../packages/piagent-core/managed/workflow.mjs';
import { HELPER_SETUP, helperPrompt } from '../packages/piagent-core/managed/helper-roles.mjs';
import { parseFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// A helper may object to its brief with evidence; the main agent decides and
// answers; the same disagreement a second time goes to the member.
const sdkRoot = piSdkRoot();
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
  assert.match(helperPrompt(['scout']), /record your decision with resolve_objection: accepted with what you changed \(a corrected brief, the plan, the code\), or rejected with what you checked and why/);
  assert.equal(helperPrompt([]), '');
});

const newRun = (policy = {}) => new RunProcess({ plan: 'off', verify: 'off', review: 'off', maxFixLoops: 0, ...policy }, { request: 'x', complex: false, checks: { commands: [] } });
function fixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-ledger-')));
  fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'cart.js'), 'a\nb\nc\n');
  return cwd;
}

test('evidence names a place the harness can find; a premise objection with evidence is required', () => {
  assert.deepEqual(evidenceRef('see src/cart.js:3 and more'), { file: 'src/cart.js', line: 3 });
  assert.deepEqual(evidenceRef('(`package.json:12`)'), { file: 'package.json', line: 12 });
  assert.equal(evidenceRef('find . -name billing.js: nothing'), null);
  const cwd = fixture();
  try {
    assert.equal(checkRef(cwd, { file: 'src/cart.js', line: 3 }), 'ok');
    assert.equal(checkRef(cwd, { file: 'src/cart.js', line: 40 }), 'missing');
    assert.equal(checkRef(cwd, { file: 'src/billing.js', line: 1 }), 'missing');
    assert.equal(checkRef(cwd, { file: '../etc/passwd', line: 1 }), null);
    assert.equal(checkRef(cwd, null), null);
    const run = newRun(), managed = { run, cwd };
    const items = addItems(managed, 'brief', 'scout', [
      { kind: 'wrong_premise', detail: 'billing.js does not exist', evidence: 'the discount is in src/cart.js:3' },
      { kind: 'wrong_premise', detail: 'no evidence', evidence: '' },
      { kind: 'conflicts_with_request', detail: 'points nowhere', evidence: 'src/cart.js:99' },
      { kind: 'ambiguous', detail: 'which discount?', evidence: 'the member says "discount"' }]);
    assert.deepEqual(items.map(i => [i.id, i.required, i.place ?? null]), [['o1', true, 'ok'], ['o2', false, null], ['o3', false, 'missing'], ['o4', false, null]]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('the main agent records each decision; a premise objection refuses edits and briefs until it is decided', async () => {
  const cwd = fixture();
  try {
    const run = newRun(), managed = { run, cwd }, tool = resolveTool(managed);
    addItems(managed, 'brief', 'scout', [{ kind: 'ambiguous', detail: 'which discount?', evidence: '' }]);
    beforeDelegate(run, 'scout', false);
    assert.deepEqual([run.ledger[0].status, run.ledger[0].resolution.change], ['accepted', 'a new brief'], 'a new brief answers an objection that is not required');
    addItems(managed, 'brief', 'scout', [{ kind: 'wrong_premise', detail: 'billing.js does not exist', evidence: 'src/cart.js:3' }]);
    assert.throws(() => beforeDelegate(run, 'scout', false), /^Error: managed-objection-open: the scout subagent objected to your brief; record your decision with resolve_objection[\s\S]*o2 \[wrong_premise\] scout: billing\.js does not exist/);
    assert.throws(() => ledgerGuard(run, 1), /^Error: managed-objection-open: resolve o2 with resolve_objection before changing files/);
    assert.throws(() => ledgerGuard(run, 1), /managed-objection-open/, 'calls of one answer count once');
    await assert.rejects(tool.execute('t', { id: 'o9', decision: 'accepted', checked: 'x', change: 'y' }), /managed-objection-unknown: no objection o9 in this message; the open ones are o2/);
    await assert.rejects(tool.execute('t', { id: 'o2', decision: 'accepted', checked: 'read src/cart.js:3' }), /managed-objection-invalid: an accepted objection names what you changed/);
    await assert.rejects(tool.execute('t', { id: 'o2', decision: 'rejected', checked: 'read src/cart.js:3' }), /managed-objection-invalid: a rejected objection says why/);
    const result = await tool.execute('t', { id: 'o2', decision: 'rejected', checked: 'grep billing: src/billing/index.js:1', reason: 'billing.js is src/billing/index.js' });
    assert.equal(result.content[0].text, 'Recorded: o2 rejected. The scout subagent judges your reason before the turn ends.');
    await assert.rejects(tool.execute('t', { id: 'o2', decision: 'accepted', checked: 'x', change: 'y' }), /managed-objection-settled: o2 is already rejected/);
    assert.doesNotThrow(() => ledgerGuard(run, 2)); assert.doesNotThrow(() => beforeDelegate(run, 'scout', false));
    // A model that cannot decide is not stuck: after three refused answers its edits go through.
    addItems(managed, 'brief', 'research', [{ kind: 'conflicts_with_request', detail: 'the member asked for Go', evidence: 'the member says "in Go"' }]);
    for (const answer of [3, 4]) assert.throws(() => ledgerGuard(run, answer), /managed-objection-open: resolve o3/);
    assert.doesNotThrow(() => ledgerGuard(run, 5)); assert.equal(run.ledgerSkipped, true);
    assert.equal(ledgerWords(run), 'objections: 1 accepted, 1 rejected, 1 left without a decision');
    // The second objection of a helper goes to the member, and the helper is refused until then.
    run.disputes.push({ source: 'scout', brief: true });
    assert.throws(() => beforeDelegate(run, 'scout', false), /^Error: managed-helper-disputed: the scout subagent objected to your briefs twice/);
    assert.doesNotThrow(() => beforeDelegate(run, 'scout', true), 'the harness itself is never refused');
    assert.equal(parseFailure('managed-helper-disputed: x').kind, 'tool');
    assert.equal(parseFailure('managed-objection-open: x').kind, 'tool');
    run.outcome = 'disputed'; run.legacyOutcome = 'no_change';
    const v3 = run.report(null, 3), v2 = run.report(null, 2);
    assert.deepEqual([v3.outcome, v3.objections, v3.objections_answered, v3.disputes], ['disputed', 3, 2, 1]);
    assert.equal(v2.outcome, 'no_change');
    assert.equal('objections' in v2, false);
    assert.deepEqual(Object.keys(run.report(null, 1)).includes('plan_skipped'), false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('the main agent asks for a review once; under a required review the harness reviews and refuses its call', () => {
  const required = newRun({ review: 'require' });
  assert.throws(() => beforeDelegate(required, 'review', false, { changed: true }), /^Error: managed-review-by-harness: the harness reviews the final patch when you finish/);
  assert.doesNotThrow(() => beforeDelegate(required, 'review', false, { changed: false }), 'a turn that changed nothing reviews earlier commits');
  assert.doesNotThrow(() => beforeDelegate(required, 'review', false, { changed: true, since: 'HEAD~2' }));
  const run = newRun({ review: 'suggest' });
  beforeDelegate(run, 'review', false, { changed: true });
  assert.throws(() => beforeDelegate(run, 'review', false, { changed: true, review: { stale: false, blocking: 1 } }), /^Error: managed-review-once: this change was reviewed already/);
  assert.throws(() => beforeDelegate(run, 'review', false, { changed: true, review: { stale: true, blocking: 0 } }), /managed-review-once/, 'major and minor findings do not earn a new review');
  assert.doesNotThrow(() => beforeDelegate(run, 'review', false, { changed: true, review: { stale: true, blocking: 2 } }), 'blocking findings fixed: one more');
  assert.equal(run.mainReviews, 2);
});

test('review findings and failed claims are ledger items: a repeated finding keeps its item, minor ones are only counted', async () => {
  const cwd = fixture();
  try {
    const run = newRun({ verify: 'require' }), managed = { run, cwd };
    const blocking = { severity: 'blocking', file: 'src/cart.js', line: 2, issue: 'percent is not checked', evidence: 'no range check' };
    const major = { severity: 'major', file: 'src/cart.js', line: 3, issue: 'no test for 100', evidence: '' };
    recordFindings(managed, [blocking, major, { severity: 'minor', file: 'src/cart.js', line: 1, issue: 'name', evidence: '' }]);
    assert.deepEqual(run.ledger.map(i => [i.id, i.kind, i.required, i.place]), [['o1', 'blocking', true, 'ok'], ['o2', 'major', false, 'ok']]);
    assert.equal(run.minorFindings, 1);
    await resolveTool(managed).execute('t', { id: 'o1', decision: 'rejected', checked: 'src/cart.js:2 validates', reason: 'validated in the caller' });
    // The reviewer repeats o1 and drops o2: o1 keeps its decision, o2 is cleared.
    recordFindings(managed, [{ ...blocking, issue: 'percent is still not checked' }]);
    assert.deepEqual(run.ledger.map(i => [i.id, i.status]), [['o1', 'rejected'], ['o2', 'cleared']]);
    recordFindings(managed, [major]);
    // A re-review of only the files changed since leaves an item about another file standing.
    managed.reviewFocus = { files: ['src/other.js'] };
    recordFindings(managed, []);
    assert.deepEqual(run.ledger.map(i => [i.id, i.status]), [['o1', 'withdrawn'], ['o2', 'cleared'], ['o3', 'open']]);
    managed.reviewFocus = null;
    run.ledger.length = 0;
    // Failed claims: required under a required verify; a later check that passes clears them.
    const details = {}, fail = '```json\n' + JSON.stringify({ verdicts: [{ claim: 'total() is unchanged', status: 'fail', evidence: 'src/cart.js:1' }] }) + '\n```';
    recordVerdicts(managed, fail, false, details);
    assert.deepEqual([run.ledger[0].source, run.ledger[0].required, run.ledger[0].status], ['verify', true, 'open']);
    recordVerdicts(managed, fail.replace('"fail"', '"pass"'), true, details);
    assert.equal(run.ledger[0].status, 'cleared');
    const suggested = newRun({ verify: 'suggest' });
    recordVerdicts({ run: suggested, cwd }, fail, false, {});
    assert.deepEqual([suggested.ledger[0].required, suggested.ledger[0].status], [false, 'noted']);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('a re-review after a fix reads only the parts holding a file changed since', async () => {
  const parts = { parts: [{ files: ['a.js', 'b.js'], text: '1' }, { files: ['c.js'], text: '2' }, { files: ['d.js'], text: '3' }], omitted: [] };
  assert.deepEqual(focusParts(parts, { files: ['c.js'] }).parts.map(p => p.text), ['2']);
  assert.deepEqual(focusParts(parts, { files: ['b.js', 'd.js'] }).parts.map(p => p.text), ['1', '3']);
  assert.equal(focusParts(parts, { files: ['z.js'] }), parts, 'a change outside every part: all of it');
  assert.equal(focusParts(parts, null), parts);
  const files = new Map([['a.js', 'h1'], ['c.js', 'h2']]);
  assert.deepEqual(await reviewFocus({ reviewFiles: files, changedFiles: async () => new Map([['a.js', 'h1'], ['c.js', 'h3'], ['e.js', 'h4']]) }), { files: ['c.js', 'e.js'] });
  assert.equal(await reviewFocus({ reviewFiles: files, changedFiles: async () => new Map(files) }), null);
  assert.equal(await reviewFocus({ changedFiles: async () => files }), null);
});

test('several helpers of a role run only when the member asks for that many, up to 3', () => {
  assert.equal(namedCount('Dùng 3 subagent review nhé'), 3);
  assert.equal(namedCount('use two scouts'), 2);
  assert.equal(namedCount('cho ba con scout'), 3);
  assert.equal(namedCount('review kỹ giúp anh'), 0);
  const manager = text => ({ getEntries: () => [{ type: 'message', message: { role: 'user', content: text } }] });
  const asked = manager('Anh muốn dùng 3 subagent review cho patch này.');
  assert.equal(fanOut(asked, 'review', { role: 'review', task: 'x' }, false), null, 'a plain call');
  assert.deepEqual(fanOut(asked, 'review', { copies: 3, member_words: 'dùng 3 subagent review' }, false), { n: 3, split: null });
  assert.deepEqual(fanOut(asked, 'review', { copies: 2, member_words: 'Dùng  3 subagent   review' }, false), { n: 2, split: null }, 'fewer than asked, spacing and case aside');
  assert.throws(() => fanOut(asked, 'review', { copies: 3, member_words: 'dùng 3 reviewer giỏi' }, false), /^Error: managed-copies-not-asked: more than one review helper runs only when the member asks for it/, 'words the member did not write');
  assert.throws(() => fanOut(manager('Sửa 3 file này rồi review nhé'), 'review', { copies: 3, member_words: 'Sửa 3 file' }, false), /managed-copies-not-asked/, 'a number of files, not of helpers');
  assert.throws(() => fanOut(manager('dùng 2 scout'), 'scout', { copies: 3, member_words: 'dùng 2 scout' }, false), /managed-copies-not-asked/, 'more than the member asked for');
  assert.throws(() => fanOut(manager('dùng 5 scout'), 'scout', { copies: 5, member_words: 'dùng 5 scout' }, false), /^Error: managed-copies-invalid: ask for 2 to 3 scout helpers/);
  assert.throws(() => fanOut(asked, 'review', { copies: 2, member_words: 'dùng 3 subagent review' }, true), /managed-copies-invalid: the harness runs one helper per call/);
  const split = fanOut(manager('cho 2 scout: một bên client, một bên server'), 'scout', { split: ['the client', 'the server'], member_words: 'cho 2 scout' }, false);
  assert.deepEqual(split, { n: 2, split: ['the client', 'the server'] });
  assert.match(copyNote('scout', 1, split), /you are scout helper 2 of 2\. Your share of the work: the server\. The others cover the rest\./);
  assert.match(copyNote('review', 0, { n: 3, split: null }), /you are review helper 1 of 3\. The others have the same brief/);
  assert.equal(parseFailure('managed-copies-not-asked: x').kind, 'tool');
  // Under a required review, reviewers the member asked for still run.
  assert.doesNotThrow(() => beforeDelegate(newRun({ review: 'require' }), 'review', false, { changed: true, asked: true }));
});

test('a helper key names its slot to the broker; the terminal panel lists the checklist and each running helper', () => {
  assert.deepEqual([slotArgs('review'), slotArgs('review#2'), baseRole('review#3')], [{ role: 'review' }, { role: 'review', slot: 2 }, 'review']);
  assert.equal(stepText('read', { path: 'src/cart.js' }), 'đọc src/cart.js');
  assert.equal(stepText('web_search', { query: 'pi release   date' }), 'tìm trên web pi release date');
  assert.equal(helperLines([]), undefined);
  assert.deepEqual(helperLines([{ role: 'scout', slot: 1, job: 'Find callers', step: 'tìm discount' }, { role: 'review', slot: 1, job: 'Review a.js' }, { role: 'scout', slot: 2, job: 'Find callers', step: 'đọc cart.js' }]),
    ['Subagent đang chạy · 3', '  ⟳ scout 1 · Find callers — tìm discount', '  ⟳ review · Review a.js', '  ⟳ scout 2 · Find callers — đọc cart.js']);
  assert.equal(planWidget(null), undefined);
  assert.equal(planWidget({ plan: [{ step: 'a', status: 'completed' }] }), undefined, 'a finished checklist leaves the panel');
  assert.deepEqual(planWidget({ plan: [{ step: 'Search', status: 'completed' }, { step: 'Compare', status: 'in_progress' }, { step: 'Report', status: 'pending' }] }),
    ['Plan · 1/3 bước xong', '  ☑ Search', '  ☐ Compare  ← đang làm', '  ☐ Report']);
});

test('the answers of several helpers merge: every finding, failed claim and objection any of them reports stands', () => {
  const block = value => '```json\n' + JSON.stringify(value) + '\n```';
  const issue = { kind: 'ambiguous', detail: 'which total?', evidence: '' };
  const one = { reply: 'First.\n' + block({ findings: [{ severity: 'major', file: 'a.js', line: 2, issue: 'no test', evidence: '' }], brief_issues: [issue], summary: 'one major' }), usage: 10 };
  const two = { reply: 'Second.\n' + block({ findings: [{ severity: 'blocking', file: 'a.js', line: 1, issue: 'crash on null', evidence: 'a.js:1' }, { severity: 'major', file: 'a.js', line: 2, issue: 'no test', evidence: '' }], brief_issues: [issue], summary: 'one blocking' }), usage: 5 };
  const merged = mergeCopies('review', 'Review', [one, two, { reply: 'No JSON here.', usage: 1 }], { findingsOf: reviewFindings, issuesOf: briefIssues, verdictsOf: verifyVerdicts });
  assert.deepEqual([merged.usage, merged.blocking, merged.parsed, merged.findings.map(f => f.severity)], [16, 1, false, ['blocking', 'major']]);
  assert.match(merged.reply, /^### Review helper 1 of 3\nFirst\.\n\n### Review helper 2 of 3\nSecond\.\n\n### Review helper 3 of 3\nNo JSON here\./);
  assert.deepEqual(briefIssues(merged.reply), [issue]);
  assert.equal(reviewFindings(merged.reply).length, 2);
  const verify = mergeCopies('verify', 'Verify', [{ reply: block({ verdicts: [{ claim: 'c', status: 'pass', evidence: 'x' }] }), usage: 1 }, { reply: block({ verdicts: [{ claim: 'c', status: 'fail', evidence: 'y' }] }), usage: 1 }], { findingsOf: reviewFindings, issuesOf: briefIssues, verdictsOf: verifyVerdicts });
  assert.deepEqual(verifyVerdicts(verify.reply).map(v => v.status), ['pass', 'fail']);
  assert.equal('findings' in verify, false);
});

test('an objection to a brief the harness wrote (its review, its re-check) only restates the request and is not relayed', async () => {
  const sent = [], run = newRun();
  const managed = { run, cwd: os.tmpdir(), session: { sendCustomMessage: async message => { sent.push(message); } } };
  const reply = 'Fine.\n```json\n{"findings":[],"brief_issues":[{"kind":"wrong_premise","detail":"the request names billing.js, which does not exist","evidence":"find"}]}\n```';
  assert.equal(await relayObjection(managed, 'review', reply, true), '');
  assert.deepEqual([run.ledger.length, sent.length], [0, 0]);
  assert.match(await relayObjection(managed, 'review', reply, false), /^\n\n\[Harness\] The review subagent objected to your brief:\no1 \[wrong_premise\] review: the request names billing\.js[\s\S]*Until you do, file changes are refused: o1 says the brief rests on a wrong premise/);
  assert.deepEqual([run.ledger.length, sent.length, sent[0].details.phase, sent[0].details.by, sent[0].details.ids], [1, 1, 'objection', 'main', ['o1']]);
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
    // Only model calls follow the script; this Studio keeps no log of failed tool calls.
    if (req.url === '/studio/v1/managed/tool-failures') { res.writeHead(404).end(); return; }
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
  // With "helper-slots" a helper of slot 2 or 3 holds a grant of its own (role#slot).
  const grant = (role, slot) => { const key = slot > 1 ? `${role}#${slot}` : role; roles[key] ??= randomUUID();
    return { ...authority, run_id: run, role_id: roles[key], role, ...(slot ? { slot } : {}), fence: ++fence, provider: 'claude', model_id: model(role).id, provider_model_id: model(role).provider_model_id, effort: 'medium', token: `as_run_${roles[key]}_${'x'.repeat(43)}` }; };
  const asks = [];
  return { roles, closes, asks, async request(action, args = {}) {
    asks.push({ action, ...args });
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'key', user: { id: 'member' }, revision: 'r1', broker_features: features, models: [MAIN, HELPER],
      harness: { configuration: { main: { model_ids: [MAIN.id] }, ...Object.fromEntries(helpers.map(role => [role, { model_ids: [HELPER.id] }])), workflow: { lanes: false, ...workflow } } } };
    if (['start', 'renew', 'child'].includes(action)) return grant(args.role ?? 'main', args.slot);
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
  script.roleOf = id => Object.keys(agent.roles).find(r => agent.roles[r] === id)?.split('#')[0];
  const server = await studio(script), managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: server.origin, broker: agent });
  return { root, agent, server, managed, async close() { await managed.dispose(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const OFF = { plan: 'off', verify: 'off', review: 'off', max_fix_loops: 2 };

const REJECT = { tool: 'resolve_objection', input: { id: 'o1', decision: 'rejected', checked: 'find . -name "billing*": src/billing/index.js', reason: 'billing.js is src/billing/index.js' } };
const ACCEPT = { tool: 'resolve_objection', input: { id: 'o1', decision: 'accepted', checked: 'find . -name billing.js: nothing', change: 'asked about cart.js instead' } };
test('an objection the agent does not decide is put to it once; a decision or its absence is on the record', { skip: !supported, timeout: 120000 }, async () => {
  for (const [last, expected] of [[ACCEPT, { phases: ['objection', 'answer', 'final'], answered: 1, words: 'objections: 1 accepted' }],
    ['The scout was right: there is no billing.js.', { phases: ['objection', 'answer', 'final'], answered: 0, words: 'objections: 1 left without a decision' }]]) {
    const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } }, 'The discount is in cart.js.', last, 'Done.'], scout: [OBJECTION] });
    try {
      await s.managed.session.prompt('Where is the discount computed?');
      const scout = s.server.requests.find(r => r.role === 'scout');
      assert.match(JSON.stringify(scout.body.messages), /The member's request, verbatim \(the main agent wrote the brief below from it\):\\n<<<\\nWhere is the discount computed\?\\n>>>/);
      assert.match(JSON.stringify(scout.body.messages), /Brief from the main agent:\\nFind where billing\.js computes the discount\./);
      assert.match(delegateResults(s.managed)[0], /\[Harness\] The scout subagent objected to your brief:\no1 \[wrong_premise\] scout: billing\.js does not exist \(evidence: find \. -name billing\.js: nothing\)\nCheck each at the place its evidence names, then record your decision with resolve_objection/);
      assert.deepEqual(notes(s.managed).map(n => n.details.phase), expected.phases);
      assert.deepEqual(notes(s.managed)[0].details, { phase: 'objection', role: 'scout', by: 'main', issues: [{ kind: 'wrong_premise', detail: 'billing.js does not exist' }], ids: ['o1'] });
      assert.match(notes(s.managed)[1].content, /^Harness: 1 objection\(s\) have no decision yet:\n- o1 \[wrong_premise\] scout: billing\.js does not exist[\s\S]*record your decision with resolve_objection/);
      assert.equal(notes(s.managed).at(-1).content, `Process status for this turn: no code changed; ${expected.words}.`);
      const report = reports(s.agent).at(-1);
      assert.deepEqual([report.version, report.outcome, report.objections, report.objections_answered, report.disputes], [3, 'no_change', 1, expected.answered, 0]);
      const saved = s.managed.session.sessionManager.getEntries().filter(e => e.customType === 'agent-watch-objections').at(-1).data.items;
      assert.equal(saved[0].status, expected.answered ? 'accepted' : 'open');
      if (expected.answered) assert.deepEqual(saved[0].resolution, { decision: 'accepted', checked: 'find . -name billing.js: nothing', change: 'asked about cart.js instead' });
    } finally { await s.close(); }
  }
});

test('a premise objection refuses file changes and a new brief until it is decided; then the corrected brief goes through', { skip: !supported, timeout: 120000 }, async () => {
  const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } },
    { tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } }, { tool: 'delegate', input: { role: 'scout', task: 'Find where cart.js computes the discount.' } }, ACCEPT,
    { tool: 'delegate', input: { role: 'scout', task: 'Find where cart.js computes the discount and every caller.' } }, 'The discount is computed in cart.js:3.'],
  scout: [OBJECTION, 'cart.js:3 computes it; called from checkout.js:12.\n' + json({ brief_issues: [] })] });
  try {
    await s.managed.session.prompt('Where is the discount computed?');
    const results = s.managed.session.messages.filter(m => m.role === 'toolResult').map(m => m.content.map(p => p.text).join('\n'));
    assert.match(results[1], /managed-objection-open: resolve o1 with resolve_objection before changing files/);
    assert.match(results[2], /managed-objection-open: the scout subagent objected to your brief; record your decision with resolve_objection before you brief it again/);
    assert.equal(results[3], 'Recorded: o1 accepted.');
    assert.equal(fs.readFileSync(path.join(s.root, 'a.txt'), 'utf8'), 'start\n');
    assert.equal(s.server.requests.filter(r => r.role === 'scout').length, 2);
    assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['objection', 'final']);
    const report = reports(s.agent).at(-1);
    assert.deepEqual([report.outcome, report.objections, report.objections_answered, report.disputes], ['no_change', 1, 1, 0]);
  } finally { await s.close(); }
});

test('a rejected premise objection goes back to the helper, which withdraws it or keeps it for the member', { skip: !supported, timeout: 180000 }, async () => {
  for (const [verdict, expected] of [['Your reason holds: src/billing/index.js computes it.\n' + json({ brief_issues: [] }), { phases: ['objection', 'rejudge', 'final'], outcome: 'no_change', status: 'withdrawn', disputes: 0 }],
    [OBJECTION, { phases: ['objection', 'rejudge', 'dispute', 'final'], outcome: 'disputed', status: 'disputed', disputes: 1 }]]) {
    const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } }, REJECT, 'The discount is in src/billing/index.js.'], scout: [OBJECTION, verdict] });
    try {
      await s.managed.session.prompt('Where is the discount computed?');
      assert.deepEqual(notes(s.managed).map(n => n.details.phase), expected.phases);
      const asks = s.server.requests.filter(r => r.role === 'scout');
      assert.equal(asks.length, 2);
      assert.match(JSON.stringify(asks[1].body.messages), /Brief from the harness:\\nYou objected to the brief the main agent gave you:\\n\[wrong_premise\] billing\.js does not exist[\s\S]*What it checked: find \. -name \\"billing\*\\": src\/billing\/index\.js\\nIts reason: billing\.js is src\/billing\/index\.js/);
      assert.equal(s.server.requests.filter(r => r.role === 'main').length, 3, 'the helper judged the reason; the agent was not sent back');
      assert.equal(notes(s.managed).at(-1).details.outcome, expected.outcome);
      const report = reports(s.agent).at(-1);
      assert.deepEqual([report.outcome, report.objections, report.objections_answered, report.disputes], [expected.outcome, 1, expected.disputes ? 0 : 1, expected.disputes]);
      assert.equal(s.managed.session.sessionManager.getEntries().filter(e => e.customType === 'agent-watch-objections').at(-1).data.items[0].status, expected.status);
    } finally { await s.close(); }
  }
});

test('a second objection from the same helper stops the exchange: the member decides and the helper is refused until then', { skip: !supported, timeout: 120000 }, async () => {
  for (const features of [['process', 'process-v2', 'process-v3'], ['process', 'process-v2']]) {
    const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where billing.js computes the discount.' } }, ACCEPT,
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
      assert.equal(final.content, 'Process status for this turn: no code changed; 1 disagreement(s) between the main agent and a subagent go to the member; objections: 1 accepted, 1 for the member.');
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
    assert.match(JSON.stringify(reviews[1].body.messages), /Since your last review only these files changed: a\.txt\. Judge whether each previous blocking finding is fixed[\s\S]*Your previous blocking findings:\\n1\. \[blocking\] a\.txt:1 — a\.txt lacks the license header/);
    assert.match(s.managed.session.messages.find(m => m.customType === 'agent-watch-process' && m.details.phase === 'review').content, /reject one with resolve_objection[\s\S]*After your fix the reviewer checks these findings and the files you changed/);
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

test('helpers the member asks for run side by side on one brief; without the member asking only one runs', { skip: !supported, timeout: 180000 }, async () => {
  const answers = ['cart.js:3 computes it.', 'checkout.js:12 calls it.', 'No other caller.'].map(text => text + '\n' + json({ brief_issues: [] }));
  const s = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where the discount is computed.', copies: 3, member_words: 'dùng 3 scout' } }, 'Three scouts agree: cart.js:3.'], scout: [...answers] });
  try {
    await s.managed.session.prompt('Anh muốn dùng 3 scout tìm chỗ tính discount.');
    const asks = s.server.requests.filter(r => r.role === 'scout');
    assert.equal(asks.length, 3);
    for (const i of [1, 2, 3]) assert.ok(asks.some(r => JSON.stringify(r.body.messages).includes(`you are scout helper ${i} of 3. The others have the same brief`)), `copy ${i}`);
    const result = delegateResults(s.managed)[0];
    for (const i of [1, 2, 3]) assert.match(result, new RegExp(`### Scout helper ${i} of 3`));
    assert.match(result, /cart\.js:3 computes it\.[\s\S]*checkout\.js:12 calls it\.|checkout\.js:12 calls it\.[\s\S]*cart\.js:3 computes it\./);
    const receipt = s.managed.session.messages.find(m => m.customType === 'agent-watch-helper-receipt');
    assert.match(receipt.content, / · 3 helpers · /);
    assert.equal(s.agent.closes.filter(c => c.role === 'scout').length, 1, 'the copies share the role\'s grant');
  } finally { await s.close(); }
  const plain = await session(OFF, ['scout'], { main: [{ tool: 'delegate', input: { role: 'scout', task: 'Find where the discount is computed.', copies: 3, member_words: 'tìm chỗ tính discount' } }, 'I will use one scout.'], scout: [] });
  try {
    await plain.managed.session.prompt('Tìm chỗ tính discount.');
    assert.match(delegateResults(plain.managed)[0], /managed-copies-not-asked: more than one scout helper runs only when the member asks for it/);
    assert.equal(plain.server.requests.filter(r => r.role === 'scout').length, 0);
  } finally { await plain.close(); }
});

test('reviewers the member asks for run even under a required review; their fresh review is the final one', { skip: !supported, timeout: 180000 }, async () => {
  const s = await session({ plan: 'off', verify: 'off', review: 'require', max_fix_loops: 2 }, ['review'], { main: [{ tool: 'write', input: { path: 'a.txt', content: 'fixed\n' } },
    { tool: 'delegate', input: { role: 'review', task: 'Review the change to a.txt.', copies: 3, member_words: 'review bằng 3 subagent' } }, 'Reviewed by three reviewers: clean.'], review: [CLEAN, CLEAN, CLEAN] });
  try {
    await s.managed.session.prompt('Sửa a.txt thành fixed rồi review bằng 3 subagent nhé.');
    assert.equal(s.server.requests.filter(r => r.role === 'review').length, 3, 'no harness review after it');
    assert.deepEqual(notes(s.managed).map(n => n.details.phase), ['final']);
    assert.equal(notes(s.managed).at(-1).details.outcome, 'clean');
  } finally { await s.close(); }
});

test('with helper slots in Studio and Agent Watch, each helper the member asked for holds a grant of its own and the terminal shows what each does', { skip: !supported, timeout: 180000 }, async () => {
  const answers = ['Source A: 12 results.', 'Source B: 4 results.', 'Source C: none.'].map(text => text + '\n' + json({ brief_issues: [] }));
  const s = await session(OFF, ['research'], { main: [{ tool: 'delegate', input: { role: 'research', task: 'Search each source for the release date.', split: ['source A', 'source B', 'source C'], member_words: 'điều phối 3 subagent' } }, 'Done.'], research: [...answers] },
    ['process', 'process-v2', 'process-v3', 'helper-slots']);
  const states = [];
  s.managed.session.subscribe(event => { if (event?.type === 'managed_helper_state') states.push(event.helpers); });
  try {
    await s.managed.session.prompt('Anh cần search 3 nguồn, điều phối 3 subagent đi tìm 3 nơi đó.');
    const children = s.agent.asks.filter(a => a.action === 'child');
    assert.deepEqual(children.map(c => c.slot ?? 1).sort(), [1, 2, 3]);
    assert.deepEqual(s.agent.closes.filter(c => c.role === 'research').map(c => c.slot ?? 1).sort(), [1, 2, 3], 'each slot closes its own grant');
    assert.equal(new Set(['research', 'research#2', 'research#3'].map(k => s.agent.roles[k])).size, 3);
    for (const [i, share] of ['source A', 'source B', 'source C'].entries()) assert.ok(s.server.requests.some(r => r.role === 'research' && JSON.stringify(r.body.messages).includes(`you are research helper ${i + 1} of 3. Your share of the work: ${share}.`)), share);
    assert.ok(states.some(list => list.length === 3), 'three helpers were seen at once');
    assert.deepEqual(states.find(list => list.length === 3).map(h => [h.role, h.slot, h.job]).sort(), [['research', 1, 'Search each source for the release date.'], ['research', 2, 'Search each source for the release date.'], ['research', 3, 'Search each source for the release date.']]);
    assert.deepEqual(states.at(-1), [], 'none left once they ended');
    assert.match(delegateResults(s.managed)[0], /### Research helper 3 of 3/);
  } finally { await s.close(); }
});
