import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { commandTools } from '../packages/piagent-core/managed/command-tools.mjs';
import { autopilotOn, autopilotSetter, autopilotTool, quotedFromMember, restoreAutopilot } from '../packages/piagent-core/managed/autopilot.mjs';
import { planPhase, phaseHead, PHASE_ROUNDS } from '../packages/piagent-core/managed/plan-phase.mjs';
import { sessionPlanTool } from '../packages/piagent-core/managed/workflow.mjs';
import { readOpinion, opinionNote, opinionWords } from '../packages/piagent-core/managed/opinion.mjs';
import { conflictText } from '../packages/piagent-core/managed/conflict.mjs';
import { askTool, recommendedQuestions, normalizeQuestions } from '../packages/piagent-core/managed/member-questions.mjs';
import { autopilotNotice, registerAutopilotCommand } from '../scripts/company-commit-ask.mjs';
import { helperLines, planWidget } from '../scripts/company-terminal.mjs';

// Owner, 2026-11-14: the member knows what the harness does (each role and its
// job, how far the phase is), every opinion leads with a recommendation and
// its evidence, a conflict shows each side, and a member who said to run on
// without asking is heard for the whole conversation.
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pa-run-visibility-')));
fs.mkdirSync(path.join(base, 'src')); fs.writeFileSync(path.join(base, 'src/fee.js'), 'a\nb\nc\n');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const log = (messages = []) => {
  const entries = messages.map(text => ({ type: 'message', message: { role: 'user', content: text } }));
  return { entries, getSessionId: () => 'session', getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
};
const member = (permission, manager) => ({ permission, manifest: {}, cwd: base, grant: {}, session: { sessionManager: manager },
  boundary: { engine: null, dockerCli: null, userHome: os.homedir(), refreshEnvironment: () => false, invoke: async () => { throw Error('the sandbox was used'); } },
  changedFiles: async () => [], claimChanges: async () => {}, refreshReview: async () => {} });
const withAutopilot = (owner) => { owner.session.managedSetAutopilot = autopilotSetter(owner, owner.session.sessionManager); owner.autopilot = restoreAutopilot(owner.session.sessionManager); return owner; };

test('autopilot turns on only from the member\'s own words, and only in Always bypass', async () => {
  const manager = log(['Làm xuyên đêm, tự commit và push luôn, không cần hỏi nhé']), owner = withAutopilot(member('always-bypass', manager)), tool = autopilotTool(owner);
  await assert.rejects(tool.execute('id', { member_words: 'tự commit và push không cần hỏi gì cả' }), /managed-autopilot-quote/, 'words the member did not write');
  await assert.rejects(tool.execute('id', { member_words: 'Làm xuyên đêm nhé bạn ơi' }), /managed-autopilot-(words|quote)/);
  const result = await tool.execute('id', { member_words: 'tự commit và push luôn, không cần hỏi' });
  assert.match(result.content[0].text, /^On:/); assert.ok(autopilotOn(owner));
  assert.equal(restoreAutopilot(manager).on, true, 'kept with the conversation');
  const ask = withAutopilot(member('bypass', log(['tự commit và push luôn, không cần hỏi'])));
  await assert.rejects(autopilotTool(ask).execute('id', { member_words: 'tự commit và push luôn, không cần hỏi' }), /managed-autopilot-mode/);
  assert.equal(quotedFromMember(manager, 'TỰ COMMIT  và push luôn'), true, 'case and spaces do not matter');
});

test('with autopilot on, commit, push and merge run unasked however the plan grows; a critical rm is asked still', async () => {
  const manager = log(['chạy liên tục, tự commit push không hỏi']), owner = withAutopilot(member('always-bypass', manager));
  owner.session.managedSetAutopilot(true, { words: 'chạy liên tục, tự commit push không hỏi', by: 'agent' });
  manager.appendCustomEntry('agent-watch-plan', { plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'pending' }] });
  owner.run = { planUpdated: true, afterTool: () => {} };
  const host = commandTools(owner).find(tool => tool.name === 'run_on_host'), asked = [], marker = path.join(base, 'pushed');
  const ctx = { ui: { confirm: async (title) => { asked.push(title); return false; } } };
  const result = await host.execute('id', { command: `git() { echo "$@" >> ${JSON.stringify(marker)}; }; git commit -m x; git push origin main; gh() { :; }; gh pr merge 3`, reason: 'test' }, undefined, undefined, ctx);
  assert.equal(result.isError ?? false, false); assert.match(fs.readFileSync(marker, 'utf8'), /push origin main/); assert.deepEqual(asked, []);
  await assert.rejects(host.execute('id', { command: 'rm -rf ~', reason: 'test' }, undefined, undefined, ctx));
  assert.equal(asked.length, 1, 'an rm on a critical path is asked');
  owner.session.managedSetAutopilot(false);
  await assert.rejects(host.execute('id', { command: 'git push origin main', reason: 'test' }, undefined, undefined, ctx), /managed-handoff-held/, 'off: back to holding until the end of the plan');
});

