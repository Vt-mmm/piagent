import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyTurn, asksMember, asksPermissionToGoOn, verdict } from '../evals/long-task-soak-v1/lib/judge.mjs';
import { Persona, asksWhatFails } from '../evals/long-task-soak-v1/lib/persona.mjs';
import { playScenario } from '../evals/long-task-soak-v1/lib/session-loop.mjs';
import { prepareProject, fixtureDir, loadScenarios } from '../evals/long-task-soak-v1/lib/workspace.mjs';

// The soak lane's simulated member: how it reads a turn end, what it answers,
// and how it plays a scenario. The agent here is a scripted surface; the
// lane itself only ever runs the real company agent.

test('a turn end reads the way a member reads it', () => {
  const failing = { pass: false, checks: [] };
  assert.equal(classifyTurn({ lastText: 'Xong phần 1-3. Tiếp theo tôi sẽ làm phần CSV.' }, failing).kind, 'midway');
  assert.equal(classifyTurn({ lastText: 'Đã làm phần 1-5. Anh có muốn tôi tiếp tục không?' }, failing).kind, 'permission_pause');
  assert.equal(classifyTurn({ lastText: 'Shall I continue with the remaining steps?' }, failing).defect, 'asked_permission_to_continue');
  assert.equal(classifyTurn({ lastText: 'Proration is not specified. Which option do you want?\n1. Prorate by day\n2. Full month' }, null).kind, 'asked');
  assert.equal(classifyTurn({ lastText: 'All done, all tests pass.' }, failing).kind, 'false_done');
  assert.equal(classifyTurn({ lastText: 'All done, all tests pass.' }, { pass: true }).kind, 'done');
  assert.equal(classifyTurn({ lastText: '', turnEnd: { state: 'failed' }, error: 'provider' }, failing).defect, 'turn_failed');
  assert.equal(classifyTurn({ lastText: 'Working', turnEnd: { state: 'midway' } }, failing).kind, 'midway');
  assert.equal(classifyTurn({ lastText: '' }, failing).defect, 'ended_without_answer');
  assert.equal(classifyTurn({ lastText: 'Đã làm xong cả ba phần. **`npm test` qua 41/41 bài.** Review không còn lỗi cần sửa.', turnEnd: { state: 'done' } }, failing).kind, 'false_done');
  assert.equal(classifyTurn({ lastText: 'Refactored the module.', turnEnd: { state: 'done' } }, failing).kind, 'false_done');
  assert.equal(classifyTurn({ stalled: true }, failing).kind, 'stalled');
  assert.ok(asksMember('Gói giá nào áp dụng? Anh chọn giúp:\n1. Basic\n2. Pro'));
  assert.ok(asksMember('どちらの方式にしますか？'));
  assert.ok(!asksMember('Implemented the parser. Tests pass.'));
  assert.ok(asksPermissionToGoOn('続けますか？'));
  assert.ok(asksWhatFails('Ở phía anh, mục nào vẫn chưa qua? Em đã chạy lại ci.sh được ci: all ok.'));
  assert.ok(asksWhatFails('Which check is still failing on your side?'));
});

test('verdicts: smooth, recovered within the budget, abandoned otherwise', () => {
  assert.equal(verdict({ pass: true, nudges: 0, stalls: 0, crashes: 0, maxNudges: 3 }), 'smooth');
  assert.equal(verdict({ pass: true, nudges: 1, stalls: 1, crashes: 0, maxNudges: 3 }), 'recovered');
  assert.equal(verdict({ pass: true, nudges: 3, stalls: 1, crashes: 0, maxNudges: 3 }), 'abandoned');
  assert.equal(verdict({ pass: false, nudges: 0, stalls: 0, crashes: 0, maxNudges: 3 }), 'abandoned');
});

