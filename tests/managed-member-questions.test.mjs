import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberQuestions, normalizeQuestions, normalizeAnswer, answerText, askTool } from '../packages/piagent-core/managed/member-questions.mjs';

const QUESTIONS = [
  { header: 'Phạm vi', question: 'Xuất CSV toàn bộ hay chỉ trang đang xem?', options: [{ label: 'Trang đang xem', description: 'Nhanh, đúng thứ người dùng thấy' }, { label: 'Toàn bộ' }] },
  { question: 'Cột nào cần thêm?', options: [{ label: 'Tồn kho' }, { label: 'Giá' }, { label: 'Nhà cung cấp' }], multiSelect: true },
];

// The questions the agent asks have a fixed shape: 1–4 questions, each with
// 2–4 options of distinct labels; text is trimmed and bounded.
test('questions and answers are checked against their shape', () => {
  const questions = normalizeQuestions(QUESTIONS);
  assert.equal(questions.length, 2); assert.equal(questions[0].options[1].description, ''); assert.equal(questions[1].multiSelect, true);
  for (const bad of [[], Array(5).fill(QUESTIONS[0]), [{ question: 'x', options: [{ label: 'a' }] }], [{ question: 'x', options: [{ label: 'a' }, { label: 'A' }] }],
    [{ question: '', options: [{ label: 'a' }, { label: 'b' }] }], 'x']) assert.equal(normalizeQuestions(bad), null, JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(normalizeAnswer(questions, { skipped: true }), { skipped: true, answers: [] });
  assert.deepEqual(normalizeAnswer(questions, { answers: [{ selected: [1] }, { selected: [2, 0], other: '  Ngày nhập  ' }] }),
    { skipped: false, answers: [{ selected: [1], other: null }, { selected: [0, 2], other: 'Ngày nhập' }] });
  for (const bad of [{ answers: [{ selected: [1] }] }, { answers: [{ selected: [0, 1] }, { selected: [0] }] }, { answers: [{ selected: [0], other: 'x' }, { selected: [0] }] },
    { answers: [{ selected: [] }, { selected: [0] }] }, { answers: [{ selected: [5] }, { selected: [0] }] }, {}]) assert.equal(normalizeAnswer(questions, bad), null, JSON.stringify(bad));
  const text = answerText(questions, normalizeAnswer(questions, { answers: [{ selected: [0] }, { selected: [1], other: 'Ngày nhập' }] }));
  assert.match(text, /^The member answered:\n1\. \[Phạm vi\] Xuất CSV.+\n   → 1\. Trang đang xem\n2\. Cột nào.+\n   → 2\. Giá\n   → Other: Ngày nhập$/);
  assert.match(answerText(questions, { skipped: true, answers: [] }), /leaves these decisions to you/);
});

// A question waits on the screen bound to its conversation until the member
// answers there; a wrong answer is refused and the question keeps waiting; a
// screen that goes away or Stop withdraws it.
test('a waiting question is answered once, on its own conversation', async () => {
  const questions = normalizeQuestions(QUESTIONS), events = [];
  const unbind = memberQuestions.bindSurface('s-1', event => events.push(event.type));
  assert.equal(memberQuestions.hasSurface('s-1'), true); assert.equal(memberQuestions.hasSurface('s-2'), false);
  const asked = memberQuestions.ask({ sessionId: 's-1', toolCallId: 'call-1', questions });
  const [pending] = memberQuestions.pending('s-1');
  assert.match(pending.questionRef, /^question\.[0-9a-f-]{36}$/); assert.equal(pending.questions[0].question, questions[0].question);
  assert.deepEqual(memberQuestions.pending('s-2'), []);
  assert.throws(() => memberQuestions.answer('s-2', pending.questionRef, { skipped: true }), /question-not-pending/);
  assert.throws(() => memberQuestions.answer('s-1', pending.questionRef, { answers: [] }), /question-answer-invalid/);
  assert.deepEqual(memberQuestions.answer('s-1', pending.questionRef, { answers: [{ selected: [0] }, { selected: [1] }] }), { questionRef: pending.questionRef, state: 'answered' });
  assert.deepEqual(await asked, { skipped: false, answers: [{ selected: [0], other: null }, { selected: [1], other: null }] });
  assert.throws(() => memberQuestions.answer('s-1', pending.questionRef, { skipped: true }), /question-not-pending/, 'answered once');
  // Stop withdraws it.
  const stop = new AbortController(), stopped = memberQuestions.ask({ sessionId: 's-1', toolCallId: 'call-2', questions, signal: stop.signal });
  stop.abort(); await assert.rejects(stopped, /managed-question-cancelled/); assert.deepEqual(memberQuestions.pending('s-1'), []);
  // The screen going away withdraws it.
  const left = memberQuestions.ask({ sessionId: 's-1', toolCallId: 'call-3', questions });
  unbind(); await assert.rejects(left, /managed-question-cancelled/);
  assert.equal(memberQuestions.hasSurface('s-1'), false);
  assert.deepEqual(events, ['asked', 'answered', 'asked', 'withdrawn', 'asked', 'withdrawn']);
});

// The tool asks where the member is: the WebUI card when a screen is bound
// to the conversation, the Terminal selector otherwise, and with no screen it
// tells the agent to go on with a stated assumption.
test('the tool asks on the WebUI, in the Terminal, or tells the agent no one can answer', async () => {
  const managed = { session: { sessionManager: { getSessionId: () => 's-tool' } } }, tool = askTool(managed);
  assert.equal(tool.name, 'ask_user');
  await assert.rejects(tool.execute('c', { questions: [{ question: 'x', options: [{ label: 'a' }] }] }), /managed-question-invalid/);
  // WebUI.
  const unbind = memberQuestions.bindSurface('s-tool', () => undefined);
  const viaWeb = tool.execute('c-1', { questions: QUESTIONS }, undefined, undefined, { hasUI: true, ui: { [Symbol.for('piagent.webui.gateway-runtime-ui.v1')]: true, select: async () => undefined } });
  await new Promise(r => setImmediate(r));
  const [pending] = memberQuestions.pending('s-tool');
  memberQuestions.answer('s-tool', pending.questionRef, { answers: [{ selected: [1] }, { selected: [], other: 'Ngày nhập' }] });
  const web = await viaWeb;
  assert.match(web.content[0].text, /→ 2\. Toàn bộ[\s\S]+→ Other: Ngày nhập/); assert.equal(web.details.answer.answers[0].selected[0], 1);
  unbind();
  // Terminal: option 1 of the first question; the second picks 3, then "Other" typed, then done.
  const picks = ['1. Trang đang xem — Nhanh, đúng thứ người dùng thấy', '3. Nhà cung cấp', '4. Khác (tự nhập)', 'Xong'], titles = [];
  const ui = { select: async (title, choices) => { titles.push(title); const next = picks.shift(); assert.ok(choices.includes(next), `${next} in ${choices}`); return next; }, input: async () => 'Ngày nhập' };
  const terminal = await tool.execute('c-2', { questions: QUESTIONS }, undefined, undefined, { hasUI: true, ui });
  assert.deepEqual(terminal.details.answer, { skipped: false, answers: [{ selected: [0], other: null }, { selected: [2], other: 'Ngày nhập' }] });
  assert.match(titles[0], /^\(1\/2\) Phạm vi: Xuất CSV/); assert.match(titles.at(-1), /Đã chọn: 3/);
  // Esc in the Terminal leaves the choice to the agent.
  const escaped = await tool.execute('c-3', { questions: QUESTIONS }, undefined, undefined, { hasUI: true, ui: { select: async () => undefined, input: async () => undefined } });
  assert.equal(escaped.details.answer.skipped, true);
  // No screen.
  const none = await tool.execute('c-4', { questions: QUESTIONS }, undefined, undefined, { hasUI: false });
  assert.match(none.content[0].text, /No member can answer right now/); assert.equal(none.details.surface, 'none');
});

// A real company session: the main agent asks, the member answers on the
// WebUI (here the screen bound to the conversation), and the model's next
// request carries the answer. Stop while it waits ends the turn as stopped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ManagedSession } from '../packages/piagent-core/managed/session.mjs';
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);