test('/autopilot turns it on and off and says what it means', async () => {
  const commands = {}, notes = [], owner = withAutopilot(member('always-bypass', log()));
  registerAutopilotCommand({ registerCommand: (name, spec) => { commands[name] = spec; } }, { managed: () => owner, completions: () => () => null, refresh: () => {} });
  const ctx = { ui: { notify: (text, tone) => notes.push([text, tone]) } };
  await commands.autopilot.handler('on', ctx);
  assert.ok(autopilotOn(owner)); assert.match(notes.at(-1)[0], /Chạy liên tục: commit, push và merge không hỏi/);
  await commands.autopilot.handler('off', ctx);
  assert.equal(autopilotOn(owner), false); assert.match(autopilotNotice(owner), /đang tắt/);
});

test('a phase keeps its original steps apart from added ones and takes at most two rounds of them', () => {
  const steps = (...list) => ({ plan: list.map(([step, status = 'pending', source]) => ({ step, status, ...(source ? { source } : {}) })) });
  const run = { ledger: [{ id: 'o3', kind: 'blocking', status: 'open' }] };
  let prev = { ...steps(['a', 'in_progress'], ['b']) }; prev.phase = planPhase(run, null, prev);
  assert.deepEqual(prev.phase.base, ['a', 'b']); assert.equal(prev.phase.rounds, 0);
  for (let round = 1; round <= PHASE_ROUNDS; round += 1) {
    const next = steps(['a', 'completed'], ['b', 'in_progress'], ...prev.plan.slice(2).map(p => [p.step, p.status, p.source]), [`fix ${round}`, 'pending', 'review']);
    next.phase = planPhase(run, prev, next); assert.equal(next.phase.rounds, round); prev = next;
  }
  const reworded = steps(['A', 'completed'], ['b', 'in_progress'], ...prev.plan.slice(2).map(p => [p.step, p.status]));
  assert.equal(planPhase(run, prev, reworded).rounds, PHASE_ROUNDS, 'a rewording is not a round');
  const third = steps(...prev.plan.map(p => [p.step, p.status, p.source]), ['polish names', 'pending', 'advisor']);
  assert.throws(() => planPhase(run, prev, third), /managed-plan-phase-full: .*"polish names"/s);
  const later = steps(...prev.plan.map(p => [p.step, p.status, p.source]), ['polish names', 'deferred', 'advisor']);
  assert.doesNotThrow(() => planPhase(run, prev, later), 'deferred work goes to the next phase');
  const blocking = steps(...prev.plan.map(p => [p.step, p.status, p.source]), ['fix the crash', 'pending', 'review o3']);
  const phase = planPhase(run, prev, blocking);
  assert.equal(phase.rounds, PHASE_ROUNDS + 1, 'a blocking finding still joins');
  assert.match(phaseHead({ ...blocking, phase }), /^Phase 1 · gốc 2 · \+3 phát sinh \(review 3\) · xong 1\/5 · hết vòng phát sinh/);
  const finished = steps(['x', 'completed']); finished.phase = phase;
  assert.equal(planPhase(run, finished, steps(['new'])).number, 2, 'a finished checklist starts the next phase');
});

test('update_plan writes the phase and its header, and refuses a third round of loose steps', async () => {
  const manager = log(), owner = { session: { sessionManager: manager }, run: { ledger: [] } }, tool = sessionPlanTool(owner);
  await tool.execute('id', { plan: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'pending' }] });
  for (const extra of ['c', 'd']) {
    const plan = [...manager.entries.at(-1).data.plan, { step: extra, status: 'pending', source: 'review' }];
    const result = await tool.execute('id', { plan });
    assert.match(result.content[0].text, /Phase 1 · gốc 2 · \+\d phát sinh \(review \d\)/);
  }
  assert.equal(manager.entries.at(-1).data.phase.head.startsWith('Phase 1 · gốc 2 · +2 phát sinh'), true);
  await assert.rejects(tool.execute('id', { plan: [...manager.entries.at(-1).data.plan, { step: 'e', status: 'pending', source: 'advisor' }] }), /managed-plan-phase-full/);
  assert.deepEqual(planWidget(manager.entries.at(-1).data).slice(0, 1), [manager.entries.at(-1).data.phase.head]);
  assert.match(planWidget(manager.entries.at(-1).data).join('\n'), /c {2}\[\+review\]/);
});