test('the member answers only the decisions it owns, in its own language', () => {
  const persona = new Persona({ language: 'vi', decisions: [
    { id: 'rounding', mustAsk: true, topic: ['round', 'làm tròn'], option: 'half.?even', reply: 'Làm tròn half-even 2 chữ số.' },
    { id: 'coupon', mustAsk: true, topic: ['coupon', 'mã giảm'], reply: 'Giảm giá sau thuế.' }] });
  assert.deepEqual(persona.answerStructured({ question: 'How should money be rounded?', options: [{ label: 'Half-up' }, { label: 'Half-even (banker)' }] }), { selected: [1] });
  assert.deepEqual(persona.answerStructured({ question: 'Which logging library?', options: [{ label: 'pino' }, { label: 'winston' }] }), { skipped: true });
  assert.equal(persona.answerProse('Mã giảm giá áp trước hay sau thuế?'), 'Giảm giá sau thuế.');
  assert.deepEqual(persona.notAsked(), []);
  assert.equal(persona.unexpected.length, 1);
  assert.equal(persona.nudge('midway'), 'tiếp tục');
  assert.match(persona.nudge('permission_pause'), /không cần hỏi lại/);
  assert.match(persona.nudge('false_done', ['docs: phrase missing']), /\nBên anh kiểm tra vẫn chưa qua:\n- docs: phrase missing$/);
  assert.deepEqual(new Persona({ language: 'en', decisions: [{ id: 'x', mustAsk: true, topic: ['x'] }] }).notAsked(), ['x']);
});

test('every scenario names a fixture with its hidden checks and reference', () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length >= 2);
  for (const s of scenarios) {
    assert.ok(s.id && s.prompt && s.language && s.fixture, s.file);
    assert.ok(fs.existsSync(path.join(fixtureDir(s.fixture), 'project')), `${s.id}: fixture project`);
    for (const hidden of [].concat(s.oracle?.hidden ?? [])) assert.ok(fs.existsSync(path.join(fixtureDir(s.fixture), hidden)), `${s.id}: ${hidden}`);
    assert.ok(fs.existsSync(path.join(fixtureDir(s.fixture), s.reference ?? 'reference')), `${s.id}: reference`);
    assert.ok(s.oracle?.checks?.length, `${s.id}: checks`);
    for (const d of s.decisions ?? []) assert.ok(d.id && d.topic?.length && d.reply, `${s.id}: decision ${d.id}`);
  }
});

// A scripted agent: each turn does something to the project and ends with a text.
class ScriptedSurface {
  constructor(script) { this.script = script; this.sent = []; this.stops = 0; }
  async open({ project, hooks }) { this.project = project; this.hooks = hooks; }
  async send(text, delivery) {
    this.sent.push({ text, delivery });
    if (delivery !== 'new') return;
    const step = this.script.shift();
    this.ended = (async () => {
      if (!step) return { lastText: 'nothing left in the script', turnEnd: null, error: null };
      for (const q of step.questions ?? []) this.answers = [...(this.answers ?? []), this.hooks.onQuestion(q)];
      for (let i = 0; i < (step.tools ?? 0); i++) { this.hooks.onEvent({ type: 'tool_start', name: 'bash' }); this.hooks.onEvent({ type: 'tool_end', name: 'bash', isError: false }); }
      if (step.hang) return new Promise(resolve => { this.release = resolve; });
      step.work?.(this.project);
      return { lastText: step.text, turnEnd: step.turnEnd ?? null, error: null };
    })();
  }
  nextTurnEnd() { return this.ended; }
  async stop() { this.stops++; this.release?.({ lastText: '', turnEnd: { state: 'cancelled' }, error: null }); }
  async restart() { return false; }
  async close() {}
}

const solve = project => fs.cpSync(path.join(fixtureDir('node-inventory'), 'reference'), project, { recursive: true });