async function company(script) {
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 };
  const model = { id: 'claude-sonnet-5-5', provider_model_id: 'claude-sonnet-5-5', owned_by: 'claude' }, roleId = randomUUID(), run = randomUUID();
  let fence = 0;
  const grant = () => ({ ...authority, run_id: run, role_id: roleId, role: 'main', fence: ++fence, provider: 'claude', model_id: model.id, provider_model_id: model.provider_model_id, effort: 'medium', token: `as_run_${roleId}_${'x'.repeat(43)}` });
  const broker = { async request(action) {
    if (action === 'config') return { schema_version: 2, credential_mode: 'managed', authority, key_id: 'k', user: { id: 'm' }, revision: 'r1', models: [model], harness: { configuration: { main: { model_ids: [model.id] } } } };
    if (['start', 'renew'].includes(action)) return grant();
    if (action === 'close') return true;
    throw Error('unexpected ' + action);
  }, async dispose() {} };
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks)); bodies.push(body);
    const step = script.shift() ?? 'Done.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    emit({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    if (typeof step === 'string') { emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step } }); }
    else { emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + randomUUID().replaceAll('-', ''), name: step.tool, input: {} } }); emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } }); }
    emit({ type: 'content_block_stop', index: 0 }); emit({ type: 'message_delta', delta: { stop_reason: typeof step === 'string' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }); emit({ type: 'message_stop' }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'member-questions-')));
  const managed = await ManagedSession.create({ sdkRoot, cwd: root, origin: `http://127.0.0.1:${server.address().port}`, broker });
  return { managed, bodies, close: async () => { await managed.dispose(); await new Promise(r => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); } };
}
const waitFor = async (check) => { for (let i = 0; i < 400; i++) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 25)); } throw Error('timeout'); };