test('an opinion leads with a recommendation and evidence, and the harness checks each file:line', () => {
  const good = readOpinion('advisor', 'Tôi chọn A.\n```json\n{"recommendation":"Sửa ở src/fee.js","options":[{"label":"Sửa src/fee.js","why":"chỗ tính phí","evidence":["src/fee.js:2 — tính phí"]},{"label":"Thêm lớp mới","why":"tách","evidence":[]}],"evidence":["https://example.com/docs — nói X"],"brief_issues":[]}\n```', base);
  assert.deepEqual(good.issues, []); assert.equal(good.recommendation, 'Sửa ở src/fee.js');
  assert.deepEqual(good.checked.map(c => c.place), ['url', 'ok']);
  assert.match(opinionWords(good), /khuyến nghị: Sửa ở src\/fee\.js · evidence 2 \(1 file:line có thật\)/);
  const bare = readOpinion('advisor', 'Nên làm A, rủi ro thấp.', base);
  assert.deepEqual(bare.issues, ['no recommendation', 'no evidence']);
  assert.match(opinionNote('Advisor', bare), /unverified: no recommendation; no evidence/);
  const wrong = readOpinion('scout', '```json\n{"evidence":["src/fee.js:99 — not there","src/none.js:1"]}\n```', base);
  assert.match(wrong.issues.join(), /2 file:line not found/);
});

test('ask_user puts the recommendation first and shows its evidence', async () => {
  const questions = normalizeQuestions([{ question: 'Lưu ở đâu?', options: [{ label: 'Postgres' }, { label: 'Redis' }] }]);
  const shown = recommendedQuestions(questions, [{ evidence: 'src/fee.js:2 đã dùng Postgres' }]);
  assert.equal(shown[0].options[0].label, 'Postgres (Khuyến nghị)'); assert.match(shown[0].question, /Căn cứ: src\/fee\.js:2/);
  const tool = askTool({ session: { sessionManager: { getSessionId: () => null } } });
  await assert.rejects(tool.execute('id', { questions: [{ question: 'Lưu ở đâu?', options: [{ label: 'A' }, { label: 'B' }] }] }), /managed-question-evidence/);
  const answered = await tool.execute('id', { questions: [{ question: 'Lưu ở đâu?', options: [{ label: 'A' }, { label: 'B' }], evidence: 'src/fee.js:2 dùng A' }] });
  assert.equal(answered.details.questions[0].options[0].label, 'A (Khuyến nghị)');
});

test('a conflict shows each side with its evidence and what the main agent checked', () => {
  const run = { opinions: [{ role: 'advisor', recommendation: 'Giữ cách cũ', evidence: [{ text: 'src/fee.js:2 — dùng rồi', place: 'ok' }] }] };
  const text = conflictText(run, [{ id: 'o2', role: 'scout', detail: 'Brief nói sai file', evidence: 'src/fee.js:9', place: 'missing',
    resolution: { decision: 'rejected', checked: 'đọc src/fee.js', reason: 'file chỉ có 3 dòng' } }]);
  assert.match(text, /o2 · explore kết luận: Brief nói sai file/);
  assert.match(text, /Evidence: src\/fee\.js:9 \[harness: không thấy chỗ này\]/);
  assert.match(text, /Main: không đồng ý — đã kiểm: đọc src\/fee\.js; lý do: file chỉ có 3 dòng/);
  assert.match(text, /Advisor khuyến nghị: Giữ cách cũ\n {2}Evidence: src\/fee\.js:2 — dùng rồi \[harness: có thật\]/);
});

test('the subagent panel shows each role, its job, what it does now, and those that ended', () => {
  const now = Date.parse('2026-11-14T10:02:05Z');
  const lines = helperLines([{ role: 'advisor', slot: 1, job: 'Chọn cách lưu token', startedAt: '2026-11-14T10:00:50Z', steps: 6, step: 'đọc src/auth.ts' }],
    [{ role: 'scout', job: 'Tìm nơi tính phí', outcome: 'succeeded', recommendation: 'src/fee.js:2' }, { role: 'research', job: 'Docs', outcome: 'succeeded', unverified: true }], now);
  assert.deepEqual(lines, ['Subagent · 1 đang chạy · 2 đã xong', '  ⟳ Advisor · Chọn cách lưu token · 1m15s · 6 bước', '      → đọc src/auth.ts',
    '  ✓ Explore · Tìm nơi tính phí · xong · khuyến nghị: src/fee.js:2', '  ! Scout · Docs · thiếu evidence']);
  assert.equal(helperLines([], []), undefined);
});