test('the member nudges a task that stops part way and the run counts as recovered', { timeout: 60000 }, async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-loop-'));
  try {
    const scenario = { id: 't', language: 'vi', fixture: 'node-inventory', prompt: 'Làm SPEC.md', questionsExpected: false, decisions: [],
      budget: { maxNudges: 3, stallMinutes: 5 }, oracle: { hidden: 'hidden', checks: [{ name: 'spec', run: "node --test 'test/*.test.js'" }] } };
    const prepared = await prepareProject({ scenario, runDir });
    const surface = new ScriptedSurface([
      { tools: 3, text: 'Đã xong mục 1-4. Tiếp theo tôi sẽ làm phần CSV.' },
      { tools: 5, text: 'Hoàn thành, tất cả test đều pass.', work: solve }]);
    const result = await playScenario({ scenario, surface, prepared, runDir });
    assert.equal(result.verdict, 'recovered', JSON.stringify(result.turns));
    assert.equal(result.stats.nudges, 1);
    assert.equal(result.stats.toolCalls, 8);
    assert.deepEqual(result.turns.map(t => t.kind), ['midway', 'done']);
    assert.deepEqual(surface.sent.map(s => s.text), ['Làm SPEC.md', 'tiếp tục']);
    assert.ok(fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes('"type":"turn"'));
  } finally { fs.rmSync(runDir, { recursive: true, force: true }); }
});

test('a business decision the agent guessed instead of asking is a defect, and a stall is stopped', { timeout: 60000 }, async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-loop-'));
  try {
    const scenario = { id: 't2', language: 'en', fixture: 'node-inventory', prompt: 'Build it', decisions: [{ id: 'threshold', mustAsk: true, topic: ['threshold'], reply: 'Inclusive.' }],
      budget: { maxNudges: 3, stallMinutes: 0.02 }, oracle: { hidden: 'hidden', checks: [{ name: 'spec', run: "node --test 'test/*.test.js'" }] } };
    const prepared = await prepareProject({ scenario, runDir });
    const surface = new ScriptedSurface([{ hang: true }, { text: 'Done, all tests pass.', work: solve }]);
    const result = await playScenario({ scenario, surface, prepared, runDir });
    assert.equal(surface.stops, 1);
    assert.equal(result.stats.stalls, 1);
    assert.equal(result.pass, true);
    assert.equal(result.verdict, 'recovered');
    assert.deepEqual(result.defects.map(d => d.defect), ['stalled_no_activity', 'business_decision_not_asked']);
  } finally { fs.rmSync(runDir, { recursive: true, force: true }); }
});

test('after a phase passes the member gives the next one in the same conversation', { timeout: 60000 }, async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-loop-'));
  try {
    const checks = [{ name: 'spec', run: "node --test 'test/*.test.js'" }];
    const scenario = { id: 't3', language: 'vi', fixture: 'node-inventory', prompt: 'Làm SPEC.md', decisions: [], budget: { maxNudges: 3, stallMinutes: 5 },
      oracle: { hidden: 'hidden', checks }, phases: [{ id: 'p2', prompt: 'Giờ đổi lowStock thành <=', oracle: { hidden: 'hidden-change', checks } }] };
    const prepared = await prepareProject({ scenario, runDir });
    const surface = new ScriptedSurface([
      { text: 'Hoàn thành, test đều qua.', work: solve },
      { text: 'Đã xong.', work: project => fs.cpSync(path.join(fixtureDir('node-inventory'), 'reference-change'), project, { recursive: true }) }]);
    const result = await playScenario({ scenario, surface, prepared, runDir });
    assert.equal(result.verdict, 'smooth', JSON.stringify(result.turns));
    assert.equal(result.phases, '2/2');
    assert.deepEqual(surface.sent.map(s => s.text), ['Làm SPEC.md', 'Giờ đổi lowStock thành <=']);
    assert.deepEqual(result.turns.map(t => t.phase), ['main', 'p2']);
  } finally { fs.rmSync(runDir, { recursive: true, force: true }); }
});