test('the main agent asks the member and goes on with the answer', { skip: !supported, timeout: 120000 }, async () => {
  const { managed, bodies, close } = await company([{ tool: 'ask_user', input: { questions: QUESTIONS } }, 'Làm theo lựa chọn của bạn.']);
  const sessionId = managed.session.sessionManager.getSessionId(), unbind = memberQuestions.bindSurface(sessionId, () => undefined);
  try {
    const prompt = managed.session.prompt('Thêm nút xuất CSV');
    const [pending] = await waitFor(() => memberQuestions.pending(sessionId).length && memberQuestions.pending(sessionId));
    assert.equal(pending.questions.length, 2);
    // The model's tools offer ask_user, and the system prompt says when to use it.
    assert.ok(bodies[0].tools.some(t => t.name === 'ask_user')); assert.match(JSON.stringify(bodies[0].system), /ask the member with ask_user before you act on a guess/);
    memberQuestions.answer(sessionId, pending.questionRef, { answers: [{ selected: [0] }, { selected: [0, 2] }] });
    await prompt;
    const result = JSON.stringify(bodies.slice(1).map(b => b.messages));
    assert.match(result, /The member answered:/); assert.match(result, /→ 1\. Trang đang xem/); assert.match(result, /→ 3\. Nhà cung cấp/);
    assert.equal(managed.session.messages.at(-1).stopReason, 'stop');
  } finally { unbind(); await close(); }
});

test('Stop while the agent waits for the member ends the turn as stopped', { skip: !supported, timeout: 120000 }, async () => {
  const { managed, close } = await company([{ tool: 'ask_user', input: { questions: QUESTIONS } }, 'unused']);
  const sessionId = managed.session.sessionManager.getSessionId(), unbind = memberQuestions.bindSurface(sessionId, () => undefined);
  try {
    const prompt = managed.session.prompt('Thêm nút xuất CSV');
    await waitFor(() => memberQuestions.pending(sessionId).length);
    await managed.session.abort(); await prompt;
    assert.deepEqual(memberQuestions.pending(sessionId), [], 'the question is withdrawn');
    assert.equal(managed.session.messages.at(-1).stopReason, 'aborted');
    // The agent reads that the decisions are still the member's, to ask again on "tiếp tục".
    const result = managed.session.messages.find(m => m.role === 'toolResult' && m.toolName === 'ask_user');
    assert.equal(result.isError, true); assert.match(result.content[0].text, /still open: when the member continues, ask again/);
  } finally { unbind(); await close(); }
});

// A member may answer long after the agent asked: the waiting question pulses
// the Gateway's operation watchdog, so the turn is not ended as silent while
// it waits; once answered, silence counts again.
test('a waiting question keeps the Gateway operation watchdog from ending the turn', async () => {
  const { SessionOperationWatchdog, sessionOperationDeadlinePolicy } = await import('../packages/piagent-webui/gateway/session-operation-watchdog.ts');
  const { bindSessionQuestions } = await import('../packages/piagent-webui/gateway/session-questions.ts');
  const previous = memberQuestions.pulseMs; memberQuestions.pulseMs = 30;
  const watchdog = new SessionOperationWatchdog(sessionOperationDeadlinePolicy({ inactivityTimeoutMs: 120, maximumDurationMs: 60_000, terminationTimeoutMs: 50, projectionTimeoutMs: 50 }));
  const expired = []; watchdog.start(reason => expired.push(reason));
  const unbind = bindSessionQuestions('s-watchdog', () => watchdog.progress());
  try {
    const asked = memberQuestions.ask({ sessionId: 's-watchdog', toolCallId: 'c', questions: normalizeQuestions(QUESTIONS) });
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(expired, [], 'still waiting after more than three idle windows');
    const [pending] = memberQuestions.pending('s-watchdog');
    memberQuestions.answer('s-watchdog', pending.questionRef, { skipped: true }); await asked;
    await new Promise(r => setTimeout(r, 250));
    assert.deepEqual(expired, ['operation-inactivity-timeout'], 'silence after the answer is noticed');
  } finally { memberQuestions.pulseMs = previous; unbind(); watchdog.close?.(); }
});
